import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import sharp from 'sharp';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const MP_API = 'https://api.mercadopago.com';
const PORT = process.env.PORT || 3001;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const CONFIG_PATH = path.join(__dirname, 'mp-config.json');
const DATA_PATH = path.join(__dirname, 'data.json');
const CRED_PATH = path.join(__dirname, 'platform-credentials.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const THUMBS_DIR = path.join(UPLOADS_DIR, 'thumbs');
const THUMB_SIZES = [48, 90, 120, 200];
const BACKUPS_DIR = path.join(__dirname, 'backups');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(THUMBS_DIR)) fs.mkdirSync(THUMBS_DIR, { recursive: true });
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });

// ─── Auth Middleware ─────────────────────────────────────────────
function authMiddleware(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token === ADMIN_TOKEN) return next();
  res.status(401).json({ error: 'No autorizado. Proporciona x-admin-token válido.' });
}

// Public routes (no auth)
// req.path is relative to mount point (/api → /health, /webhook)
const publicPaths = ['/health', '/webhook'];
app.use('/api', (req, res, next) => {
  if (req.path === '/' || publicPaths.some(p => req.path.startsWith(p))) return next();
  authMiddleware(req, res, next);
});

// ─── Backup System ──────────────────────────────────────────────
const BACKUP_INTERVAL = 30 * 60 * 1000; // 30 min
const MAX_BACKUPS = 30;

function createBackup() {
  if (!fs.existsSync(DATA_PATH)) return;
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(BACKUPS_DIR, `data_${ts}.json`);
    fs.copyFileSync(DATA_PATH, dest);
    // Rotate old backups
    const files = fs.readdirSync(BACKUPS_DIR)
      .filter(f => f.startsWith('data_') && f.endsWith('.json'))
      .sort()
      .reverse();
    if (files.length > MAX_BACKUPS) {
      files.slice(MAX_BACKUPS).forEach(f => {
        try { fs.unlinkSync(path.join(BACKUPS_DIR, f)); } catch {}
      });
    }
  } catch (e) { console.warn('Backup error:', e.message); }
}

// Backup on every save (debounced)
let backupTimer = null;
function scheduleBackup() {
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = setTimeout(createBackup, 60000); // 1 min after last save
}

// Periodic backup
setInterval(createBackup, BACKUP_INTERVAL);
setTimeout(createBackup, 10000); // first backup after 10s

// ─── Image Processing ────────────────────────────────────────────
async function processImage(filePath, baseName) {
  const name = baseName.replace(/\.\w+$/, '') + '.webp';
  const outPath = path.join(UPLOADS_DIR, name);
  try {
    await sharp(filePath)
      .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 })
      .toFile(outPath);
    const stat = fs.statSync(outPath);
    const thumbs = {};
    for (const size of THUMB_SIZES) {
      const tn = `${size}_${name}`;
      await sharp(filePath)
        .resize(size, size, { fit: 'cover' })
        .webp({ quality: 72, effort: 3 })
        .toFile(path.join(THUMBS_DIR, tn));
      thumbs[size] = `/uploads/thumbs/${tn}`;
    }
    try { fs.unlinkSync(filePath); } catch {}
    return { url: `/uploads/${name}`, filename: name, size: stat.size, thumbs };
  } catch (err) {
    console.warn('Image processing failed, keeping original:', err.message);
    const origName = path.basename(filePath);
    return { url: `/uploads/${origName}`, filename: origName, size: fs.statSync(filePath).size, thumbs: {} };
  }
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, Date.now() + '_' + crypto.randomBytes(4).toString('hex') + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype);
    cb(ok ? null : new Error('Formato no soportado'), ok);
  }
});

// ─── Persistence helpers ────────────────────────────────────────
function loadJson(filePath, fallback = {}) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) { console.warn(`Could not read ${path.basename(filePath)}:`, e.message); }
  return fallback;
}
function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ─── MP Config ──────────────────────────────────────────────────
function loadMpConfig() { return loadJson(CONFIG_PATH); }
function saveMpConfig(config) { const m = { ...loadMpConfig(), ...config }; saveJson(CONFIG_PATH, m); return m; }
function getMpAccessToken() { return loadMpConfig().accessToken || process.env.MP_ACCESS_TOKEN || ''; }
function getMpPublicKey() { return loadMpConfig().publicKey || process.env.MP_PUBLIC_KEY || ''; }
function getWebhookUrl() { return loadMpConfig().webhookUrl || process.env.WEBHOOK_URL || ''; }
function maskToken(t) { if (!t || t.length < 12) return t || ''; return t.slice(0, 4) + '••••' + t.slice(-4); }

// ─── Data (full state sync) ─────────────────────────────────────
function loadAppData() { return loadJson(DATA_PATH, {}); }
function saveAppData(data) { saveJson(DATA_PATH, data); scheduleBackup(); }

// ─── Platform Credentials ───────────────────────────────────────
function loadPlatformCreds() { return loadJson(CRED_PATH, {}); }
function savePlatformCreds(creds) { saveJson(CRED_PATH, creds); }

// ─── Orders store ───────────────────────────────────────────────
const orders = new Map();

// In-memory cache for app data
let dataCache = null;
let dataCacheTime = 0;
const CACHE_TTL = 2000;

function getData() {
  const now = Date.now();
  if (dataCache && (now - dataCacheTime) < CACHE_TTL) return dataCache;
  dataCache = loadAppData();
  dataCacheTime = now;
  return dataCache;
}

function setData(data) {
  saveAppData(data);
  dataCache = data;
  dataCacheTime = Date.now();
}

// ─── Calculation Engines ────────────────────────────────────────

/** Unit conversion */
const UNITS = {
  kg: { g: 1000, lb: 2.20462, oz: 35.274, ml: 1000, l: 1, L: 1, pz: 1, unidad: 1000, docena: 83.3333 },
  g: { kg: 0.001, lb: 0.00220462, oz: 0.035274, ml: 1, l: 0.001, L: 0.001, pz: 0.001, unidad: 1, docena: 0.08333 },
  l: { ml: 1000, kg: 1, g: 1000, lb: 2.20462, oz: 35.274, L: 1, pz: 1, unidad: 1000, docena: 83.3333 },
  L: { ml: 1000, kg: 1, g: 1000, lb: 2.20462, oz: 35.274, l: 1, pz: 1, unidad: 1000, docena: 83.3333 },
  ml: { l: 0.001, L: 0.001, kg: 0.001, g: 1, lb: 0.00220462, oz: 0.035274, pz: 0.001, unidad: 1, docena: 0.08333 },
  lb: { kg: 0.453592, g: 453.592, oz: 16, ml: 453.592, l: 0.453592, L: 0.453592, pz: 1, unidad: 453.592, docena: 37.7993 },
  oz: { kg: 0.0283495, g: 28.3495, lb: 0.0625, ml: 28.3495, l: 0.0283495, L: 0.0283495, pz: 0.0283495, unidad: 28.3495, docena: 2.36246 },
  pz: { kg: 1, g: 1000, lb: 2.20462, oz: 35.274, ml: 1000, l: 1, L: 1, unidad: 1000, docena: 83.3333 },
  unidad: { kg: 0.001, g: 1, ml: 1, l: 0.001, L: 0.001, pz: 1, docena: 0.08333 },
  docena: { kg: 0.012, g: 12, ml: 12, l: 0.012, L: 0.012, pz: 12, unidad: 12 }
};

function convertUnit(value, from, to) {
  if (from === to) return value;
  if (UNITS[from]?.[to] !== undefined) return value * UNITS[from][to];
  return value;
}

function calcularCostoUnitario(ing) {
  if (!ing) return 0;
  const price = ing.purchasePrice || ing.price || 0;
  const qty = ing.purchaseQuantity || ing.qty || 0;
  if (!price || !qty) return 0;
  const fromUnit = ing.purchaseUnit || ing.unit || 'kg';
  const toUnit = ing.recipeUnit || 'g';
  const yieldPct = ing.yield || 100;
  const converted = convertUnit(qty, fromUnit, toUnit);
  if (!converted || converted <= 0) return 0;
  const usable = converted * (yieldPct / 100);
  return usable > 0 ? price / usable : 0;
}

function calcularCostoPlatillo(platillo, ingredientes) {
  const recipe = platillo?.ingredients || platillo?.recipe || [];
  if (!recipe.length) return 0;
  return recipe.reduce((sum, ri) => {
    const ing = ingredientes.find(i => i.id === ri.ingredientId);
    const qty = ri.quantity || ri.qty || 0;
    if (!ing || !qty) return sum;
    const unitCost = calcularCostoUnitario(ing);
    return sum + unitCost * qty;
  }, 0);
}

function calcularNetoPlataforma(precio, comisionPct, config) {
  const c = config || {};
  const ivaTasa = (c.ivaTasa || 16) / 100;
  const tieneRFC = c.tieneRFC !== false;
  const isrRet = tieneRFC ? (c.isrRetencion || 2.5) / 100 : 0.20;
  const ivaRetPct = tieneRFC ? (c.ivaRetencion || 50) / 100 : 1;

  const comPct = comisionPct / 100;
  const iva = precio * ivaTasa;
  const totalConIva = precio + iva;
  const comision = precio * comPct;
  const ivaCom = comision * ivaTasa;
  const isr = isrRet * precio;
  const ivaRet = ivaRetPct * iva;
  const neto = totalConIva - comision - ivaCom - isr - ivaRet;

  return {
    neto,
    c: comision,
    ic: ivaCom,
    ir: isr,
    ivr: ivaRet,
    subtotal: totalConIva,
    isrRetPct: isrRet * 100,
    ivaRetPct: ivaRetPct * 100,
    ivaTasa: ivaTasa * 100
  };
}

function calcularDashboard(data) {
  const { ingredientes = [], platillos = [], gastosFijos = [], configPlataformas = {}, dashInputs = {} } = data;
  const { plataformas = [], isrRetencion = 2.5, ivaRetencion = 50, ivaTasa = 16, tieneRFC = true } = configPlataformas;
  const { platilloId, plataformaId, ventas = 0, publicidad = 0, margenGanancia = 30 } = dashInputs;

  const plat = platilloId && platilloId !== '__promedio__' ? platillos.find(p => p.id === platilloId) : null;
  const pltf = plataformaId ? plataformas.find(p => p.id === plataformaId) : (plataformas.find(p => p.activa) || null);

  const platilloCostResults = [];
  let costoPromedio = 0, precioSugeridoPromedio = 0, count = 0;

  for (const p of platillos) {
    const cp = calcularCostoPlatillo(p, ingredientes);
    const po = p.portions || 1;
    const costo = po > 0 ? cp / po : 0;
    const mg = margenGanancia;
    const ps = mg > 0 ? costo / (1 - mg / 100) : costo;
    platilloCostResults.push({ id: p.id, name: p.name, costo, precioSugerido: ps, icon: p.icon || '🍽️' });
    costoPromedio += costo;
    precioSugeridoPromedio += ps;
    count++;
  }
  costoPromedio = count > 0 ? costoPromedio / count : 0;
  precioSugeridoPromedio = count > 0 ? precioSugeridoPromedio / count : 0;

  const precioBase = plat ? (platilloCostResults.find(r => r.id === plat.id)?.precioSugerido || 0) : precioSugeridoPromedio;
  const costoBase = plat ? (platilloCostResults.find(r => r.id === plat.id)?.costo || 0) : costoPromedio;

  const platformResults = [];
  for (const p of (plataformas.filter(p => p.activa))) {
    const net = calcularNetoPlataforma(precioBase, p.comision, { ivaTasa, tieneRFC, isrRetencion, ivaRetencion });
    platformResults.push({ id: p.id, name: p.nombre, icon: p.icon, comision: p.comision, ...net });
  }

  const selectedPfResult = pltf ? platformResults.find(r => r.id === pltf.id) : platformResults[0];
  const neto = selectedPfResult?.neto || 0;
  const c = selectedPfResult?.c || 0;
  const ic = selectedPfResult?.ic || 0;
  const ir = selectedPfResult?.ir || 0;
  const ivr = selectedPfResult?.ivr || 0;

  const ingresoMensual = precioBase * ventas;
  const costoIngMensual = costoBase * ventas;
  const comMensual = c * ventas;
  const ivaComMensual = ic * ventas;
  const isrMensual = ir * ventas;
  const ivaRetMensual = ivr * ventas;
  const totalGastosFijos = gastosFijos.reduce((s, g) => {
    const FREQ = { mensual: 1, bimestral: 1 / 2, trimestral: 1 / 3, semestral: 1 / 6, anual: 1 / 12 };
    return s + (g.amount || 0) * (FREQ[g.frequency] || 1);
  }, 0);
  const totalCostos = costoIngMensual + comMensual + ivaComMensual + isrMensual + ivaRetMensual + totalGastosFijos + publicidad;
  const utilidadNeta = ingresoMensual - totalCostos;
  const contribucionMarginal = neto - costoBase;
  const puntoEquilibrio = contribucionMarginal > 0 ? Math.ceil((totalGastosFijos + publicidad) / contribucionMarginal) : Infinity;
  const margenNetoPct = ingresoMensual > 0 ? (utilidadNeta / ingresoMensual) * 100 : 0;
  const margenBrutoPct = ingresoMensual > 0 ? ((ingresoMensual - costoIngMensual - comMensual - ivaComMensual) / ingresoMensual) * 100 : 0;

  return {
    ventas,
    publicidad,
    margenGanancia,
    precioBase,
    costoBase,
    neto,
    comision: c,
    ivaComision: ic,
    isrRet: ir,
    ivaRet: ivr,
    ingresoMensual,
    costoIngMensual,
    comMensual,
    ivaComMensual,
    isrMensual,
    ivaRetMensual,
    totalGastosFijos,
    totalCostos,
    utilidadNeta,
    contribucionMarginal,
    puntoEquilibrio,
    margenNetoPct,
    margenBrutoPct,
    selectedPlatform: pltf ? { id: pltf.id, name: pltf.nombre, icon: pltf.icon } : null,
    platformResults,
    platilloResults: plat ? platilloCostResults.find(r => r.id === plat.id) : null,
    costoPromedio,
    precioSugeridoPromedio
  };
}

// ─── Serve uploaded images ──────────────────────────────────────
app.use('/uploads', express.static(UPLOADS_DIR));

// ─── API: Data Sync ─────────────────────────────────────────────
// GET /api/data — load all app data
app.get('/api/data', (_req, res) => {
  const data = getData();
  res.json({ ok: true, data });
});

// POST /api/data — save all app data (full sync)
app.post('/api/data', (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ ok: false, error: 'Se requiere payload "data"' });
  setData(data);
  res.json({ ok: true, message: 'Datos guardados correctamente' });
});

// ─── API: Calculations ──────────────────────────────────────────

// POST /api/calculate/dish-cost
app.post('/api/calculate/dish-cost', (req, res) => {
  const { platillo, ingredientes } = req.body;
  if (!platillo) return res.status(400).json({ error: 'platillo requerido' });
  const ings = ingredientes || getData().ingredientes || [];
  const costo = calcularCostoPlatillo(platillo, ings);
  const po = platillo.portions || 1;
  const costoPorcion = po > 0 ? costo / po : 0;
  res.json({ ok: true, costo, costoPorcion, portions: po });
});

// POST /api/calculate/net-revenue
app.post('/api/calculate/net-revenue', (req, res) => {
  const { precio, comision, config } = req.body;
  if (precio === undefined || comision === undefined) {
    return res.status(400).json({ error: 'precio y comision requeridos' });
  }
  const defConfig = getData().configPlataformas || {};
  const result = calcularNetoPlataforma(precio, comision, { ...defConfig, ...config });
  res.json({ ok: true, ...result });
});

// POST /api/calculate/dashboard
app.post('/api/calculate/dashboard', (req, res) => {
  const appData = getData();
  const dashInputs = req.body;
  const data = {
    ...appData,
    dashInputs: {
      platilloId: dashInputs.platilloId,
      plataformaId: dashInputs.plataformaId,
      ventas: dashInputs.ventas || 0,
      publicidad: dashInputs.publicidad || 0,
      margenGanancia: dashInputs.margenGanancia || 30
    }
  };
  const result = calcularDashboard(data);
  res.json({ ok: true, ...result });
});

// POST /api/calculate/costing — full costing analysis
app.post('/api/calculate/costing', (req, res) => {
  const appData = getData();
  const { ingredientes = [], platillos = [], configPlataformas = {} } = appData;
  const { plataformas = [], ivaTasa = 16, tieneRFC = true, isrRetencion = 2.5, ivaRetencion = 50 } = configPlataformas;
  const margenGanancia = req.body.margenGanancia !== undefined ? req.body.margenGanancia : 30;

  const activePlatforms = plataformas.filter(p => p.activa);

  const dishResults = platillos.map(p => {
    const cp = calcularCostoPlatillo(p, ingredientes);
    const po = p.portions || 1;
    const costo = po > 0 ? cp / po : 0;
    const precioVenta = margenGanancia > 0 ? costo / (1 - margenGanancia / 100) : costo;

    const platformNets = activePlatforms.map(pl => {
      const net = calcularNetoPlataforma(precioVenta, pl.comision, { ivaTasa, tieneRFC, isrRetencion, ivaRetencion });
      return { id: pl.id, name: pl.nombre, icon: pl.icon, comision: pl.comision, ...net };
    });

    const pRecipe = p.ingredients || p.recipe || [];
    return {
      id: p.id, name: p.name, icon: p.icon || '🍽️',
      costo, precioVenta, portions: po,
      platforms: platformNets,
      recipeCount: pRecipe.length,
      ingredients: pRecipe.map(ri => {
        const ing = ingredientes.find(i => i.id === ri.ingredientId);
        if (!ing) return null;
        const qty = ri.quantity || ri.qty || 0;
        const unitCost = calcularCostoUnitario(ing);
        return { name: ing.name, qty, unit: ing.recipeUnit || ing.unit || 'g', cost: unitCost * qty };
      }).filter(Boolean)
    };
  });

  res.json({
    ok: true,
    dishes: dishResults,
    totalDishes: dishResults.length,
    margenGanancia,
    activePlatforms: activePlatforms.map(p => ({ id: p.id, name: p.nombre, icon: p.icon, comision: p.comision }))
  });
});

// ─── API: Image Upload ──────────────────────────────────────────
// POST /api/upload/image
app.post('/api/upload/image', (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError) return res.status(400).json({ error: 'Archivo muy grande (max 1MB)' });
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'No se envió ninguna imagen' });
    try {
      const result = await processImage(req.file.path, req.file.filename);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: 'Error al procesar imagen: ' + e.message });
    }
  });
});

// POST /api/upload/image-base64 — accept base64 images (migration)
app.post('/api/upload/image-base64', express.json({ limit: '5mb' }), async (req, res) => {
  const { base64, filename } = req.body;
  if (!base64) return res.status(400).json({ error: 'base64 requerido' });
  const matches = base64.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!matches) return res.status(400).json({ error: 'Formato base64 inválido' });
  const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
  const rawName = (filename || Date.now() + '_' + crypto.randomBytes(4).toString('hex')) + '.' + ext;
  const cleanName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const tmpPath = path.join(UPLOADS_DIR, cleanName);
  fs.writeFileSync(tmpPath, Buffer.from(matches[2], 'base64'));
  try {
    const result = await processImage(tmpPath, cleanName);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: 'Error al procesar imagen: ' + e.message });
  }
});

// POST /api/migrate/images — migrate multiple base64 images at once
app.post('/api/migrate/images', express.json({ limit: '50mb' }), async (req, res) => {
  const { images } = req.body;
  if (!Array.isArray(images)) return res.status(400).json({ error: 'Se requiere array "images"' });
  const results = [];
  for (let idx = 0; idx < images.length; idx++) {
    const img = images[idx];
    if (!img.data || !img.data.startsWith('data:image')) {
      results.push({ index: idx, url: img.data, migrated: false, error: 'No es base64' });
      continue;
    }
    const matches = img.data.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!matches) {
      results.push({ index: idx, url: img.data, migrated: false, error: 'Formato inválido' });
      continue;
    }
    const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
    const rawName = (img.name || 'img_' + Date.now() + '_' + idx) + '.' + ext;
    const cleanName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const tmpPath = path.join(UPLOADS_DIR, cleanName);
    try {
      fs.writeFileSync(tmpPath, Buffer.from(matches[2], 'base64'));
      const processed = await processImage(tmpPath, cleanName);
      results.push({ index: idx, url: processed.url, migrated: true, field: img.field, thumbs: processed.thumbs });
    } catch (e) {
      results.push({ index: idx, url: img.data, migrated: false, error: e.message });
    }
  }
  res.json({ ok: true, migrated: results.filter(r => r.migrated).length, failed: results.filter(r => !r.migrated).length, results });
});

// ─── API: Image Management ──────────────────────────────────────

// GET /api/images — list all uploaded images with usage info
app.get('/api/images', (req, res) => {
  try {
    const files = fs.readdirSync(UPLOADS_DIR).filter(f => {
      if (f === 'thumbs' || f === '.gitkeep') return false;
      return /\.(jpg|jpeg|png|webp|gif)$/i.test(f);
    });
    const data = getData();
    const platillos = data.platillos || [];
    const configTienda = data.configTienda || {};

    const images = files.map(f => {
      const fp = path.join(UPLOADS_DIR, f);
      let stat;
      try { stat = fs.statSync(fp); } catch { return null; }
      if (!stat.isFile()) return null;
      const url = `/uploads/${f}`;
      const thumbSizes = {};
      for (const s of THUMB_SIZES) {
        const tn = path.join(THUMBS_DIR, `${s}_${f}`);
        if (fs.existsSync(tn)) thumbSizes[s] = `/uploads/thumbs/${s}_${f}`;
      }
      const usedBy = [];
      platillos.forEach(p => { if (p.image === url) usedBy.push({ type: 'platillo', id: p.id, name: p.name }); });
      if (configTienda.logo === url) usedBy.push({ type: 'store', id: 'logo', name: 'Logo de tienda' });
      if (configTienda.banner === url) usedBy.push({ type: 'store', id: 'banner', name: 'Banner de tienda' });
      return {
        filename: f,
        url,
        size: stat.size,
        created: stat.mtime,
        webp: f.endsWith('.webp'),
        thumbs: thumbSizes,
        usedBy
      };
    }).filter(Boolean);

    images.sort((a, b) => new Date(b.created) - new Date(a.created));
    res.json({ ok: true, count: images.length, images });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE /api/images/:filename — delete an image and its thumbnails
app.delete('/api/images/:filename', (req, res) => {
  const { filename } = req.params;
  const clean = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  const fp = path.join(UPLOADS_DIR, clean);
  if (!fs.existsSync(fp)) return res.status(404).json({ ok: false, error: 'Archivo no encontrado' });

  // Remove thumbnails
  for (const s of THUMB_SIZES) {
    const tn = path.join(THUMBS_DIR, `${s}_${clean}`);
    try { fs.unlinkSync(tn); } catch {}
  }

  try { fs.unlinkSync(fp); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  res.json({ ok: true, message: `Imagen ${clean} eliminada` });
});

// POST /api/images/cleanup — remove orphaned images (not referenced by any dish or store config)
app.post('/api/images/cleanup', (req, res) => {
  try {
    const data = getData();
    const platillos = data.platillos || [];
    const configTienda = data.configTienda || {};
    const referenced = new Set();
    platillos.forEach(p => { if (p.image) referenced.add(p.image); });
    if (configTienda.logo) referenced.add(configTienda.logo);
    if (configTienda.banner) referenced.add(configTienda.banner);

    const files = fs.readdirSync(UPLOADS_DIR).filter(f => {
      if (f === 'thumbs' || f === '.gitkeep') return false;
      return /\.(jpg|jpeg|png|webp|gif)$/i.test(f);
    });

    const removed = [];
    for (const f of files) {
      const url = `/uploads/${f}`;
      if (!referenced.has(url)) {
        const fp = path.join(UPLOADS_DIR, f);
        try { fs.unlinkSync(fp); removed.push(f); } catch {}
        for (const s of THUMB_SIZES) {
          const tn = path.join(THUMBS_DIR, `${s}_${f}`);
          try { fs.unlinkSync(tn); } catch {}
        }
      }
    }
    res.json({ ok: true, removed: removed.length, files: removed });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── API: Backups ───────────────────────────────────────────────
// GET /api/backups — list available backups
app.get('/api/backups', (_req, res) => {
  try {
    const files = fs.readdirSync(BACKUPS_DIR)
      .filter(f => f.startsWith('data_') && f.endsWith('.json'))
      .sort().reverse()
      .map(f => {
        const stat = fs.statSync(path.join(BACKUPS_DIR, f));
        return { name: f, size: stat.size, date: stat.mtime };
      });
    res.json({ ok: true, backups: files });
  } catch (e) {
    res.json({ ok: false, error: e.message, backups: [] });
  }
});

// POST /api/backup/now — trigger immediate backup
app.post('/api/backup/now', (_req, res) => {
  createBackup();
  res.json({ ok: true, message: 'Backup creado' });
});

// ─── API: Platform Credentials ──────────────────────────────────
// GET /api/data/platform-credentials — masked
app.get('/api/data/platform-credentials', (_req, res) => {
  const creds = loadPlatformCreds();
  const masked = {};
  for (const [key, val] of Object.entries(creds)) {
    masked[key] = {};
    for (const [k, v] of Object.entries(val || {})) {
      const secretFields = ['apiKey', 'apiSecret', 'token', 'password'];
      masked[key][k] = secretFields.includes(k) ? maskToken(String(v)) : v;
    }
  }
  res.json({ ok: true, credentials: masked });
});

// POST /api/data/platform-credentials
app.post('/api/data/platform-credentials', (req, res) => {
  const { platformId, credentials } = req.body;
  if (!platformId || !credentials) return res.status(400).json({ error: 'platformId y credentials requeridos' });
  const all = loadPlatformCreds();
  all[platformId] = { ...(all[platformId] || {}), ...credentials };
  savePlatformCreds(all);
  res.json({ ok: true, message: `Credenciales de ${platformId} guardadas` });
});

// ─── API: MP Config (existing, extended) ────────────────────────
app.get('/api/config/mp', (_req, res) => {
  const config = loadMpConfig();
  res.json({
    accessToken: maskToken(config.accessToken || process.env.MP_ACCESS_TOKEN || ''),
    publicKey: config.publicKey || process.env.MP_PUBLIC_KEY || '',
    webhookUrl: config.webhookUrl || process.env.WEBHOOK_URL || '',
    environment: config.environment || 'production',
    hasToken: !!(config.accessToken || process.env.MP_ACCESS_TOKEN),
    fromEnv: !config.accessToken
  });
});

app.post('/api/config/mp', (req, res) => {
  const { accessToken, publicKey, webhookUrl, environment } = req.body;
  const toSave = {};
  if (accessToken !== undefined) toSave.accessToken = accessToken;
  if (publicKey !== undefined) toSave.publicKey = publicKey;
  if (webhookUrl !== undefined) toSave.webhookUrl = webhookUrl;
  if (environment !== undefined) toSave.environment = environment;
  const saved = saveMpConfig(toSave);
  res.json({
    ok: true, message: 'Configuración guardada correctamente',
    config: {
      accessToken: maskToken(saved.accessToken || process.env.MP_ACCESS_TOKEN || ''),
      publicKey: saved.publicKey || process.env.MP_PUBLIC_KEY || '',
      webhookUrl: saved.webhookUrl || process.env.WEBHOOK_URL || '',
      environment: saved.environment || 'production'
    }
  });
});

app.post('/api/test/mp-connection', async (req, res) => {
  const { accessToken, publicKey } = req.body;
  const token = accessToken || getMpAccessToken();
  if (!token) return res.json({ ok: false, message: 'No hay Access Token configurado' });
  try {
    const testRes = await fetch(`${MP_API}/v1/merchants/me`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await testRes.json();
    if (testRes.ok) {
      const name = data.collector?.legal_name || data.collector?.nickname || 'Desconocido';
      return res.json({ ok: true, message: `Conexión exitosa — ${name}`, merchantName: name, merchantId: data.collector?.id, liveMode: data.live_mode });
    } else {
      return res.json({ ok: false, message: `Error MP: ${data.message || data.error || 'Credenciales inválidas'}` });
    }
  } catch (e) {
    return res.json({ ok: false, message: 'Error de conexión: ' + e.message });
  }
});

// ─── API: Create Order (with server-side price validation) ──────
app.post('/api/create-order', async (req, res) => {
  try {
    const { items, total, currency = 'MXN', payer = {}, paymentMethod } = req.body;

    if (!items?.length || !paymentMethod?.id || !paymentMethod?.type) {
      return res.status(400).json({ error: 'Faltan campos requeridos: items, total, paymentMethod.id, paymentMethod.type' });
    }

    // Server-side price validation
    const appData = getData();
    const { platillos = [], configTienda = {} } = appData;
    const margenGanancia = 30;
    let serverTotal = 0;
    const validatedItems = [];

    for (const item of items) {
      const dish = platillos.find(p => p.id === item.id || p.name === item.name);
      if (!dish) {
        // Fallback: trust client price for items not in menu (custom items)
        validatedItems.push({ title: item.name, unit_price: String(item.price), quantity: item.qty });
        serverTotal += Number(item.price) * item.qty;
        continue;
      }
      const cp = calcularCostoPlatillo(dish, appData.ingredientes || []);
      const po = dish.portions || 1;
      const costoPorcion = po > 0 ? cp / po : 0;
      const computedPrice = margenGanancia > 0 ? costoPorcion / (1 - margenGanancia / 100) : costoPorcion;
      const displayPrice = dish.price || Math.round(computedPrice * 100) / 100;
      validatedItems.push({
        title: dish.name,
        unit_price: String(displayPrice),
        quantity: item.qty
      });
      serverTotal += displayPrice * item.qty;
    }

    // Add delivery fee
    const envio = configTienda.envio || 0;
    serverTotal += envio;

    // Accept client total if within 5% of server total (allows rounding)
    const clientTotal = Number(total);
    const diff = Math.abs(serverTotal - clientTotal);
    const finalTotal = (diff / serverTotal) <= 0.05 ? clientTotal : serverTotal;

    const orderPayload = {
      type: 'online',
      total_amount: String(finalTotal),
      external_reference: 'ORD_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      transactions: {
        payments: [{
          amount: String(finalTotal),
          payment_method: {
            id: paymentMethod.id,
            type: paymentMethod.type,
            ...(paymentMethod.token && { token: paymentMethod.token }),
            ...(paymentMethod.installments && { installments: paymentMethod.installments }),
            ...(paymentMethod.type === 'credit_card' && { statement_descriptor: 'CosteApp' })
          }
        }]
      },
      payer: {
        email: payer.email || 'cliente@restaurant.com',
        ...(payer.firstName && { first_name: payer.firstName }),
        ...(payer.lastName && { last_name: payer.lastName }),
        ...(payer.identification && { identification: payer.identification })
      },
      items: validatedItems
    };

    const wu = getWebhookUrl();
    const callbackUrl = wu ? wu + '/api/webhook' : '';
    if (callbackUrl) {
      orderPayload.config = { online: { callback_url: callbackUrl } };
    }

    const accessToken = getMpAccessToken();
    if (!accessToken) {
      return res.status(500).json({ error: 'Mercado Pago no configurado — configura el Access Token en el panel admin' });
    }

    const mpRes = await fetch(`${MP_API}/v1/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': crypto.randomUUID()
      },
      body: JSON.stringify(orderPayload)
    });

    const data = await mpRes.json();

    if (!mpRes.ok) {
      console.error('MP API error:', mpRes.status, JSON.stringify(data));
      return res.status(mpRes.status).json(data);
    }

    orders.set(data.id, {
      ...data,
      createdAt: new Date().toISOString(),
      external_reference: orderPayload.external_reference,
      items: validatedItems,
      serverValidated: true
    });

    if (paymentMethod.type === 'ticket' || paymentMethod.type === 'bank_transfer') {
      try {
        const paymentId = data.transactions?.payments?.[0]?.id;
        if (paymentId) {
          const payRes = await fetch(`${MP_API}/v1/payments/${paymentId}`, {
            headers: { 'Authorization': `Bearer ${getMpAccessToken()}` }
          });
          const payData = await payRes.json();
          data._paymentDetails = payData;
        }
      } catch (e) {
        console.warn('Could not fetch payment details:', e.message);
      }
    }

    res.json(data);
  } catch (err) {
    console.error('Error creating order:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Order Status ──────────────────────────────────────────
app.get('/api/order-status/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const mpRes = await fetch(`${MP_API}/v1/orders/${id}`, {
      headers: { 'Authorization': `Bearer ${getMpAccessToken()}` }
    });
    const data = await mpRes.json();
    if (!mpRes.ok) return res.status(mpRes.status).json(data);

    const paymentId = data.transactions?.payments?.[0]?.id;
    const paymentStatus = data.transactions?.payments?.[0]?.status;
    if (paymentId && (paymentStatus === 'pending' || paymentStatus === 'in_process')) {
      try {
        const payRes = await fetch(`${MP_API}/v1/payments/${paymentId}`, {
          headers: { 'Authorization': `Bearer ${getMpAccessToken()}` }
        });
        const payData = await payRes.json();
        data._paymentDetails = payData;
      } catch (e) {
        console.warn('Could not fetch payment details:', e.message);
      }
    }
    res.json(data);
  } catch (err) {
    console.error('Error getting order:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Webhook ───────────────────────────────────────────────
app.post('/api/webhook', (req, res) => {
  const { action, type, data } = req.body;
  console.log('Webhook received:', JSON.stringify({ action, type, data }));
  if (data?.id) {
    const orderId = data.id;
    const stored = orders.get(orderId);
    if (stored) orders.set(orderId, { ...stored, webhookReceived: true, webhookData: req.body });
  }
  res.status(200).json({ received: true });
});

// ─── API: Test Platform Connection ──────────────────────────────
app.post('/api/test-platform-connection', async (req, res) => {
  const { platformId, platformName, apiKey, apiSecret } = req.body;
  if (!apiKey && !apiSecret) return res.json({ ok: false, message: 'No hay credenciales configuradas' });

  const platformTests = {
    rappi: async () => {
      try {
        const testRes = await fetch('https://partner.rappi.com/api/v1/health', {
          headers: { 'Authorization': `Bearer ${apiKey || apiSecret}` }
        });
        return testRes.ok ? { ok: true, message: 'Conexión exitosa con Rappi API' } : { ok: false, message: `Rappi respondió con status ${testRes.status}` };
      } catch (e) { return { ok: false, message: 'No se pudo alcanzar Rappi API: ' + e.message }; }
    },
    uber: async () => {
      try {
        const testRes = await fetch('https://api.uber.com/v1/health', {
          headers: { 'Authorization': `Bearer ${apiKey || apiSecret}`, 'Content-Type': 'application/json' }
        });
        return testRes.ok ? { ok: true, message: 'Conexión exitosa con Uber Eats API' } : { ok: false, message: `Uber respondió con status ${testRes.status}` };
      } catch (e) { return { ok: false, message: 'No se pudo alcanzar Uber Eats API: ' + e.message }; }
    },
    didi: async () => {
      try {
        const testRes = await fetch('https://openapi.didiglobal.com/v1/health', {
          headers: { 'Authorization': `Bearer ${apiKey || apiSecret}` }
        });
        return testRes.ok ? { ok: true, message: 'Conexión exitosa con DiDi Food API' } : { ok: false, message: `DiDi respondió con status ${testRes.status}` };
      } catch (e) { return { ok: false, message: 'No se pudo alcanzar DiDi Food API: ' + e.message }; }
    }
  };

  const testFn = platformTests[platformId] || (async () => ({ ok: false, message: `Prueba no disponible para "${platformName}". Verifica manualmente.` }));
  res.json(await testFn());
});

// ─── API: Orders History ────────────────────────────────────────
app.get('/api/orders', (_req, res) => {
  const list = [];
  for (const [id, order] of orders) {
    list.push({
      id,
      status: order.status || 'unknown',
      total: order.total_amount,
      external_reference: order.external_reference,
      createdAt: order.createdAt,
      paymentType: order.transactions?.payments?.[0]?.payment_method?.type,
      items: order.items
    });
  }
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ ok: true, orders: list.slice(0, 100) });
});

// ─── API: Health ────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  const tk = getMpAccessToken();
  res.json({ status: 'ok', ordersCount: orders.size, mpConfigured: !!tk, webhookUrl: getWebhookUrl() || null });
});

app.listen(PORT, () => {
  const tk = getMpAccessToken();
  console.log(`CosteApp backend running on http://localhost:${PORT}`);
  console.log(`MP Access Token configured: ${tk ? '✅' : '❌'}`);
  console.log(`Webhook URL: ${getWebhookUrl() || '⚠️  not set'}`);
  console.log(`Uploads dir: ${UPLOADS_DIR}`);
});

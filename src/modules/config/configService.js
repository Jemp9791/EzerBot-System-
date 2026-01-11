const { GoogleSpreadsheet } = require('google-spreadsheet');

// ==============================
// CONFIGURACIÓN GOOGLE SHEETS
// ==============================
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = 'Config';

const doc = new GoogleSpreadsheet(SPREADSHEET_ID);

// Cache simple para no pedir a Sheets todo el tiempo
let cache = {};
let lastLoad = 0;
const CACHE_TTL = 60 * 1000; // 1 minuto

// ==============================
// AUTENTICACIÓN
// ==============================
async function auth() {
  await doc.useServiceAccountAuth({
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  });

  await doc.loadInfo();
}

// ==============================
// CARGAR CONFIG DESDE SHEETS
// ==============================
async function loadConfig() {
  const now = Date.now();

  if (now - lastLoad < CACHE_TTL && Object.keys(cache).length > 0) {
    return cache;
  }

  await auth();

  const sheet = doc.sheetsByTitle[SHEET_NAME];
  if (!sheet) {
    throw new Error(`Hoja "${SHEET_NAME}" no encontrada`);
  }

  const rows = await sheet.getRows();
  const data = {};

  rows.forEach(row => {
    const key = row.Clave || row.clave;
    const value = row.Valor || row.valor;

    if (key) {
      data[key.trim()] = value ? value.toString().trim() : '';
    }
  });

  cache = data;
  lastLoad = now;

  return cache;
}

// ==============================
// API PÚBLICA
// ==============================
async function getValue(key) {
  const config = await loadConfig();
  return config[key] || null;
}

async function getAll() {
  return await loadConfig();
}

// ==============================
// EXPORT
// ==============================
module.exports = {
  getValue,
  getAll,
};

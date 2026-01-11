const { GoogleSpreadsheet } = require('google-spreadsheet');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = 'Config';

const doc = new GoogleSpreadsheet(SPREADSHEET_ID);

let cache = {};
let lastLoad = 0;
const CACHE_TTL = 60 * 1000;

async function auth() {
  await doc.useServiceAccountAuth({
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  });
  await doc.loadInfo();
}

async function loadConfig() {
  const now = Date.now();
  if (now - lastLoad < CACHE_TTL && Object.keys(cache).length) return cache;

  await auth();
  const sheet = doc.sheetsByTitle[SHEET_NAME];
  if (!sheet) throw new Error('Hoja Config no encontrada');

  const rows = await sheet.getRows();
  const data = {};

  rows.forEach(r => {
    if (r.Clave) data[r.Clave.trim()] = (r.Valor || '').toString().trim();
  });

  cache = data;
  lastLoad = now;
  return data;
}

async function getValue(key) {
  const cfg = await loadConfig();
  return cfg[key] ?? null;
}

module.exports = { getValue };

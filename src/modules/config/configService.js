const { GoogleSpreadsheet } = require('google-spreadsheet');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = 'Config';

let cache = null;

async function loadConfig() {
  if (cache) return cache;

  const doc = new GoogleSpreadsheet(SHEET_ID);
  await doc.useServiceAccountAuth({
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  });

  await doc.loadInfo();

  const sheet = doc.sheetsByTitle[SHEET_NAME];
  if (!sheet) {
    throw new Error(`❌ Hoja "${SHEET_NAME}" no encontrada`);
  }

  const rows = await sheet.getRows();
  const config = {};

  rows.forEach(row => {
    if (!row.KEY) return;

    const key = String(row.KEY).trim();
    const value = row.VALUE ? String(row.VALUE).trim() : '';

    config[key] = value;
  });

  cache = config;
  return config;
}

async function get(key) {
  const config = await loadConfig();
  return config[key] || null;
}

module.exports = {
  get,
};

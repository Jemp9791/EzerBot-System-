const { GoogleSpreadsheet } = require('google-spreadsheet');

const doc = new GoogleSpreadsheet(process.env.SHEET_ID);

async function getValue(key) {
  try {
    await doc.useServiceAccountAuth({
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    });

    await doc.loadInfo();

    const sheet = doc.sheetsByTitle['Config'];
    const rows = await sheet.getRows();

    const row = rows.find(r => r.Clave === key);

    return row ? row.Valor : null;

  } catch (err) {
    console.error('❌ Error en ConfigService:', err.message);
    throw err;
  }
}

module.exports = {
  getValue
};

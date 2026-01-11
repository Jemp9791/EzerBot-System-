const { GoogleSpreadsheet } = require('google-spreadsheet');

class ConfigService {
  constructor() {
    this.doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);
  }

  async init() {
    if (this.initialized) return;

    await this.doc.useServiceAccountAuth({
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    });

    await this.doc.loadInfo();
    this.sheet = this.doc.sheetsByTitle['Config'];

    if (!this.sheet) {
      throw new Error('Hoja Config no encontrada');
    }

    this.initialized = true;
  }

  async getValue(key) {
    await this.init();

    const rows = await this.sheet.getRows();
    const row = rows.find(r => r.key === key);

    return row ? row.value : null;
  }
}

module.exports = ConfigService;

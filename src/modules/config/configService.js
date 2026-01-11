const { GoogleSpreadsheet } = require('google-spreadsheet');

class ConfigService {
  constructor() {
    if (ConfigService.instance) {
      return ConfigService.instance;
    }

    this.doc = null;
    this.sheet = null;

    ConfigService.instance = this;
  }

  async init() {
    if (this.sheet) return;

    try {
      const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

      if (!process.env.GOOGLE_SHEET_ID) {
        throw new Error('GOOGLE_SHEET_ID no definido');
      }

      if (!process.env.GOOGLE_CLIENT_EMAIL) {
        throw new Error('GOOGLE_CLIENT_EMAIL no definido');
      }

      if (!privateKey) {
        throw new Error('GOOGLE_PRIVATE_KEY no definido');
      }

      this.doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);

      await this.doc.useServiceAccountAuth({
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: privateKey,
      });

      await this.doc.loadInfo();

      // 🔴 ESTE NOMBRE TIENE QUE SER EXACTO
      this.sheet = this.doc.sheetsByTitle['Config'];

      if (!this.sheet) {
        throw new Error('Hoja "Config" no encontrada');
      }

    } catch (error) {
      console.error('❌ Error inicializando ConfigService:', error.message);
      throw error;
    }
  }

  async getValue(key) {
    await this.init();

    const rows = await this.sheet.getRows();

    const row = rows.find(
      r => String(r.Clave).trim() === String(key).trim()
    );

    if (!row) {
      return null;
    }

    return row.Valor ?? null;
  }
}

module.exports = new ConfigService();

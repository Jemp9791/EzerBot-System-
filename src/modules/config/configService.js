
const { google } = require('googleapis');

class ConfigService {
  constructor() {
    this.sheets = google.sheets({ version: 'v4' });
    this.spreadsheetId = process.env.SHEETS_ID;
    this.range = 'Config!A2:B'; // A = KEY, B = VALUE
  }

  async getConfig() {
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: this.range
    });

    const rows = response.data.values || [];

    const config = {};
    rows.forEach(([key, value]) => {
      config[key] = value;
    });

    return config;
  }

  async getValue(key) {
    const config = await this.getConfig();
    return config[key] || '';
  }
}

module.exports = ConfigService;
  

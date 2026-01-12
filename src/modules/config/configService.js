// configService.js
import { google } from 'googleapis';

export class ConfigService {
  constructor() {
    this.sheetId = process.env.GOOGLE_SHEET_ID;
    this.sheetName = 'Config';

    const auth = new google.auth.JWT(
      process.env.GOOGLE_CLIENT_EMAIL,
      null,
      process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      ['https://www.googleapis.com/auth/spreadsheets.readonly']
    );

    this.sheets = google.sheets({ version: 'v4', auth });
  }

  async getConfig() {
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.sheetId,
      range: `${this.sheetName}!A:B`,
    });

    const rows = res.data.values || [];
    const config = {};

    for (let i = 1; i < rows.length; i++) {
      const key = (rows[i][0] || '').toString().trim();
      const value = (rows[i][1] || '').toString().trim();
      if (key) config[key] = value;
    }

    return config;
  }

  async get(key) {
    const config = await this.getConfig();
    return config[key] || null;
  }
}

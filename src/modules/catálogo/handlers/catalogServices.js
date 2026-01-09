
const { google } = require('googleapis');

class CatalogService {
  constructor() {
    this.sheets = google.sheets({ version: 'v4' });
    this.spreadsheetId = process.env.SHEETS_ID;
    this.range = 'Catalogo!A2:J'; // A = CODIGO, J = STOCK
  }

  async getAllProducts() {
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: this.range
    });

    const rows = response.data.values || [];

    return rows.map(row => ({
      CODIGO: row[0] || '',
      NOMBRE: row[1] || '',
      PRECIO: row[2] || '',
      UNIDAD: row[3] || '',
      PRECIOPORKILO: row[4] || '',
      CODIGOBARRAS: row[5] || '',
      DESCRIPCION: row[6] || '',
      IMAGEN: row[7] || '',
      CATEGORIA: row[8] || '',
      STOCK: row[9] || ''
    }));
  }

  async getProductsByCategory(category) {
    const all = await this.getAllProducts();
    return all.filter(p => p.CATEGORIA.toLowerCase() === category.toLowerCase());
  }
}

module.exports = CatalogService;


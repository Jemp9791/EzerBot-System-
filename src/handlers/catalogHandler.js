const axios = require('axios');

class CatalogService {
  constructor() {
    this.url = process.env.CATALOGO_URL;

    if (!this.url) {
      throw new Error('❌ Falta CATALOGO_URL en variables de entorno');
    }
  }

  async getAllProducts() {
    try {
      const res = await axios.get(this.url, { timeout: 10000 });

      if (!Array.isArray(res.data)) {
        throw new Error('CATALOGO_URL no devuelve un array');
      }

      return res.data;
    } catch (err) {
      console.error('❌ Error obteniendo catálogo:', err.message);
      return [];
    }
  }

  async getProductsByCategory(categoria) {
    const productos = await this.getAllProducts();
    return productos.filter(
      p => String(p.CATEGORIA).toLowerCase() === String(categoria).toLowerCase()
    );
  }
}

module.exports = CatalogService;

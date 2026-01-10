
const axios = require('axios');
class CatalogService {
  constructor() {
    this.url = process.env.CATALOGO_URL;
  }

  async getAllProducts() {
    const res = await axios.get(this.url);
    return res.data;
  }

  async getProductsByCategory(categoria) {
    const productos = await this.getAllProducts();
    return productos.filter(p => p.CATEGORIA === categoria);
  }
}

module.exports = CatalogService;

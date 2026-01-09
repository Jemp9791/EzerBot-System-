
const axios = require('axios');

class ConfigService {
  constructor() {
    this.url = process.env.CONFIG_URL;
  }

  async getAll() {
    const res = await axios.get(this.url);
    return res.data;
  }

  async getValue(key) {
    const config = await this.getAll();
    const item = config.find(row => row.CLAVE === key);
    return item ? item.VALOR : null;
  }
}

module.exports = ConfigService;


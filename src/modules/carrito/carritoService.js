
const axios = require('axios');

class CarritoService {
  constructor() {
    this.url = process.env.CARRITOS_URL; 
    // Esta URL es igual que Config y Catálogo, pero apuntando a la hoja Carritos
  }

  // Obtener todos los ítems del carrito de un usuario
  async getCarrito(userId) {
    const res = await axios.get(this.url);
    const data = res.data;

    return data.filter(item => item.ID_TELEGRAM == userId);
  }

  // Agregar un producto al carrito
  async agregarProducto(userId, producto, cantidad, precioUnitario) {
    const subtotal = cantidad * precioUnitario;

    const payload = {
      ID_TELEGRAM: userId,
      PRODUCTO: producto,
      CANTIDAD: cantidad,
      PRECIO_UNITARIO: precioUnitario,
      SUBTOTAL: subtotal,
      FECHA: new Date().toISOString()
    };

    await axios.post(this.url, payload);
    return true;
  }

  // Quitar un producto del carrito (por nombre)
  async quitarProducto(userId, producto) {
    await axios.delete(`${this.url}?user=${userId}&producto=${encodeURIComponent(producto)}`);
    return true;
  }

  // Vaciar carrito completo
  async vaciarCarrito(userId) {
    await axios.delete(`${this.url}?user=${userId}`);
    return true;
  }

  // Calcular total del carrito
  async calcularTotal(userId) {
    const carrito = await this.getCarrito(userId);
    return carrito.reduce((acc, item) => acc + Number(item.SUBTOTAL), 0);
  }

  // Saber si el carrito tiene productos
  async tieneProductos(userId) {
    const carrito = await this.getCarrito(userId);
    return carrito.length > 0;
  }
}

module.exports = CarritoService;

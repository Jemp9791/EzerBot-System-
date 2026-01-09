
const axios = require('axios');
const ConfigService = require('../config/configService');
const ClientesService = require('../clientes/clientesService');

const configService = new ConfigService();
const clientesService = new ClientesService();

class ComprasService {
  constructor() {}

  async registrarCompra(userId, items, total, metodoPago, datosCliente) {
    const config = await configService.getConfig();

    const url = `${config.API_URL}?sheet=Compras`;

    const compra = {
      ClienteId: userId,
      Nombre: datosCliente.nombre,
      Telefono: datosCliente.telefono,
      Entrega: datosCliente.entrega,
      Direccion: datosCliente.direccion || '',
      Horario: datosCliente.horario || '',
      Nota: datosCliente.nota || '',
      MetodoPago: metodoPago,
      Total: total,
      Fecha: new Date().toISOString(),
      Productos: JSON.stringify(items)
    };

    // Registrar compra en Google Sheets
    await axios.post(url, compra);

    // Sumar sellos
    await this.sumarSellos(userId, total);

    // Validar referido
    await this.validarReferido(userId, total);

    return true;
  }

  async sumarSellos(userId, total) {
    const cliente = await clientesService.obtenerCliente(userId);
    if (!cliente) return;

    const sellosActuales = Number(cliente.Sellos) || 0;

    // 1 sello por cada $3000
    const nuevosSellos = Math.floor(total / 3000);

    const totalSellos = sellosActuales + nuevosSellos;

    await clientesService.actualizarCliente(userId, { Sellos: totalSellos });

    return totalSellos;
  }

  async validarReferido(userId, total) {
    const cliente = await clientesService.obtenerCliente(userId);
    if (!cliente) return;

    const referido = cliente.Referido;
    if (!referido) return;

    // 10% del total para el referido
    const puntos = Math.floor(total * 0.10);

    const clienteReferido = await clientesService.obtenerCliente(referido);
    if (!clienteReferido) return;

    const puntosActuales = Number(clienteReferido.Puntos) || 0;
    const nuevosPuntos = puntosActuales + puntos;

    await clientesService.actualizarCliente(referido, { Puntos: nuevosPuntos });

    return nuevosPuntos;
  }
}

module.exports = ComprasService;

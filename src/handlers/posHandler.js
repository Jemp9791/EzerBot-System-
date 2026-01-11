// src/handlers/posHandler.js

const posService = require("../modules/pos/posService");
const stockService = require("../modules/stock/stockService");
const ticketService = require("../modules/ticket/ticketService");
const userState = require("../modules/state/userStateService");
const config = require("../modules/config/configService");

async function confirmarVenta(phone, monto, medioPago, vendedor) {
  const state = userState.getState(phone);

  const negocio = await config.get("NegocioNombre");

  // 1️⃣ procesar venta
  const venta = await posService.procesarVenta({
    phone,
    monto,
    medioPago,
    referidoA: state.referredBy,
  });

  // 2️⃣ descontar stock
  await stockService.descontarStock(state.cart);

  // 3️⃣ generar ticket
  const ticket = await ticketService.generarTicket({
    negocio,
    items: state.cart,
    total: monto,
    medioPago,
    vendedor,
  });

  // 4️⃣ limpiar estado
  userState.clearCart(phone);
  userState.clearReferral(phone);
  userState.setStage(phone, "WELCOME");

  return {
    mensajeCliente: ticket,
    ticket,
  };
}

module.exports = {
  confirmarVenta,
}; 

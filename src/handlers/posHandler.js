// src/handlers/posHandler.js

const posService = require("../modules/pos/posService");
const userState = require("../modules/state/userStateService");
const metricsService = require("../modules/metrics/metricsService");

async function confirmarVenta(phone, monto, medioPago, vendedor) {
  const state = userState.getState(phone);

  const venta = await posService.procesarVenta({
    phone,
    monto,
    medioPago,
    referidoA: state.referredBy,
  });

  // 📊 registrar métricas
  await metricsService.registrarVentaMetrica({
    phone,
    monto,
    medioPago,
    sellosCompra: venta.sellosCompra,
    sellosReferido: venta.sellosReferido,
    referidoA: venta.referidoA,
    vendedor,
  });

  // 🔄 limpiar estado
  userState.clearReferral(phone);
  userState.setStage(phone, "WELCOME");

  let mensajeCliente =
    `🎉 *Pago confirmado* 🎉\n\n` +
    `💰 Monto: *$${monto}*\n` +
    `💳 Medio: *${medioPago}*\n`;

  if (venta.sellosCompra > 0) {
    mensajeCliente += `🏷️ Sumaste *${venta.sellosCompra} sellos* 🎁\n`;
  }

  mensajeCliente += `\n¡Gracias por tu compra! 🧀`;

  return mensajeCliente;
}

module.exports = {
  confirmarVenta,
};

// src/handlers/posHandler.js

const posService = require("../modules/pos/posService");
const userState = require("../modules/state/userStateService");

async function confirmarVenta(phone, monto, medioPago) {
  const state = userState.getState(phone);

  const venta = await posService.procesarVenta({
    phone,
    monto,
    medioPago,
    referidoA: state.referredBy,
  });

  // 🔄 limpiar estado
  userState.clearCart(phone);
  userState.clearReferral(phone);
  userState.setStage(phone, "WELCOME");

  // 🧾 mensaje al comprador
  let mensajeCliente =
    `🎉 *¡Pago confirmado!* 🎉\n\n` +
    `💳 Medio: *${medioPago}*\n` +
    `💰 Monto: *$${monto}*\n`;

  if (venta.sellosCompra > 0) {
    mensajeCliente += `🏷️ Sumaste *${venta.sellosCompra} sellos* por tu compra 🎁\n`;
  }

  mensajeCliente += `\n¡Gracias por elegirnos! 🧀`;

  // 🧾 mensaje al referidor (si existe)
  let mensajeReferidor = null;
  if (venta.sellosReferido && venta.referidoA) {
    mensajeReferidor =
      `🎁 *¡Buenas noticias!* 🎉\n\n` +
      `Un cliente compró desde tu link y sumaste *1 sello* 🙌\n` +
      `¡Gracias por recomendarnos! 🧀`;
  }

  return {
    venta,
    mensajeCliente,
    mensajeReferidor,
  };
}

module.exports = {
  confirmarVenta,
};

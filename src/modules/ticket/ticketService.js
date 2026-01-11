// src/modules/ticket/ticketService.js

const config = require("../config/configService");

function formatMoney(value) {
  return `$${Number(value).toLocaleString("es-AR")}`;
}

async function generarTicket({ negocio, items, total, medioPago, vendedor }) {
  const fecha = new Date().toLocaleString("es-AR");

  let ticket = "";
  ticket += `🧾 *${negocio}*\n`;
  ticket += `📅 ${fecha}\n`;
  ticket += `👤 Vendedor: ${vendedor}\n`;
  ticket += `💳 Pago: ${medioPago}\n`;
  ticket += `────────────────\n`;

  items.forEach(i => {
    ticket += `${i.nombre}\n`;
    ticket += `${i.cantidad} ${i.unidad} x ${formatMoney(i.precio)}\n`;
  });

  ticket += `────────────────\n`;
  ticket += `💰 *TOTAL: ${formatMoney(total)}*\n\n`;
  ticket += `Gracias por tu compra 🙌`;

  return ticket;
}

module.exports = {
  generarTicket,
};

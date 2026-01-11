// src/handlers/superSellerHandler.js

const superSeller = require("../modules/sales/superSellerService");

async function intervenirDespuesProducto(phone, categoria) {
  const complemento = await superSeller.sugerirComplemento(categoria);
  const combo = await superSeller.sugerirCombo(categoria);
  const beneficio = await superSeller.mensajeBeneficio();

  let mensajes = [];

  if (complemento) {
    mensajes.push({
      to: phone,
      type: "text",
      text: {
        body:
          `👀 *Dato rápido*:\n` +
          `Esto suele combinarse muy bien con *${complemento}* 😉`,
      },
    });
  }

  if (combo) {
    mensajes.push({
      to: phone,
      type: "text",
      text: {
        body:
          `🔥 *Tip del día*:\n` +
          `Tenemos un combo armado que te hace ahorrar 👌\n` +
          `Si querés, te lo muestro.`,
      },
    });
  }

  if (beneficio) {
    mensajes.push({
      to: phone,
      type: "text",
      text: {
        body: `🏷️ ${beneficio}`,
      },
    });
  }

  return mensajes;
}

module.exports = {
  intervenirDespuesProducto,
};

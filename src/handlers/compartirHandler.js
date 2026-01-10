// src/handlers/compartirHandler.js

const referralService = require("../modules/referrals/referralService");
const config = require("../modules/config/configService");

async function compartirCatalogo(phone) {
  const link = await referralService.generarLinkReferido(phone);
  const gif = await config.get("GifCompartirCatalogo");

  return {
    to: phone,
    type: "image",
    image: {
      link: gif,
      caption:
        `📣 *Compartí el catálogo y ganá sellos* 🏷️\n\n` +
        `Si alguien compra desde tu link, sumás un sello 🙌\n\n` +
        `👉 ${link}`,
    },
  };
}

async function compartirSistema(phone) {
  const link = await referralService.generarLinkReferido(phone);
  const gif = await config.get("GifCompartirSistema");

  return {
    to: phone,
    type: "image",
    image: {
      link: gif,
      caption:
        `🤖 *Mirá este sistema increíble* ✨\n\n` +
        `Te atiende solo, te muestra productos y encima te da premios 🎁\n\n` +
        `👉 ${link}`,
    },
  };
}

module.exports = {
  compartirCatalogo,
  compartirSistema,
};

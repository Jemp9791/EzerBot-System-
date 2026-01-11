// src/modules/referrals/referralService.js

const config = require("../config/configService");

async function generarLinkReferido(phone) {
  // Base del bot desde Config
  const baseUrl = await config.get("UrlBot");

  // Fallback por si no está configurado
  if (!baseUrl) {
    return "https://wa.me/549XXXXXXXXX";
  }

  return `${baseUrl}?ref=${phone}`;
}

module.exports = {
  generarLinkReferido,
};

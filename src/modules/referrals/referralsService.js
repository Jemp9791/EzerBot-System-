// src/modules/referrals/referralService.js

const config = require("../config/configService");

async function generarLinkReferido(phone) {
  const baseUrl = await config.get("UrlBot"); 
  // ej: https://wa.me/54911XXXXXXX

  return `${baseUrl}?ref=${phone}`;
}

module.exports = {
  generarLinkReferido,
};

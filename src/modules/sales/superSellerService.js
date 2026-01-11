// src/modules/sales/superSellerService.js

const config = require("../config/configService");

async function sugerirComplemento(categoria) {
  const reglas = await config.list("ReglasUpsell");
  /**
   * Ejemplo Config:
   * ReglasUpsell →
   * QUESOS:VINOS
   * FIAMBRES:PAN
   */

  const regla = reglas.find(r => r.startsWith(categoria + ":"));
  if (!regla) return null;

  return regla.split(":")[1];
}

async function sugerirCombo(categoria) {
  const combosActivos = await config.isEnabled("CombosActivos");
  if (!combosActivos) return null;

  return `COMBO_${categoria}`;
}

async function mensajeBeneficio() {
  const texto = await config.text("TextoBeneficioSellos");
  return texto || null;
}

module.exports = {
  sugerirComplemento,
  sugerirCombo,
  mensajeBeneficio,
};

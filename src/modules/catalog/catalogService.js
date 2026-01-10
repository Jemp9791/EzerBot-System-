// src/modules/catalog/catalogService.js

async function obtenerCategorias() {
  /**
   * Acá va la lectura REAL de la hoja "Catalogo"
   * Estructura esperada (ejemplo):
   * Categoria | Producto | Precio | Activo
   */

  // MOCK / PLACEHOLDER hasta conectar Sheets
  return [
    "Quesos",
    "Fiambres",
    "Picadas",
    "Promociones",
  ];
}

module.exports = {
  obtenerCategorias,
};

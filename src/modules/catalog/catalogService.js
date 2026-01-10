// src/modules/catalog/catalogService.js

async function obtenerCategorias() {
  /**
   * Hoja: Catalogo
   * Columnas ejemplo:
   * Categoria | Producto | Precio | Imagen | Activo
   */

  // 🔁 Placeholder hasta Sheets real
  return [
    {
      id: "QUESOS",
      nombre: "Quesos",
      imagen: "https://...",
    },
    {
      id: "FIAMBRES",
      nombre: "Fiambres",
      imagen: "https://...",
    },
    {
      id: "PICADAS",
      nombre: "Picadas",
      imagen: "https://...",
    },
  ];
}

async function obtenerProductosPorCategoria(categoriaId) {
  return [
    {
      id: "P001",
      nombre: "Queso Tybo",
      precio: 3500,
      imagen: "https://...",
    },
    {
      id: "P002",
      nombre: "Queso Pategrás",
      precio: 4200,
      imagen: "https://...",
    },
  ];
}

module.exports = {
  obtenerCategorias,
  obtenerProductosPorCategoria,
};

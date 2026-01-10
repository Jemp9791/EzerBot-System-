// src/handlers/catalogHandler.js

const catalogService = require("../modules/catalog/catalogService");

async function mostrarCategorias(phone) {
  const categorias = await catalogService.obtenerCategorias();

  return {
    to: phone,
    type: "interactive",
    interactive: {
      type: "list",
      header: {
        type: "text",
        text: "🧀 Nuestro catálogo",
      },
      body: {
        text: "Elegí una categoría para ojeár los productos 👇",
      },
      action: {
        button: "Ver categorías",
        sections: [
          {
            title: "Categorías",
            rows: categorias.map(cat => ({
              id: `CAT_${cat.id}`,
              title: cat.nombre,
            })),
          },
        ],
      },
    },
  };
}

module.exports = {
  mostrarCategorias,
};

// src/handlers/productHandler.js

const catalogService = require("../modules/catalog/catalogService");

async function mostrarProductos(phone, categoriaId) {
  const productos = await catalogService.obtenerProductosPorCategoria(
    categoriaId
  );

  return {
    to: phone,
    type: "interactive",
    interactive: {
      type: "list",
      header: {
        type: "text",
        text: "🧀 Productos",
      },
      body: {
        text: "Ojeá los productos disponibles 👇",
      },
      action: {
        button: "Ver productos",
        sections: [
          {
            title: "Productos",
            rows: productos.map(p => ({
              id: `PROD_${p.id}`,
              title: `${p.nombre}`,
              description: `$${p.precio}`,
            })),
          },
        ],
      },
    },
  };
}

module.exports = {
  mostrarProductos,
};

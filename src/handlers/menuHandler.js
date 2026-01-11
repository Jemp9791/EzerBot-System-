// src/handlers/menuHandler.js

async function mostrarMenu(phone) {
  return {
    to: phone,
    type: "interactive",
    interactive: {
      type: "list",
      header: {
        type: "text",
        text: "📋 ¿Cómo seguimos?",
      },
      body: {
        text: "Elegí una opción 👇",
      },
      action: {
        button: "Opciones",
        sections: [
          {
            title: "Menú",
            rows: [
              { id: "MENU_SEGUIR", title: "➕ Seguir comprando" },
              { id: "MENU_CARRITO", title: "🛒 Ver carrito" },
              { id: "MENU_PAGAR", title: "💳 Ir al pago" },
              { id: "MENU_COMPARTIR", title: "📣 Compartir catálogo" },
            ],
          },
        ],
      },
    },
  };
}

module.exports = {
  mostrarMenu,
};

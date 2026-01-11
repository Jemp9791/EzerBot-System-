// src/bot.js

const userState = require("./modules/state/userStateService");

// Handlers
const startHandler = require("./handlers/startHandler");
const catalogHandler = require("./handlers/catalogHandler");
const productHandler = require("./handlers/productHandler");
const menuHandler = require("./handlers/menuHandler");
const compartirHandler = require("./handlers/compartirHandler");

async function handleMessage(payload) {
  const phone =
    payload.from ||
    payload.phone ||
    payload?.contacts?.[0]?.wa_id;

  if (!phone) return null;

  const state = userState.getState(phone);

  // TEXTO INICIAL
  if (payload.type === "text" && state.stage === "WELCOME") {
    userState.setStage(phone, "CATALOG");
    return startHandler.showWelcome(phone);
  }

  // INTERACTIVOS (CARRUSEL)
  if (payload.type === "interactive") {
    const id =
      payload.interactive?.list_reply?.id ||
      payload.interactive?.button_reply?.id;

    // CATEGORÍAS
    if (id?.startsWith("CAT_")) {
      const categoriaId = id.replace("CAT_", "");
      userState.setStage(phone, "PRODUCTS");
      return productHandler.mostrarProductos(phone, categoriaId);
    }

    // PRODUCTOS
    if (id?.startsWith("PROD_")) {
      // acá luego sumás al carrito
      return menuHandler.mostrarMenu(phone);
    }

    // MENÚ
    if (id === "MENU_COMPARTIR") {
      return compartirHandler.compartirCatalogo(phone);
    }

    if (id === "MENU_SEGUIR") {
      return catalogHandler.mostrarCategorias(phone);
    }
  }

  // ENTRADA A CATÁLOGO
  if (state.stage === "CATALOG") {
    return catalogHandler.mostrarCategorias(phone);
  }

  return null;
}

module.exports = {
  handleMessage,
};

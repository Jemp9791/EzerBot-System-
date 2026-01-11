// src/bot.js

const userState = require("./modules/state/userStateService");
const roleService = require("./modules/roles/roleService");

// Handlers
const startHandler = require("./handlers/startHandler");
const catalogHandler = require("./handlers/catalogHandler");
const productHandler = require("./handlers/productHandler");
const menuHandler = require("./handlers/menuHandler");
const compartirHandler = require("./handlers/compartirHandler");
const posHandler = require("./handlers/posHandler");
const superSellerHandler = require("./handlers/superSellerHandler");

async function handleMessage(payload) {
  const phone =
    payload.from ||
    payload.phone ||
    payload?.contacts?.[0]?.wa_id;

  if (!phone) return null;

  const role = await roleService.getRole(phone);
  const state = userState.getState(phone);

  // =============================
  // VENDEDOR / ADMIN
  // =============================
  if (payload.type === "text" && role !== "CLIENTE") {
    const text = payload.text.body.toLowerCase();

    if (text.startsWith("confirmar pago")) {
      // ejemplo: confirmar pago 15000 efectivo
      const parts = text.split(" ");
      const monto = Number(parts.find(p => !isNaN(p)));
      const medioPago = text.includes("transfer")
        ? "Transferencia"
        : "Efectivo";

      const mensaje = await posHandler.confirmarVenta(
        phone,
        monto,
        medioPago,
        phone // vendedor
      );

      return {
        to: phone,
        type: "text",
        text: { body: mensaje },
      };
    }

    return {
      to: phone,
      type: "text",
      text: {
        body: "👋 Modo vendedor.\nUsá: *confirmar pago monto medio*",
      },
    };
  }

  // =============================
  // CLIENTE
  // =============================
  if (payload.type === "text" && state.stage === "WELCOME") {
    userState.setStage(phone, "CATALOG");
    return startHandler.showWelcome(phone);
  }

  if (payload.type === "interactive") {
    const id =
      payload.interactive?.list_reply?.id ||
      payload.interactive?.button_reply?.id;

    if (id?.startsWith("CAT_")) {
      const cat = id.replace("CAT_", "");
      state.lastCategory = cat;
      userState.setStage(phone, "PRODUCTS");
      return productHandler.mostrarProductos(phone, cat);
    }

    if (id?.startsWith("PROD_")) {
      const mensajes = await superSellerHandler.intervenirDespuesProducto(
        phone,
        state.lastCategory
      );
      return [...mensajes, await menuHandler.mostrarMenu(phone)];
    }

    if (id === "MENU_SEGUIR") {
      return catalogHandler.mostrarCategorias(phone);
    }

    if (id === "MENU_COMPARTIR") {
      return compartirHandler.compartirCatalogo(phone);
    }
  }

  if (state.stage === "CATALOG") {
    return catalogHandler.mostrarCategorias(phone);
  }

  return null;
}

module.exports = {
  handleMessage,
};

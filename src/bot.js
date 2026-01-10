// src/bot.js

const config = require("./modules/config/configService");
const userState = require("./modules/state/userStateService");
const actionRouter = require("./modules/actions/actionRouter");

// Handlers
const startHandler = require("./handlers/startHandler");
const catalogHandler = require("./handlers/catalogHandler");
const carritoHandler = require("./handlers/carritoHandler");
const checkoutHandler = require("./handlers/checkoutHandler");
const compartirHandler = require("./handlers/compartirHandler");
const posHandler = require("./handlers/posHandler");

async function handleMessage(payload) {
  const phone =
    payload.from ||
    payload.phone ||
    payload?.contacts?.[0]?.wa_id;

  if (!phone) return null;

  // 🆕 REFERIDO POR LINK
  if (payload.text?.body?.includes("?ref=")) {
    const ref = payload.text.body.split("?ref=")[1];
    if (ref && ref !== phone) {
      userState.setReferredBy(phone, ref);
    }
  }

  const state = userState.getState(phone);

  // =============================
  // TEXTO
  // =============================
  if (payload.type === "text") {
    const text = payload.text.body.toLowerCase();

    if (text.includes("compartir")) {
      return compartirHandler.compartirCatalogo(phone);
    }

    if (text.startsWith("confirmar pago")) {
      const parts = text.split(" ");
      const monto = Number(parts.find(p => !isNaN(p)));
      const medioPago = text.includes("transfer")
        ? "Transferencia"
        : "Efectivo";

      return posHandler.confirmarVenta(phone, monto, medioPago);
    }

    if (state.stage === "WELCOME") {
      userState.setStage(phone, "CATALOG");
      return startHandler.showWelcome(phone);
    }

    if (state.stage === "CATALOG") {
      return catalogHandler.show(phone);
    }
  }

  // =============================
  // INTERACTIVOS
  // =============================
  if (payload.type === "interactive") {
    const buttonId =
      payload.interactive?.button_reply?.id ||
      payload.interactive?.list_reply?.id;

    if (!buttonId) return null;

    const action = await config.get(buttonId);
    const result = actionRouter.execute(action, phone);

    if (result === "CATALOG") return catalogHandler.show(phone);
    if (result === "CART") return carritoHandler.show(phone);
    if (result === "PAYMENT") return checkoutHandler.show(phone);
  }

  return null;
}

module.exports = {
  handleMessage,
};

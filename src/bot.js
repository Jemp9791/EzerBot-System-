// src/bot.js

const config = require("./modules/config/configService");
const userState = require("./modules/state/userStateService");
const actionRouter = require("./modules/actions/actionRouter");

// Handlers
const startHandler = require("./handlers/startHandler");
const catalogHandler = require("./handlers/catalogHandler");
const carritoHandler = require("./handlers/carritoHandler");
const checkoutHandler = require("./handlers/checkoutHandler");
const posHandler = require("./handlers/posHandler");

async function handleMessage(payload) {
  const phone =
    payload.from ||
    payload.phone ||
    payload?.contacts?.[0]?.wa_id;

  if (!phone) return null;

  // 🆕 detectar referido (ej: ?ref=54911...)
  if (payload.referral?.referrer_id) {
    userState.setReferredBy(phone, payload.referral.referrer_id);
  }

  const state = userState.getState(phone);

  // =============================
  // TEXTO
  // =============================
  if (payload.type === "text") {
    const text = payload.text?.body?.toLowerCase() || "";

    // 👨‍💼 CONFIRMACIÓN VENDEDOR
    if (text.startsWith("confirmar pago")) {
      const parts = text.split(" ");
      const monto = Number(parts.find(p => !isNaN(p)));
      const medioPago = text.includes("transfer")
        ? "Transferencia"
        : "Efectivo";

      const { mensajeCliente, mensajeReferidor } =
        await posHandler.confirmarVenta(phone, monto, medioPago);

      return {
        to: phone,
        type: "text",
        text: { body: mensajeCliente },
        extra: mensajeReferidor
          ? { to: state.referredBy, text: mensajeReferidor }
          : null,
      };
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

// src/bot.js

const config = require("./modules/config/configService");
const userState = require("./modules/state/userStateService");
const actionRouter = require("./modules/actions/actionRouter");

// Handlers
const startHandler = require("./handlers/startHandler");
const catalogHandler = require("./handlers/catalogHandler");
const carritoHandler = require("./handlers/carritoHandler");
const checkoutHandler = require("./handlers/checkoutHandler");

async function handleMessage(payload) {
  const phone =
    payload.from ||
    payload.phone ||
    payload?.contacts?.[0]?.wa_id;

  if (!phone) return null;

  const state = userState.getState(phone);

  // =============================
  // TEXTO
  // =============================
  if (payload.type === "text") {
    if (state.stage === "WELCOME") {
      userState.setStage(phone, "CATALOG");
      return startHandler.showWelcome(phone);
    }

    if (state.stage === "CATALOG") {
      return catalogHandler.show(phone);
    }
  }

  // =============================
  // BOTONES
  // =============================
  if (payload.type === "interactive") {
    const buttonId =
      payload.interactive?.button_reply?.id ||
      payload.interactive?.list_reply?.id;

    if (!buttonId) return null;

    const action = await config.get(buttonId);
    const result = actionRouter.execute(action, phone);

    if (result === "CATALOG") {
      return catalogHandler.show(phone);
    }

    if (result === "CART") {
      return carritoHandler.show(phone);
    }

    if (result === "PAYMENT") {
      return checkoutHandler.show(phone);
    }

    if (result === "CONFIRM_PAYMENT") {
      userState.setStage(phone, "CONFIRMATION");
      return checkoutHandler.confirm(phone);
    }
  }

  return null;
}

module.exports = {
  handleMessage,
};

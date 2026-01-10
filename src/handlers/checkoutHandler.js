// src/handlers/checkoutHandler.js

const userState = require("../modules/state/userStateService");
const copy = require("../modules/copy/copyService");

async function show(phone) {
  const text = await copy.paymentOptions();

  return {
    to: phone,
    type: "text",
    text: {
      body: text,
    },
  };
}

async function confirm(phone) {
  const state = userState.getState(phone);
  const text = await copy.confirmPayment(state.paymentMethod || "—");

  return {
    to: phone,
    type: "text",
    text: {
      body: text,
    },
  };
}

module.exports = {
  show,
  confirm,
};

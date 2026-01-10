// src/handlers/carritoHandler.js

const userState = require("../modules/state/userStateService");
const copy = require("../modules/copy/copyService");

async function show(phone) {
  const state = userState.getState(phone);
  const text = await copy.showCart(state.cart);

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
};

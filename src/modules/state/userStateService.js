// src/modules/state/userStateService.js

const states = {};

function getDefaultState(phone) {
  return {
    phone,
    stage: "WELCOME",
    cart: [],
    paymentMethod: null,
    lastInteraction: Date.now(),
  };
}

function getState(phone) {
  if (!states[phone]) {
    states[phone] = getDefaultState(phone);
  }
  return states[phone];
}

function setStage(phone, stage) {
  const state = getState(phone);
  state.stage = stage;
  state.lastInteraction = Date.now();
}

function addToCart(phone, item) {
  const state = getState(phone);
  state.cart.push(item);
  state.lastInteraction = Date.now();
}

function clearCart(phone) {
  const state = getState(phone);
  state.cart = [];
}

function setPaymentMethod(phone, method) {
  const state = getState(phone);
  state.paymentMethod = method;
}

module.exports = {
  getState,
  setStage,
  addToCart,
  clearCart,
  setPaymentMethod,
};

// src/modules/state/userStateService.js

const states = {};

function getDefaultState(phone) {
  return {
    phone,
    stage: "WELCOME",
    cart: [],
    paymentMethod: null,

    // 🆕 REFERIDOS
    referredBy: null, // phone del que compartió

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
  state.lastInteraction = Date.now();
}

function setPaymentMethod(phone, method) {
  const state = getState(phone);
  state.paymentMethod = method;
  state.lastInteraction = Date.now();
}

// 🆕 REFERIDOS
function setReferredBy(phone, referrerPhone) {
  const state = getState(phone);
  state.referredBy = referrerPhone;
}

function clearReferral(phone) {
  const state = getState(phone);
  state.referredBy = null;
}

module.exports = {
  getState,
  setStage,
  addToCart,
  clearCart,
  setPaymentMethod,
  setReferredBy,
  clearReferral,
};

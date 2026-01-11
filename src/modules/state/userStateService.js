// src/modules/state/userStateService.js

const states = {};

function getDefaultState(phone) {
  return {
    phone,
    role: "CLIENTE",
    stage: "WELCOME",
    cart: [],
    paymentMethod: null,
    referredBy: null,
    lastCategory: null,
    lastInteraction: Date.now(),
  };
}

function getState(phone) {
  if (!states[phone]) {
    states[phone] = getDefaultState(phone);
  }
  return states[phone];
}

function setRole(phone, role) {
  const state = getState(phone);
  state.role = role;
}

function setStage(phone, stage) {
  const state = getState(phone);
  state.stage = stage;
  state.lastInteraction = Date.now();
}

function setReferredBy(phone, ref) {
  const state = getState(phone);
  state.referredBy = ref;
}

function clearReferral(phone) {
  const state = getState(phone);
  state.referredBy = null;
}

module.exports = {
  getState,
  setRole,
  setStage,
  setReferredBy,
  clearReferral,
};

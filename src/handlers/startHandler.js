// src/handlers/startHandler.js

const copy = require("../modules/copy/copyService");

async function showWelcome(phone) {
  const text = await copy.welcome();

  return {
    to: phone,
    type: "text",
    text: {
      body: text,
    },
  };
}

module.exports = {
  showWelcome,
};

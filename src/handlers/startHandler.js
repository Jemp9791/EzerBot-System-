// src/handlers/startHandler.js


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

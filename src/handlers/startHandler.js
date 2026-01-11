// src/handlers/startHandler.js

const config = require('../modules/config/configService');

async function showWelcome(ctx) {
  const text = await config.getValue('TextoBienvenida');

  await ctx.reply(text || '¡Bienvenido! 👋');
}

module.exports = {
  showWelcome,
};

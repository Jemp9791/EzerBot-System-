// src/handlers/startHandler.js

const config = require('../modules/config/configService');

async function showWelcome(ctx) {
  const text = await config.get('TextoBienvenida');

  await ctx.reply(text || '¡Bienvenida! 👋');
}

module.exports = {
  showWelcome,
};

// src/handlers/startHandler.js

const ConfigService = require('../modules/config/configService');
const config = new ConfigService();

async function showWelcome(ctx) {
  const text = await config.getValue('TextoBienvenida');

  await ctx.reply(text || '¡Bienvenido! 👋');
}

module.exports = {
  showWelcome,
};

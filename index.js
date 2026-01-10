const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();
// Handlers
const catalogHandler = require('./src/handlers/catalogHandler.js');
const carritoHandler = require('./src/handlers/carritoHandler.js');
const checkoutHandler = require('./src/handlers/checkoutHandler.js');
const adminConfirmHandler = require('./src/handlers/adminConfirmHandler.js');

const token = process.env.TelegramBotToken;
const bot = new TelegramBot(token, { polling: true });

// 🔴 Captura errores de polling
bot.on('polling_error', (error) => {
  console.error('Polling error:', error.code, error.message);
});

// Comando /start
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, '¡Bienvenido a EZERBOT!', {
    reply_markup: {
      keyboard: [['Menú']],
      resize_keyboard: true
    }
  });
});

// Comando /catalogo
bot.onText(/\/catalogo/, (msg) => {
  catalogHandler(bot, msg);
});

// Comando /carrito
bot.onText(/\/carrito/, (msg) => {
  carritoHandler(bot, msg);
});

// Comando /checkout
bot.onText(/\/checkout/, (msg) => {
  checkoutHandler(bot, msg);
});

// Mensajes del vendedor
bot.on('message', (msg) => {
  adminConfirmHandler(bot, msg);
});

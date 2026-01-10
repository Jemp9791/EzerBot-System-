const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

// Handlers (nombres EXACTOS según tu repo)
const catalogHandler = require('./src/handlers/catalogHandler.js');
const carritoHandler = require('./src/handlers/carritoHandler.js');
const checkoutHandler = require('./src/handlers/checkoutHandler.js');
const adminConfirmHandler = require('./src/handlers/adminConfirmHandler.js'); // así está en tu repo

const token = process.env.TelegramBotToken;

// Bot en modo polling (necesario para Web Service)
const bot = new TelegramBot(token, { polling: true });

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

// Mensajes del vendedor (confirmar/rechazar)
bot.on('message', (msg) => {
  adminConfirmHandler(bot, msg);
});

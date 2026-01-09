const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

const catalogHandlers = require('./src/handlers/catalogHandlers.js');
const carritoHandler = require('./src/handlers/carritoHandlerjs');
const checkoutHandler = require('./src/handlers/checkoutHandlerjs');
const adminConfirmHandler = require('./src/handlers/adminConfirmHandlerjs');

const token = process.env.TelegramBotToken;
const bot = new TelegramBot(token, { polling: true });

// Comandos
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, '¡Bienvenido a EZERBOT!', {
    reply_markup: {
      keyboard: [['Menú']],
      resize_keyboard: true
    }
  });
});

bot.onText(/\/catalogo/, (msg) => catalogHandlers(bot, msg));
bot.onText(/\/carrito/, (msg) => carritoHandler(bot, msg));
bot.onText(/\/checkout/, (msg) => checkoutHandler(bot, msg));

// Mensajes del vendedor (Confirmar/Rechazar)
bot.on('message', (msg) => adminConfirmHandler(bot, msg));

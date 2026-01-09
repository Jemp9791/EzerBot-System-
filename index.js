const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

const catalogoHandler = require('./src/handlers/catalogoHandler');
const carritoHandler = require('./src/handlers/carritoHandler');
const checkoutHandler = require('./src/handlers/checkoutHandler');
const adminConfirmHandler = require('./src/handlers/adminConfirmHandler');

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

bot.onText(/\/catalogo/, (msg) => catalogoHandler(bot, msg));
bot.onText(/\/carrito/, (msg) => carritoHandler(bot, msg));
bot.onText(/\/checkout/, (msg) => checkoutHandler(bot, msg));

// Mensajes del vendedor (Confirmar/Rechazar)
bot.on('message', (msg) => adminConfirmHandler(bot, msg));

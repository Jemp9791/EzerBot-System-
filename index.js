const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

const token = process.env.TelegramBotToken;
if (!token) {
  console.error('❌ Falta TelegramBotToken');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

// ================= HANDLERS =================
const startHandler = require('./src/handlers/startHandler');
const helpHandler = require('./src/handlers/helpHandler');
const catalogHandler = require('./src/handlers/catalogHandler');
const categoriesHandler = require('./src/handlers/categoriesHandler');
const categoryCarouselHandler = require('./src/handlers/categoryCarouselHandler');
const quieroEsteHandler = require('./src/handlers/quieroEsteHandler');
const carritoHandler = require('./src/handlers/carritoHandler');
const checkoutHandler = require('./src/handlers/checkoutHandler');
const ticketHandler = require('./src/handlers/ticketHandler');
const compartirHandler = require('./src/handlers/compartirHandler');
const navigationHandler = require('./src/handlers/navigationHandler');
const adminConfirmHandler = require('./src/handlers/adminConfirmHandler');

// ================= ERRORES =================
bot.on('polling_error', err => {
  console.error('❌ Polling error:', err.message);
});

// ================= COMANDOS =================
bot.onText(/\/start/i, msg => startHandler(bot, msg));
bot.onText(/\/help/i, msg => helpHandler(bot, msg));
bot.onText(/📦 Catálogo|\/catalogo/i, msg => catalogHandler(bot, msg));
bot.onText(/🛒 Carrito|\/carrito/i, msg => carritoHandler(bot, msg));
bot.onText(/✅ Checkout|\/checkout/i, msg => checkoutHandler(bot, msg));

// ================= CALLBACKS =================
bot.on('callback_query', query => {
  if (!query.data) return;

  if (query.data.startsWith('categoria_')) {
    categoriesHandler(bot, query);
  } else if (query.data.startsWith('producto_')) {
    categoryCarouselHandler(bot, query);
  } else if (query.data.startsWith('quiero_')) {
    quieroEsteHandler(bot, query);
  } else if (query.data.startsWith('nav_')) {
    navigationHandler(bot, query);
  }
});

// ================= MENSAJES =================
bot.on('message', msg => {
  adminConfirmHandler(bot, msg);
});

console.log('✅ EZERBOT iniciado y escuchando'); 

const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

// 🔐 Token
const token = process.env.TelegramBotToken;

if (!token) {
  console.error('❌ Falta TelegramBotToken en variables de entorno');
  process.exit(1);
}

// 🤖 Bot
const bot = new TelegramBot(token, { polling: true });

// 🔹 Handlers
const catalogHandler = require('./src/handlers/catalogHandler');
const carritoHandler = require('./src/handlers/carritoHandler');
const checkoutHandler = require('./src/handlers/checkoutHandler');
const adminConfirmHandler = require('./src/handlers/adminConfirmHandler');

// =======================
// ERRORES DE POLLING
// =======================
bot.on('polling_error', (err) => {
  console.error('❌ Polling error:', err.code, err.message);
});

// =======================
// START
// =======================
bot.onText(/\/start/i, (msg) => {
  bot.sendMessage(msg.chat.id, '👋 Bienvenida a EZERBOT', {
    reply_markup: {
      keyboard: [
        ['📦 Catálogo'],
        ['🛒 Carrito'],
        ['✅ Checkout']
      ],
      resize_keyboard: true
    }
  });
});

// =======================
// CATÁLOGO
// =======================
bot.onText(/📦 Catálogo|\/catalogo/i, (msg) => {
  catalogHandler(bot, msg);
});

// =======================
// CARRITO
// =======================
bot.onText(/🛒 Carrito|\/carrito/i, (msg) => {
  carritoHandler(bot, msg);
});

// =======================
// CHECKOUT
// =======================
bot.onText(/✅ Checkout|\/checkout/i, (msg) => {
  checkoutHandler(bot, msg);
});

// =======================
// MENSAJES ADMIN / CONFIRMACIONES
// =======================
bot.on('message', (msg) => {
  adminConfirmHandler(bot, msg);
});

console.log('✅ EZERBOT iniciado correctamente'); 

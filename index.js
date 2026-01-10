const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

// Handlers
const catalogHandler = require('./src/handlers/catalogHandler');
const carritoHandler = require('./src/handlers/carritoHandler');
const checkoutHandler = require('./src/handlers/checkoutHandler');
const adminConfirmHandler = require('./src/handlers/adminConfirmHandler');

const token = process.env.TelegramBotToken;

if (!token) {
  console.error('❌ Falta TelegramBotToken en variables de entorno');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

// =========================
// LOG DE ARRANQUE
// =========================
console.log('🤖 EzerBot iniciado y en polling');

// =========================
// ERRORES DE POLLING
// =========================
bot.on('polling_error', (error) => {
  console.error('Polling error:', error.code, error.message);
});

// =========================
// /start
// =========================
bot.onText(/^\/start$/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    '¡Bienvenido a EZERBOT!',
    {
      reply_markup: {
        keyboard: [['Menú']],
        resize_keyboard: true,
        one_time_keyboard: false
      }
    }
  );
});

// =========================
// /catalogo
// =========================
bot.onText(/^\/catalogo$/, (msg) => {
  catalogHandler(bot, msg);
});

// =========================
// /carrito
// =========================
bot.onText(/^\/carrito$/, (msg) => {
  carritoHandler(bot, msg);
});

// =========================
// /checkout
// =========================
bot.onText(/^\/checkout$/, (msg) => {
  checkoutHandler(bot, msg);
});

// =========================
// MENSAJES NORMALES (NO comandos)
// =========================
bot.on('message', (msg) => {
  if (!msg.text) return;

  // ⚠️ MUY IMPORTANTE: no interceptar comandos
  if (msg.text.startsWith('/')) return;

  adminConfirmHandler(bot, msg);
});

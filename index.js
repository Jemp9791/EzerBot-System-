require('dotenv').config();

const { Telegraf } = require('telegraf');

// Bot
const bot = new Telegraf(process.env.BOT_TOKEN);

// Handlers existentes (SOLO los que realmente tenés)
const startHandler = require('./src/handlers/startHandler');
const categoriesHandler = require('./src/handlers/categoriesHandler');
const categoryCarouselHandler = require('./src/handlers/categoryCarouselHandler');
const navigationHandler = require('./src/handlers/navigationHandler');
const helpHandler = require('./src/handlers/helpHandler');

// Comandos
bot.start(startHandler);
bot.command('catalogo', categoriesHandler);
bot.hears('📖 Ayuda', helpHandler);

// Callbacks
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;

  if (data.startsWith('categoria_')) {
    return categoryCarouselHandler(ctx);
  }

  if (data.startsWith('next_') || data.startsWith('prev_')) {
    return navigationHandler(ctx);
  }
});

// Lanzar bot
bot.launch();

console.log('🤖 EzerBot iniciado correctamente');

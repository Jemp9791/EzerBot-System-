
const { Telegraf } = require('telegraf');
const startHandler = require('./handlers/startHandler');
const categoriesHandler = require('./handlers/categoriesHandler');
const categoryCarouselHandler = require('./handlers/categoryCarouselHandler');
const navigationHandler = require('./handlers/navigationHandler');
const helpHandler = require('./handlers/helpHandler');

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start(startHandler);
bot.command('catalogo', categoriesHandler);
bot.hears('ℹ️ Ayuda', helpHandler);

bot.on('callback_query', async ctx => {
  const data = ctx.callbackQuery.data;

  if (data.startsWith('categoria_')) return categoryCarouselHandler(ctx);
  if (data.startsWith('next_') || data.startsWith('prev_')) return navigationHandler(ctx);
});

bot.launch();
       

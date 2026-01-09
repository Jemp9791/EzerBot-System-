const navigationHandler = require('./handlers/navigationHandler');

bot.on('callback_query', async ctx => {
  const data = ctx.callbackQuery.data;

  if (data.startsWith('categoria_')) {
    return categoryCarouselHandler(ctx);
  }

  if (data.startsWith('next_') || data.startsWith('prev_')) {
    return navigationHandler(ctx);
  }

  // después agregamos el botón "Quiero este"
});

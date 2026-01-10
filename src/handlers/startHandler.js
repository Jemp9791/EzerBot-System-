async function startHandler(ctx) {
  const texto = '👋 Bienvenida al bot';
  const gifId = null; // o lo que venga de config

  if (gifId) {
    await ctx.replyWithAnimation(gifId, {
      caption: texto,
      reply_markup: {
        keyboard: [
          ['📦 Catálogo', '🎟️ Sellos'],
          ['ℹ️ Ayuda', '📣 Compartir']
        ],
        resize_keyboard: true
      }
    });
  } else {
    await ctx.reply(texto, {
      reply_markup: {
        keyboard: [
          ['📦 Catálogo', '🎟️ Sellos'],
          ['ℹ️ Ayuda', '📣 Compartir']
        ],
        resize_keyboard: true
      }
    });
  }
}

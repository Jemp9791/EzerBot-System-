module.exports = async (ctx) => {
  console.log('📥 /start recibido');

  await ctx.reply(
    '👋 Hola Jenny!\n\n' +
    'Bienvenida a *EzerBot* 🤖\n\n' +
    'Usá el menú para continuar.',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [
          ['📦 Catálogo', '🎟 Sellos'],
          ['🆘 Ayuda', '📤 Compartir']
        ],
        resize_keyboard: true
      }
    }
  );
};

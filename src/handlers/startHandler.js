module.exports = async (ctx) => {
  await ctx.reply(
    '📤 *Compartir Todo Queso*\n\n' +
    'Recomendá el negocio compartiendo este link:\n' +
    'https://t.me/Todo_Queso_bot',
    { parse_mode: 'Markdown' }
  );
};

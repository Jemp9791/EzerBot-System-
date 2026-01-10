const ClienteService = require('../modules/clientes/clienteService');

const clienteService = new ClienteService();

async function ticketHandler(ctx) {
  try {
    const telegramId = String(ctx.from.id);

    const cliente = await clienteService.getClienteByTelegramId(telegramId);

    if (!cliente) {
      return ctx.reply(
        '❌ No encontramos tu ticket.\n\nSi ya realizaste una compra, escribí *Ayuda*.',
        { parse_mode: 'Markdown' }
      );
    }

    const mensaje =
      `🎟 *Tu ticket*\n\n` +
      `👤 Cliente: ${cliente.NOMBRE || '—'}\n` +
      `🧾 Ticket: ${cliente.TICKET || '—'}\n` +
      `💰 Total: $${cliente.TOTAL || '—'}\n` +
      `📅 Fecha: ${cliente.FECHA || '—'}`;

    await ctx.reply(mensaje, { parse_mode: 'Markdown' });

  } catch (err) {
    console.error('❌ Error en ticketHandler:', err);
    await ctx.reply('⚠️ Ocurrió un error al obtener tu ticket.');
  }
}

module.exports = ticketHandler;

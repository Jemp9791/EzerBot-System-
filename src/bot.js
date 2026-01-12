import { Telegraf } from 'telegraf';
import startHandler from './handlers/startHandler.js';

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start(async (ctx) => {
  console.log('/start recibido');
  await startHandler(ctx);
});

bot.launch();

export default bot;

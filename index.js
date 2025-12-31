import express from "express";
import fetch from "node-fetch";
import TelegramBot from "node-telegram-bot-api";

const app = express();
app.use(express.json());

// ===============================
// VARIABLES (YA EXISTENTES)
// ===============================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL;

if (!TELEGRAM_TOKEN || !PUBLIC_URL) {
  console.error("❌ Faltan variables obligatorias");
  process.exit(1);
}

const DATA_API_URL =
  "https://script.google.com/macros/s/AKfycbzuiATw40Q9ut7BpAAf0YNFnYlyvBQX2NuyNdF9kz758TSZnq6l1IQYr7sTcoIRGsi3/exec";

// ===============================
// BOT
// ===============================
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

// 🔴 ESTO ES LO QUE FALTABA
await bot.setWebHook(`${PUBLIC_URL}/webhook`);

// ===============================
// UTILS
// ===============================
async function getConfig() {
  const r = await fetch(`${DATA_API_URL}?type=config`);
  return await r.json();
}

async function getCatalog() {
  const r = await fetch(`${DATA_API_URL}?type=catalog`);
  return await r.json();
}

// ===============================
// MENÚ FIJO (SIN CARRITO)
// ===============================
function mainMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🛍️ Catálogo" }],
        [{ text: "🎫 Sellos" }, { text: "📣 Compartir bot" }],
        [{ text: "🆘 Ayuda" }],
      ],
      resize_keyboard: true,
    },
  };
}

// ===============================
// MENSAJES
// ===============================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  const config = await getConfig();

  if (text === "/start") {
    await bot.sendMessage(chatId, config.Descripcion, mainMenu());
    return;
  }

  if (text === "🛍️ Catálogo") {
    const catalog = await getCatalog();

    for (const p of catalog.items) {
      const tipo =
        p.unidad === "unidad"
          ? "📦 Por unidad"
          : "⚖️ Indicá gramos (ej: 200, 500)";

      await bot.sendMessage(
        chatId,
        `🧀 *${p.nombre}*\n${p.descripcion || ""}\n💲 ${p.precio} ${
          config.Moneda
        }\n${tipo}`,
        { parse_mode: "Markdown" }
      );
    }
    return;
  }

  if (text === "🎫 Sellos") {
    await bot.sendMessage(
      chatId,
      `🎫 *Tarjeta de sellos*\n\nCada $${config.MontoPorSello} = 1 sello\n\n📲 ${config.CARD_URL}`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (text === "📣 Compartir bot") {
    await bot.sendMessage(
      chatId,
      `🤖 ${config.TextoSistema}\n\n📩 ${config.EmailSistema}\n🔗 ${config.BotLink}`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "WhatsApp",
                url: `https://wa.me/?text=${encodeURIComponent(
                  config.TextoSistema + " " + config.BotLink
                )}`,
              },
              {
                text: "Telegram",
                url: `https://t.me/share/url?url=${encodeURIComponent(
                  config.BotLink
                )}`,
              },
            ],
          ],
        },
      }
    );
    return;
  }

  if (text === "🆘 Ayuda") {
    await bot.sendMessage(
      chatId,
      `🆘 *Ayuda*\n\nSi necesitás algo que no viste en el catálogo o querés hacer una consulta:\n\n📱 ${config.WhatsAppLink}\n📸 ${config.NegocioInstagram}`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  await bot.sendMessage(chatId, "Usá el menú 👇", mainMenu());
});

// ===============================
// WEBHOOK REAL
// ===============================
app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ===============================
// HEALTHCHECK
// ===============================
app.get("/", (_, res) => {
  res.send("EZERBOT OK");
});

// ===============================
// SERVER
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🤖 EZERBOT ACTIVO");
});

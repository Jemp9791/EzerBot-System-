import express from "express";
import fetch from "node-fetch";
import TelegramBot from "node-telegram-bot-api";

const app = express();
app.use(express.json());

// ===============================
// CONFIG BÁSICA (NO TOCAR)
// ===============================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) {
  console.error("❌ Falta TELEGRAM_TOKEN");
  process.exit(1);
}

const DATA_API_URL =
  "https://script.google.com/macros/s/AKfycbzuiATw40Q9ut7BpAAf0YNFnYlyvBQX2NuyNdF9kz758TSZnq6l1IQYr7sTcoIRGsi3/exec";

// ===============================
// BOT
// ===============================
const bot = new TelegramBot(TELEGRAM_TOKEN, {
  polling: false,
});

// ===============================
// UTILIDADES
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
// MENÚ PRINCIPAL (FIJO)
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
// HANDLERS
// ===============================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  const config = await getConfig();

  // START
  if (text === "/start") {
    await bot.sendMessage(
      chatId,
      config.Descripcion || "Bienvenido 👋",
      mainMenu()
    );
    return;
  }

  // CATÁLOGO
  if (text === "🛍️ Catálogo") {
    const catalog = await getCatalog();

    if (!catalog.items || !catalog.items.length) {
      await bot.sendMessage(chatId, "No hay productos disponibles.");
      return;
    }

    for (const p of catalog.items) {
      let unidadTxt =
        p.unidad === "unidad"
          ? "Por unidad"
          : "Por gramos (ej: 200, 500)";

      await bot.sendMessage(
        chatId,
        `🧀 *${p.nombre}*\n${p.descripcion || ""}\n💲 ${
          p.precio
        } ${config.Moneda}\n📦 ${unidadTxt}`,
        {
          parse_mode: "Markdown",
        }
      );
    }

    return;
  }

  // SELLOS
  if (text === "🎫 Sellos") {
    await bot.sendMessage(
      chatId,
      `🎫 *Tu tarjeta virtual*\n\nCada $${config.MontoPorSello} sumás 1 sello.\n\n📲 Mirala acá:\n${config.CARD_URL}`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  // COMPARTIR BOT
  if (text === "📣 Compartir bot") {
    await bot.sendMessage(
      chatId,
      `🤖 ${config.TextoSistema}\n\n📩 ${config.EmailSistema}\n🔗 ${config.BotLink}`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "📲 Compartir por WhatsApp",
                url: `https://wa.me/?text=${encodeURIComponent(
                  config.TextoSistema + " " + config.BotLink
                )}`,
              },
            ],
            [
              {
                text: "✈️ Compartir por Telegram",
                url: `https://t.me/share/url?url=${encodeURIComponent(
                  config.BotLink
                )}&text=${encodeURIComponent(config.TextoSistema)}`,
              },
            ],
          ],
        },
      }
    );
    return;
  }

  // AYUDA
  if (text === "🆘 Ayuda") {
    await bot.sendMessage(
      chatId,
      `🆘 *¿Necesitás ayuda?*\n\nSi te faltó algo en tu pedido o no encontraste un producto en el catálogo, escribinos directo:\n\n📱 WhatsApp:\n${config.WhatsAppLink}\n📸 Instagram: ${config.NegocioInstagram}\n\n¡Gracias por elegir ${config.NegocioNombre}! 🧀`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  // DEFAULT
  await bot.sendMessage(
    chatId,
    "Usá el menú 👇",
    mainMenu()
  );
});

// ===============================
// WEBHOOK (ESTE ERA EL PROBLEMA)
// ===============================
app.post("/", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ===============================
// SERVER
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🤖 EZERBOT ACTIVO");
});

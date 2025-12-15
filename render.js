import express from "express";
import TelegramBot from "node-telegram-bot-api";

const BOT_TOKEN = process.env.BOT_TOKEN;
const GAS_URL = process.env.GAS_URL || "";
const WEBHOOK_URL = process.env.WEBHOOK_URL; // https://ezerbot-system.onrender.com
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) throw new Error("Falta BOT_TOKEN en Render (Environment)");
if (!WEBHOOK_URL) throw new Error("Falta WEBHOOK_URL en Render (Environment)");

const app = express();
app.use(express.json({ limit: "2mb" }));

let bootedAt = new Date().toISOString();
let lastUpdateAt = null;
let lastText = null;

app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/health", (_, res) =>
  res.status(200).json({ ok: true, bootedAt, lastUpdateAt, lastText })
);

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

app.get("/debug", async (_, res) => {
  try {
    const info = await bot.getWebHookInfo();
    res.status(200).json({
      ok: true,
      bootedAt,
      webhookInfo: info,
      lastUpdateAt,
      lastText,
      GAS_URL_present: Boolean(GAS_URL),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

const WEBHOOK_PATH = "/webhook";
app.post(WEBHOOK_PATH, (req, res) => {
  try {
    bot.processUpdate(req.body);
  } catch (e) {
    console.error("processUpdate_error:", e?.message || e);
  }
  res.sendStatus(200);
});

function mainMenuKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🛍️ Catálogo" }, { text: "🛒 Mi carrito" }],
        [{ text: "🎁 Mis sellos" }],
        [{ text: "💬 Hablar con el vendedor" }],
        [{ text: "🏪 Información del local" }, { text: "📣 Compartir el bot" }],
      ],
      resize_keyboard: true,
    },
  };
}
async function showMenu(chatId) {
  await bot.sendMessage(
    chatId,
    `👋 Hola Jenny\nSoy el asistente de Todo Queso 🧀\n\nElegí una opción 👇`,
    mainMenuKeyboard()
  );
}

// ✅ Responde a cualquier comando y cualquier texto
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  lastUpdateAt = new Date().toISOString();
  lastText = text || "(sin texto)";
  await showMenu(chatId);
});

app.listen(PORT, async () => {
  console.log("Server up on", PORT);

  const base = WEBHOOK_URL.replace(/\/$/, "");
  const full = base + WEBHOOK_PATH;

  try {
    await bot.deleteWebHook({ drop_pending_updates: true }).catch(() => {});
    await bot.setWebHook(full, { drop_pending_updates: true });
    console.log("✅ Webhook seteado:", full);
  } catch (e) {
    console.error("WEBHOOK_INIT_ERROR:", e?.message || e);
  }
});

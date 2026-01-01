import express from "express";
import TelegramBot from "node-telegram-bot-api";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL;     // ej: https://ezerbot-system.onrender.com  (SIN / al final)
const DATA_API_URL = process.env.DATA_API_URL; // tu Apps Script exec

if (!TELEGRAM_TOKEN || !PUBLIC_URL || !DATA_API_URL) {
  console.error("❌ FALTAN VARIABLES: TELEGRAM_TOKEN / PUBLIC_URL / DATA_API_URL");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "2mb" }));

// Health
app.get("/", (_, res) => res.status(200).send("EZERBOT OK"));

// Telegram bot (webhook)
const bot = new TelegramBot(TELEGRAM_TOKEN, { webHook: true });
app.post("/telegram", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ====== Config cache ======
let CONFIG = {};
const cfg = (k, d = "") => (CONFIG[k] ?? d);

async function loadConfig() {
  const r = await fetch(DATA_API_URL, { method: "GET" });
  if (!r.ok) throw new Error("No pude leer DATA_API_URL");
  const j = await r.json();

  // Acepta: {config:[{KEY,VALUE}]} o [{KEY,VALUE}]
  const rows = Array.isArray(j) ? j : (j.config || []);
  const map = {};
  for (const row of rows) {
    if (row && row.KEY != null) map[String(row.KEY).trim()] = String(row.VALUE ?? "");
  }
  CONFIG = map;

  console.log("✅ CONFIG OK:", Object.keys(CONFIG).length, "keys");
}

// ====== Menu fijo (sin Carrito) ======
const MENU = {
  keyboard: [
    [{ text: "🛍️ Catálogo" }],
    [{ text: "🏷️ Sellos" }, { text: "📣 Compartir bot" }],
    [{ text: "🆘 Ayuda" }]
  ],
  resize_keyboard: true
};

// ====== Bot handlers ======
bot.onText(/\/start/, async (msg) => {
  const name = msg.from?.first_name || "";
  const desc = cfg("Descripcion", "Hola 😊").replace("{NOMBRE}", name);
  await bot.sendMessage(msg.chat.id, desc, { reply_markup: MENU });
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const t = msg.text || "";

  if (t === "🆘 Ayuda") {
    await bot.sendMessage(
      chatId,
      `📌 Si necesitás hacer una consulta o reclamo:\n\n✅ WhatsApp:\n${cfg("WhatsAppLink")}\n📸 Instagram:\n${cfg("NegocioInstagram")}\n\nGracias por elegir ${cfg("NegocioNombre","Todo Queso")} 🧀`,
      { reply_markup: MENU, disable_web_page_preview: true }
    );
  }

  if (t === "📣 Compartir bot") {
    // SOLO la leyenda + datos de contacto (como pediste)
    await bot.sendMessage(
      chatId,
      `🤖 ${cfg("TextoSistema", "¿Querés este sistema para tu negocio? Contactános")}\n\n✉️ ${cfg("EmailSistema")}\n🔗 ${cfg("BotLink")}`,
      { reply_markup: MENU, disable_web_page_preview: true }
    );
  }

  if (t === "🏷️ Sellos") {
    await bot.sendMessage(
      chatId,
      `🏷️ Tus sellos se ven acá:\n${PUBLIC_URL}/card/${chatId}`,
      { reply_markup: MENU, disable_web_page_preview: true }
    );
  }
});

// ====== Página Sellos (simple, visible) ======
app.get("/card/:id", (req, res) => {
  const negocio = cfg("NegocioNombre", "Todo Queso");
  const cardUrl = cfg("CARD_URL", "");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
<!doctype html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body style="margin:0;background:#0b1220;color:#fff;font-family:system-ui;text-align:center;padding:24px">
  <h2 style="margin:0 0 8px">${negocio}</h2>
  <div style="opacity:.85;margin-bottom:18px">Tarjeta / Sellos virtuales</div>
  ${cardUrl ? `<img src="${cardUrl}" style="max-width:360px;width:100%;border-radius:16px" />`
            : `<div style="padding:20px;border:1px solid #334155;border-radius:16px">No hay CARD_URL en Config</div>`}
</body>
</html>`);
});

// ====== Start ======
async function start() {
  await loadConfig();

  // IMPORTANTE: PUBLIC_URL sin "/" final
  const base = PUBLIC_URL.replace(/\/+$/, "");
  await bot.setWebHook(`${base}/telegram`);

  const PORT = process.env.PORT || 10000;
  app.listen(PORT, () => console.log("🟢 EZERBOT ACTIVO en", base));
}

start().catch((e) => {
  console.error("❌ FATAL:", e?.message || e);
  process.exit(1);
});

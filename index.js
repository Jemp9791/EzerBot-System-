import express from "express";
import TelegramBot from "node-telegram-bot-api";

const TOKEN = process.env.TELEGRAM_TOKEN || "8130447159:AAHxzp5S1lcgYOemw5dgF5V1DGh141dHmkA";
const BACKEND = process.env.GAS_BACKEND || "https://script.google.com/macros/s/AKfycbxznmXVhDFd45kwrtsO0lORoGDn7AcHVdQIYQkgYy_63jaJCrjumzphVK_N39T_zjK_/exec";
const URL_BASE = process.env.URL_BASE || "https://ezerbot-system.onrender.com";
const LOGO = "https://i.postimg.cc/q7WvjsYm/20251206-210311.jpg";

const app = express();
app.use(express.json());

const bot = new TelegramBot(TOKEN, { webHook: true });

/* =====================
   UTILIDAD GAS
===================== */
async function GAS(action, params = {}) {
  const url = new URL(BACKEND);
  url.searchParams.append("accion", action);
  Object.keys(params).forEach(k => url.searchParams.append(k, params[k]));
  const r = await fetch(url);
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return { ok: false };
  }
}

/* =====================
   MENÚ PRINCIPAL
===================== */
async function enviarMenu(chatId, nombre = "Jenny") {
  await bot.sendPhoto(chatId, LOGO, {
    caption:
`Hola ${nombre} 👋
Soy el asistente de *TODO QUESO CLUB* 🧀

Desde acá podés:
• Ver el catálogo
• Armar tu pedido
• Sumar sellos
• Hablar con nosotros

👇 Elegí una opción`,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🛍️ Catálogo", callback_data: "CATALOGO" },
          { text: "🛒 Mi carrito", callback_data: "CARRITO" }
        ],
        [{ text: "🏆 Mis sellos", callback_data: "SELLOS" }],
        [{ text: "💬 Hablar con el vendedor", callback_data: "HABLAR" }],
        [
          { text: "🏪 Información del local", callback_data: "INFO" },
          { text: "📣 Compartir el bot", callback_data: "COMPARTIR" }
        ]
      ]
    }
  });
}

/* =====================
   START
===================== */
bot.onText(/\/start|hola|buenas/i, async msg => {
  await enviarMenu(msg.chat.id, msg.chat.first_name);
});

/* =====================
   CALLBACKS
===================== */
bot.on("callback_query", async q => {
  const chatId = q.message.chat.id;
  const d = q.data;
  await bot.answerCallbackQuery(q.id);

  if (d === "CATALOGO") return mostrarCategorias(chatId);
  if (d === "INFO") return infoLocal(chatId);
  if (d === "HABLAR") return hablarVendedor(chatId);
  if (d === "COMPARTIR") return compartir(chatId);
  if (d === "SELLOS") return sellos(chatId);
});

/* =====================
   FUNCIONES
===================== */
async function mostrarCategorias(chatId) {
  const r = await GAS("catalogo");
  if (!Array.isArray(r.items)) {
    return bot.sendMessage(chatId, "⚠️ No pude leer el catálogo.");
  }

  const cats = [...new Set(r.items.map(i => i.categoria || "General"))];

  await bot.sendMessage(chatId, "🛍️ Elegí una categoría:", {
    reply_markup: {
      inline_keyboard: cats.map(c => [{ text: c, callback_data: "CAT_" + c }])
    }
  });
}

async function infoLocal(chatId) {
  await bot.sendMessage(chatId,
`🏪 *TODO QUESO CLUB*
📍 Productos frescos todos los días
🧀 Calidad y promos reales`,
{ parse_mode: "Markdown" });
}

async function hablarVendedor(chatId) {
  await bot.sendMessage(chatId,
"💬 Hablá directo con nosotros por WhatsApp",
{
  reply_markup: {
    inline_keyboard: [
      [{ text: "📞 Abrir WhatsApp", url: "https://wa.me/5493484230184" }]
    ]
  }
});
}

async function compartir(chatId) {
  await bot.sendMessage(chatId,
"📣 Compartí nuestro bot:\nhttps://t.me/Ezer_IA_Bot");
}

async function sellos(chatId) {
  await bot.sendMessage(chatId,
"🏆 Tu sistema de sellos se mostrará acá");
}

/* =====================
   WEBHOOK
===================== */
app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (_, res) => res.send("EzerBot OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  await bot.setWebHook(`${URL_BASE}/webhook`);
  console.log("Bot activo en puerto", PORT);
});

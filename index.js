/**
 * index.js — AISLADO: SOLO "Compartir bot" + "Compartir promo"
 *
 * ENV (Render):
 * - TELEGRAM_TOKEN   = (tu token)
 * - BOT_USERNAME     = Todo_Queso          (sin @)
 * - SYSTEM_EMAIL     = ezerbot.assistant@gmail.com
 *
 * Webhook: root "/"
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;

const TOKEN = process.env.TELEGRAM_TOKEN || "";
const BOT_USERNAME = (process.env.BOT_USERNAME || "").replace(/^@/, "");
const SYSTEM_EMAIL = process.env.SYSTEM_EMAIL || "ezerbot.assistant@gmail.com";

if (!TOKEN) console.error("Falta ENV TELEGRAM_TOKEN");
if (!BOT_USERNAME) console.error("Falta ENV BOT_USERNAME");

const TG = (method) => `https://api.telegram.org/bot${TOKEN}/${method}`;

// ---------- Telegram API ----------
async function tgCall(method, payload) {
  const res = await fetch(TG(method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data?.ok) console.error("Telegram API error:", method, data);
  return data;
}

async function sendMessage(chat_id, text, extra = {}) {
  return tgCall("sendMessage", { chat_id, text, ...extra });
}

function replyKeyboard() {
  // Botones violetas (Reply Keyboard)
  return {
    keyboard: [[{ text: "📣 Compartir bot" }], [{ text: "🔥 Compartir promo" }]],
    resize_keyboard: true,
  };
}

function shareInlineKeyboard(textToShare) {
  const t = encodeURIComponent(textToShare);
  const botUrl = `https://t.me/${BOT_USERNAME}`;
  const botUrlEnc = encodeURIComponent(botUrl);

  return {
    inline_keyboard: [
      [
        { text: "📲 WhatsApp", url: `https://wa.me/?text=${t}` },
        { text: "✈️ Telegram", url: `https://t.me/share/url?url=${botUrlEnc}&text=${t}` },
      ],
      [{ text: "📧 Email", url: `mailto:?subject=Todo%20Queso&body=${t}` }],
      [{ text: "💼 Quiero este sistema", url: `mailto:${SYSTEM_EMAIL}?subject=Quiero%20el%20sistema%20EzerBot` }],
    ],
  };
}

function botShareText() {
  return (
    "🧀 *Todo Queso* — Mirá el catálogo y comprá directo por el bot 👇\n\n" +
    `https://t.me/${BOT_USERNAME}\n\n` +
    "💼 ¿Querés este sistema para tu negocio?\n" +
    `📧 ${SYSTEM_EMAIL}`
  );
}

function promoShareText() {
  // Cambiá SOLO este texto cuando quieras (no afecta nada más)
  return (
    "🔥 *Promo Todo Queso* 🔥\n\n" +
    "Picada P/4 — $30.000 (solo con reserva previa)\n\n" +
    `🛒 Pedila acá:\nhttps://t.me/${BOT_USERNAME}\n\n` +
    "💼 ¿Querés este sistema para tu negocio?\n" +
    `📧 ${SYSTEM_EMAIL}`
  );
}

async function sendMenu(chat_id) {
  return sendMessage(chat_id, "Elegí qué querés compartir:", {
    reply_markup: replyKeyboard(),
  });
}

async function handleShareBot(chat_id) {
  const text = botShareText();
  return sendMessage(chat_id, "📣 Compartir bot (elegí canal):", {
    parse_mode: "Markdown",
    reply_markup: shareInlineKeyboard(text),
  });
}

async function handleSharePromo(chat_id) {
  const text = promoShareText();
  return sendMessage(chat_id, "🔥 Compartir promo (elegí canal):", {
    parse_mode: "Markdown",
    reply_markup: shareInlineKeyboard(text),
  });
}

// ---------- Routes ----------
app.get("/", (req, res) => res.status(200).send("OK - SHARE ONLY LIVE"));

app.get("/debug", (req, res) => {
  res.status(200).json({
    ok: true,
    env: {
      hasToken: Boolean(TOKEN),
      botUsername: BOT_USERNAME || null,
      systemEmail: SYSTEM_EMAIL || null,
    },
  });
});

// Webhook root "/"
app.post("/", async (req, res) => {
  res.sendStatus(200);

  const update = req.body || {};

  // LOG TOTAL para aislar por qué "no responde"
  console.log("UPDATE:", JSON.stringify(update));

  try {
    // Mensajes normales (Reply Keyboard)
    if (update.message?.text) {
      const chat_id = update.message.chat.id;
      const text = String(update.message.text).trim();

      if (text === "/start" || text.toLowerCase() === "start") {
        return sendMenu(chat_id);
      }

      if (text === "📣 Compartir bot") {
        return handleShareBot(chat_id);
      }

      if (text === "🔥 Compartir promo") {
        return handleSharePromo(chat_id);
      }

      // Si escriben cualquier cosa, mostramos menú
      return sendMenu(chat_id);
    }

    // Si llega callback_query (inline), solo lo cerramos (no debería ser necesario acá)
    if (update.callback_query?.id) {
      return tgCall("answerCallbackQuery", { callback_query_id: update.callback_query.id });
    }
  } catch (e) {
    console.error("Handler error:", e);
  }
});

app.listen(PORT, () => {
  console.log("✅ SHARE ONLY server en puerto", PORT);
  console.log("✅ BOT_USERNAME:", BOT_USERNAME ? BOT_USERNAME : "(vacío)");
});

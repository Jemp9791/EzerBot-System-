/**
 * SHARE WHATSAPP ONLY - Todo_Queso
 * - /start muestra 2 botones: "Compartir bot" y "Compartir promo"
 * - Los botones son URL -> abren WhatsApp (NO usan callback_data)
 *
 * ENV (Render):
 * - TELEGRAM_TOKEN
 * - BOT_USERNAME   (ej: Ezer_IA_Bot)  sin @
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_TOKEN || "";
const BOT_USERNAME = (process.env.BOT_USERNAME || "").replace(/^@/, "");

if (!TOKEN) console.error("Falta ENV TELEGRAM_TOKEN");
if (!BOT_USERNAME) console.error("Falta ENV BOT_USERNAME");

const TG = (method) => `https://api.telegram.org/bot${TOKEN}/${method}`;

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

async function sendMessage(chat_id, text, reply_markup) {
  return tgCall("sendMessage", {
    chat_id,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(reply_markup ? { reply_markup } : {}),
  });
}

function enc(s) {
  return encodeURIComponent(String(s || ""));
}

function botLink() {
  return `https://t.me/${BOT_USERNAME}`;
}

function productLink(code) {
  // deep link (ejemplo promo TQ01)
  return `https://t.me/${BOT_USERNAME}?start=prod_${enc(code)}`;
}

function waLink(text) {
  return `https://wa.me/?text=${enc(text)}`;
}

function shareKeyboard() {
  const bot = botLink();
  const promo = productLink("TQ01"); // si querés otra promo cambiá solo este código

  const textBot = `🧀 Todo Queso — Compras por Telegram\nAbrí el bot acá: ${bot}`;
  const textPromo = `🏷️ Promo Todo Queso (TQ01)\nComprala directo acá: ${promo}`;

  return {
    inline_keyboard: [
      [{ text: "📲 Compartir BOT por WhatsApp", url: waLink(textBot) }],
      [{ text: "📲 Compartir PROMO por WhatsApp", url: waLink(textPromo) }],
    ],
  };
}

/** ---- Webhook ---- */
app.get("/", (req, res) => res.status(200).send("OK - SHARE WHATSAPP ONLY LIVE"));

app.get("/debug", (req, res) => {
  res.status(200).json({
    ok: true,
    env: {
      hasToken: Boolean(TOKEN),
      botUsername: BOT_USERNAME || null,
    },
  });
});

app.post("/", async (req, res) => {
  res.sendStatus(200);
  const update = req.body || {};

  try {
    if (update.message) {
      const chat_id = update.message.chat.id;
      const text = update.message.text || "";

      if (text.startsWith("/start")) {
        return sendMessage(
          chat_id,
          "📣 <b>Compartir</b>\nElegí qué querés compartir por WhatsApp:",
          shareKeyboard()
        );
      }

      // Si escribe cualquier cosa, volvemos a mostrar botones
      return sendMessage(
        chat_id,
        "Tocá un botón para compartir por WhatsApp 👇",
        shareKeyboard()
      );
    }
  } catch (e) {
    console.error("Handler error:", e);
  }
});

app.listen(PORT, () => {
  console.log("✅ Server listo en puerto", PORT);
  console.log("✅ BOT_USERNAME:", BOT_USERNAME);
});

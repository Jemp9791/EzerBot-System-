/**
 * SHARE ONLY - Telegram Bot (Webhook en "/")
 * Solo 2 cosas:
 * 1) 📣 Compartir bot
 * 2) 📤 Compartir promo
 *
 * ENV (Render):
 * - TELEGRAM_TOKEN   = (tu token)
 * - PUBLIC_URL       = https://ezerbot-system.onrender.com   (sin barra final)
 * - BOT_USERNAME     = Ezer_IA_Bot   (sin @)
 * - SYSTEM_EMAIL     = ezerbot.assistant@gmail.com
 *
 * Webhook: PUBLIC_URL + "/"
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_TOKEN || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const BOT_USERNAME = (process.env.BOT_USERNAME || "").replace(/^@/, "");
const SYSTEM_EMAIL = process.env.SYSTEM_EMAIL || "ezerbot.assistant@gmail.com";

if (!TOKEN) console.error("Falta ENV TELEGRAM_TOKEN");
if (!PUBLIC_URL) console.error("Falta ENV PUBLIC_URL");
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

async function sendMessage(chat_id, text, extra = {}) {
  return tgCall("sendMessage", { chat_id, text, ...extra });
}

function replyMenu() {
  // Botones “de abajo” (ReplyKeyboard) -> llegan como texto en update.message.text
  return {
    keyboard: [
      [{ text: "📣 Compartir bot" }, { text: "📤 Compartir promo" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

/**
 * IMPORTANTE:
 * - “Compartir” se hace con botones INLINE tipo URL.
 * - NO llevan callback_data.
 * - NO se mezclan url + callback_data.
 */
function shareBotInlineKeyboard() {
  const botLink = `https://t.me/${encodeURIComponent(BOT_USERNAME)}?start=from_share`;
  const msg = encodeURIComponent(
    `🧀 Todo Queso: pedí por el bot acá 👉 ${botLink}`
  );

  return {
    inline_keyboard: [
      [
        {
          text: "📲 WhatsApp",
          url: `https://wa.me/?text=${msg}`,
        },
        {
          text: "✈️ Telegram",
          url: `https://t.me/share/url?url=${encodeURIComponent(botLink)}&text=${encodeURIComponent("🧀 Todo Queso: pedí por el bot acá")}`,
        },
      ],
      [
        {
          text: "✉️ Email",
          url: `mailto:${encodeURIComponent(SYSTEM_EMAIL)}?subject=${encodeURIComponent("Quiero el sistema EzerBot")}&body=${encodeURIComponent(
            "Hola! Me interesa el sistema. Vi el bot y quiero implementarlo.\n\nBot demo: " + botLink
          )}`,
        },
      ],
      [
        {
          text: "🤖 Abrir bot ahora",
          url: botLink,
        },
      ],
    ],
  };
}

function sharePromoInlineKeyboard() {
  // PROMO FIJA (la podés cambiar después, pero ahora es “aislar y que funcione”)
  // Deep link con start=promo_TQ01 para que al abrir el bot puedas detectar de dónde viene
  const promoCode = "TQ01";
  const botLinkPromo = `https://t.me/${encodeURIComponent(BOT_USERNAME)}?start=promo_${encodeURIComponent(promoCode)}`;

  const msg = encodeURIComponent(
    `🔥 Promo Todo Queso (PICADA P/4) - Mirala y pedila acá 👉 ${botLinkPromo}`
  );

  return {
    inline_keyboard: [
      [
        { text: "📲 WhatsApp", url: `https://wa.me/?text=${msg}` },
        {
          text: "✈️ Telegram",
          url: `https://t.me/share/url?url=${encodeURIComponent(botLinkPromo)}&text=${encodeURIComponent("🔥 Promo Todo Queso (PICADA P/4)")}`,
        },
      ],
      [
        {
          text: "✉️ Email",
          url: `mailto:${encodeURIComponent(SYSTEM_EMAIL)}?subject=${encodeURIComponent("Quiero esta promo / catálogo")}&body=${encodeURIComponent(
            "Hola! Me interesa esta promo y/o el sistema.\n\nPromo: " + botLinkPromo
          )}`,
        },
      ],
      [{ text: "🛒 Abrir promo en el bot", url: botLinkPromo }],
    ],
  };
}

async function handleStart(chat_id, startPayload = "") {
  // startPayload llega como: "/start promo_TQ01" o "/start from_share"
  let extra = "";
  if (startPayload?.startsWith("promo_")) {
    const code = startPayload.replace("promo_", "");
    extra = `\n\n✅ Llegaste por una promo: <b>${escapeHtml(code)}</b>\n(Después lo conectás con tu catálogo, ahora solo confirmamos que comparte y abre.)`;
  } else if (startPayload === "from_share") {
    extra = `\n\n✅ Llegaste desde un link compartido.`;
  }

  return sendMessage(
    chat_id,
    `🧀 <b>Todo Queso</b>\nElegí una opción:${extra}`,
    { parse_mode: "HTML", reply_markup: replyMenu() }
  );
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function handleText(chat_id, text) {
  if (text === "📣 Compartir bot") {
    return sendMessage(
      chat_id,
      "📣 <b>Compartir el bot</b>\nElegí dónde querés enviarlo:",
      { parse_mode: "HTML", reply_markup: shareBotInlineKeyboard() }
    );
  }

  if (text === "📤 Compartir promo") {
    return sendMessage(
      chat_id,
      "📤 <b>Compartir promo</b>\nElegí dónde querés enviarla:",
      { parse_mode: "HTML", reply_markup: sharePromoInlineKeyboard() }
    );
  }

  // fallback
  return sendMessage(
    chat_id,
    "Usá los botones de abajo 👇",
    { reply_markup: replyMenu() }
  );
}

// Health
app.get("/", (req, res) => res.status(200).send("OK - SHARE ONLY LIVE"));
app.get("/debug", (req, res) => {
  res.status(200).json({
    ok: true,
    env: {
      hasToken: Boolean(TOKEN),
      publicUrl: PUBLIC_URL || null,
      botUsername: BOT_USERNAME || null,
      systemEmail: SYSTEM_EMAIL || null,
    },
  });
});

// Webhook root "/"
app.post("/", async (req, res) => {
  res.sendStatus(200);

  const update = req.body || {};

  try {
    // Mensajes normales (ReplyKeyboard)
    if (update.message) {
      const chat_id = update.message.chat.id;
      const text = update.message.text || "";

      if (text.startsWith("/start")) {
        const payload = text.split(" ").slice(1).join(" ").trim(); // lo que viene después de /start
        return handleStart(chat_id, payload);
      }

      return handleText(chat_id, text);
    }

    // Callbacks (por si Telegram te manda alguno por otros botones)
    if (update.callback_query) {
      const chat_id = update.callback_query.message?.chat?.id;
      await tgCall("answerCallbackQuery", { callback_query_id: update.callback_query.id }).catch(() => {});
      if (chat_id) {
        return sendMessage(chat_id, "✅ Recibí tu toque (callback).", { reply_markup: replyMenu() });
      }
    }
  } catch (e) {
    console.error("Handler error:", e);
  }
});

app.listen(PORT, () => {
  console.log("✅ Server listo en puerto", PORT);
  console.log("✅ PUBLIC_URL:", PUBLIC_URL);
  console.log("✅ BOT_USERNAME:", BOT_USERNAME);
});

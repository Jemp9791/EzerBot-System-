/**
 * Todo_Queso - SHARE (WhatsApp + Email) FIXED
 * - Evita mailto: en botones inline (Telegram NO lo permite -> 400)
 * - Usa links https a tu server (Render) y redirige a WhatsApp / Mail
 *
 * ENV (Render):
 * - TELEGRAM_TOKEN  = (tu token)
 * - PUBLIC_URL      = https://ezerbot-system.onrender.com   (sin / final)
 * - BOT_USERNAME    = Ezer_IA_Bot
 * - SYSTEM_EMAIL    = ezerbot.assistant@gmail.com  (opcional)
 * - PROMO_IMAGE_URL = (opcional) si querés foto, si no manda texto
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_TOKEN || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const BOT_USERNAME = (process.env.BOT_USERNAME || "Ezer_IA_Bot").replace(/^@/, "");
const SYSTEM_EMAIL = process.env.SYSTEM_EMAIL || "ezerbot.assistant@gmail.com";
const PROMO_IMAGE_URL = (process.env.PROMO_IMAGE_URL || "").trim();

if (!TOKEN) console.error("Falta ENV TELEGRAM_TOKEN");
if (!PUBLIC_URL) console.error("Falta ENV PUBLIC_URL");
if (!BOT_USERNAME) console.error("Falta ENV BOT_USERNAME");

const TG = (method) => `https://api.telegram.org/bot${TOKEN}/${method}`;

function enc(s) {
  return encodeURIComponent(String(s || ""));
}

function botLink() {
  return `https://t.me/${BOT_USERNAME}`;
}

// ====== PROMO (solo para compartir) ======
const PROMO = {
  title: "PROMO DESTACADA",
  name: "PICADA P/4",
  price: "30000",
  unit: "unidad",
  desc:
    "Picada p/personas con 2 latas de cerveza Corona\n" +
    "SOLO CON RESERVA PREVIA",
};

// ====== Telegram API ======
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

async function sendPhoto(chat_id, photo, caption, extra = {}) {
  return tgCall("sendPhoto", { chat_id, photo, caption, ...extra });
}

// ====== Keyboards ======
function mainReplyKeyboard() {
  // teclado inferior (reply keyboard) => NO callbacks => siempre responde
  return {
    keyboard: [
      [{ text: "📣 Compartir BOT" }],
      [{ text: "🎁 Compartir PROMO" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

// Botones inline SOLO con https (Telegram-friendly)
function shareInlineKeyboard({ waUrl, emailUrl }) {
  return {
    inline_keyboard: [
      [{ text: "🛍️ Abrir bot", url: botLink() }],
      [{ text: "📣 Compartir por WhatsApp", url: waUrl }],
      [{ text: "📧 Compartir por Email", url: emailUrl }],
    ],
  };
}

// ====== Textos para compartir ======
function buildBotShareText() {
  return (
    `🧀 Todo Queso — Compras por Telegram\n` +
    `Abrí el bot acá:\n${botLink()}\n\n` +
    `📩 Si querés tu propio sistema (EzerBot), escribinos:\n${SYSTEM_EMAIL}`
  );
}

function buildPromoShareText() {
  return (
    `🎁 ${PROMO.title} — ${PROMO.name}\n` +
    `💰 $ ${PROMO.price} (${PROMO.unit})\n\n` +
    `${PROMO.desc}\n\n` +
    `✅ Para pedir: abrí el bot y escribí: QUIERO LA PROMO\n` +
    `👉 ${botLink()}`
  );
}

// ====== Links https a tu server (redirect) ======
function makeRedirectLinks(text, emailSubject = "Todo Queso") {
  // WhatsApp redirect
  const waUrl = `${PUBLIC_URL}/go/wa?text=${enc(text)}`;

  // Email redirect (subject + body)
  const emailUrl = `${PUBLIC_URL}/go/email?subject=${enc(emailSubject)}&body=${enc(text)}`;

  return { waUrl, emailUrl };
}

// ====== Handlers ======
async function handleStart(chat_id) {
  const text =
    `🧀 <b>Todo Queso</b>\n\n` +
    `Elegí qué querés compartir:\n` +
    `• 📣 Compartir BOT\n` +
    `• 🎁 Compartir PROMO`;

  return sendMessage(chat_id, text, {
    parse_mode: "HTML",
    reply_markup: mainReplyKeyboard(),
  });
}

async function handleShareBot(chat_id) {
  const shareText = buildBotShareText();
  const { waUrl, emailUrl } = makeRedirectLinks(shareText, "🧀 Todo Queso — Compras por Telegram");

  return sendMessage(chat_id, "📣 <b>Compartir BOT</b>\nElegí cómo compartir:", {
    parse_mode: "HTML",
    reply_markup: shareInlineKeyboard({ waUrl, emailUrl }),
  });
}

async function handleSharePromo(chat_id) {
  const shareText = buildPromoShareText();
  const { waUrl, emailUrl } = makeRedirectLinks(shareText, `🎁 Promo Todo Queso — ${PROMO.name}`);

  const caption =
    `🎁 <b>${PROMO.title}</b>\n` +
    `🛍️ <b>${PROMO.name}</b>\n` +
    `💰 <b>$ ${PROMO.price}</b> (${PROMO.unit})\n` +
    `📝 ${PROMO.desc}\n\n` +
    `✅ Para pedir: escribí <b>QUIERO LA PROMO</b>`;

  // Si hay imagen válida en ENV, manda foto. Si no, manda mensaje.
  if (PROMO_IMAGE_URL && PROMO_IMAGE_URL.startsWith("http")) {
    const r = await sendPhoto(chat_id, PROMO_IMAGE_URL, caption, {
      parse_mode: "HTML",
      reply_markup: shareInlineKeyboard({ waUrl, emailUrl }),
    });

    // Si Telegram rechaza la imagen, cae a texto (no se rompe)
    if (!r?.ok) {
      return sendMessage(chat_id, caption + "\n\n" + "🔗 " + botLink(), {
        parse_mode: "HTML",
        reply_markup: shareInlineKeyboard({ waUrl, emailUrl }),
      });
    }
    return;
  }

  // fallback solo texto
  return sendMessage(chat_id, caption + "\n\n🔗 " + botLink(), {
    parse_mode: "HTML",
    reply_markup: shareInlineKeyboard({ waUrl, emailUrl }),
  });
}

// ====== Routes ======
app.get("/", (req, res) => res.status(200).send("OK - SHARE FIX LIVE"));

app.get("/debug", (req, res) => {
  res.status(200).json({
    ok: true,
    env: {
      hasToken: Boolean(TOKEN),
      publicUrl: PUBLIC_URL || null,
      botUsername: BOT_USERNAME || null,
      systemEmail: SYSTEM_EMAIL || null,
      hasPromoImage: Boolean(PROMO_IMAGE_URL),
    },
    botLink: botLink(),
  });
});

// Redirect WhatsApp
app.get("/go/wa", (req, res) => {
  const text = req.query.text ? String(req.query.text) : "";
  const url = `https://wa.me/?text=${enc(text)}`;
  return res.redirect(302, url);
});

// Redirect Email (mailto) — desde https, para que Telegram lo acepte como botón
app.get("/go/email", (req, res) => {
  const subject = req.query.subject ? String(req.query.subject) : "Todo Queso";
  const body = req.query.body ? String(req.query.body) : "";
  const mailto = `mailto:?subject=${enc(subject)}&body=${enc(body)}`;
  return res.redirect(302, mailto);
});

// Webhook Telegram
app.post("/", async (req, res) => {
  res.sendStatus(200);
  const update = req.body || {};

  try {
    if (update.message) {
      const chat_id = update.message.chat?.id;
      const text = (update.message.text || "").trim();
      if (!chat_id) return;

      if (text === "/start" || text.toLowerCase() === "start") return handleStart(chat_id);

      if (text === "📣 Compartir BOT") return handleShareBot(chat_id);
      if (text === "🎁 Compartir PROMO") return handleSharePromo(chat_id);

      return handleStart(chat_id);
    }
  } catch (e) {
    console.error("Handler error:", e);
  }
});

app.listen(PORT, () => {
  console.log("✅ Server listo en puerto", PORT);
  console.log("✅ Bot:", BOT_USERNAME);
  console.log("✅ PUBLIC_URL:", PUBLIC_URL);
});

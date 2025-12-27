/**
 * Todo_Queso - SHARE ONLY (WhatsApp + Email)
 * - /start muestra 2 botones (reply keyboard): Compartir BOT / Compartir PROMO
 * - Compartir BOT: genera link WhatsApp + Email listo para enviar
 * - Compartir PROMO: manda FOTO + texto + botones inline (Abrir bot, WhatsApp, Email)
 *
 * ENV (Render):
 * - TELEGRAM_TOKEN = (tu token)
 * - PUBLIC_URL     = https://ezerbot-system.onrender.com  (sin / al final)
 * - BOT_USERNAME   = Ezer_IA_Bot   (username real del bot)
 *
 * Opcional:
 * - SYSTEM_EMAIL   = ezerbot.assistant@gmail.com
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_TOKEN || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const BOT_USERNAME = (process.env.BOT_USERNAME || "Ezer_IA_Bot").replace(/^@/, "");
const SYSTEM_EMAIL = process.env.SYSTEM_EMAIL || "ezerbot.assistant@gmail.com";

if (!TOKEN) console.error("Falta ENV TELEGRAM_TOKEN");
if (!PUBLIC_URL) console.error("Falta ENV PUBLIC_URL");
if (!BOT_USERNAME) console.error("Falta ENV BOT_USERNAME");

const TG = (method) => `https://api.telegram.org/bot${TOKEN}/${method}`;

// ====== PROMO (hardcode por ahora, porque estamos aislando SHARE) ======
const PROMO = {
  title: "PROMO DESTACADA",
  name: "PICADA P/4",
  price: "30000",
  unit: "unidad",
  desc: 'Picada p/personas con 2 latas de cerveza Corona\nSOLO CON RESERVA PREVIA',
  // link directo a imagen (tu png está ok):
  image: "https://i.postimg.cc/26WcGXBd/Copia-de-Orange-Bold-Colorful-Turkey-Sandwich-Instagram-Story-(Video).png",
};

// ====== Utils ======
function enc(s) {
  return encodeURIComponent(String(s || ""));
}
function botLink() {
  return `https://t.me/${BOT_USERNAME}`;
}
function waShareLink(text) {
  return `https://wa.me/?text=${enc(text)}`;
}
function mailShareLink(subject, body) {
  // mailto: abre app de correo con asunto y cuerpo
  return `mailto:?subject=${enc(subject)}&body=${enc(body)}`;
}

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
  // teclado inferior (reply keyboard) => NO callbacks => no se traba
  return {
    keyboard: [
      [{ text: "📣 Compartir BOT" }],
      [{ text: "🎁 Compartir PROMO" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

function promoInlineKeyboard(promoShareWA, promoShareEmail) {
  return {
    inline_keyboard: [
      [{ text: "🛍️ Abrir bot", url: botLink() }],
      [
        { text: "📣 Compartir esta promo (WhatsApp)", url: promoShareWA },
      ],
      [
        { text: "📧 Compartir esta promo (Email)", url: promoShareEmail },
      ],
    ],
  };
}

function botInlineKeyboard(botShareWA, botShareEmail) {
  return {
    inline_keyboard: [
      [{ text: "🛍️ Abrir bot", url: botLink() }],
      [{ text: "📣 Compartir bot (WhatsApp)", url: botShareWA }],
      [{ text: "📧 Compartir bot (Email)", url: botShareEmail }],
    ],
  };
}

// ====== Flujos ======
async function handleStart(chat_id) {
  const text =
`🧀 <b>Todo Queso</b>

Elegí qué querés compartir:
• 📣 Compartir BOT
• 🎁 Compartir PROMO

Si alguien lo recibe, abre el bot y puede comprar.`;

  return sendMessage(chat_id, text, {
    parse_mode: "HTML",
    reply_markup: mainReplyKeyboard(),
  });
}

function buildBotShareText() {
  return `🧀 Todo Queso — Compras por Telegram
Abrí el bot acá:
${botLink()}

Si querés tu propio sistema (EzerBot), pedilo por acá:
${SYSTEM_EMAIL}`;
}

function buildPromoShareText() {
  return `🎁 ${PROMO.title} — ${PROMO.name}
💰 $ ${PROMO.price} (${PROMO.unit})

${PROMO.desc}

✅ Para pedir: abrí el bot y escribí: QUIERO LA PROMO
👉 ${botLink()}`;
}

async function handleShareBot(chat_id) {
  const shareText = buildBotShareText();

  const wa = waShareLink(shareText);
  const emSubject = "🧀 Todo Queso — Compras por Telegram";
  const emBody = shareText;
  const mail = mailShareLink(emSubject, emBody);

  // Mando un mensaje simple + botones inline (Abrir/WhatsApp/Email)
  return sendMessage(
    chat_id,
    `📣 <b>Compartir BOT</b>\n\nElegí cómo lo querés compartir:`,
    {
      parse_mode: "HTML",
      reply_markup: botInlineKeyboard(wa, mail),
    }
  );
}

async function handleSharePromo(chat_id) {
  const shareText = buildPromoShareText();

  const wa = waShareLink(shareText);
  const emSubject = `🎁 Promo Todo Queso — ${PROMO.name}`;
  const emBody = shareText;
  const mail = mailShareLink(emSubject, emBody);

  const caption =
`🎁 <b>${PROMO.title}</b>
🛍️ <b>${PROMO.name}</b>
💰 <b>$ ${PROMO.price}</b> (${PROMO.unit})
📝 ${PROMO.desc}

✅ Para pedir: escribí <b>QUIERO LA PROMO</b>`;

  return sendPhoto(chat_id, PROMO.image, caption, {
    parse_mode: "HTML",
    reply_markup: promoInlineKeyboard(wa, mail),
  });
}

// ====== Webhook ======
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
    botLink: botLink(),
  });
});

app.post("/", async (req, res) => {
  // Telegram necesita 200 rápido
  res.sendStatus(200);

  const update = req.body || {};

  try {
    if (update.message) {
      const chat_id = update.message.chat?.id;
      const text = (update.message.text || "").trim();

      if (!chat_id) return;

      // START
      if (text === "/start" || text.toLowerCase() === "start") {
        return handleStart(chat_id);
      }

      // BOTONES (reply keyboard manda texto)
      if (text === "📣 Compartir BOT") {
        return handleShareBot(chat_id);
      }
      if (text === "🎁 Compartir PROMO") {
        return handleSharePromo(chat_id);
      }

      // fallback: si escribe cualquier cosa, mostramos el menú
      return handleStart(chat_id);
    }
  } catch (e) {
    console.error("Handler error:", e);
  }
});

app.listen(PORT, () => {
  console.log("✅ Server listo en puerto", PORT);
  console.log("✅ Bot:", BOT_USERNAME);
  console.log("✅ Webhook URL esperada:", PUBLIC_URL ? `${PUBLIC_URL}/` : "(PUBLIC_URL vacío)");
});

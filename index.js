import express from "express";
import { Telegraf, Markup } from "telegraf";
import { google } from "googleapis";

/* =========================================================
   ENV (NO CAMBIAR NOMBRES)
========================================================= */
const TelegramBotToken =
  process.env.TelegramBotToken || process.env.TELEGRAM_BOT_TOKEN;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_B64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const PORT = process.env.PORT || 10000;

if (!TelegramBotToken) throw new Error("Falta TelegramBotToken");
if (!GOOGLE_SHEET_ID) throw new Error("Falta GOOGLE_SHEET_ID");
if (!GOOGLE_SERVICE_ACCOUNT_B64) throw new Error("Falta GOOGLE_SERVICE_ACCOUNT_B64");

/* =========================================================
   GOOGLE AUTH
========================================================= */
function decodeServiceAccountB64(b64) {
  const raw = Buffer.from(b64, "base64").toString("utf8").trim();
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_B64 inválido");
  }
  return obj;
}

const sa = decodeServiceAccountB64(GOOGLE_SERVICE_ACCOUNT_B64);

const auth = new google.auth.JWT({
  email: sa.client_email,
  key: sa.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

/* =========================================================
   HELPERS
========================================================= */
function parseYes(v) {
  return String(v || "").trim().toLowerCase() === "si";
}
function parseNumber(v, def = 0) {
  const n = Number(String(v || "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : def;
}
function money(n, moneda = "ARS") {
  const num = Math.round(Number(n) || 0);
  return `${moneda} ${num.toLocaleString("es-AR")}`;
}
function roundARS(n) {
  return Math.round(Number(n) || 0);
}

/* =========================================================
   STATE
========================================================= */
const SESS = new Map();
const ORDER_TIMERS = new Map();

function getSess(chatId) {
  if (!SESS.has(chatId)) {
    SESS.set(chatId, {
      lastMessageId: null,
      lastScreen: "MENU",
      lastScreenData: {},
      category: null,
      productIndex: 0,
      productsInView: [],
      cart: [],
      refBy: null,
      jumpProdCode: null,
      waiting: null,
      checkout: {
        entregaTipo: null,
        pagoTipo: null,
        nombre: "",
        telefono: "",
        direccion: "",
        notas: "",
      },
      pages: { HELP: 0, SHARE: 0, SELLOS: 0 },
    });
  }
  return SESS.get(chatId);
}

function setScreen(sess, screen, data = {}) {
  sess.lastScreen = screen;
  sess.lastScreenData = data;
}

/* =========================================================
   SAFE EDIT (ANTI SPAM CHAT)
========================================================= */
async function safeEditOrSend(ctx, payload) {
  const chatId = ctx.chat?.id;
  const sess = chatId ? getSess(chatId) : null;
  const canEdit = !!sess?.lastMessageId;

  try {
    if (canEdit) {
      await ctx.telegram.editMessageText(
        chatId,
        sess.lastMessageId,
        undefined,
        payload.text || " ",
        { parse_mode: "HTML", ...(payload.extra || {}) }
      );
      return;
    }
  } catch {}

  const msg = await ctx.reply(payload.text || " ", {
    parse_mode: "HTML",
    ...(payload.extra || {}),
  });
  if (sess && msg?.message_id) sess.lastMessageId = msg.message_id;
}

/* =========================================================
   KEYBOARDS
========================================================= */
function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🧀 Catálogo", "MENU_CATALOGO")],
    [
      Markup.button.callback("🎟️ Sellos", "MENU_SELLOS"),
      Markup.button.callback("💬 Ayuda", "MENU_AYUDA"),
    ],
    [Markup.button.callback("📣 Compartir", "MENU_COMPARTIR")],
  ]);
}

function backMenuRows() {
  return [
    [Markup.button.callback("⬅️ Volver", "GO_BACK")],
    [Markup.button.callback("🏠 Menú", "GO_MENU")],
  ];
}

/* =========================================================
   BOT INIT
========================================================= */
const bot = new Telegraf(TelegramBotToken);

/* START */
bot.start(async (ctx) => {
  const sess = getSess(ctx.chat.id);

  const payload = (ctx.startPayload || "").trim();
  if (payload) {
    const mRef = payload.match(/ref_(\d+)/);
    if (mRef) sess.refBy = Number(mRef[1]);
  }

  await safeEditOrSend(ctx, {
    text: `👋 <b>Bienvenido/a</b>\n\nElegí una opción 👇`,
    extra: mainMenuKeyboard(),
  });
});
/* =========================================================
   SELLLOS + AYUDA + COMPARTIR (PAGINADO, NO ENSUCIA CHAT)
========================================================= */

bot.action("MENU_SELLOS", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  sess.pages.SELLOS = 0;

  await safeEditOrSend(ctx, {
    text:
      `🎟️ <b>Tus sellos</b>\n\n` +
      `Cada compra suma sellos automáticamente.\n` +
      `Si compartís el bot y compran, también ganás.\n\n` +
      `💡 Tip: mientras más compartís, más beneficios.`,
    extra: Markup.inlineKeyboard([
      [Markup.button.callback("➡️ Ver beneficios", "SELLOS_NEXT")],
      ...backMenuRows(),
    ]),
  });
});

bot.action("SELLOS_NEXT", async (ctx) => {
  await ctx.answerCbQuery();
  await safeEditOrSend(ctx, {
    text:
      `🏆 <b>Niveles de beneficios</b>\n\n` +
      `• 5 sellos → descuento\n` +
      `• 10 sellos → promo especial\n` +
      `• 20 sellos → regalo\n\n` +
      `📌 Se aplican automáticamente.`,
    extra: Markup.inlineKeyboard(backMenuRows()),
  });
});

/* =========================================================
   AYUDA – ASISTENTE VENDEDOR HUMANO
========================================================= */
bot.action("MENU_AYUDA", async (ctx) => {
  await ctx.answerCbQuery();

  await safeEditOrSend(ctx, {
    text:
      `💬 <b>¿Necesitás ayuda?</b>\n\n` +
      `Estoy acá para ayudarte a comprar fácil y rápido 👌\n\n` +
      `• Consultas sobre productos\n` +
      `• Pagos y envíos\n` +
      `• Promos y sellos\n\n` +
      `📲 Escribinos y te responde una persona real.`,
    extra: Markup.inlineKeyboard([
      [Markup.button.callback("✍️ Hablar con vendedor", "HELP_CONTACT")],
      ...backMenuRows(),
    ]),
  });
});

bot.action("HELP_CONTACT", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  sess.waiting = { type: "HELP_MSG" };

  await safeEditOrSend(ctx, {
    text: `✍️ Escribí tu mensaje.\n\nSe lo enviamos directo al vendedor.`,
    extra: Markup.inlineKeyboard(backMenuRows()),
  });
});

/* =========================================================
   COMPARTIR BOT (WhatsApp / Telegram / Mail)
========================================================= */
bot.action("MENU_COMPARTIR", async (ctx) => {
  await ctx.answerCbQuery();
  const cfg = {};
  const botLink = process.env.BOT_LINK || "";

  const text =
    `🧀 Mirá este bot para pedir fácil y rápido\n` +
    `Promos, descuentos y sellos 🎟️`;

  const wa = `https://wa.me/?text=${encodeURIComponent(text + "\n" + botLink)}`;
  const tg = `https://t.me/share/url?url=${encodeURIComponent(botLink)}&text=${encodeURIComponent(text)}`;
  const mail = `mailto:?subject=Te recomiendo este bot&body=${encodeURIComponent(text + "\n" + botLink)}`;

  await safeEditOrSend(ctx, {
    text: `📣 <b>Compartir el bot</b>\n\nElegí cómo compartir 👇`,
    extra: Markup.inlineKeyboard([
      [
        Markup.button.url("📲 WhatsApp", wa),
        Markup.button.url("✈️ Telegram", tg),
      ],
      [Markup.button.url("✉️ Mail", mail)],
      ...backMenuRows(),
    ]),
  });
});

/* =========================================================
   VENDEDOR CONFIRMA / RECHAZA PEDIDO
========================================================= */
bot.action(/^V_CONFIRM_(.+)$/i, async (ctx) => {
  await ctx.answerCbQuery("Confirmado ✅");

  const orderId = ctx.match[1];

  // Aviso al cliente
  await bot.telegram.sendMessage(
    ctx.chat.id,
    `✅ <b>Pedido confirmado</b>\n\n` +
      `Tu comprobante fue validado.\n` +
      `Estamos preparando tu pedido 🧀\n\n` +
      `📦 Estado: <b>Pendiente de entrega</b>`,
    { parse_mode: "HTML" }
  );

  // Aviso al vendedor
  await ctx.editMessageText(
    `✅ Pedido <b>${orderId}</b>\n\n` +
      `El cliente fue notificado.\n` +
      `📦 En espera de entrega.`,
    { parse_mode: "HTML" }
  );
});

bot.action(/^V_REJECT_(.+)$/i, async (ctx) => {
  await ctx.answerCbQuery("Rechazado ❌");

  await ctx.editMessageText(
    `❌ Pedido rechazado.\n\nEl cliente fue notificado.`,
    { parse_mode: "HTML" }
  );
});

/* =========================================================
   GO BACK / MENU
========================================================= */
bot.action("GO_MENU", async (ctx) => {
  await ctx.answerCbQuery();
  await safeEditOrSend(ctx, {
    text: `🏠 <b>Menú principal</b>\n\nElegí una opción 👇`,
    extra: mainMenuKeyboard(),
  });
});

bot.action("GO_BACK", async (ctx) => {
  await ctx.answerCbQuery();
  await safeEditOrSend(ctx, {
    text: `⬅️ Volvemos al menú`,
    extra: mainMenuKeyboard(),
  });
});

/* =========================================================
   TEXT HANDLER (MENSAJES)
========================================================= */
bot.on("text", async (ctx) => {
  const sess = getSess(ctx.chat.id);
  if (!sess.waiting) return;

  if (sess.waiting.type === "HELP_MSG") {
    sess.waiting = null;

    // ACA se envía al vendedor real
    await bot.telegram.sendMessage(
      process.env.VENDEDOR_CHAT_ID,
      `📩 <b>Mensaje de cliente</b>\n\n${ctx.message.text}`,
      { parse_mode: "HTML" }
    );

    await safeEditOrSend(ctx, {
      text: `✅ Mensaje enviado.\n\nTe respondemos a la brevedad 🙌`,
      extra: mainMenuKeyboard(),
    });
  }
});

/* =========================================================
   SERVER
========================================================= */
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.send("Bot OK"));

if (PUBLIC_URL) {
  bot.telegram.setWebhook(`${PUBLIC_URL}/telegram`);
  app.use(bot.webhookCallback("/telegram"));
}

app.listen(PORT, () => console.log("🚀 Bot activo"));

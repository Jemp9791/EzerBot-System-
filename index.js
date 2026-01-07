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

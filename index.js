// ==========================
// index.js — PARTE 1 / 2
// ==========================

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
if (!GOOGLE_SERVICE_ACCOUNT_B64)
  throw new Error("Falta GOOGLE_SERVICE_ACCOUNT_B64");

/* =========================================================
GOOGLE AUTH
========================================================= */
function decodeServiceAccountB64(b64) {
  const raw = Buffer.from(b64, "base64").toString("utf8").trim();
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_B64 decodifica pero NO es JSON válido."
    );
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
SHEETS HELPERS
========================================================= */
async function getSheetValues(rangeA1) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: rangeA1,
  });
  return res.data.values || [];
}

async function setSheetValues(rangeA1, values) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: rangeA1,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
}

async function appendRow(sheetName, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `${sheetName}!A:Z`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}

/* =========================================================
UTILIDADES GENERALES
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
ESTADO DE SESIÓN (CHAT LIMPIO)
========================================================= */
const SESS = new Map();

function getSess(chatId) {
  if (!SESS.has(chatId)) {
    SESS.set(chatId, {
      cart: [],
      productsInView: [],
      productIndex: 0,
      category: null,

      lastEditableMessageId: null,
      utilityMessageId: null,
      utilityIsAnimation: false,

      checkout: {
        entregaTipo: null,
        pagoTipo: null,
        nombre: "",
        telefono: "",
        direccion: "",
        notas: "",
      },

      waiting: null,
      lastScreen: "MENU",
    });
  }
  return SESS.get(chatId);
}

/* =========================================================
SAFE EDIT (NO ENSUCIA CHAT)
========================================================= */
async function safeEditOrSendEditable(ctx, payload) {
  const chatId = ctx.chat?.id;
  const sess = chatId ? getSess(chatId) : null;
  const msgId = sess?.lastEditableMessageId;

  try {
    if (msgId) {
      if (payload.photo) {
        await ctx.telegram.editMessageMedia(
          chatId,
          msgId,
          undefined,
          {
            type: "photo",
            media: payload.photo,
            caption: payload.caption || "",
            parse_mode: "HTML",
          },
          payload.extra || {}
        );
        return;
      }
      await ctx.telegram.editMessageText(
        chatId,
        msgId,
        undefined,
        payload.text || " ",
        {
          parse_mode: "HTML",
          ...(payload.extra || {}),
        }
      );
      return;
    }
  } catch {}

  const msg = payload.photo
    ? await ctx.replyWithPhoto(payload.photo, {
        caption: payload.caption || "",
        parse_mode: "HTML",
        ...(payload.extra || {}),
      })
    : await ctx.reply(payload.text || " ", {
        parse_mode: "HTML",
        ...(payload.extra || {}),
      });

  if (sess && msg?.message_id) sess.lastEditableMessageId = msg.message_id;
}

/* =========================================================
TELEGRAM BOT
========================================================= */
const bot = new Telegraf(TelegramBotToken);
/* =========================================================
VENDEDOR CONFIRMA / RECHAZA  (FIX DEFINITIVO)
========================================================= */
bot.action(/^V_CONFIRM_(TQ-.+)$/i, async (ctx) => {
  await ctx.answerCbQuery("Confirmado ✅");

  const orderId = ctx.match[1];

  // ⚠️ Acá NO tocamos lógica previa: asumimos que setPedidoEstado ya existe
  const row = await setPedidoEstado(orderId, "APROBADO");
  if (!row) return;

  const chatIdCliente = Number(row[3]);
  const entregaTipo = row[8] || "";
  const pagoTipo = row[9] || "";
  const nombre = row[4] || "";
  const usuario = row[5] || "";
  const itemsText = row[6] || "";
  const total = parseNumber(row[7], 0);
  const direccion = row[10] || "";
  const telefono = row[11] || "";
  const notas = row[12] || "";

  const texto = [
    "✅ <b>Pedido confirmado</b>",
    `<code>${orderId}</code>`,
    "──────────────────",
    `👤 ${nombre} ${usuario ? `(${usuario})` : ""}`,
    `📦 ${itemsText}`,
    `🧮 <b>Total:</b> ${money(total)}`,
    `🚚 <b>Entrega:</b> ${entregaTipo}`,
    `💳 <b>Pago:</b> ${pagoTipo}`,
    direccion ? `📍 <b>Dirección:</b> ${direccion}` : "",
    telefono ? `📞 <b>Tel:</b> ${telefono}` : "",
    notas ? `📝 <b>Notas:</b> ${notas}` : "",
    "──────────────────",
    "🧑‍🍳 Ya estamos preparando tu pedido.",
    "🔔 Te avisamos cuando esté listo.",
  ]
    .filter(Boolean)
    .join("\n");

  // Cliente → 1 solo mensaje
  if (Number.isFinite(chatIdCliente)) {
    await bot.telegram.sendMessage(chatIdCliente, texto, {
      parse_mode: "HTML",
    });
  }

  // Vendedor → intenta editar (carrusel)
  try {
    await ctx.editMessageText(`${texto}\n\n✅ <b>Estado:</b> APROBADO`, {
      parse_mode: "HTML",
    });
  } catch {
    // fallback único, no ensucia
    await ctx.telegram.sendMessage(
      ctx.chat.id,
      `${texto}\n\n✅ <b>Estado:</b> APROBADO`,
      { parse_mode: "HTML" }
    );
  }
});

/* =========================================================
WEB SERVER
========================================================= */
const app = express();
app.use(express.json());

app.get("/", (_, res) => res.send("Bot OK"));

async function start() {
  if (PUBLIC_URL && PUBLIC_URL.startsWith("http")) {
    const hook = `${PUBLIC_URL.replace(/\/$/, "")}/telegram`;
    await bot.telegram.setWebhook(hook);
    app.use(bot.webhookCallback("/telegram"));
    app.listen(PORT, () =>
      console.log("Webhook activo en", hook, "Puerto", PORT)
    );
  } else {
    bot.launch();
    app.listen(PORT, () =>
      console.log("Long polling activo | Puerto", PORT)
    );
  }
}

start();

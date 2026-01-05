import express from "express";
import { Telegraf, Markup } from "telegraf";
import { google } from "googleapis";

/* =========================
   NOTA IMPORTANTE
   NO CAMBIAR VARIABLES
========================= */
const BOT_TOKEN = process.env.BOT_TOKEN;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_B64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const BOT_LINK = process.env.BOT_LINK || "";

if (!BOT_TOKEN) throw new Error("Falta BOT_TOKEN");
if (!GOOGLE_SHEET_ID) throw new Error("Falta GOOGLE_SHEET_ID");
if (!GOOGLE_SERVICE_ACCOUNT_B64) throw new Error("Falta GOOGLE_SERVICE_ACCOUNT_B64");

/* =========================
   GOOGLE AUTH
========================= */
function decodeServiceAccount(b64) {
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}
const sa = decodeServiceAccount(GOOGLE_SERVICE_ACCOUNT_B64);

const auth = new google.auth.JWT({
  email: sa.client_email,
  key: sa.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

/* =========================
   HELPERS SHEETS
========================= */
async function getValues(range) {
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range,
  });
  return r.data.values || [];
}
async function setValues(range, values) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: GOOGLE_SHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
}
async function appendRow(sheet, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `${sheet}!A:Z`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

/* =========================
   UTILS
========================= */
const yes = (v) => String(v || "").toLowerCase() === "si";
const num = (v, d = 0) => (isNaN(Number(v)) ? d : Number(v));
const money = (n, m = "ARS") => `${m} ${Math.round(n).toLocaleString("es-AR")}`;
const nowISO = () => new Date().toISOString();
const in1hISO = () => new Date(Date.now() + 60 * 60000).toISOString();
const token = () => Math.random().toString(36).substring(2, 10).toUpperCase();

/* =========================
   BADGES VISUALES
========================= */
const B_CLIENTE = "🟦 <b>CLIENTE</b>";
const B_VENDEDOR = "🟧 <b>VENDEDOR</b>";
const B_OK = "🟩 <b>PAGO CONFIRMADO</b>";
const B_PEND = "🟨 <b>PAGO PENDIENTE</b>";
const B_CANCEL = "🟥 <b>CANCELADO</b>";

/* =========================
   BOT
========================= */
const bot = new Telegraf(BOT_TOKEN);

/* =========================
   MEMORIA SIMPLE
========================= */
const SESS = new Map();
function S(chat) {
  if (!SESS.has(chat)) {
    SESS.set(chat, {
      cart: [],
      step: null,
      entrega: null,
      pago: null,
      nombre: "",
      telefono: "",
      direccion: "",
      lastMsg: null,
    });
  }
  return SESS.get(chat);
}

/* =========================
   SAFE SEND (NO SPAM)
========================= */
async function send(ctx, text, kb) {
  const s = S(ctx.chat.id);
  try {
    if (s.lastMsg) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        s.lastMsg,
        null,
        text,
        { parse_mode: "HTML", ...kb }
      );
      return;
    }
  } catch {}
  const m = await ctx.reply(text, { parse_mode: "HTML", ...kb });
  s.lastMsg = m.message_id;
}

/* =========================
   CONFIG
========================= */
async function loadConfig() {
  const rows = await getValues("Config!A:B");
  const cfg = {};
  rows.forEach(r => cfg[r[0]] = r[1]);
  return cfg;
}

/* =========================
   CATALOGO
========================= */
async function loadCatalogo() {
  const rows = await getValues("Catalogo!A1:Z");
  const h = rows[0];
  return rows.slice(1).map(r => ({
    codigo: r[h.indexOf("codigo")],
    nombre: r[h.indexOf("nombre")],
    precio: num(r[h.indexOf("precio")]),
    unidad: r[h.indexOf("unidad")],
    categoria: r[h.indexOf("categoria")],
  }));
}

/* =========================
   MENU INICIAL (CON LOGO)
========================= */
bot.start(async ctx => {
  const cfg = await loadConfig();
  const logo = cfg.LogoURL;
  const txt = `
${B_CLIENTE}
🏠 <b>${cfg.NegocioNombre}</b>
📍 ${cfg.NegocioDireccion || ""}
🕒 ${cfg.NegocioHorario || ""}

${cfg.Descripcion || ""}
`.trim();

  if (logo) {
    const m = await ctx.replyWithPhoto(logo, {
      caption: txt,
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback("🧀 Catálogo", "CAT")],
        [Markup.button.callback("🎟️ Sellos", "SELL")],
      ]).reply_markup,
    });
    S(ctx.chat.id).lastMsg = m.message_id;
  } else {
    await send(ctx, txt, Markup.inlineKeyboard([
      [Markup.button.callback("🧀 Catálogo", "CAT")],
      [Markup.button.callback("🎟️ Sellos", "SELL")],
    ]));
  }
});




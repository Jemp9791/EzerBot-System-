import express from "express";
import { Telegraf, Markup } from "telegraf";
import { google } from "googleapis";

/* =========================
   ENV (FIJAS)
========================= */
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_B64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
const PUBLIC_URL = process.env.PUBLIC_URL || "";

if (!TELEGRAM_BOT_TOKEN) throw new Error("Falta TELEGRAM_BOT_TOKEN");
if (!GOOGLE_SHEET_ID) throw new Error("Falta GOOGLE_SHEET_ID");
if (!GOOGLE_SERVICE_ACCOUNT_B64) throw new Error("Falta GOOGLE_SERVICE_ACCOUNT_B64");

/* =========================
   GOOGLE AUTH
========================= */
const sa = JSON.parse(
  Buffer.from(GOOGLE_SERVICE_ACCOUNT_B64, "base64").toString("utf8")
);

const auth = new google.auth.JWT({
  email: sa.client_email,
  key: sa.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

async function getSheet(range) {
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range,
  });
  return r.data.values || [];
}

/* =========================
   CONFIG
========================= */
async function loadConfig() {
  const rows = await getSheet("Config!A:B");
  const cfg = {};
  rows.forEach(r => {
    if (r[0]) cfg[String(r[0]).trim()] = String(r[1] || "").trim();
  });
  return cfg;
}

/* =========================
   CATALOGO
========================= */
async function loadCatalog() {
  const rows = await getSheet("Catalogo!A1:Z");
  if (!rows.length) return [];

  const headers = rows[0].map(h => String(h).toLowerCase());
  return rows.slice(1).map(r => ({
    codigo: r[headers.indexOf("codigo")] || "",
    nombre: r[headers.indexOf("nombre")] || "",
    precio: Number(r[headers.indexOf("precio")] || 0),
    categoria: r[headers.indexOf("categoria")] || "General",
    imagen: r[headers.indexOf("imagen")] || "",
    unidad: r[headers.indexOf("unidad")] || "unidad" // preparado
  }));
}

/* =========================
   BOT
========================= */
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const SESS = new Map();

function sess(id) {
  if (!SESS.has(id)) {
    SESS.set(id, { cart: [] });
  }
  return SESS.get(id);
}

bot.start(async (ctx) => {
  const cfg = await loadConfig();
  await ctx.reply(
    `🧀 *${cfg.NegocioNombre || "Todo Queso"}*\n` +
    `${cfg.Estado || ""}\n\n` +
    `Elegí una opción 👇`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🧀 Catálogo", "CAT")],
      [Markup.button.callback("🎟️ Sellos", "SELLOS")],
      [Markup.button.callback("ℹ️ Ayuda", "AYUDA")]
    ]).parse_mode("Markdown")
  );
});

bot.action("CAT", async (ctx) => {
  const items = await loadCatalog();
  const buttons = items.map(p =>
    [Markup.button.callback(`${p.nombre} - $${p.precio}`, `PROD_${p.codigo}`)]
  );
  await ctx.editMessageText(
    "🧀 *Catálogo*",
    Markup.inlineKeyboard(buttons).parse_mode("Markdown")
  );
});

bot.action(/PROD_(.+)/, async (ctx) => {
  const code = ctx.match[1];
  const items = await loadCatalog();
  const p = items.find(x => x.codigo === code);
  if (!p) return;

  sess(ctx.chat.id).cart.push({ ...p, qty: 1 });

  await ctx.editMessageText(
    `✅ Agregado:\n*${p.nombre}*\n$${p.precio}`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🛒 Finalizar compra", "BUY")],
      [Markup.button.callback("⬅️ Volver", "CAT")]
    ]).parse_mode("Markdown")
  );
});

bot.action("BUY", async (ctx) => {
  const s = sess(ctx.chat.id);
  const total = s.cart.reduce((a, b) => a + b.precio * b.qty, 0);
  await ctx.editMessageText(
    `🧾 *Resumen*\n` +
    s.cart.map(i => `• ${i.nombre} x${i.qty}`).join("\n") +
    `\n\nTotal: $${total}`,
    Markup.inlineKeyboard([
      [Markup.button.callback("❌ Cancelar", "CANCEL")],
      [Markup.button.callback("✅ Confirmar", "OK")]
    ]).parse_mode("Markdown")
  );
});

bot.action("CANCEL", async (ctx) => {
  sess(ctx.chat.id).cart = [];
  await ctx.editMessageText("❌ Compra cancelada.");
});

bot.action("OK", async (ctx) => {
  sess(ctx.chat.id).cart = [];
  await ctx.editMessageText("✅ Pedido enviado al vendedor.");
});

/* =========================
   SERVER
========================= */
const app = express();
app.get("/", (_, res) => res.send("EzerBot OK"));

const PORT = process.env.PORT || 10000;

if (PUBLIC_URL) {
  bot.telegram.setWebhook(`${PUBLIC_URL}/telegram`);
  app.use(bot.webhookCallback("/telegram"));
} else {
  bot.launch();
}

app.listen(PORT, () => console.log("EzerBot listo"));

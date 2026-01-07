// ===============================
// IMPORTS
// ===============================
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

async function listSheets() {
  const res = await sheets.spreadsheets.get({
    spreadsheetId: GOOGLE_SHEET_ID,
  });
  return (res.data.sheets || []).map((s) => s.properties.title);
}

async function ensureSheet(sheetName, headers) {
  const existing = await listSheets();
  if (!existing.includes(sheetName)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: GOOGLE_SHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: sheetName } } }],
      },
    });
    await setSheetValues(`${sheetName}!A1`, [headers]);
  }
}

/* =========================================================
   CONFIG HELPERS
========================================================= */
function kvFromRows(rows) {
  const out = {};
  for (const r of rows) {
    const k = (r[0] || "").toString().trim();
    const v = (r[1] || "").toString().trim();
    if (k) out[k] = v;
  }
  return out;
}

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

function splitPipes(v) {
  const s = String(v || "").trim();
  if (!s) return [];
  return s.split("|").map((x) => x.trim()).filter(Boolean);
}

function pickRandom(arr) {
  if (!arr || !arr.length) return "";
  return arr[Math.floor(Math.random() * arr.length)];
}

function roundARS(n) {
  return Math.round(Number(n) || 0);
}

/* =========================================================
   (SIGUE EN PARTE 2)
========================================================= */
/* =========================================================
   STATE + NAV
========================================================= */
const SESS = new Map();
const ORDER_TIMERS = new Map();

function getSess(chatId) {
  if (!SESS.has(chatId)) {
    SESS.set(chatId, {
      mode: "MENU",
      category: null,
      productIndex: 0,
      productsInView: [],
      cart: [],
      refBy: null,
      lastMessageId: null,
      checkout: {
        entregaTipo: null,
        pagoTipo: null,
        nombre: "",
        telefono: "",
        direccion: "",
        notas: "",
      },
      waiting: null,
      jumpProdCode: null,
      lastScreen: "MENU",
      lastScreenData: {},
      pages: { HELP: 0, SHARE: 0, SELLOS: 0 },
    });
  }
  return SESS.get(chatId);
}

function setScreen(sess, screen, data = {}) {
  sess.lastScreen = screen;
  sess.lastScreenData = data || {};
}

/* =========================================================
   SHEETS MODELO
========================================================= */
const CLIENTES_SHEET = "Clientes";
const PEDIDOS_SHEET = "Pedidos";

const CLIENTES_HEADERS = [
  "ChatId",
  "Nombre",
  "Usuario",
  "Sellos",
  "TotalComprado",
  "UltimaCompraISO",
  "ReferidoPor",
  "ReferidosGanados",
];

const PEDIDOS_HEADERS = [
  "PedidoId",
  "FechaISO",
  "ExpiraISO",
  "ChatIdCliente",
  "NombreCliente",
  "UsuarioCliente",
  "Items",
  "Total",
  "EntregaTipo",
  "PagoTipo",
  "Direccion",
  "Telefono",
  "Notas",
  "Estado",
  "RefBy",
];

async function ensureBaseSheets() {
  await ensureSheet(CLIENTES_SHEET, CLIENTES_HEADERS);
  await ensureSheet(PEDIDOS_SHEET, PEDIDOS_HEADERS);
}

/* =========================================================
   SELLADO CORRECTO (SOLO AL CONFIRMAR VENDEDOR)
========================================================= */
async function aplicarSellosConfirmados({ chatIdCliente, refBy, total, cfg }) {
  const usaSellos = parseYes(cfg.UsaSellos || "SI");
  if (!usaSellos) return;

  const montoPorSello = parseNumber(cfg.MontoPorSello || "10000", 10000);
  const sellosGanados = Math.floor(total / montoPorSello);

  const rows = await getSheetValues(`${CLIENTES_SHEET}!A2:H`);
  const idx = rows.findIndex((r) => String(r[0]) === String(chatIdCliente));

  if (idx === -1) return;

  const row = rows[idx];
  const rowNumber = idx + 2;

  const sellosActuales = parseNumber(row[3], 0);
  const totalActual = parseNumber(row[4], 0);
  const refGanados = parseNumber(row[7], 0);

  await setSheetValues(`${CLIENTES_SHEET}!A${rowNumber}:H${rowNumber}`, [[
    row[0],
    row[1],
    row[2],
    sellosActuales + sellosGanados,
    totalActual + total,
    new Date().toISOString(),
    row[6],
    refGanados,
  ]]);

  // 👉 Sellos por referido
  if (refBy) {
    const bonus = parseNumber(cfg.BonusSellosShare || "1", 1);
    for (let i = 0; i < bonus; i++) {
      await addSelloReferido(refBy);
    }
  }
}

/* =========================================================
   AYUDA – TEXTO VENDEDOR CONVINCENTE
========================================================= */
async function showHelpPaged(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  setScreen(sess, "HELP");

  const nombre = cfg.NegocioNombre || "nuestro local";
  const mail = cfg.Email || cfg.Mail || "";

  const pages = [
    [
      `🤝 <b>¿Necesitás ayuda?</b>`,
      ``,
      `Estoy acá para acompañarte paso a paso 💙`,
      ``,
      `🧀 Elegí productos`,
      `🛒 Armá tu pedido`,
      `💳 Pagá como prefieras`,
      `🚚 Retirá o recibí en tu casa`,
      ``,
      `📌 Todo es simple, rápido y seguro.`,
    ].join("\n"),
    [
      `✨ <b>¿Por qué comprar en ${nombre}?</b>`,
      ``,
      `✔️ Productos seleccionados`,
      `✔️ Atención personalizada`,
      `✔️ Beneficios con sellos`,
      `✔️ Respuesta humana, no automática`,
      ``,
      mail ? `📧 También podés escribirnos a: <b>${mail}</b>` : ``,
    ].join("\n"),
  ];

  const page = Math.max(0, Math.min(sess.pages.HELP || 0, pages.length - 1));
  sess.pages.HELP = page;

  const kb = pagerKb("HELP", page, pages.length);

  await safeEditOrSend(ctx, { text: pages[page], extra: kb });
}

/* =========================================================
   COMPARTIR BOT – AGREGA MAIL
========================================================= */
async function showShareBotPaged(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  setScreen(sess, "SHARE");

  const botLink = String(cfg.BotLink || "").trim();
  const mail = cfg.Email || cfg.Mail || "";

  const textShare =
    String(cfg.TextoCompartirBot || "").trim() ||
    `🧀 Pedí en ${cfg.NegocioNombre || "nuestro local"} fácil y rápido.\n${
      mail ? "📧 " + mail : ""
    }`;

  const links = buildShareLinks({ botLink, text: textShare });

  const kb = Markup.inlineKeyboard([
    [Markup.button.url("📲 WhatsApp", links.wa)],
    [Markup.button.url("✈️ Telegram", links.tg)],
    ...backMenuRows(),
  ]);

  await safeEditOrSend(ctx, {
    text: `📣 <b>Compartí nuestro bot</b>\n\n${textShare}`,
    extra: kb,
  });
}

/* =========================================================
   VENDEDOR CONFIRMA – ACÁ SE SUMAN LOS SELLOS
========================================================= */
bot.action(/^V_CONFIRM_(TQ-.+)$/i, async (ctx) => {
  await ctx.answerCbQuery("Confirmado ✅");

  const cfg = await loadConfig();
  const orderId = ctx.match[1];
  const row = await setPedidoEstado(orderId, "APROBADO");
  if (!row) return;

  const chatIdCliente = Number(row[3]);
  const total = parseNumber(row[7], 0);
  const refBy = row[14] || "";

  // ✅ AHORA sí sumamos sellos
  await aplicarSellosConfirmados({
    chatIdCliente,
    refBy,
    total,
    cfg,
  });

  await ctx.editMessageText(
    `✅ Pedido <b>${orderId}</b> confirmado.\n\nSellos acreditados correctamente.`,
    { parse_mode: "HTML" }
  );
});

/* =========================================================
   SERVER
========================================================= */
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.status(200).send("EzerBot OK ✅"));

async function start() {
  await ensureBaseSheets();

  if (PUBLIC_URL && PUBLIC_URL.startsWith("http")) {
    const hook = `${PUBLIC_URL.replace(/\/$/, "")}/telegram`;
    await bot.telegram.setWebhook(hook);
    app.use(bot.webhookCallback("/telegram"));
    app.listen(PORT, () =>
      console.log(`✅ Webhook activo: ${hook} | Puerto ${PORT}`)
    );
  } else {
    bot.launch();
    app.listen(PORT, () =>
      console.log(`✅ Long polling activo | Puerto ${PORT}`)
    );
  }
}

start().catch((e) => {
  console.error("FATAL:", e?.message || e);
  process.exit(1);
});

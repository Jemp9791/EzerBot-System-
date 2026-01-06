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
    throw new Error("GOOGLE_SERVICE_ACCOUNT_B64 decodifica pero NO es JSON válido.");
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
  const res = await sheets.spreadsheets.get({ spreadsheetId: GOOGLE_SHEET_ID });
  return (res.data.sheets || []).map((s) => s.properties.title);
}

async function ensureSheet(sheetName, headers) {
  const existing = await listSheets();
  if (!existing.includes(sheetName)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: GOOGLE_SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
    });
    await setSheetValues(`${sheetName}!A1`, [headers]);
    return;
  }

  const firstRow = await getSheetValues(`${sheetName}!A1:Z1`);
  if (!firstRow.length || firstRow[0].join("").trim() === "") {
    await setSheetValues(`${sheetName}!A1`, [headers]);
  } else {
    const cur = firstRow[0].map((x) => String(x || "").trim());
    const set = new Set(cur.map((x) => x.toLowerCase()));
    const missing = headers.filter((h) => !set.has(String(h).toLowerCase()));
    if (missing.length) {
      const merged = [...cur, ...missing];
      await setSheetValues(`${sheetName}!A1`, [merged]);
    }
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
  return s
    .split("|")
    .map((x) => x.trim())
    .filter(Boolean);
}

function pickRandom(arr) {
  if (!arr || !arr.length) return "";
  return arr[Math.floor(Math.random() * arr.length)];
}

function roundARS(n) {
  return Math.round(Number(n) || 0);
}

/* =========================================================
CATALOGO HELPERS
========================================================= */
function normalizeHeaders(headerRow) {
  const map = {};
  headerRow.forEach((h, i) => {
    const key = String(h || "").trim().toLowerCase().replace(/\s+/g, "");
    if (key) map[key] = i;
  });
  return map;
}

function pick(row, hmap, keys, def = "") {
  for (const k of keys) {
    const idx = hmap[k];
    if (idx !== undefined && row[idx] !== undefined && row[idx] !== "") return row[idx];
  }
  return def;
}

function inferUnit(raw) {
  const u = String(raw || "").trim().toLowerCase();
  if (!u) return "u";
  if (u.includes("gr") || u === "g" || u.includes("gram")) return "g";
  if (u.includes("kg") || u.includes("kilo")) return "g";
  if (u.includes("unidad") || u === "u" || u.includes("unid")) return "u";
  if (u.includes("pack")) return "u";
  return "u";
}

/* =========================================================
CACHE (B)
========================================================= */
const CACHE = {
  cfg: { value: null, ts: 0, inflight: null },
  cat: { value: null, ts: 0, inflight: null },
};
const CFG_TTL_MS = 10_000;
const CAT_TTL_MS = 20_000;

async function loadConfigRaw() {
  const rows = await getSheetValues(`Config!A:B`);
  return kvFromRows(rows);
}

async function loadCatalogRaw() {
  const rows = await getSheetValues(`Catalogo!A1:Z`);
  if (!rows.length) return { items: [], headers: {} };
  const headerRow = rows[0];
  const hmap = normalizeHeaders(headerRow);
  const data = rows.slice(1).filter((r) => r.some((c) => String(c || "").trim() !== ""));

  const items = data.map((r, i) => {
    const code = String(pick(r, hmap, ["codigo", "codigoproducto", "id", "sku"], "")).trim() || `P${i + 1}`;
    const name = String(pick(r, hmap, ["nombre", "producto", "name"], "Producto")).trim();
    const price = parseNumber(pick(r, hmap, ["precio", "price"], 0), 0);
    const pricePerKg = parseNumber(pick(r, hmap, ["precioporkg", "preciokg", "precio_kg"], 0), 0);
    const unitRaw = pick(r, hmap, ["unidad", "unit", "tipo", "medida"], "");
    const unit = inferUnit(unitRaw);
    const cat = String(pick(r, hmap, ["categoria", "categoría", "rubro"], "General")).trim() || "General";
    const img = String(pick(r, hmap, ["imagenurl", "imagen", "foto", "urlimagen"], "")).trim();
    const desc = String(pick(r, hmap, ["descripcion", "descripción", "detalle"], "")).trim();
    const isCombo = String(pick(r, hmap, ["combo", "escombo"], "")).trim();
    return { code, name, price, pricePerKg, unit, cat, img, desc, isCombo };
  });

  return { items, headers: hmap };
}

async function loadConfig() {
  const now = Date.now();
  if (CACHE.cfg.value && now - CACHE.cfg.ts < CFG_TTL_MS) return CACHE.cfg.value;
  if (CACHE.cfg.inflight) return CACHE.cfg.inflight;

  CACHE.cfg.inflight = (async () => {
    const v = await loadConfigRaw();
    CACHE.cfg.value = v;
    CACHE.cfg.ts = Date.now();
    CACHE.cfg.inflight = null;
    return v;
  })().catch((e) => {
    CACHE.cfg.inflight = null;
    throw e;
  });

  return CACHE.cfg.inflight;
}

async function loadCatalog() {
  const now = Date.now();
  if (CACHE.cat.value && now - CACHE.cat.ts < CAT_TTL_MS) return CACHE.cat.value;
  if (CACHE.cat.inflight) return CACHE.cat.inflight;

  CACHE.cat.inflight = (async () => {
    const v = await loadCatalogRaw();
    CACHE.cat.value = v;
    CACHE.cat.ts = Date.now();
    CACHE.cat.inflight = null;
    return v;
  })().catch((e) => {
    CACHE.cat.inflight = null;
    throw e;
  });

  return CACHE.cat.inflight;
}

function categoriesFromItems(items) {
  const set = new Set();
  for (const it of items) set.add(it.cat || "General");
  return Array.from(set).sort((a, b) => a.localeCompare(b, "es"));
}

/* =========================================================
STATE (chat limpio + flujo)
========================================================= */
const SESS = new Map(); // chatId -> state
const ORDER_TIMERS = new Map(); // orderId -> timeout

function getSess(chatId) {
  if (!SESS.has(chatId)) {
    SESS.set(chatId, {
      mode: "MENU",
      category: null,
      productIndex: 0,
      productsInView: [],
      cart: [],
      refBy: null,

      // ✅ separados: mensaje editable vs utilidades (GIF)
      lastEditableMessageId: null, // catálogo/carrito/checkout (se edita)
      utilityMessageId: null, // menú/sellos/ayuda/compartir
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
      jumpProdCode: null,

      lastScreen: "MENU",
      lastScreenData: {},
    });
  }
  return SESS.get(chatId);
}

function setScreen(sess, screen, data = {}) {
  sess.lastScreen = screen;
  sess.lastScreenData = data || {};
}

/* =========================================================
SHEETS MODELO (ROBUSTO POR HEADERS)
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

// map headers -> idx
function headerIndexMap(headerRow) {
  const m = {};
  headerRow.forEach((h, i) => {
    const k = String(h || "").trim().toLowerCase();
    if (k) m[k] = i;
  });
  return m;
}

async function readTable(sheetName) {
  const rows = await getSheetValues(`${sheetName}!A1:Z`);
  const header = rows[0] || [];
  const data = rows.slice(1) || [];
  const hmap = headerIndexMap(header);
  return { header, hmap, data };
}

function getCell(row, hmap, colName, def = "") {
  const idx = hmap[String(colName || "").toLowerCase()];
  if (idx === undefined) return def;
  return row[idx] !== undefined ? row[idx] : def;
}

function setCell(row, hmap, colName, value) {
  const idx = hmap[String(colName || "").toLowerCase()];
  if (idx === undefined) return row;
  const r = [...row];
  while (r.length <= idx) r.push("");
  r[idx] = value;
  return r;
}

async function writeRow(sheetName, rowNumber1based, rowArray) {
  await setSheetValues(`${sheetName}!A${rowNumber1based}:Z${rowNumber1based}`, [rowArray]);
}

async function upsertCliente({ chatId, nombre, usuario, addSellos = 0, addTotal = 0, refBy = "" }) {
  const { header, hmap, data } = await readTable(CLIENTES_SHEET);

  const idxRow = data.findIndex((r) => String(getCell(r, hmap, "ChatId", "")) === String(chatId));
  const now = new Date().toISOString();

  if (idxRow === -1) {
    const newRow = new Array(header.length).fill("");
    let r = newRow;
    r = setCell(r, hmap, "ChatId", String(chatId));
    r = setCell(r, hmap, "Nombre", nombre || "");
    r = setCell(r, hmap, "Usuario", usuario || "");
    r = setCell(r, hmap, "Sellos", Number(addSellos) || 0);
    r = setCell(r, hmap, "TotalComprado", Number(addTotal) || 0);
    r = setCell(r, hmap, "UltimaCompraISO", now);
    r = setCell(r, hmap, "ReferidoPor", refBy || "");
    r = setCell(r, hmap, "ReferidosGanados", 0);
    await appendRow(CLIENTES_SHEET, r);
    return { sellos: Number(addSellos) || 0, total: Number(addTotal) || 0 };
  }

  const row = data[idxRow];
  const currentSellos = parseNumber(getCell(row, hmap, "Sellos", 0), 0);
  const currentTotal = parseNumber(getCell(row, hmap, "TotalComprado", 0), 0);
  const currentRefGanados = parseNumber(getCell(row, hmap, "ReferidosGanados", 0), 0);
  const currentRefBy = String(getCell(row, hmap, "ReferidoPor", "") || "");

  const newSellos = currentSellos + (Number(addSellos) || 0);
  const newTotal = currentTotal + (Number(addTotal) || 0);

  let newRow = [...row];
  newRow = setCell(newRow, hmap, "ChatId", String(chatId));
  newRow = setCell(newRow, hmap, "Nombre", nombre || getCell(row, hmap, "Nombre", ""));
  newRow = setCell(newRow, hmap, "Usuario", usuario || getCell(row, hmap, "Usuario", ""));
  newRow = setCell(newRow, hmap, "Sellos", newSellos);
  newRow = setCell(newRow, hmap, "TotalComprado", newTotal);
  newRow = setCell(newRow, hmap, "UltimaCompraISO", now);
  newRow = setCell(newRow, hmap, "ReferidoPor", currentRefBy || refBy || "");
  newRow = setCell(newRow, hmap, "ReferidosGanados", currentRefGanados);

  const rowNumber = idxRow + 2; // header=1
  await writeRow(CLIENTES_SHEET, rowNumber, newRow);

  return { sellos: newSellos, total: newTotal };
}

async function addSelloReferido(chatIdReferente) {
  const { hmap, data } = await readTable(CLIENTES_SHEET);
  const idxRow = data.findIndex((r) => String(getCell(r, hmap, "ChatId", "")) === String(chatIdReferente));
  if (idxRow === -1) return;

  const row = data[idxRow];
  const currentSellos = parseNumber(getCell(row, hmap, "Sellos", 0), 0);
  const currentRefGanados = parseNumber(getCell(row, hmap, "ReferidosGanados", 0), 0);

  let newRow = [...row];
  newRow = setCell(newRow, hmap, "Sellos", currentSellos + 1);
  newRow = setCell(newRow, hmap, "ReferidosGanados", currentRefGanados + 1);
  newRow = setCell(newRow, hmap, "UltimaCompraISO", new Date().toISOString());

  const rowNumber = idxRow + 2;
  await writeRow(CLIENTES_SHEET, rowNumber, newRow);
}

async function readPedidos() {
  return await readTable(PEDIDOS_SHEET);
}

async function findPedidoRow(orderId) {
  const { hmap, data } = await readPedidos();
  const idxRow = data.findIndex((r) => String(getCell(r, hmap, "PedidoId", "")) === String(orderId));
  if (idxRow === -1) return null;
  return { idx: idxRow, row: data[idxRow], rowNumber: idxRow + 2, hmap };
}

async function setPedidoEstado(orderId, newEstado) {
  const found = await findPedidoRow(orderId);
  if (!found) return null;
  const { row, rowNumber, hmap } = found;

  let newRow = [...row];
  newRow = setCell(newRow, hmap, "Estado", newEstado);

  await writeRow(PEDIDOS_SHEET, rowNumber, newRow);
  return newRow; // ⬅️ mantenemos esto para no romper lo demás
}

/* =========================================================
✅ FIX NUEVO: LECTOR ROBUSTO POR HEADERS (para vendedor/vencimiento)
========================================================= */
async function getPedidoById(orderId) {
  const found = await findPedidoRow(orderId);
  if (!found) return null;
  // found.row YA ESTÁ alineado a headers; devolvemos hmap para leer seguro
  return { row: found.row, hmap: found.hmap };
}

async function expireOldPending() {
  const { hmap, data } = await readPedidos();
  const now = Date.now();

  for (let i = 0; i < data.length; i++) {
    const r = data[i];
    const expIso = String(getCell(r, hmap, "ExpiraISO", "") || "");
    const estado = String(getCell(r, hmap, "Estado", "") || "").toUpperCase();
    if (!expIso || estado !== "PENDIENTE") continue;

    const exp = Date.parse(expIso);
    if (Number.isFinite(exp) && exp <= now) {
      let newRow = [...r];
      newRow = setCell(newRow, hmap, "Estado", "VENCIDO");
      await writeRow(PEDIDOS_SHEET, i + 2, newRow);
    }
  }
}

/* =========================================================
UI HELPERS (chat limpio)
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
          { type: "photo", media: payload.photo, caption: payload.caption || "", parse_mode: "HTML" },
          payload.extra || {}
        );
        return;
      }
      await ctx.telegram.editMessageText(chatId, msgId, undefined, payload.text || " ", {
        parse_mode: "HTML",
        ...(payload.extra || {}),
      });
      return;
    }
  } catch {}

  let msg;
  if (payload.photo) {
    msg = await ctx.replyWithPhoto(payload.photo, {
      caption: payload.caption || "",
      parse_mode: "HTML",
      ...(payload.extra || {}),
    });
  } else {
    msg = await ctx.reply(payload.text || " ", { parse_mode: "HTML", ...(payload.extra || {}) });
  }

  if (sess && msg?.message_id) sess.lastEditableMessageId = msg.message_id;
}

async function safeEditOrSendUtility(ctx, payload) {
  const chatId = ctx.chat?.id;
  const sess = chatId ? getSess(chatId) : null;

  const msgId = sess?.utilityMessageId;
  const isAnim = !!sess?.utilityIsAnimation;

  if (msgId) {
    try {
      if (isAnim) {
        await ctx.telegram.editMessageCaption(chatId, msgId, undefined, payload.caption || payload.text || " ", {
          parse_mode: "HTML",
          ...(payload.extra || {}),
        });
        return;
      }

      if (payload.photo) {
        await ctx.telegram.editMessageMedia(
          chatId,
          msgId,
          undefined,
          { type: "photo", media: payload.photo, caption: payload.caption || "", parse_mode: "HTML" },
          payload.extra || {}
        );
        return;
      }

      await ctx.telegram.editMessageText(chatId, msgId, undefined, payload.text || " ", {
        parse_mode: "HTML",
        ...(payload.extra || {}),
      });
      return;
    } catch {}
  }

  let msg;
  if (payload.animation) {
    msg = await ctx.replyWithAnimation(payload.animation, {
      caption: payload.caption || "",
      parse_mode: "HTML",
      reply_markup: payload.extra?.reply_markup || undefined,
    });
    if (sess && msg?.message_id) {
      sess.utilityMessageId = msg.message_id;
      sess.utilityIsAnimation = true;
    }
    return;
  }

  if (payload.photo) {
    msg = await ctx.replyWithPhoto(payload.photo, {
      caption: payload.caption || "",
      parse_mode: "HTML",
      ...(payload.extra || {}),
    });
    if (sess && msg?.message_id) {
      sess.utilityMessageId = msg.message_id;
      sess.utilityIsAnimation = false;
    }
    return;
  }

  msg = await ctx.reply(payload.text || " ", { parse_mode: "HTML", ...(payload.extra || {}) });
  if (sess && msg?.message_id) {
    sess.utilityMessageId = msg.message_id;
    sess.utilityIsAnimation = false;
  }
}

/* =========================================================
KEYBOARDS
========================================================= */
function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🧀 Catálogo", "MENU_CATALOGO")],
    [Markup.button.callback("🎟️ Sellos", "MENU_SELLOS"), Markup.button.callback("ℹ️ Ayuda", "MENU_AYUDA")],
    [Markup.button.callback("📣 Compartir", "MENU_COMPARTIR")],
  ]);
}

function goMenuRow() {
  return [Markup.button.callback("🏠 Menú", "GO_MENU")];
}

function backMenuRows() {
  return [[Markup.button.callback("⬅️ Volver", "GO_BACK")], goMenuRow()];
}

/* =========================================================
PRODUCT UI
========================================================= */
function productCaption(cfg, p, index, total) {
  const moneda = cfg.Moneda || "ARS";
  const showPrice = parseYes(cfg.CatalogoMostrarPrecios || "SI");
  const lines = [];
  lines.push(`<b>${p.name}</b>`);

  if (showPrice) {
    if (p.unit === "g" && p.pricePerKg > 0) lines.push(`💰 <b>${money(p.pricePerKg, moneda)}</b> / kg`);
    else lines.push(`💰 <b>${money(p.price, moneda)}</b>`);
  }

  if (p.desc) lines.push(`\n${p.desc}`);
  lines.push(`\n📌 ${p.cat}`);
  lines.push(`\n<code>${index + 1}/${total}</code>`);
  return lines.join("\n");
}

function productKeyboard(sess, p) {
  const rows = [
    [Markup.button.callback("⬅️", "PROD_PREV"), Markup.button.callback("➡️", "PROD_NEXT")],
    [Markup.button.callback("✅ Quiero éste", `WANT_${p.code}`), Markup.button.callback("🔗 Compartir", `SHARE_PROD_${p.code}`)],
  ];

  if (sess.cart && sess.cart.length) rows.push([Markup.button.callback("🛒 Ver carrito", "VIEW_CART")]);

  rows.push(...backMenuRows());
  return Markup.inlineKeyboard(rows);
}

/* =========================================================
CART + TICKETS
========================================================= */
function cartTotal(cart) {
  return roundARS(cart.reduce((acc, it) => acc + (Number(it.subtotal) || 0), 0));
}

function fmtQty(it) {
  if (it.qtyType === "g") return `${it.grams} g`;
  return `${it.qty} u`;
}

function ticketPOS(cfg, { orderId, items, total, entregaTipo, pagoTipo, nombre, telefono, direccion, notas, estado, costoEnvio = 0 }) {
  const moneda = cfg.Moneda || "ARS";
  const lines = [];
  lines.push(`🧾 <b>TICKET</b>`);
  lines.push(`<code>${orderId}</code>`);
  lines.push(`──────────────────`);
  for (const it of items) {
    const sub = roundARS(it.subtotal || 0);
    lines.push(`• <b>${it.name}</b>`);
    lines.push(`  ${fmtQty(it)}  ·  ${money(sub, moneda)}`);
  }

  if ((entregaTipo === "ENVIO" || entregaTipo === "EXPRESS") && roundARS(costoEnvio) > 0) {
    lines.push(`• <b>Envío</b>`);
    lines.push(`  ${money(roundARS(costoEnvio), moneda)}`);
  }

  lines.push(`──────────────────`);
  lines.push(`🧮 <b>Total:</b> ${money(roundARS(total), moneda)}`);
  lines.push(`🚚 <b>Entrega:</b> ${entregaTipo}`);
  lines.push(`💳 <b>Pago:</b> ${pagoTipo}`);
  if (nombre) lines.push(`👤 <b>Nombre:</b> ${nombre}`);
  if (telefono) lines.push(`📞 <b>Tel:</b> ${telefono}`);
  if (direccion) lines.push(`📍 <b>Dirección:</b> ${direccion}`);
  if (notas) lines.push(`📝 <b>Notas:</b> ${notas}`);
  if (estado) lines.push(`📌 <b>Estado:</b> ${estado}`);
  return lines.join("\n");
}

function buildShareLinks({ botLink, text }) {
  const url = encodeURIComponent(botLink);
  const t = encodeURIComponent(text);
  return {
    wa: `https://wa.me/?text=${t}%0A${url}`,
    tg: `https://t.me/share/url?url=${url}&text=${t}`,
  };
}

function shareKeyboard(links) {
  return Markup.inlineKeyboard([
    [Markup.button.url("📲 WhatsApp", links.wa), Markup.button.url("✈️ Telegram", links.tg)],
    ...backMenuRows(),
  ]);
}

/* =========================================================
SELLOS UI
========================================================= */
function sellosTextShort(cfg, sellos) {
  const montoPorSello = parseNumber(cfg.MontoPorSello || "10000", 10000);
  const moneda = cfg.Moneda || "ARS";
  const tip = `✨ Tip: si alguien entra por tu link y compra, ganás <b>${parseNumber(cfg.BonusSellosShare || "1", 1)}</b> sello(s).`;
  return [
    `🎟️ <b>Sellos</b>`,
    `Tenés <b>${sellos}</b> sellos acumulados.`,
    `Cada <b>${money(montoPorSello, moneda)}</b> = <b>1 sello</b>.`,
    ``,
    tip,
  ].join("\n");
}

function sellosTextLevels(cfg) {
  const sellosPorNivel = String(cfg.SellosPorNivel || "").trim();
  const beneficios = String(cfg.BeneficiosPorNivel || "").trim();
  const nombres = String(cfg.NombresNiveles || "").trim();

  const lines = [];
  lines.push(`🏅 <b>Niveles</b>`);
  if (nombres) lines.push(nombres);
  if (sellosPorNivel) lines.push(sellosPorNivel);
  if (beneficios) {
    lines.push(`\n🎁 <b>Beneficios</b>`);
    lines.push(beneficios);
  }
  return lines.join("\n");
}

/* =========================================================
FLOW SCREENS + GIFs
========================================================= */
function pickGifFromCfg(cfg, keys) {
  for (const k of keys) {
    const v = String(cfg[k] || "").trim();
    const arr = splitPipes(v);
    const pickOne = pickRandom(arr);
    if (pickOne) return pickOne;
  }
  return "";
}

/* =========================================================
TELEGRAM BOT
========================================================= */
const bot = new Telegraf(TelegramBotToken);

/* =======================
✅ DESDE ACÁ SIGUE EN PARTE 2/2
======================= */
/* =========================================================
MENÚ / PANTALLAS PRINCIPALES
========================================================= */
async function showMenu(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  setScreen(sess, "MENU");

  const nombre = cfg.NegocioNombre || "Tu Negocio";
  const dire = cfg.NegocioDireccion || "";
  const hora = cfg.NegocioHorario || "";
  const estado = cfg.Estado || "";
  const desc = String(cfg.Descripcion || "").trim();

  const gifId = pickGifFromCfg(cfg, ["GifBienvenidaID", "GifBienvenidaFileId", "GifBienvenida"]);
  const gifUrl = pickRandom(splitPipes(cfg.GifBienvenidaURL || ""));
  const logo = String(cfg.LogoURL || "").trim();

  const header = [];
  header.push(`🏠 <b>${nombre}</b>`);
  if (estado) header.push(`🟢 <b>${estado}</b>`);
  if (dire) header.push(`📍 ${dire}`);
  if (hora) header.push(`🕒 ${hora}`);

  const caption = `${header.join("\n")}\n\n${desc}\n\nElegí una opción 👇`;

  if (gifId) {
    await safeEditOrSendUtility(ctx, {
      animation: gifId,
      caption,
      extra: { reply_markup: mainMenuKeyboard().reply_markup },
    });
    return;
  }

  if (gifUrl && gifUrl.startsWith("http")) {
    await safeEditOrSendUtility(ctx, {
      animation: gifUrl,
      caption,
      extra: { reply_markup: mainMenuKeyboard().reply_markup },
    });
    return;
  }

  if (logo && logo.startsWith("http")) {
    await safeEditOrSendUtility(ctx, {
      photo: logo,
      caption,
      extra: mainMenuKeyboard(),
    });
    return;
  }

  await safeEditOrSendUtility(ctx, { text: caption, extra: mainMenuKeyboard() });
}

/* =========================================================
CATEGORÍAS
========================================================= */
async function showCategories(ctx) {
  const sess = getSess(ctx.chat.id);
  setScreen(sess, "CATS");

  const { items } = await loadCatalog();
  const cats = categoriesFromItems(items);

  if (!cats.length) {
    await safeEditOrSendEditable(ctx, {
      text: "🧀 Catálogo vacío. Cargá productos en la hoja <b>Catalogo</b>.",
      extra: Markup.inlineKeyboard(backMenuRows()),
    });
    return;
  }

  const buttons = [];
  for (let i = 0; i < cats.length; i += 2) {
    const row = [];
    row.push(Markup.button.callback(`📁 ${cats[i]}`, `CAT_${encodeURIComponent(cats[i])}`));
    if (cats[i + 1])
      row.push(Markup.button.callback(`📁 ${cats[i + 1]}`, `CAT_${encodeURIComponent(cats[i + 1])}`));
    buttons.push(row);
  }
  buttons.push(...backMenuRows());

  await safeEditOrSendEditable(ctx, {
    text: `🧀 <b>Catálogo</b>\n\nElegí una <b>categoría</b> 👇`,
    extra: Markup.inlineKeyboard(buttons),
  });
}

/* =========================================================
PRODUCTOS (CARRUSEL)
========================================================= */
async function showProductCarousel(ctx, cat) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);

  const { items } = await loadCatalog();
  const prods = items.filter((p) => (p.cat || "General") === cat);

  if (!prods.length) {
    await safeEditOrSendEditable(ctx, {
      text: `No hay productos en <b>${cat}</b>.`,
      extra: Markup.inlineKeyboard(backMenuRows()),
    });
    return;
  }

  sess.productsInView = prods;
  sess.productIndex = 0;
  sess.category = cat;
  setScreen(sess, "PROD", { cat });

  const p = prods[0];
  const caption = productCaption(cfg, p, 0, prods.length);
  const photo = p.img && p.img.startsWith("http") ? p.img : undefined;

  if (photo)
    await safeEditOrSendEditable(ctx, { photo, caption, extra: productKeyboard(sess, p) });
  else await safeEditOrSendEditable(ctx, { text: caption, extra: productKeyboard(sess, p) });
}

/* =========================================================
BOT ACTIONS BÁSICAS
========================================================= */
bot.start(async (ctx) => {
  await ensureBaseSheets();
  await expireOldPending();
  await showMenu(ctx);
});

bot.action("GO_MENU", async (ctx) => {
  await ctx.answerCbQuery();
  await showMenu(ctx);
});

bot.action("MENU_CATALOGO", async (ctx) => {
  await ctx.answerCbQuery();
  await showCategories(ctx);
});

bot.action("MENU_SELLOS", async (ctx) => {
  await ctx.answerCbQuery();
  await showSellos(ctx, false);
});

bot.action("MENU_AYUDA", async (ctx) => {
  await ctx.answerCbQuery();
  await showHelp(ctx);
});

bot.action("MENU_COMPARTIR", async (ctx) => {
  await ctx.answerCbQuery();
  await showShareBot(ctx);
});

bot.action(/^CAT_(.+)$/i, async (ctx) => {
  await ctx.answerCbQuery();
  await showProductCarousel(ctx, decodeURIComponent(ctx.match[1]));
});

/* =========================================================
PRODUCTO SIG / ANT
========================================================= */
bot.action("PROD_NEXT", async (ctx) => {
  await ctx.answerCbQuery();
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);

  sess.productIndex = (sess.productIndex + 1) % sess.productsInView.length;
  const p = sess.productsInView[sess.productIndex];

  const caption = productCaption(cfg, p, sess.productIndex, sess.productsInView.length);
  const photo = p.img && p.img.startsWith("http") ? p.img : undefined;

  if (photo)
    await safeEditOrSendEditable(ctx, { photo, caption, extra: productKeyboard(sess, p) });
  else await safeEditOrSendEditable(ctx, { text: caption, extra: productKeyboard(sess, p) });
});

bot.action("PROD_PREV", async (ctx) => {
  await ctx.answerCbQuery();
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);

  sess.productIndex =
    (sess.productIndex - 1 + sess.productsInView.length) % sess.productsInView.length;
  const p = sess.productsInView[sess.productIndex];

  const caption = productCaption(cfg, p, sess.productIndex, sess.productsInView.length);
  const photo = p.img && p.img.startsWith("http") ? p.img : undefined;

  if (photo)
    await safeEditOrSendEditable(ctx, { photo, caption, extra: productKeyboard(sess, p) });
  else await safeEditOrSendEditable(ctx, { text: caption, extra: productKeyboard(sess, p) });
});

/* =========================================================
WEB SERVER (Render)
========================================================= */
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.status(200).send("EzerBot OK ✅"));

async function start() {
  await ensureBaseSheets();
  await expireOldPending();

  setInterval(() => {
    expireOldPending().catch(() => {});
  }, 5 * 60 * 1000);

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
      console.log(`✅ Long-polling activo | Puerto ${PORT}`)
    );
  }
}

start().catch((e) => {
  console.error("FATAL:", e?.message || e);
  process.exit(1);
});

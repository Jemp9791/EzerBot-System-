import express from "express";
import { Telegraf, Markup } from "telegraf";
import { google } from "googleapis";

/* ===================== ENV ===================== */
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

/* ===================== GOOGLE AUTH ===================== */
function decodeServiceAccountB64(b64) {
  const raw = Buffer.from(b64, "base64").toString("utf8").trim();
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_B64 no es JSON válido.");
  }
}

const sa = decodeServiceAccountB64(GOOGLE_SERVICE_ACCOUNT_B64);

const auth = new google.auth.JWT({
  email: sa.client_email,
  key: sa.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

/* ===================== SHEETS HELPERS ===================== */
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
      requestBody: {
        requests: [{ addSheet: { properties: { title: sheetName } } }],
      },
    });
    await setSheetValues(`${sheetName}!A1`, [headers]);
    return;
  }

  const firstRow = await getSheetValues(`${sheetName}!A1:Z1`);
  const current = (firstRow[0] || []).map((x) => String(x || "").trim());
  const empty = !firstRow.length || current.join("").trim() === "";
  if (empty) {
    await setSheetValues(`${sheetName}!A1`, [headers]);
    return;
  }

  const currentLower = new Set(current.map((h) => h.toLowerCase()));
  const missing = headers.filter(
    (h) => !currentLower.has(String(h).toLowerCase())
  );
  if (missing.length) {
    await setSheetValues(`${sheetName}!A1`, [[...current, ...missing]]);
  }
}

/* ===================== UTILS ===================== */
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
  const s = String(v || "")
    .trim()
    .toLowerCase()
    .replace(/\./g, "");
  return (
    s === "si" ||
    s === "sí" ||
    s === "s" ||
    s === "true" ||
    s === "1" ||
    s === "yes" ||
    s === "y"
  );
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

/* ===================== CATALOGO ===================== */
function normalizeHeaders(headerRow) {
  const map = {};
  headerRow.forEach((h, i) => {
    const key = String(h || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "");
    if (key) map[key] = i;
  });
  return map;
}

function pick(row, hmap, keys, def = "") {
  for (const k of keys) {
    const idx = hmap[k];
    if (idx !== undefined && row[idx] !== undefined && row[idx] !== "")
      return row[idx];
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

/* ===================== CACHE ===================== */
const CACHE = {
  cfg: { value: null, ts: 0, inflight: null },
  cat: { value: null, ts: 0, inflight: null },
  pedidosHdr: { value: null, ts: 0, inflight: null },
};
const CFG_TTL_MS = 10_000;
const CAT_TTL_MS = 20_000;
const HDR_TTL_MS = 30_000;

async function loadConfigRaw() {
  const rows = await getSheetValues(`Config!A:B`);
  return kvFromRows(rows);
}

async function loadCatalogRaw() {
  const rows = await getSheetValues(`Catalogo!A1:Z`);
  if (!rows.length) return { items: [], headers: {} };

  const headerRow = rows[0];
  const hmap = normalizeHeaders(headerRow);

  const data = rows
    .slice(1)
    .filter((r) => r.some((c) => String(c || "").trim() !== ""));

  const items = data.map((r, i) => {
    const code =
      String(pick(r, hmap, ["codigo", "codigoproducto", "id", "sku"], "")).trim() ||
      `P${i + 1}`;
    const name = String(pick(r, hmap, ["nombre", "producto", "name"], "Producto")).trim();
    const price = parseNumber(pick(r, hmap, ["precio", "price"], 0), 0);
    const pricePerKg = parseNumber(
      pick(r, hmap, ["precioporkg", "preciokg", "precio_kg"], 0),
      0
    );
    const unitRaw = pick(r, hmap, ["unidad", "unit", "tipo", "medida"], "");
    const unit = inferUnit(unitRaw);
    const cat =
      String(pick(r, hmap, ["categoria", "categoría", "rubro"], "General")).trim() ||
      "General";
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

/* ===================== STATE ===================== */
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
    });
  }
  return SESS.get(chatId);
}

function setScreen(sess, screen, data = {}) {
  sess.lastScreen = screen;
  sess.lastScreenData = data || {};
}

/* ===================== SHEETS MODELO ===================== */
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
  "SellosGanados",
  "SellosAcreditados",
];

async function ensureBaseSheets() {
  await ensureSheet(CLIENTES_SHEET, CLIENTES_HEADERS);
  await ensureSheet(PEDIDOS_SHEET, PEDIDOS_HEADERS);
}

/* ===================== PEDIDOS HEADER MAP ===================== */
function normalizeHdrKey(h) {
  return String(h || "").trim().toLowerCase().replace(/\s+/g, "");
}

async function loadPedidosHeaderMap() {
  const now = Date.now();
  if (CACHE.pedidosHdr.value && now - CACHE.pedidosHdr.ts < HDR_TTL_MS)
    return CACHE.pedidosHdr.value;
  if (CACHE.pedidosHdr.inflight) return CACHE.pedidosHdr.inflight;

  CACHE.pedidosHdr.inflight = (async () => {
    const row = await getSheetValues(`${PEDIDOS_SHEET}!A1:Z1`);
    const headers = row[0] || [];
    const map = {};
    headers.forEach((h, i) => {
      const k = normalizeHdrKey(h);
      if (k) map[k] = i;
    });
    CACHE.pedidosHdr.value = map;
    CACHE.pedidosHdr.ts = Date.now();
    CACHE.pedidosHdr.inflight = null;
    return map;
  })().catch((e) => {
    CACHE.pedidosHdr.inflight = null;
    throw e;
  });

  return CACHE.pedidosHdr.inflight;
}

/* ===================== CLIENTES / PEDIDOS OPS ===================== */
async function upsertCliente({
  chatId,
  nombre,
  usuario,
  addSellos = 0,
  addTotal = 0,
  refBy = "",
}) {
  const rows = await getSheetValues(`${CLIENTES_SHEET}!A2:H`);
  const idx = rows.findIndex((r) => String(r[0] || "") === String(chatId));
  const now = new Date().toISOString();

  if (idx === -1) {
    await appendRow(CLIENTES_SHEET, [
      String(chatId),
      nombre || "",
      usuario || "",
      addSellos,
      addTotal,
      now,
      refBy || "",
      0,
    ]);
    return { sellos: addSellos, total: addTotal, isNew: true };
  }

  const row = rows[idx];
  const currentSellos = parseNumber(row[3], 0);
  const currentTotal = parseNumber(row[4], 0);
  const currentRefGanados = parseNumber(row[7], 0);

  const newSellos = currentSellos + addSellos;
  const newTotal = currentTotal + addTotal;

  const rowNumber = idx + 2;
  await setSheetValues(`${CLIENTES_SHEET}!A${rowNumber}:H${rowNumber}`, [
    [
      String(chatId),
      nombre || row[1] || "",
      usuario || row[2] || "",
      newSellos,
      newTotal,
      now,
      row[6] || refBy || "",
      currentRefGanados
    ],
  ]);

  return { sellos: newSellos, total: newTotal, isNew: false };
}

async function addSelloReferido(chatIdReferente) {
  const rows = await getSheetValues(`${CLIENTES_SHEET}!A2:H`);
  const idx = rows.findIndex(
    (r) => String(r[0] || "") === String(chatIdReferente)
  );
  if (idx === -1) return;

  const row = rows[idx];
  const currentSellos = parseNumber(row[3], 0);
  const currentRefGanados = parseNumber(row[7], 0);
  const rowNumber = idx + 2;

  await setSheetValues(`${CLIENTES_SHEET}!A${rowNumber}:H${rowNumber}`, [
    [
      row[0] || "",
      row[1] || "",
      row[2] || "",
      currentSellos + 1,
      row[4] || 0,
      new Date().toISOString(),
      row[6] || "",
      currentRefGanados + 1,
    ],
  ]);
}

async function findPedidoRow(orderId) {
  const rows = await getSheetValues(`${PEDIDOS_SHEET}!A2:Z`);
  const idx = rows.findIndex((r) => String(r[0] || "") === String(orderId));
  if (idx === -1) return null;
  return { idx, row: rows[idx], rowNumber: idx + 2 };
}

async function setPedidoEstado(orderId, newEstado) {
  const found = await findPedidoRow(orderId);
  if (!found) return null;
  const { row, rowNumber } = found;

  const hdr = await loadPedidosHeaderMap();
  const estadoIdx = hdr["estado"] ?? 13;
  row[estadoIdx] = newEstado;

  await setSheetValues(`${PEDIDOS_SHEET}!A${rowNumber}:Z${rowNumber}`, [row]);
  return row;
}

async function setPedidoField(orderId, key, value) {
  const found = await findPedidoRow(orderId);
  if (!found) return null;
  const { row, rowNumber } = found;

  const hdr = await loadPedidosHeaderMap();
  const idx = hdr[normalizeHdrKey(key)];
  if (idx === undefined) return null;

  row[idx] = value;
  await setSheetValues(`${PEDIDOS_SHEET}!A${rowNumber}:Z${rowNumber}`, [row]);
  return row;
}

async function expireOldPending() {
  const rows = await getSheetValues(`${PEDIDOS_SHEET}!A2:Z`);
  const hdr = await loadPedidosHeaderMap();
  const expIdx = hdr["expiraiso"] ?? 2;
  const estadoIdx = hdr["estado"] ?? 13;

  const now = Date.now();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const expIso = r[expIdx];
    const estado = String(r[estadoIdx] || "").toUpperCase();
    if (!expIso || estado !== "PENDIENTE") continue;
    const exp = Date.parse(expIso);
    if (Number.isFinite(exp) && exp <= now) {
      const rowNumber = i + 2;
      r[estadoIdx] = "VENCIDO";
      await setSheetValues(`${PEDIDOS_SHEET}!A${rowNumber}:Z${rowNumber}`, [r]);
    }
  }
}

/* ===================== UI SAFE EDIT/SEND ===================== */
async function safeEditOrSend(ctx, payload) {
  const chatId = ctx.chat?.id;
  const sess = chatId ? getSess(chatId) : null;
  const canEdit = !!(sess?.lastMessageId);

  try {
    if (canEdit) {
      if (payload.photo) {
        await ctx.telegram.editMessageMedia(
          chatId,
          sess.lastMessageId,
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
      } else {
        await ctx.telegram.editMessageText(
          chatId,
          sess.lastMessageId,
          undefined,
          payload.text || " ",
          { parse_mode: "HTML", ...(payload.extra || {}) }
        );
        return;
      }
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
    msg = await ctx.reply(payload.text || " ", {
      parse_mode: "HTML",
      ...(payload.extra || {}),
    });
  }

  if (sess && msg?.message_id) sess.lastMessageId = msg.message_id;
}

/* ===================== KEYBOARDS ===================== */
function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🧀 Catálogo", "MENU_CATALOGO")],
    [
      Markup.button.callback("🎟️ Sellos", "MENU_SELLOS"),
      Markup.button.callback("ℹ️ Ayuda", "MENU_AYUDA"),
    ],
    [Markup.button.callback("📣 Compartir", "MENU_COMPARTIR")],
  ]);
}

function goMenuRow() {
  return [Markup.button.callback("🏠 Menú", "GO_MENU")];
}

function backMenuRows() {
  return [[Markup.button.callback("⬅️ Volver", "GO_BACK")], goMenuRow()];
}

/* ===================== PRODUCT UI ===================== */
function productCaption(cfg, p, index, total) {
  const moneda = cfg.Moneda || "ARS";
  const showPrice = parseYes(cfg.CatalogoMostrarPrecios ?? "SI");
  const lines = [];
  lines.push(`<b>${p.name}</b>`);

  if (showPrice) {
    if (p.unit === "g" && p.pricePerKg > 0)
      lines.push(`💰 <b>${money(p.pricePerKg, moneda)}</b> / kg`);
    else lines.push(`💰 <b>${money(p.price, moneda)}</b>`);
  }

  if (p.desc) lines.push(`\n${p.desc}`);
  lines.push(`\n📌 ${p.cat}`);
  lines.push(`\n<code>${index + 1}/${total}</code>`);
  return lines.join("\n");
}

function productKeyboard(p) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("⬅️", "PROD_PREV"),
      Markup.button.callback("➡️", "PROD_NEXT"),
    ],
    [
      Markup.button.callback("✅ Quiero éste", `WANT_${p.code}`),
      Markup.button.callback("🔗 Compartir", `SHARE_PROD_${p.code}`),
    ],
    ...backMenuRows(),
  ]);
}

/* ===================== CART / TICKET ===================== */
function cartTotal(cart) {
  return roundARS(cart.reduce((acc, it) => acc + (Number(it.subtotal) || 0), 0));
}

function fmtQty(it) {
  if (it.qtyType === "g") return `${it.grams} g`;
  return `${it.qty} u`;
}

function ticketPOS(
  cfg,
  {
    orderId,
    items,
    total,
    entregaTipo,
    pagoTipo,
    nombre,
    telefono,
    direccion,
    notas,
    estado,
    costoEnvio = 0,
  }
) {
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
    [
      Markup.button.url("📲 WhatsApp", links.wa),
      Markup.button.url("✈️ Telegram", links.tg),
    ],
    ...backMenuRows(),
  ]);
}

/* ===================== GIF SEND (fallback) ===================== */
async function trySendAnimation(ctx, { animationId, animationUrl, caption, reply_markup }) {
  try {
    if (animationId) {
      await ctx.replyWithAnimation(animationId, { caption, parse_mode: "HTML", reply_markup });
      return true;
    }
  } catch {}
  try {
    if (animationUrl && animationUrl.startsWith("http")) {
      await ctx.replyWithAnimation(animationUrl, { caption, parse_mode: "HTML", reply_markup });
      return true;
    }
  } catch {}
  return false;
}

/* ===================== SCREENS ===================== */
async function showMenu(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  setScreen(sess, "MENU");

  const nombre = cfg.NegocioNombre || "Tu Negocio";
  const dire = cfg.NegocioDireccion || "";
  const hora = cfg.NegocioHorario || "";
  const estado = cfg.Estado || "";
  const desc = String(cfg.Descripcion || "").trim();

  const gifId = pickRandom(splitPipes(cfg.GifBienvenidaID || cfg.GifBienvenidaFileId || ""));
  const gifUrl = pickRandom(splitPipes(cfg.GifBienvenidaURL || ""));
  const logo = String(cfg.LogoURL || "").trim();

  const header = [];
  header.push(`🏠 <b>${nombre}</b>`);
  if (estado) header.push(`🟢 <b>${estado}</b>`);
  if (dire) header.push(`📍 ${dire}`);
  if (hora) header.push(`🕒 ${hora}`);

  let caption = `${header.join("\n")}\n\n${desc}\n\nElegí una opción 👇`;
  if (caption.length > 1000) caption = caption.slice(0, 980) + "…";

  const sentGif = await trySendAnimation(ctx, {
    animationId: gifId,
    animationUrl: gifUrl,
    caption,
    reply_markup: mainMenuKeyboard().reply_markup,
  });

  if (sentGif) return;

  if (logo && logo.startsWith("http")) {
    await ctx.replyWithPhoto(logo, {
      caption,
      parse_mode: "HTML",
      reply_markup: mainMenuKeyboard().reply_markup,
    });
    return;
  }

  await ctx.reply(caption, { parse_mode: "HTML", reply_markup: mainMenuKeyboard().reply_markup });
}

async function showCategories(ctx) {
  const sess = getSess(ctx.chat.id);
  setScreen(sess, "CATS");

  const { items } = await loadCatalog();
  const cats = categoriesFromItems(items);

  if (!cats.length) {
    await safeEditOrSend(ctx, {
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

  await safeEditOrSend(ctx, {
    text: `🧀 <b>Catálogo</b>\n\nElegí una <b>categoría</b> 👇`,
    extra: Markup.inlineKeyboard(buttons),
  });
}

async function showProductCarousel(ctx, cat) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);

  const { items } = await loadCatalog();
  const prods = items.filter((p) => (p.cat || "General") === cat);

  if (!prods.length) {
    setScreen(sess, "CATS");
    await safeEditOrSend(ctx, {
      text: `No hay productos en <b>${cat}</b>.`,
      extra: Markup.inlineKeyboard(backMenuRows()),
    });
    return;
  }

  sess.mode = "CATALOGO";
  sess.category = cat;
  sess.productsInView = prods;
  sess.productIndex = 0;

  setScreen(sess, "PROD", { cat });

  const p = prods[0];
  const caption = productCaption(cfg, p, 0, prods.length);
  const photo = p.img && p.img.startsWith("http") ? p.img : undefined;

  if (photo) await safeEditOrSend(ctx, { photo, caption, extra: productKeyboard(p) });
  else await safeEditOrSend(ctx, { text: caption, extra: productKeyboard(p) });
}

/* ===================== SELLOS / HELP / SHARE BOT ===================== */
async function showSellos(ctx, showLevels = false) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  setScreen(sess, "SELLOS", { showLevels });

  const rows = await getSheetValues(`${CLIENTES_SHEET}!A2:H`);
  const me = rows.find((r) => String(r[0] || "") === String(ctx.chat.id));
  const sellos = me ? parseNumber(me[3], 0) : 0;

  const montoPorSello = parseNumber(cfg.MontoPorSello || "10000", 10000);
  const moneda = cfg.Moneda || "ARS";

  const txtBase = [
    `🎟️ <b>Sellos</b>`,
    `Tenés <b>${sellos}</b> sellos acumulados.`,
    `Cada <b>${money(montoPorSello, moneda)}</b> = <b>1 sello</b>.`,
  ].join("\n");

  const niveles = [
    `\n🏅 <b>Niveles</b>`,
    String(cfg.NombresNiveles || "").trim(),
    String(cfg.SellosPorNivel || "").trim(),
    String(cfg.BeneficiosPorNivel || "").trim() ? `\n🎁 <b>Beneficios</b>\n${String(cfg.BeneficiosPorNivel || "").trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const caption = showLevels ? `${txtBase}\n${niveles}` : txtBase;

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        showLevels ? "⬅️ Volver" : "🏅 Ver niveles",
        showLevels ? "SELLOS_BACK" : "SELLOS_LEVELS"
      ),
    ],
    [Markup.button.callback("🧀 Catálogo", "MENU_CATALOGO")],
    ...backMenuRows(),
  ]);

  await safeEditOrSend(ctx, { text: caption, extra: kb });
}

async function showHelp(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  setScreen(sess, "HELP");

  const gifId = pickRandom(splitPipes(cfg.GifAyudaID || cfg.GifAyudaFileId || ""));
  const gifUrl = pickRandom(splitPipes(cfg.GifAyudaURL || ""));

  const nombre = cfg.NegocioNombre || "Todo Queso";
  let text = [
    `ℹ️ <b>Ayuda - ${nombre}</b>`,
    ``,
    `• Tocá 🧀 <b>Catálogo</b> y elegí productos.`,
    `• Tocá ✅ <b>Quiero éste</b> y escribí gramos o unidades.`,
    `• Para pagar por transferencia: enviás comprobante por WhatsApp y el vendedor confirma.`,
  ].join("\n");

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("✉️ Hablar con vendedor", "HELP_CONTACT")],
    ...backMenuRows(),
  ]);

  const sentGif = await trySendAnimation(ctx, {
    animationId: gifId,
    animationUrl: gifUrl,
    caption: text,
    reply_markup: kb.reply_markup,
  });

  if (sentGif) return;
  await safeEditOrSend(ctx, { text, extra: kb });
}

function applyTemplate(text, cfg) {
  const email =
    String(cfg.EmailSistema || cfg.EmailDelSistema || cfg.EmailSoporte || cfg.Email || "").trim();
  const botLink = String(cfg.BotLink || "").trim();

  return String(text || "")
    .replaceAll("(EmailSistema)", email || "")
    .replaceAll("{{EmailSistema}}", email || "")
    .replaceAll("{EmailSistema}", email || "")
    .replaceAll("(BotLink)", botLink || "")
    .replaceAll("{{BotLink}}", botLink || "")
    .replaceAll("{BotLink}", botLink || "");
}

async function showShareBot(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  setScreen(sess, "SHARE");

  const gifId = pickRandom(splitPipes(cfg.GifCompartirID || cfg.GifCompartirFileId || ""));
  const gifUrl = pickRandom(splitPipes(cfg.GifCompartirURL || ""));

  const botLink = String(cfg.BotLink || "").trim();
  if (!botLink) {
    await safeEditOrSend(ctx, { text: "Falta <b>BotLink</b> en Config.", extra: mainMenuKeyboard() });
    return;
  }

  const email =
    String(cfg.EmailSistema || cfg.EmailDelSistema || cfg.EmailSoporte || cfg.Email || "").trim();

  let textShare =
    String(cfg.TextoCompartirBot || "").trim() ||
    `🧀 Comprá en ${cfg.NegocioNombre || "Todo Queso"} desde este bot: elegí productos, cantidad y forma de entrega en 1 minuto.\n\n📩 Consultas: ${email || ""}`;

  textShare = applyTemplate(textShare, cfg).trim();

  const links = buildShareLinks({ botLink, text: textShare });
  const caption = `📣 <b>Compartir</b>\n\nElegí dónde compartir 👇`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.url("📲 WhatsApp", links.wa), Markup.button.url("✈️ Telegram", links.tg)],
    ...backMenuRows(),
  ]);

  const sentGif = await trySendAnimation(ctx, {
    animationId: gifId,
    animationUrl: gifUrl,
    caption,
    reply_markup: kb.reply_markup,
  });

  if (sentGif) return;
  await safeEditOrSend(ctx, { text: caption, extra: kb });
}

/* ===================== QUIERO ESTE -> CANTIDAD ===================== */
function qtyPromptText(cfg, p) {
  if (p.unit === "g") {
    return `✅ <b>${p.name}</b>\n\n¿Cuántos <b>gramos</b> querés?\nEj: <code>250</code> o <code>1000</code>`;
  }
  return `✅ <b>${p.name}</b>\n\n¿Cuántas <b>unidades</b> querés?\nEj: <code>1</code> o <code>2</code>`;
}

function computeSubtotal(p, qtyType, value) {
  if (qtyType === "g") {
    const grams = Math.max(1, parseNumber(value, 0));
    const perKg = p.pricePerKg > 0 ? p.pricePerKg : p.price;
    const subtotal = roundARS((grams / 1000) * perKg);
    return { grams, qty: 0, subtotal };
  }
  const qty = Math.max(1, parseNumber(value, 0));
  const subtotal = roundARS(qty * p.price);
  return { grams: 0, qty, subtotal };
}

function addToCart(sess, p, qtyType, value) {
  const calc = computeSubtotal(p, qtyType, value);
  const existing = sess.cart.find((x) => x.code === p.code && x.qtyType === qtyType);

  if (existing) {
    existing.subtotal = roundARS((existing.subtotal || 0) + calc.subtotal);
    if (qtyType === "g") existing.grams = (existing.grams || 0) + calc.grams;
    else existing.qty = (existing.qty || 0) + calc.qty;
  } else {
    sess.cart.push({
      code: p.code,
      name: p.name,
      cat: p.cat,
      img: p.img,
      desc: p.desc,
      unit: p.unit,
      price: p.price,
      pricePerKg: p.pricePerKg,
      qtyType,
      qty: calc.qty,
      grams: calc.grams,
      subtotal: calc.subtotal,
    });
  }
}

/* ===================== ENTREGA / PAGO ===================== */
function deliveryKeyboard(cfg) {
  const rows = [];
  if (parseYes(cfg.UsaEnvíoDomicilio || cfg.UsaEnvioDomicilio || "SI"))
    rows.push([Markup.button.callback("🚚 Envío a domicilio", "DELIVERY_ENVIO")]);
  if (parseYes(cfg.EnvioExpress || "SI"))
    rows.push([Markup.button.callback("⚡ Envío express", "DELIVERY_EXPRESS")]);
  if (parseYes(cfg.UsaRetiroLocal || "SI"))
    rows.push([Markup.button.callback("🏪 Retiro en el local", "DELIVERY_RETIRO")]);

  rows.push(...backMenuRows());
  return Markup.inlineKeyboard(rows);
}

function payKeyboard(cfg) {
  const rows = [];
  if (parseYes(cfg.PermitirPagoOnline || cfg.PermitePagoOnline || "SI")) {
    const tipo = (cfg.TipoPagoOnline || "TRANSFERENCIA").toUpperCase();
    rows.push([Markup.button.callback(`💳 ${tipo}`, `PAY_${tipo}`)]);
  }
  rows.push([Markup.button.callback("💵 Efectivo", "PAY_EFECTIVO")]);
  rows.push(...backMenuRows());
  return Markup.inlineKeyboard(rows);
}

async function showCart(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  setScreen(sess, "CART");

  if (!sess.cart.length) {
    await safeEditOrSend(ctx, {
      text: `🛒 <b>Carrito</b>\n\nTu carrito está vacío.\nVolvé al catálogo para elegir productos.`,
      extra: Markup.inlineKeyboard([[Markup.button.callback("🧀 Catálogo", "MENU_CATALOGO")], ...backMenuRows()]),
    });
    return;
  }

  const moneda = cfg.Moneda || "ARS";
  const lines = [];
  lines.push(`🛒 <b>Carrito</b>`);
  lines.push(`──────────────────`);
  sess.cart.forEach((it, i) => {
    lines.push(`${i + 1}) <b>${it.name}</b>`);
    lines.push(`   ${fmtQty(it)} · ${money(roundARS(it.subtotal || 0), moneda)}`);
  });
  lines.push(`──────────────────`);
  lines.push(`🧮 <b>Total:</b> ${money(cartTotal(sess.cart), moneda)}`);

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("✅ Finalizar compra", "CHK_DELIVERY")],
    [Markup.button.callback("🧀 Seguir comprando", "MENU_CATALOGO")],
    [Markup.button.callback("🗑️ Vaciar carrito", "CART_CLEAR")],
    ...backMenuRows(),
  ]);

  await safeEditOrSend(ctx, { text: lines.join("\n"), extra: kb });
}

async function showDelivery(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  setScreen(sess, "DELIVERY");

  await safeEditOrSend(ctx, {
    text: `🚚 <b>Entrega</b>\n\nElegí cómo querés recibir tu pedido 👇`,
    extra: deliveryKeyboard(cfg),
  });
}

async function showCheckoutTicketPreview(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  setScreen(sess, "TICKET", { preview: true });

  const entrega = sess.checkout.entregaTipo || "-";
  const pago = sess.checkout.pagoTipo || "-";

  const costoEnvio = parseNumber(cfg.CostoEnvio || "0", 0);
  let total = cartTotal(sess.cart);
  if (entrega === "ENVIO" || entrega === "EXPRESS") total = roundARS(total + costoEnvio);

  const t = ticketPOS(cfg, {
    orderId: "—",
    items: sess.cart,
    total,
    entregaTipo: entrega,
    pagoTipo: pago,
    nombre: sess.checkout.nombre,
    telefono: sess.checkout.telefono,
    direccion: sess.checkout.direccion,
    notas: sess.checkout.notas,
    estado: "Pendiente de confirmación",
    costoEnvio,
  });

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("✅ Finalizar compra", "FINALIZE_ORDER")],
    [Markup.button.callback("❌ Cancelar compra", "CANCEL_FLOW")],
    ...backMenuRows(),
  ]);

  await safeEditOrSend(ctx, { text: t, extra: kb });
}

async function showPayment(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  setScreen(sess, "PAY");

  const entregaTipo = sess.checkout.entregaTipo || "";
  const moneda = cfg.Moneda || "ARS";
  const costoEnvio = parseNumber(cfg.CostoEnvio || "0", 0);

  let extraText = "";
  if (entregaTipo === "ENVIO" || entregaTipo === "EXPRESS") {
    extraText = `\n\n🚚 Costo de envío: <b>${money(costoEnvio, moneda)}</b>`;
  }

  await safeEditOrSend(ctx, {
    text: `💳 <b>Pago</b>\n\nElegí cómo vas a pagar 👇${extraText}`,
    extra: payKeyboard(cfg),
  });
}

/* ===================== FINALIZAR + VENDEDOR CONFIRMA ===================== */
function buildOrderId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `TQ-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours()
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function buildTransferDataText(cfg) {
  const alias = String(cfg.AliasTransferencia || "").trim();
  const cbu = String(cfg.CBUPago || "").trim();
  const msg = String(cfg.MensajeTransferencia || "").trim();

  const lines = [];
  lines.push(`💳 <b>Transferencia</b>`);
  if (alias) lines.push(`• <b>Alias:</b> <code>${alias}</code>`);
  if (cbu) lines.push(`• <b>CBU:</b> <code>${cbu}</code>`);
  if (msg) lines.push(`\n${msg}`);
  return lines.join("\n");
}

function getWhatsappOrderLink(cfg, orderId) {
  const link = String(cfg.WhatsAppLink || "").trim();
  const telRaw = String(cfg.NegocioTelefono || "").trim();
  const tel = telRaw.replace(/[^\d]/g, "");
  const waBase = link || (tel ? `https://wa.me/${tel}` : "");
  if (!waBase) return "";

  const text = encodeURIComponent(
    `Hola! Te envío el comprobante de transferencia del pedido ${orderId}.`
  );
  return waBase.includes("?")
    ? `${waBase}${waBase.includes("text=") ? "" : `&text=${text}`}`
    : `${waBase}?text=${text}`;
}

function scheduleExpire(orderId, expMs, onExpire) {
  if (ORDER_TIMERS.has(orderId)) clearTimeout(ORDER_TIMERS.get(orderId));
  const t = setTimeout(onExpire, expMs);
  ORDER_TIMERS.set(orderId, t);
}

async function finalizeOrderCreate(ctx, bot) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);

  if (!sess.cart.length) {
    await safeEditOrSend(ctx, { text: "Tu carrito está vacío.", extra: mainMenuKeyboard() });
    return;
  }

  const entregaTipo = sess.checkout.entregaTipo || "RETIRO";
  const pagoTipo = sess.checkout.pagoTipo || "EFECTIVO";
  const costoEnvio = parseNumber(cfg.CostoEnvio || "0", 0);

  let total = cartTotal(sess.cart);
  if (entregaTipo === "ENVIO" || entregaTipo === "EXPRESS")
    total = roundARS(total + costoEnvio);

  const usaSellos = parseYes(cfg.UsaSellos ?? "SI");
  const montoPorSello = parseNumber(cfg.MontoPorSello || "10000", 10000);
  const sellosGanados = usaSellos ? Math.floor(total / montoPorSello) : 0;

  const nombre =
    sess.checkout.nombre ||
    `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim();
  const usuario = ctx.from.username ? `@${ctx.from.username}` : "";
  const telefono = sess.checkout.telefono || "";
  const direccion = sess.checkout.direccion || "";
  const notas = sess.checkout.notas || "";

  const orderId = buildOrderId();
  const now = new Date();
  const expMs = 60 * 60 * 1000;
  const expIso = new Date(now.getTime() + expMs).toISOString();

  const itemsText = sess.cart.map((it) => `${it.name} (${fmtQty(it)})`).join(" | ");

  await appendRow(PEDIDOS_SHEET, [
    orderId,
    now.toISOString(),
    expIso,
    String(ctx.chat.id),
    nombre,
    usuario,
    itemsText,
    total,
    entregaTipo,
    pagoTipo,
    direccion,
    telefono,
    notas,
    "PENDIENTE",
    sess.refBy ? String(sess.refBy) : "",
    sellosGanados,
    "NO",
  ]);

  const vendedorIdReal = String(cfg.VendedorChatId || "").trim();
  const vendedor = vendedorIdReal ? Number(vendedorIdReal) : null;

  const ticketVendedor = ticketPOS(cfg, {
    orderId,
    items: sess.cart,
    total,
    entregaTipo,
    pagoTipo,
    nombre,
    telefono,
    direccion,
    notas,
    estado: "PENDIENTE (espera comprobante)",
    costoEnvio,
  });

  if (vendedor && Number.isFinite(vendedor)) {
    const kbVend = Markup.inlineKeyboard([
      [Markup.button.callback("✅ Confirmar pago", `V_CONFIRM_${orderId}`)],
      [Markup.button.callback("❌ Rechazar", `V_REJECT_${orderId}`)],
    ]);
    await bot.telegram.sendMessage(vendedor, ticketVendedor, {
      parse_mode: "HTML",
      reply_markup: kbVend.reply_markup,
    });
  }

  const waOrder = getWhatsappOrderLink(cfg, orderId);

  const extra = [];
  extra.push(`⏳ Este pedido queda <b>pendiente</b> hasta que el vendedor confirme.`);
  extra.push(`🕐 Si no se confirma en <b>1 hora</b>, se cancela automáticamente.`);
  if (sellosGanados > 0)
    extra.push(`🎟️ Al confirmarse, se acreditan <b>${sellosGanados}</b> sello(s).`);

  if (String(pagoTipo).toUpperCase().includes("TRANSF")) {
    extra.push("");
    extra.push(buildTransferDataText(cfg));
    extra.push("");
    extra.push(`📲 Enviá el <b>comprobante</b> por WhatsApp.`);
  }

  const kbClienteRows = [];
  if (waOrder) kbClienteRows.push([Markup.button.url("📲 Enviar comprobante por WhatsApp", waOrder)]);
  kbClienteRows.push([Markup.button.callback("❌ Cancelar pedido", `CANCEL_${orderId}`)]);
  kbClienteRows.push(...backMenuRows());

  const ticketCliente = ticketPOS(cfg, {
    orderId,
    items: sess.cart,
    total,
    entregaTipo,
    pagoTipo,
    nombre,
    telefono,
    direccion,
    notas,
    estado: "PENDIENTE",
    costoEnvio,
  });

  await safeEditOrSend(ctx, {
    text: `${ticketCliente}\n\n${extra.join("\n")}`,
    extra: Markup.inlineKeyboard(kbClienteRows),
  });

  scheduleExpire(orderId, expMs, async () => {
    const row = await setPedidoEstado(orderId, "VENCIDO");
    if (!row) return;
    const hdr = await loadPedidosHeaderMap();
    const chatIdCliente = Number(row[hdr["chatidcliente"] ?? 3]);
    if (Number.isFinite(chatIdCliente)) {
      await bot.telegram.sendMessage(
        chatIdCliente,
        `⏳ Tu pedido <b>${orderId

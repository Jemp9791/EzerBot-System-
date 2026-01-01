/**
 * EZERBot / Todo Queso — Bot + Catálogo + Carrito + Checkout + Sellos + Referidos
 * (Definitivo para TU estructura de Google Sheets)
 *
 * Hojas:
 * - Config (A=KEY, B=VALUE)
 * - Clientes (A:H): UserIdTG, Nombre, Telefono, Sellos, TotalConfirmado, CodigoReferido, ReferidoPor, UltAct
 * - Catalogo (A:I): CODIGO, NOMBRE, PRECIO, UNIDAD, PRECIOPORKILO, CODIGOBARRAS, DESCRIPCION, IMAGEN, CATEGORIA
 * - Referidos (A:B): CodigoReferido, OwnerUserIdTG
 *
 * ENV (Render / Node18):
 * - TELEGRAM_BOT_TOKEN (obligatorio)
 * - GOOGLE_SA_JSON     (obligatorio)
 * - SHEET_ID           (obligatorio)
 * - BASE_URL           (obligatorio) ej https://ezerbot-system.onrender.com
 * - VENDEDOR_CHAT_ID   (opcional si no está en Config como VendedorChatId)
 */

import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";
import { google } from "googleapis";

const app = express();
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true }));

// -------------------- ENV --------------------
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SHEET_ID = process.env.SHEET_ID;
const BASE_URL = (process.env.BASE_URL || "").replace(/\/+$/, "");
const GOOGLE_SA_JSON = process.env.GOOGLE_SA_JSON;

function must(v, name) {
  if (!v) throw new Error(`Falta variable de entorno: ${name}`);
  return v;
}
must(BOT_TOKEN, "TELEGRAM_BOT_TOKEN");
must(SHEET_ID, "SHEET_ID");
must(BASE_URL, "BASE_URL");
must(GOOGLE_SA_JSON, "GOOGLE_SA_JSON");

// -------------------- Helpers --------------------
function nowISO() {
  return new Date().toISOString();
}
function safe(s) {
  return String(s ?? "").trim();
}
function lower(s) {
  return safe(s).toLowerCase();
}
function toInt(x, def = 0) {
  const n = parseInt(String(x ?? "").replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : def;
}
function toNum(x, def = 0) {
  if (x === null || x === undefined) return def;
  const s = String(x).trim().replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : def;
}
function money(n) {
  const v = Number(n || 0);
  return v.toLocaleString("es-AR");
}
function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
function hashToken(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 16);
}
function normalizeUrl(u) {
  if (!u) return "";
  return String(u).trim().replace(/^"+|"+$/g, "");
}
function isHttp(u) {
  return typeof u === "string" && /^https?:\/\//i.test(u.trim());
}

// base36 para payload de share
function base36(n) {
  try { return Math.abs(Number(n)).toString(36); } catch { return ""; }
}
function unbase36(s) {
  try { return parseInt(String(s || ""), 36); } catch { return 0; }
}

// -------------------- Google Sheets Client --------------------
const sa = JSON.parse(GOOGLE_SA_JSON);
const auth = new google.auth.JWT(
  sa.client_email,
  null,
  sa.private_key,
  ["https://www.googleapis.com/auth/spreadsheets"]
);
const sheets = google.sheets({ version: "v4", auth });

async function getSheetValues(rangeA1) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: rangeA1,
  });
  return res.data.values || [];
}
async function appendRow(rangeA1, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: rangeA1,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}
async function updateCell(rangeA1, value) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: rangeA1,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[value]] },
  });
}

// -------------------- Cache Config/Catalog --------------------
let CACHE = { cfg: null, cfgTs: 0, catalogo: null, catTs: 0 };

async function loadConfig(force = false) {
  const ttl = 20_000;
  if (!force && CACHE.cfg && Date.now() - CACHE.cfgTs < ttl) return CACHE.cfg;

  const rows = await getSheetValues("Config!A:B");
  const cfg = {};
  for (let i = 0; i < rows.length; i++) {
    const k = safe(rows[i][0]);
    const v = rows[i][1];
    if (k) cfg[k] = v;
  }
  CACHE.cfg = cfg;
  CACHE.cfgTs = Date.now();
  return cfg;
}

async function loadCatalogo(force = false) {
  const ttl = 20_000;
  if (!force && CACHE.catalogo && Date.now() - CACHE.catTs < ttl) return CACHE.catalogo;

  // Catalogo A:I
  const rows = await getSheetValues("Catalogo!A:I");
  if (!rows.length) {
    CACHE.catalogo = { items: [], categories: [] };
    CACHE.catTs = Date.now();
    return CACHE.catalogo;
  }

  // si la primera fila es header, la detectamos por texto "CODIGO"
  const headA = lower(rows[0]?.[0]);
  const hasHeader = headA.includes("codigo");

  const data = hasHeader ? rows.slice(1) : rows;

  const items = data
    .map((r) => {
      const codigo = safe(r[0]);
      const nombre = safe(r[1]);
      const precio = toNum(r[2], 0);
      const unidad = safe(r[3]) || "unidad";
      const precioPorKilo = toNum(r[4], 0);
      const codBarras = safe(r[5]);
      const descripcion = safe(r[6]);
      const imagen = normalizeUrl(r[7]);
      const categoria = safe(r[8]) || "General";

      return {
        codigo, nombre, precio, unidad, precioPorKilo, codBarras, descripcion, imagen, categoria,
      };
    })
    .filter((x) => x.codigo && x.nombre);

  const categories = [...new Set(items.map((x) => x.categoria))]
    .sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));

  CACHE.catalogo = { items, categories };
  CACHE.catTs = Date.now();
  return CACHE.catalogo;
}

// -------------------- Pesable vs Unidad + Subtotal --------------------
function isPesable(item) {
  const u = lower(item?.unidad);
  if (Number(item?.precioPorKilo || 0) > 0) return true;
  if (u.includes("kg")) return true;
  if (u.includes("gram") || u === "g" || u.includes("gr")) return true;
  if (u.includes("100g") || u.includes("100 g")) return true;
  return false;
}

// regla pesable:
// - si PRECIOPORKILO > 0 => precio por kg
// - si UNIDAD contiene "100g" => PRECIO es por 100g
// - si UNIDAD dice "kg" => PRECIO es por kg
// - default pesable => PRECIO por kg
function calcPesableSubtotal(item, grams) {
  const g = Math.max(1, Number(grams || 0));
  const u = lower(item.unidad);
  if (Number(item.precioPorKilo || 0) > 0) {
    return Math.round((item.precioPorKilo || 0) * (g / 1000));
  }
  if (u.includes("100g") || u.includes("100 g")) {
    return Math.round((item.precio || 0) * (g / 100));
  }
  if (u.includes("kg")) {
    return Math.round((item.precio || 0) * (g / 1000));
  }
  return Math.round((item.precio || 0) * (g / 1000));
}

function parseQty(text) {
  const t = lower(text);

  // "200g" / "200"
  const m = t.match(/^(\d+)\s*(g|gr|gramos)?$/);
  if (m) return { value: Number(m[1]), kind: "NUM", text: `${Number(m[1])}` };

  return null;
}

// -------------------- Telegram API --------------------
async function tg(method, body) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) console.error("Telegram error", method, json);
  return json;
}

async function sendText(chat_id, text, extra = {}) {
  return tg("sendMessage", {
    chat_id,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}
async function sendPhoto(chat_id, photo, caption, extra = {}) {
  return tg("sendPhoto", {
    chat_id,
    photo,
    caption,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}
async function editMessageMedia(chat_id, message_id, photo, caption, extra = {}) {
  return tg("editMessageMedia", {
    chat_id,
    message_id,
    media: { type: "photo", media: photo, caption, parse_mode: "HTML" },
    ...extra,
  });
}
async function editMessageCaption(chat_id, message_id, caption, extra = {}) {
  return tg("editMessageCaption", {
    chat_id,
    message_id,
    caption,
    parse_mode: "HTML",
    ...extra,
  });
}
async function editMessageReplyMarkup(chat_id, message_id, reply_markup) {
  return tg("editMessageReplyMarkup", { chat_id, message_id, reply_markup });
}
async function forwardMessage(chat_id, from_chat_id, message_id) {
  return tg("forwardMessage", { chat_id, from_chat_id, message_id });
}

// -------------------- Menú fijo (como tus capturas) --------------------
function mainMenuKeyboard() {
  return {
    keyboard: [
      [{ text: "🛍️ Catálogo" }, { text: "🧾 Carrito" }],
      [{ text: "🎟️ Sellos" }, { text: "📣 Compartir bot" }],
      [{ text: "🆘 Ayuda" }],
    ],
    resize_keyboard: true,
  };
}

// -------------------- Clientes --------------------
async function findClienteByUserId(userId) {
  const rows = await getSheetValues("Clientes!A:H");
  for (let i = 1; i < rows.length; i++) {
    if (safe(rows[i][0]) === String(userId)) return { rowIndex: i + 1, row: rows[i] };
  }
  return null;
}

async function resolverReferido(codigo) {
  const rows = await getSheetValues("Referidos!A:B");
  for (let i = 1; i < rows.length; i++) {
    if (safe(rows[i][0]).toUpperCase() === safe(codigo).toUpperCase()) return String(rows[i][1] || "");
  }
  return "";
}

async function ensureReferidoRow(codigo, ownerUserId) {
  if (!codigo || !ownerUserId) return;
  const rows = await getSheetValues("Referidos!A:B");
  for (let i = 1; i < rows.length; i++) {
    if (safe(rows[i][0]).toUpperCase() === safe(codigo).toUpperCase()) return; // ya existe
  }
  await appendRow("Referidos!A:B", [codigo, String(ownerUserId)]);
}

async function ensureCliente(userId, nombre, referidoPor = "") {
  const found = await findClienteByUserId(userId);
  if (found) return found;

  const codigoRef = `R-${String(userId).slice(-6)}-${hashToken(userId).slice(0, 4)}`.toUpperCase();

  await appendRow("Clientes!A:H", [
    String(userId),
    safe(nombre),
    "",      // Telefono
    0,       // Sellos
    0,       // TotalConfirmado
    codigoRef,
    safe(referidoPor),
    nowISO(), // UltAct
  ]);

  // guardar en Referidos también
  await ensureReferidoRow(codigoRef, userId);

  return await findClienteByUserId(userId);
}

async function updateClienteCell(rowIndex, colLetter, value) {
  await updateCell(`Clientes!${colLetter}${rowIndex}`, value);
  await updateCell(`Clientes!H${rowIndex}`, nowISO());
}

// -------------------- Pedidos (si no existe, creala) --------------------
async function ensurePedidosSheetExistsHint() {
  // No podemos crear hojas desde acá (sin API de estructura),
  // pero dejamos el script listo. Si no existe, va a fallar en append.
}

async function createPedido(p) {
  // Pedidos A:N:
  // A=OrderId, B=Fecha, C=UserIdTG, D=Nombre, E=Detalle, F=Total, G=EntregaTipo, H=EntregaDatos,
  // I=PagoTipo, J=PagoEstado, K=ComprobanteFileId, L=Estado, M=ReferidoCodigoUsado, N=VendedorMsgId
  await appendRow("Pedidos!A:N", [
    p.orderId,
    nowISO(),
    String(p.userId),
    safe(p.nombre),
    safe(p.detalle),
    Number(p.total || 0),
    safe(p.entregaTipo),
    safe(p.entregaDatos),
    safe(p.pagoTipo),
    safe(p.pagoEstado),
    safe(p.comprobanteFileId || ""),
    safe(p.estado),
    safe(p.referidoCodigoUsado || ""),
    safe(p.vendedorMsgId || ""),
  ]);
}

async function findPedido(orderId) {
  const rows = await getSheetValues("Pedidos!A:N");
  for (let i = 1; i < rows.length; i++) {
    if (safe(rows[i][0]) === String(orderId)) return { rowIndex: i + 1, row: rows[i] };
  }
  return null;
}

async function setPedidoEstado(orderId, updates) {
  const found = await findPedido(orderId);
  if (!found) return null;

  const r = found.rowIndex;
  const col = {
    total: "F",
    entregaTipo: "G",
    entregaDatos: "H",
    pagoTipo: "I",
    pagoEstado: "J",
    comprobante: "K",
    estado: "L",
    referido: "M",
    vendedorMsgId: "N",
  };

  if (updates.total !== undefined) await updateCell(`Pedidos!${col.total}${r}`, updates.total);
  if (updates.entregaTipo !== undefined) await updateCell(`Pedidos!${col.entregaTipo}${r}`, updates.entregaTipo);
  if (updates.entregaDatos !== undefined) await updateCell(`Pedidos!${col.entregaDatos}${r}`, updates.entregaDatos);
  if (updates.pagoTipo !== undefined) await updateCell(`Pedidos!${col.pagoTipo}${r}`, updates.pagoTipo);
  if (updates.pagoEstado !== undefined) await updateCell(`Pedidos!${col.pagoEstado}${r}`, updates.pagoEstado);
  if (updates.comprobanteFileId !== undefined) await updateCell(`Pedidos!${col.comprobante}${r}`, updates.comprobanteFileId);
  if (updates.estado !== undefined) await updateCell(`Pedidos!${col.estado}${r}`, updates.estado);
  if (updates.referidoCodigoUsado !== undefined) await updateCell(`Pedidos!${col.referido}${r}`, updates.referidoCodigoUsado);
  if (updates.vendedorMsgId !== undefined) await updateCell(`Pedidos!${col.vendedorMsgId}${r}`, updates.vendedorMsgId);

  return true;
}

// -------------------- Sesiones en memoria --------------------
const S = new Map(); // userId -> session
function getSes(userId) {
  if (!S.has(userId)) S.set(userId, {});
  return S.get(userId);
}
function clearSes(userId) {
  S.delete(userId);
}
function newOrderId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// carrito por userId
function ensureCart(ses) {
  if (!ses.cart) ses.cart = [];
  return ses.cart;
}
function recalcCart(ses) {
  const cart = ensureCart(ses);
  let total = 0;
  for (const it of cart) total += Number(it.subtotal || 0);
  ses.total = Math.round(total);
  return ses.total;
}
function formatCart(ses, moneda = "ARS") {
  const cart = ensureCart(ses);
  if (!cart.length) return "— (vacío)";
  return cart
    .map((x) => `• <b>${escapeHtml(x.nombre)}</b> — <i>${escapeHtml(x.qtyText)}</i> — <b>${escapeHtml(moneda)} ${escapeHtml(money(x.subtotal))}</b>`)
    .join("\n");
}

// -------------------- Catálogo UI (carrusel) --------------------
function categoriesKeyboard(categories) {
  const rows = [];
  rows.push([{ text: "📚 Todas", callback_data: "CAT:__ALL__" }]);
  for (let i = 0; i < categories.length; i += 2) {
    const a = categories[i];
    const b = categories[i + 1];
    const row = [{ text: a, callback_data: `CAT:${encodeURIComponent(a)}` }];
    if (b) row.push({ text: b, callback_data: `CAT:${encodeURIComponent(b)}` });
    rows.push(row);
  }
  rows.push([{ text: "🏠 Menú", callback_data: "MENU" }]);
  return { inline_keyboard: rows };
}

function productCaption(cfg, item, pos, total, categoryLabel) {
  const moneda = safe(cfg.Moneda) || "ARS";
  const priceLine =
    isPesable(item)
      ? `💰 <b>${escapeHtml(moneda)} ${escapeHtml(money(item.precioPorKilo > 0 ? item.precioPorKilo : item.precio))}</b> ${item.precioPorKilo > 0 ? "<i>(por kg)</i>" : ""}\n`
      : `💰 <b>${escapeHtml(moneda)} ${escapeHtml(money(item.precio))}</b> <i>(por unidad)</i>\n`;

  const desc = item.descripcion ? `\n📝 ${escapeHtml(item.descripcion)}` : "";
  const cat = categoryLabel ? `\n📁 <i>${escapeHtml(categoryLabel)}</i>` : "";

  const tip = isPesable(item)
    ? `\n✅ <b>Para agregar:</b> tocá <b>🟢 Quiero este</b> (te voy a pedir <b>gramos</b>)`
    : `\n✅ <b>Para agregar:</b> tocá <b>🟢 Quiero este</b> (te voy a pedir <b>unidades</b>)`;

  return (
    `🧀 <b>${escapeHtml(item.nombre)}</b>\n` +
    priceLine +
    `📌 <i>${pos} de ${total}</i>${cat}` +
    `${desc}\n` +
    tip
  );
}

function productNavKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "⬅️", callback_data: "P:PREV" },
        { text: "➡️", callback_data: "P:NEXT" },
      ],
      [{ text: "🟢 Quiero este", callback_data: "P:BUY" }],
      [{ text: "📣 Compartir", callback_data: "P:SHARE_MENU" }],
      [{ text: "🧾 Ver carrito", callback_data: "CART:VIEW" }],
      [{ text: "📁 Categorías", callback_data: "CAT_MENU" }, { text: "🏠 Menú", callback_data: "MENU" }],
    ],
  };
}

function botStartLink(cfg, payload = "") {
  // BOT_USERNAME no siempre está: usamos BotLink en Config si existe
  const botLink = safe(cfg.BotLink);
  if (botLink) {
    if (!payload) return botLink;
    // si ya es t.me/xxx, le agregamos ?start=
    if (botLink.includes("?start=")) return botLink;
    return `${botLink}${botLink.includes("?") ? "&" : "?"}start=${encodeURIComponent(payload)}`;
  }
  // fallback: si no tenés BotLink cargado, queda sin payload (igual funciona el bot, pero no el share con start)
  return botLink || "";
}

// payload: R{refBase36}_P{codigo}
function buildProductPayload(refUserId, code) {
  const ref = refUserId ? base36(refUserId) : "";
  const c = String(code || "").slice(0, 30);
  if (ref) return `R${ref}_P${c}`;
  return `P${c}`;
}
function parseStartPayload(payload) {
  const p = String(payload || "").trim();
  // Rxxx_Pyyy
  if (p.startsWith("R") && p.includes("_P")) {
    const [a, b] = p.split("_P");
    const ref = a.slice(1);
    const code = b || "";
    return { referrerUserId: unbase36(ref), code: code.trim(), kind: "PRODUCT" };
  }
  // Pyyy
  if (p.startsWith("P")) return { referrerUserId: 0, code: p.slice(1).trim(), kind: "PRODUCT" };

  // si parece un codigo de referido (R-xxxx-xxxx)
  if (p.toUpperCase().startsWith("R-")) return { kind: "REFCODE", refCode: p.trim() };

  return { kind: "NONE" };
}

function shareMenuKeyboard(cfg, item, ownerUserId) {
  const negocio = safe(cfg.NegocioNombre) || "Todo Queso";
  const payload = buildProductPayload(ownerUserId, item.codigo || "");
  const link = botStartLink(cfg, payload);

  const texto =
    `🧀 ${negocio} — Mirá este producto:\n` +
    `${item.nombre}\n` +
    `💰 ${safe(cfg.Moneda) || "ARS"} ${money(isPesable(item) ? (item.precioPorKilo || item.precio) : item.precio)} ${isPesable(item) ? "(por peso)" : "(por unidad)"}\n\n` +
    `Abrilo y pedilo acá 👉 ${link}`;

  const wa = `https://wa.me/?text=${encodeURIComponent(texto)}`;
  const tgShare = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(texto)}`;

  return {
    inline_keyboard: [
      [{ text: "📣 WhatsApp", url: wa }, { text: "✈️ Telegram", url: tgShare }],
      [{ text: "⬅️ Volver", callback_data: "SH:BACK" }],
    ],
  };
}

// estado carrusel por userId
const userState = new Map(); // userId -> { list, index, messageId, categoryLabel, awaitingQty, pendingItem, shareMode, awaitingAddress, awaitingProof }
function getState(userId) {
  if (!userState.has(userId)) userState.set(userId, {});
  return userState.get(userId);
}

async function showProductCarousel(chat_id, list, index, categoryLabel) {
  const cfg = await loadConfig();
  const total = list.length;
  const item = list[index];
  const caption = productCaption(cfg, item, index + 1, total, categoryLabel);
  const kb = productNavKeyboard();

  if (isHttp(item.imagen)) {
    const msg = await sendPhoto(chat_id, item.imagen, caption, { reply_markup: kb });
    return { messageId: msg?.result?.message_id || null };
  } else {
    const msg = await sendText(chat_id, caption + "\n\n⚠️ (Este producto no tiene imagen válida)", { reply_markup: kb });
    return { messageId: msg?.result?.message_id || null };
  }
}

async function updateCarousel(chat_id, st) {
  const cfg = await loadConfig();
  const { list, index, messageId, categoryLabel } = st;
  const total = list.length;
  const item = list[index];
  const caption = productCaption(cfg, item, index + 1, total, categoryLabel);

  if (!messageId) {
    const created = await showProductCarousel(chat_id, list, index, categoryLabel);
    st.messageId = created.messageId;
    userState.set(chat_id, st);
    return;
  }

  st.shareMode = false;
  userState.set(chat_id, st);

  if (isHttp(item.imagen)) {
    const edited = await editMessageMedia(chat_id, messageId, item.imagen, caption, { reply_markup: productNavKeyboard() });
    if (!edited?.ok) {
      const created = await showProductCarousel(chat_id, list, index, categoryLabel);
      st.messageId = created.messageId;
      userState.set(chat_id, st);
    }
  } else {
    const edited = await editMessageCaption(chat_id, messageId, caption + "\n\n⚠️ (Este producto no tiene imagen válida)", {
      reply_markup: productNavKeyboard(),
    });
    if (!edited?.ok) {
      const created = await showProductCarousel(chat_id, list, index, categoryLabel);
      st.messageId = created.messageId;
      userState.set(chat_id, st);
    }
  }
}

async function handleCatalogMenu(chat_id) {
  const { categories } = await loadCatalogo();
  if (!categories.length) {
    return sendText(chat_id, "🛍️ Todavía no hay productos cargados en el Catálogo.\nRevisá la hoja <b>Catalogo</b> (A:I).", {
      reply_markup: mainMenuKeyboard(),
    });
  }
  return sendText(chat_id, "📚 <b>Categorías</b>\nElegí una para ver productos:", {
    reply_markup: categoriesKeyboard(categories),
  });
}

async function handleCategory(chat_id, category) {
  const { items } = await loadCatalogo();
  let list = items;
  let label = "Todas";

  if (category && category !== "__ALL__") {
    label = category;
    list = items.filter((x) => x.categoria === category);
  }

  if (!list.length) {
    return sendText(chat_id, "No hay productos en esta categoría.", { reply_markup: mainMenuKeyboard() });
  }

  const st = getState(chat_id);
  st.categoryLabel = label;
  st.list = list;
  st.index = 0;
  st.messageId = null;
  st.awaitingQty = false;
  st.pendingItem = null;
  st.shareMode = false;

  const created = await showProductCarousel(chat_id, list, 0, label);
  st.messageId = created.messageId;
  userState.set(chat_id, st);
}

async function askQuantity(chat_id, item) {
  const pesable = isPesable(item);

  const txt = pesable
    ? `🟢 <b>${escapeHtml(item.nombre)}</b>\n\nDecime cuánto querés en <b>gramos</b>.\nEj: <b>200g</b> o <b>500g</b>`
    : `🟢 <b>${escapeHtml(item.nombre)}</b>\n\nDecime cuántas <b>unidades</b> querés.\nEj: <b>1</b> o <b>2</b>`;

  const st = getState(chat_id);
  st.awaitingQty = true;
  st.pendingItem = item;
  userState.set(chat_id, st);

  return sendText(chat_id, txt, { reply_markup: mainMenuKeyboard() });
}

async function addToCart(chat_id, item, qtyValue) {
  const cfg = await loadConfig();
  const moneda = safe(cfg.Moneda) || "ARS";

  const ses = getSes(chat_id);
  const cart = ensureCart(ses);

  if (isPesable(item)) {
    const grams = Math.max(1, Number(qtyValue || 0));
    const subtotal = calcPesableSubtotal(item, grams);
    cart.push({
      codigo: item.codigo,
      nombre: item.nombre,
      qtyText: `${grams}g`,
      subtotal,
      pesable: true,
    });
  } else {
    const units = Math.max(1, Number(qtyValue || 0));
    const subtotal = Math.round((item.precio || 0) * units);
    cart.push({
      codigo: item.codigo,
      nombre: item.nombre,
      qtyText: `x${units}`,
      subtotal,
      pesable: false,
    });
  }

  recalcCart(ses);

  return sendText(chat_id, `✅ Listo 😊 Agregué <b>${escapeHtml(item.nombre)}</b> (${escapeHtml(cart[cart.length - 1].qtyText)}).`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🧾 Ver carrito", callback_data: "CART:VIEW" }],
        [{ text: "🛍️ Seguir comprando", callback_data: "CAT_MENU" }],
      ],
    },
  });
}

// -------------------- Carrito + Checkout --------------------
async function showCart(chat_id) {
  const cfg = await loadConfig();
  const moneda = safe(cfg.Moneda) || "ARS";

  const ses = getSes(chat_id);
  const cart = ensureCart(ses);
  recalcCart(ses);

  if (!cart.length) {
    return sendText(chat_id, "🧾 <b>Carrito</b>\n\nTodavía no agregaste productos.\n👉 Tocá <b>🛍️ Catálogo</b> para empezar 😊", {
      reply_markup: mainMenuKeyboard(),
    });
  }

  const txt =
    `🧾 <b>Tu carrito</b>\n\n` +
    formatCart(ses, moneda) +
    `\n\n<b>Total:</b> ${escapeHtml(moneda)} <b>${escapeHtml(money(ses.total))}</b>\n\n` +
    `✅ Tocá <b>Finalizar compra</b> para elegir envío/retiro y pago.`;

  return sendText(chat_id, txt, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Finalizar compra", callback_data: "CHECKOUT:START" }],
        [{ text: "🛍️ Seguir comprando", callback_data: "CAT_MENU" }],
      ],
    },
  });
}

async function startCheckout(chat_id) {
  const cfg = await loadConfig();
  const ses = getSes(chat_id);
  const cart = ensureCart(ses);
  recalcCart(ses);

  if (!cart.length) {
    return sendText(chat_id, "Tu carrito está vacío 😊 Tocá Catálogo para agregar productos.", {
      reply_markup: mainMenuKeyboard(),
    });
  }

  const usaEnvio = ["si", "true", "1"].includes(lower(cfg["UsaEnvíoDomicilio"] || cfg["UsaEnvioDomicilio"]));
  const usaRetiro = ["si", "true", "1"].includes(lower(cfg["UsaRetiroLocal"]));
  const costoEnvio = toInt(cfg["CostoEnvio"], 0);
  const moneda = safe(cfg.Moneda) || "ARS";

  const botones = [];
  if (usaRetiro) botones.push([{ text: "🏠 Retiro en local", callback_data: "CHECKOUT:RETIRO" }]);
  if (usaEnvio) botones.push([{ text: `🚚 Envío a domicilio (+${escapeHtml(moneda)} ${escapeHtml(money(costoEnvio))})`, callback_data: "CHECKOUT:ENVIO" }]);
  if (!botones.length) botones.push([{ text: "✅ Continuar", callback_data: "CHECKOUT:RETIRO" }]);

  ses.checkout = ses.checkout || {};
  ses.checkout.delivery = null;
  ses.checkout.address = "";
  ses.checkout.payment = null;
  ses.checkout.pendingProof = false;
  ses.checkout.orderId = newOrderId();

  return sendText(chat_id, `✅ <b>Finalizar compra</b>\n\nElegí cómo querés recibir tu pedido:`, {
    reply_markup: { inline_keyboard: botones },
  });
}

async function chooseDelivery(chat_id, delivery) {
  const cfg = await loadConfig();
  const ses = getSes(chat_id);
  ses.checkout = ses.checkout || {};
  ses.checkout.delivery = delivery;

  const st = getState(chat_id);

  if (delivery === "ENVIO") {
    const texto = safe(cfg["TextoEnvíoDomicilio"] || cfg["TextoEnvioDomicilio"] || "Escribime tu dirección completa (calle, número, localidad y referencia).");
    st.awaitingAddress = true;
    userState.set(chat_id, st);

    return sendText(
      chat_id,
      `🚚 <b>Envío a domicilio</b>\n\n📍 Ahora escribime tu <b>dirección completa</b>.\n${escapeHtml(texto)}`,
      { reply_markup: mainMenuKeyboard() }
    );
  }

  st.awaitingAddress = false;
  userState.set(chat_id, st);
  return choosePaymentMenu(chat_id);
}

async function choosePaymentMenu(chat_id) {
  const cfg = await loadConfig();
  const ses = getSes(chat_id);
  const moneda = safe(cfg.Moneda) || "ARS";
  const costoEnvio = toInt(cfg["CostoEnvio"], 0);

  recalcCart(ses);
  const total = ses.checkout?.delivery === "ENVIO" ? ses.total + costoEnvio : ses.total;
  ses.checkout.totalFinal = total;

  const permitirTransfer = lower(cfg["PermitirPagoOnline"] || "si") !== "no"; // por defecto SI
  const botones = [];
  botones.push([{ text: "💵 Efectivo", callback_data: "PAY:CASH" }]);
  if (permitirTransfer) botones.push([{ text: "🏦 Transferencia", callback_data: "PAY:TRANSFER" }]);

  return sendText(chat_id, `💳 <b>Forma de pago</b>\n\nTotal: <b>${escapeHtml(moneda)} ${escapeHtml(money(total))}</b>\nElegí una opción:`, {
    reply_markup: { inline_keyboard: botones },
  });
}

function buildOrderText(cfg, ses, userId, userName, statusLabel = "PENDIENTE") {
  const moneda = safe(cfg.Moneda) || "ARS";
  const costoEnvio = toInt(cfg["CostoEnvio"], 0);
  const total = ses.checkout?.delivery === "ENVIO" ? ses.total + costoEnvio : ses.total;

  const itemsTxt = ensureCart(ses)
    .map((x) => `- ${x.nombre} (${x.qtyText}) — ${moneda} ${money(x.subtotal)}`)
    .join("\n");

  const entrega =
    ses.checkout?.delivery === "ENVIO"
      ? `🚚 Envío a domicilio\n📍 Dirección: ${ses.checkout?.address || "(no informada)"}\n💲 Envío: ${moneda} ${money(costoEnvio)}`
      : `🏠 Retiro en local`;

  const pago =
    ses.checkout?.payment === "TRANSFER"
      ? "🏦 Transferencia (pendiente confirmación)"
      : ses.checkout?.payment === "CASH"
      ? "💵 Efectivo"
      : "(no definido)";

  const negocio = safe(cfg.NegocioNombre) || "Todo Queso";
  const orderId = ses.checkout?.orderId || "";

  return (
    `🧾 <b>PEDIDO</b> — <b>${escapeHtml(negocio)}</b>\n` +
    `🆔 ID: <b>${escapeHtml(orderId)}</b>\n` +
    `📌 Estado: <b>${escapeHtml(statusLabel)}</b>\n\n` +
    `👤 Cliente: <b>${escapeHtml(userName)}</b> (${escapeHtml(String(userId))})\n\n` +
    `🛒 <b>Detalle</b>\n${escapeHtml(itemsTxt)}\n\n` +
    `📦 <b>Entrega</b>\n${escapeHtml(entrega)}\n\n` +
    `💳 <b>Pago</b>\n${escapeHtml(pago)}\n\n` +
    `💰 <b>Total:</b> ${escapeHtml(moneda)} ${escapeHtml(money(total))}`
  );
}

async function notifyBusinessWithButtons(cfg, buyerUserId, orderText, orderId) {
  const vendorChat = safe(cfg["VendedorChatId"] || process.env.VENDEDOR_CHAT_ID);
  if (!vendorChat) return { ok: false, reason: "No VendedorChatId" };

  const msg = await sendText(
    vendorChat,
    `${orderText}\n\n¿Confirmás este pedido?`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Confirmar", callback_data: `V:CONFIRM:${orderId}:${buyerUserId}` }],
          [{ text: "❌ Rechazar", callback_data: `V:REJECT:${orderId}:${buyerUserId}` }],
        ],
      },
    }
  );

  return { ok: true, vendorChatId: vendorChat, vendorMsgId: msg?.result?.message_id || "" };
}

function calcSellosPorCompra(total, montoPorSello) {
  const t = Math.max(0, Number(total || 0));
  const m = Math.max(1, Number(montoPorSello || 10000));
  return Math.floor(t / m);
}

async function applySellosAfterConfirmed(cfg, buyerUserId, totalFinal, referidoCodigoUsado = "") {
  const montoPorSello = toInt(cfg["MontoPorSello"], 10000);
  const sellosCompra = calcSellosPorCompra(totalFinal, montoPorSello);

  const cli = await findClienteByUserId(buyerUserId);
  if (cli) {
    const actual = toInt(cli.row[3], 0);
    const nuevo = actual + sellosCompra;
    await updateClienteCell(cli.rowIndex, "D", nuevo);
    const totalConf = toInt(cli.row[4], 0) + toInt(totalFinal, 0);
    await updateClienteCell(cli.rowIndex, "E", totalConf);

    if (sellosCompra > 0) {
      await sendText(buyerUserId, `🎟️ Sumaste <b>${sellosCompra}</b> sello(s). Ahora tenés <b>${nuevo}</b>.`, {
        reply_markup: mainMenuKeyboard(),
      });
    }
  }

  // Bonus por referido (si hay código y es válido)
  const bonus = toInt(cfg["BonusSellosShare"], 0);
  if (bonus > 0 && referidoCodigoUsado) {
    const ownerUserId = await resolverReferido(referidoCodigoUsado);
    if (ownerUserId && String(ownerUserId) !== String(buyerUserId)) {
      const owner = await findClienteByUserId(ownerUserId);
      if (owner) {
        const actualO = toInt(owner.row[3], 0);
        const nuevoO = actualO + bonus;
        await updateClienteCell(owner.rowIndex, "D", nuevoO);
        await sendText(ownerUserId, `🎉 ¡Un referido compró! Sumaste <b>${bonus}</b> sello(s). Ahora tenés <b>${nuevoO}</b>.`, {
          reply_markup: mainMenuKeyboard(),
        });
      }
    }
  }
}

// -------------------- Bienvenida / Ayuda / Compartir / Sellos --------------------
async function handleStart(chatId, user, payload = "") {
  const cfg = await loadConfig();

  // asegurar cliente
  const cli = await ensureCliente(user.id, user.first_name || user.username || "Cliente");

  const negocio = safe(cfg.NegocioNombre) || "Todo Queso";
  const desc = safe(cfg.Descripcion) || `Bienvenido/a a ${negocio} 😊`;
  const dir = safe(cfg.NegocioDireccion);
  const hor = safe(cfg.NegocioHorario);
  const tel = safe(cfg.NegocioTelefono);
  const wa = safe(cfg.WhatsAppLink);
  const ig = safe(cfg.NegocioInstagram);

  const parsed = parseStartPayload(payload);
  const ses = getSes(user.id);

  // guardar referido si vino por código
  if (parsed.kind === "REFCODE" && parsed.refCode) {
    ses.referidoCodigoUsado = parsed.refCode;
  }

  // guardar referido si vino por share Rbase36 (sin usar Referidos sheet)
  if (parsed.kind === "PRODUCT" && parsed.referrerUserId && parsed.referrerUserId !== user.id) {
    // Creamos un "codigo referido" virtual del dueño (si existe en Clientes lo sacamos)
    // Preferimos guardar un código real: buscamos el codigo del owner en Clientes
    const ownerCli = await findClienteByUserId(parsed.referrerUserId);
    if (ownerCli) {
      ses.referidoCodigoUsado = safe(ownerCli.row[5]); // CodigoReferido
    }
    // y mostramos el producto compartido
    await sendText(chatId, `👋 <b>${escapeHtml(negocio)}</b>\n\n${escapeHtml(desc)}\n\n👉 Tocá <b>🛍️ Catálogo</b> para ver productos.\n👉 Tocá <b>🧾 Carrito</b> para finalizar.\n👉 Tocá <b>🎟️ Sellos</b> para ver tu tarjeta.`, {
      reply_markup: mainMenuKeyboard(),
    });
    return showSharedProduct(chatId, parsed.code);
  }

  const info =
    (dir ? `📍 ${escapeHtml(dir)}\n` : "") +
    (hor ? `🕒 ${escapeHtml(hor)}\n` : "") +
    (tel ? `📲 ${escapeHtml(tel)}\n` : "") +
    (wa ? `✅ WhatsApp: ${escapeHtml(wa)}\n` : "") +
    (ig ? `📸 Instagram: ${escapeHtml(ig)}\n` : "");

  const txt =
    `👋 <b>${escapeHtml(negocio)}</b>\n\n` +
    `${escapeHtml(desc)}\n\n` +
    (info ? `${info}\n` : "") +
    `👉 Tocá <b>🛍️ Catálogo</b> para ver productos con foto.\n` +
    `👉 Tocá <b>🧾 Carrito</b> para finalizar.\n` +
    `👉 Tocá <b>🎟️ Sellos</b> para ver tu tarjeta.\n` +
    `👉 Si necesitás una mano, tocá <b>🆘 Ayuda</b>.`;

  await sendText(chatId, txt, { reply_markup: mainMenuKeyboard() });

  // si vino con producto compartido sin referrer
  if (parsed.kind === "PRODUCT" && parsed.code) return showSharedProduct(chatId, parsed.code);
}

async function showAyuda(chatId) {
  const cfg = await loadConfig();
  const negocio = safe(cfg.NegocioNombre) || "Todo Queso";
  const wa = safe(cfg.WhatsAppLink);
  const ig = safe(cfg.NegocioInstagram);
  const dir = safe(cfg.NegocioDireccion);
  const hor = safe(cfg.NegocioHorario);

  const txt =
    `🆘 <b>Ayuda</b>\n\n` +
    `Así comprás en <b>${escapeHtml(negocio)}</b>:\n\n` +
    `1) Entrá a <b>🛍️ Catálogo</b>\n` +
    `2) Elegí una categoría\n` +
    `3) Tocá <b>🟢 Quiero este</b>\n` +
    `4) Escribí <b>unidades</b> (1,2,3) o <b>gramos</b> (200g, 500g)\n` +
    `5) Abrí <b>🧾 Carrito</b> y tocá <b>Finalizar compra</b>\n\n` +
    `📍 <b>Dirección:</b> ${escapeHtml(dir || "—")}\n` +
    `⏰ <b>Horario:</b> ${escapeHtml(hor || "—")}\n` +
    `✅ <b>WhatsApp:</b> ${escapeHtml(wa || "—")}\n` +
    `📸 <b>Instagram:</b> ${escapeHtml(ig || "—")}\n\n` +
    `Gracias por elegir <b>${escapeHtml(negocio)}</b> 🧀`;

  await sendText(chatId, txt, { reply_markup: mainMenuKeyboard() });
}

async function showCompartir(chatId) {
  const cfg = await loadConfig();
  const email = safe(cfg.EmailSistema || "ezerbot.assistant@gmail.com");
  const botDemo = safe(cfg.BotLink);
  const texto = safe(cfg.TextoSistema) || "¿Querés este sistema para tu negocio? Contactanos";

  const msg =
    `🤖 <b>${escapeHtml(texto)}</b>\n\n` +
    `📩 <b>Email:</b> ${escapeHtml(email)}\n` +
    (botDemo ? `🔗 <b>Demo:</b> ${escapeHtml(botDemo)}` : "");

  const shareWA = `https://wa.me/?text=${encodeURIComponent(msg.replace(/<[^>]+>/g, ""))}`;
  const shareTG = botDemo
    ? `https://t.me/share/url?url=${encodeURIComponent(botDemo)}&text=${encodeURIComponent(msg.replace(/<[^>]+>/g, ""))}`
    : `https://t.me/share/url?url=&text=${encodeURIComponent(msg.replace(/<[^>]+>/g, ""))}`;

  await sendText(chatId, msg, {
    reply_markup: { inline_keyboard: [[{ text: "📣 WhatsApp", url: shareWA }, { text: "✈️ Telegram", url: shareTG }]] },
  });
}

async function showSellos(chatId, userId) {
  const url = `${BASE_URL}/s/${encodeURIComponent(String(userId))}`;
  const txt = `🎟️ <b>Tus sellos</b>\n\nAbrí tu tarjeta y tus sellos acá:\n${escapeHtml(url)}`;
  await sendText(chatId, txt, { reply_markup: mainMenuKeyboard() });
}

// producto compartido
async function showSharedProduct(chat_id, code) {
  const cfg = await loadConfig();
  const { items } = await loadCatalogo();
  const item = items.find((x) => lower(x.codigo) === lower(code));

  if (!item) {
    return sendText(chat_id, "🧀 Te compartieron un producto, pero no lo encontré. Tocá Catálogo para verlo.", {
      reply_markup: mainMenuKeyboard(),
    });
  }

  const st = getState(chat_id);
  st.list = [item];
  st.index = 0;
  st.messageId = null;
  st.shareMode = false;
  st.categoryLabel = item.categoria || "Producto";
  userState.set(chat_id, st);

  const caption = `🎁 <b>Te compartieron este producto</b>\n\n` + productCaption(cfg, item, 1, 1, item.categoria);
  const kb = {
    inline_keyboard: [
      [{ text: "🟢 Quiero este", callback_data: "P:BUY" }],
      [{ text: "🛍️ Ver categorías", callback_data: "CAT_MENU" }],
      [{ text: "🧾 Ver carrito", callback_data: "CART:VIEW" }],
    ],
  };

  if (isHttp(item.imagen)) {
    const msg = await sendPhoto(chat_id, item.imagen, caption, { reply_markup: kb });
    st.messageId = msg?.result?.message_id || null;
    userState.set(chat_id, st);
    return;
  }

  const msg = await sendText(chat_id, caption, { reply_markup: kb });
  st.messageId = msg?.result?.message_id || null;
  userState.set(chat_id, st);
}

// -------------------- Webhook --------------------
app.post("/telegram", async (req, res) => {
  try {
    const update = req.body;

    // CALLBACKS
    if (update.callback_query) {
      const cq = update.callback_query;
      const data = cq.data || "";
      const userId = cq.from.id;
      const chatId = cq.message?.chat?.id || userId;

      await tg("answerCallbackQuery", { callback_query_id: cq.id });

      if (data === "MENU") {
        await sendText(chatId, "🏠 Menú", { reply_markup: mainMenuKeyboard() });
        return res.json({ ok: true });
      }

      if (data === "CAT_MENU") {
        await handleCatalogMenu(chatId);
        return res.json({ ok: true });
      }

      if (data.startsWith("CAT:")) {
        const raw = data.slice(4);
        const cat = decodeURIComponent(raw);
        await handleCategory(chatId, cat === "__ALL__" ? "__ALL__" : cat);
        return res.json({ ok: true });
      }

      // carrusel
      if (data === "P:NEXT" || data === "P:PREV") {
        const st = getState(chatId);
        if (!st?.list?.length) return res.json({ ok: true });
        const total = st.list.length;
        st.index = data === "P:NEXT" ? (st.index + 1) % total : (st.index - 1 + total) % total;
        userState.set(chatId, st);
        await updateCarousel(chatId, st);
        return res.json({ ok: true });
      }

      // share menu del producto (edita el mensaje)
      if (data === "P:SHARE_MENU") {
        const cfg = await loadConfig();
        const st = getState(chatId);
        const item = st?.list?.[st?.index];
        if (!st?.messageId || !item) return res.json({ ok: true });
        st.shareMode = true;
        userState.set(chatId, st);
        await editMessageReplyMarkup(chatId, st.messageId, shareMenuKeyboard(cfg, item, chatId));
        return res.json({ ok: true });
      }

      if (data === "SH:BACK") {
        const st = getState(chatId);
        if (!st?.messageId) return res.json({ ok: true });
        st.shareMode = false;
        userState.set(chatId, st);
        await editMessageReplyMarkup(chatId, st.messageId, productNavKeyboard());
        return res.json({ ok: true });
      }

      if (data === "P:BUY") {
        const st = getState(chatId);
        const item = st?.list?.[st?.index];
        if (!item) return res.json({ ok: true });
        await askQuantity(chatId, item);
        return res.json({ ok: true });
      }

      // carrito / checkout
      if (data === "CART:VIEW") {
        await showCart(chatId);
        return res.json({ ok: true });
      }
      if (data === "CHECKOUT:START") {
        await startCheckout(chatId);
        return res.json({ ok: true });
      }
      if (data === "CHECKOUT:RETIRO") {
        await chooseDelivery(chatId, "RETIRO");
        return res.json({ ok: true });
      }
      if (data === "CHECKOUT:ENVIO") {
        await chooseDelivery(chatId, "ENVIO");
        return res.json({ ok: true });
      }
      if (data === "PAY:CASH") {
        const cfg = await loadConfig();
        const ses = getSes(chatId);
        ses.checkout = ses.checkout || {};
        ses.checkout.payment = "CASH";

        const userName = cq.from.first_name || cq.from.username || "Cliente";
        const orderId = ses.checkout.orderId || newOrderId();

        const orderText = buildOrderText(cfg, ses, chatId, userName, "PENDIENTE");
        const notif = await notifyBusinessWithButtons(cfg, chatId, orderText, orderId);

        // guardar pedido en Sheets
        await createPedido({
          orderId,
          userId: chatId,
          nombre: userName,
          detalle: formatCart(ses, safe(cfg.Moneda) || "ARS").replace(/<[^>]+>/g, ""),
          total: ses.checkout.totalFinal || ses.total,
          entregaTipo: ses.checkout.delivery === "ENVIO" ? "Envío a domicilio" : "Retiro en local",
          entregaDatos: ses.checkout.delivery === "ENVIO" ? (ses.checkout.address || "") : (safe(cfg.NegocioDireccion) || ""),
          pagoTipo: "EFECTIVO",
          pagoEstado: "PENDIENTE_CONFIRMACION",
          comprobanteFileId: "",
          estado: "PENDIENTE_CONFIRMACION",
          referidoCodigoUsado: ses.referidoCodigoUsado || "",
          vendedorMsgId: notif.vendorMsgId || "",
        });

        await sendText(chatId, `✅ <b>Pedido enviado</b>\n\nTu pedido quedó <b>pendiente de confirmación</b> del negocio.\nTe avisamos por acá apenas lo confirmen 😊`, {
          reply_markup: mainMenuKeyboard(),
        });

        // no borramos sellos ni referido; limpiamos carrito cuando el vendedor confirma
        return res.json({ ok: true });
      }

      if (data === "PAY:TRANSFER") {
        const cfg = await loadConfig();
        const ses = getSes(chatId);
        ses.checkout = ses.checkout || {};
        ses.checkout.payment = "TRANSFER";

        const moneda = safe(cfg.Moneda) || "ARS";
        const total = ses.checkout.totalFinal || ses.total || 0;
        const alias = safe(cfg.AliasTransferencia);
        const cbu = safe(cfg.CBUPago);
        const msg = safe(cfg.MensajeTransferencia || "Hacé la transferencia y luego enviá el comprobante por acá.");

        // IMPORTANTÍSIMO: no decir “recibimos”, solo instrucción
        const texto =
          `🏦 <b>Transferencia</b>\n\n` +
          `Total: <b>${escapeHtml(moneda)} ${escapeHtml(money(total))}</b>\n\n` +
          (alias ? `🔑 Alias: <b>${escapeHtml(alias)}</b>\n` : "") +
          (cbu ? `🏷️ CBU: <b>${escapeHtml(cbu)}</b>\n` : "") +
          `\n${escapeHtml(msg)}\n\n` +
          `📎 <b>Ahora enviá el comprobante</b> (foto o archivo) por este chat.\n` +
          `Cuando el negocio lo confirme, te avisamos por acá ✅`;

        const st = getState(chatId);
        st.awaitingProof = true;
        userState.set(chatId, st);

        await sendText(chatId, texto, { reply_markup: mainMenuKeyboard() });
        return res.json({ ok: true });
      }

      // vendedor confirma/rechaza
      if (data.startsWith("V:CONFIRM:") || data.startsWith("V:REJECT:")) {
        const cfg = await loadConfig();
        const parts = data.split(":");
        const action = parts[1]; // CONFIRM / REJECT
        const orderId = parts[2];
        const buyerId = Number(parts[3] || 0);

        const pedido = await findPedido(orderId);
        if (!pedido) {
          await sendText(chatId, "ℹ️ Ese pedido no existe o ya fue procesado.");
          return res.json({ ok: true });
        }

        if (action === "CONFIRM") {
          await setPedidoEstado(orderId, { estado: "CONFIRMADO", pagoEstado: "CONFIRMADO" });

          const okTxt = safe(cfg.TextoConfirmacionPedido) || "Tu compra fue confirmada y está en preparación ✅";
          await sendText(buyerId, `✅ <b>Pedido confirmado</b>\n\n${escapeHtml(okTxt)}\n🆔 <b>ID:</b> ${escapeHtml(orderId)}`, {
            reply_markup: mainMenuKeyboard(),
          });

          // aplicar sellos + referido
          const totalFinal = toNum(pedido.row[5], 0);
          const referidoCodigoUsado = safe(pedido.row[12]); // M
          await applySellosAfterConfirmed(cfg, buyerId, totalFinal, referidoCodigoUsado);

          // limpiar carrito del comprador
          const sesBuyer = getSes(buyerId);
          sesBuyer.cart = [];
          sesBuyer.total = 0;

          await sendText(chatId, "✅ Confirmado. Avisé al cliente y apliqué sellos.");
          return res.json({ ok: true });
        }

        if (action === "REJECT") {
          await setPedidoEstado(orderId, { estado: "RECHAZADO" });
          await sendText(buyerId, `❌ Tu pedido <b>${escapeHtml(orderId)}</b> fue rechazado. Si querés, escribinos por <b>🆘 Ayuda</b>.`, {
            reply_markup: mainMenuKeyboard(),
          });
          await sendText(chatId, "❌ Rechazado. Avisé al cliente.");
          return res.json({ ok: true });
        }
      }

      return res.json({ ok: true });
    }

    // MENSAJES
    if (update.message) {
      const m = update.message;
      const chatId = m.chat.id;
      const user = m.from;
      const userId = user.id;
      const text = safe(m.text);

      const st = getState(userId);
      const ses = getSes(userId);

      // /start + payload
      if (text.startsWith("/start")) {
        const parts = text.split(" ").map((x) => x.trim()).filter(Boolean);
        const payload = parts[1] || "";
        await handleStart(chatId, user, payload);
        return res.json({ ok: true });
      }

      // botones menú
      if (text === "🛍️ Catálogo") {
        await handleCatalogMenu(chatId);
        return res.json({ ok: true });
      }
      if (text === "🧾 Carrito") {
        await showCart(chatId);
        return res.json({ ok: true });
      }
      if (text === "🎟️ Sellos") {
        await showSellos(chatId, userId);
        return res.json({ ok: true });
      }
      if (text === "📣 Compartir bot") {
        await showCompartir(chatId);
        return res.json({ ok: true });
      }
      if (text === "🆘 Ayuda") {
        await showAyuda(chatId);
        return res.json({ ok: true });
      }

      // esperando dirección
      if (st.awaitingAddress) {
        ses.checkout = ses.checkout || {};
        ses.checkout.address = text;
        st.awaitingAddress = false;
        userState.set(userId, st);
        await choosePaymentMenu(chatId);
        return res.json({ ok: true });
      }

      // esperando comprobante
      if (st.awaitingProof) {
        let fileId = "";
        if (m.document?.file_id) fileId = m.document.file_id;
        if (!fileId && m.photo?.length) fileId = m.photo[m.photo.length - 1].file_id;

        if (!fileId) {
          await sendText(chatId, "Por favor, enviá el comprobante como foto o archivo.", { reply_markup: mainMenuKeyboard() });
          return res.json({ ok: true });
        }

        st.awaitingProof = false;
        userState.set(userId, st);

        const cfg = await loadConfig();
        const userName = user.first_name || user.username || "Cliente";
        const orderId = ses.checkout?.orderId || newOrderId();

        // avisar vendedor + forward comprobante
        const orderText = buildOrderText(cfg, ses, userId, userName, "PENDIENTE (COMPROBANTE RECIBIDO)");
        const notif = await notifyBusinessWithButtons(cfg, userId, orderText, orderId);

        // guardar pedido en Sheets
        await createPedido({
          orderId,
          userId,
          nombre: userName,
          detalle: formatCart(ses, safe(cfg.Moneda) || "ARS").replace(/<[^>]+>/g, ""),
          total: ses.checkout?.totalFinal || ses.total,
          entregaTipo: ses.checkout?.delivery === "ENVIO" ? "Envío a domicilio" : "Retiro en local",
          entregaDatos: ses.checkout?.delivery === "ENVIO" ? (ses.checkout?.address || "") : (safe(cfg.NegocioDireccion) || ""),
          pagoTipo: "TRANSFERENCIA",
          pagoEstado: "PENDIENTE_CONFIRMACION",
          comprobanteFileId: fileId,
          estado: "PENDIENTE_CONFIRMACION",
          referidoCodigoUsado: ses.referidoCodigoUsado || "",
          vendedorMsgId: notif.vendorMsgId || "",
        });

        const vendorChat = safe(cfg["VendedorChatId"] || process.env.VENDEDOR_CHAT_ID);
        if (vendorChat) await forwardMessage(vendorChat, chatId, m.message_id);

        await sendText(chatId, `✅ <b>Comprobante recibido</b>\n\nQuedó <b>pendiente</b> hasta que el negocio confirme.\nTe avisamos por acá apenas esté ✅`, {
          reply_markup: mainMenuKeyboard(),
        });

        return res.json({ ok: true });
      }

      // esperando cantidad
      if (st.awaitingQty && st.pendingItem) {
        const qty = parseQty(text);
        if (!qty) {
          const pesable = isPesable(st.pendingItem);
          await sendText(chatId, pesable ? "Decime gramos 😊 Ej: <b>200g</b>" : "Decime unidades 😊 Ej: <b>1</b> o <b>2</b>", {
            reply_markup: mainMenuKeyboard(),
          });
          return res.json({ ok: true });
        }

        // Validación: pesable pide gramos, unidad pide unidades
        const value = qty.value;
        if (value <= 0) {
          await sendText(chatId, "Decime una cantidad válida 😊", { reply_markup: mainMenuKeyboard() });
          return res.json({ ok: true });
        }

        const item = st.pendingItem;
        st.awaitingQty = false;
        st.pendingItem = null;
        userState.set(userId, st);

        // si NO es pesable y el usuario puso algo gigante (ej 200) lo dejamos igual (puede ser 200 unidades),
        // si querés luego ponemos un límite.
        await addToCart(chatId, item, value);
        return res.json({ ok: true });
      }

      // fallback
      await sendText(chatId, "Elegí una opción del menú 👇", { reply_markup: mainMenuKeyboard() });
      return res.json({ ok: true });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ ok: true });
  }
});

// -------------------- Stamps page /s/:uid --------------------
app.get("/s/:uid", async (req, res) => {
  try {
    const userId = req.params.uid;
    const cfg = await loadConfig();
    const cli = await findClienteByUserId(userId);

    const negocio = safe(cfg.NegocioNombre) || "Todo Queso";
    const logo = normalizeUrl(cfg.LogoURL);
    const cardUrl = normalizeUrl(cfg.CARD_URL);
    const montoPorSello = toInt(cfg.MontoPorSello, 10000);

    const sellos = cli ? toInt(cli.row[3], 0) : 0;
    const nombre = cli ? safe(cli.row[1]) : "Cliente";

    // meta simple para mostrar (10 por defecto)
    const meta = toInt(cfg.MetaSellos, 10) || 10;
    const faltan = Math.max(0, meta - sellos);

    const slots = meta;
    const filled = Math.min(sellos, slots);

    const stamp = (on) => `
      <div class="stamp ${on ? "on" : ""}">
        ${logo ? `<img src="${logo}" alt="logo"/>` : `<div style="opacity:.25;font-size:12px;">SELLO</div>`}
      </div>`;

    const grid = Array.from({ length: slots }).map((_, i) => stamp(i < filled)).join("");

    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`
<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(negocio)} — Sellos</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; margin:0; background:#0b1220; color:#fff;}
    .wrap{max-width:860px; margin:0 auto; padding:18px;}
    .card{background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.12); border-radius:16px; padding:16px; box-shadow:0 10px 30px rgba(0,0,0,.25);}
    .top{display:flex; gap:12px; align-items:center; margin-bottom:12px;}
    .top img{width:54px;height:54px;border-radius:12px; object-fit:cover;}
    h1{font-size:18px; margin:0;}
    .sub{opacity:.9; font-size:14px;}
    .row{display:flex; gap:12px; flex-wrap:wrap;}
    .col{flex:1; min-width:280px;}
    .imgCard{width:100%; border-radius:14px; border:1px solid rgba(255,255,255,.12); background:#000; overflow:hidden;}
    .imgCard img{width:100%; display:block;}
    .grid{display:grid; grid-template-columns:repeat(5, 1fr); gap:10px; margin-top:12px;}
    .stamp{aspect-ratio:1/1; border-radius:14px; border:1px dashed rgba(255,255,255,.25); background:rgba(255,255,255,.04); display:flex; align-items:center; justify-content:center; overflow:hidden;}
    .stamp img{width:80%; height:80%; object-fit:contain; opacity:.18; filter:grayscale(1);}
    .stamp.on{border-style:solid; background:rgba(255,255,255,.10);}
    .stamp.on img{opacity:1; filter:none;}
    .pill{display:inline-block; padding:6px 10px; border-radius:999px; background:rgba(255,255,255,.10); border:1px solid rgba(255,255,255,.14); font-size:13px;}
    .muted{opacity:.9; font-size:14px; line-height:1.35;}
    .big{font-size:28px; font-weight:800; margin:8px 0;}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="top">
        ${logo ? `<img src="${logo}" alt="logo"/>` : ""}
        <div>
          <h1>${escapeHtml(negocio)}</h1>
          <div class="sub">Hola ${escapeHtml(nombre)} 😊</div>
        </div>
      </div>

      <div class="row">
        <div class="col">
          <div class="pill">🎟️ Sellos acumulados</div>
          <div class="big">${sellos}</div>
          <div class="muted">1 sello cada <b>${money(montoPorSello)}</b>.</div>
          <div class="muted" style="margin-top:10px;">
            Te faltan <b>${faltan}</b> sello(s) para completar <b>${meta}</b>.
          </div>
          <div class="grid">${grid}</div>
        </div>

        <div class="col">
          <div class="pill">🪪 Tu tarjeta</div>
          <div class="imgCard" style="margin-top:10px;">
            ${cardUrl ? `<img src="${cardUrl}" alt="tarjeta"/>` : `<div style="padding:14px;opacity:.8;">Cargá <b>CARD_URL</b> en Config para ver tu tarjeta acá.</div>`}
          </div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`);
  } catch (e) {
    console.error(e);
    res.status(500).send("Error");
  }
});

// -------------------- Health --------------------
app.get("/", (_req, res) => res.send("OK"));

// -------------------- Set Webhook --------------------
async function setWebhook() {
  const url = `${BASE_URL}/telegram`;
  await tg("setWebhook", { url });
  console.log("Webhook set:", url);
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  console.log("Server listening on", PORT);
  try { await setWebhook(); } catch (e) { console.error(e); }
});

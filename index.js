/**
 * EzerBot / Todo Queso — Bot Telegram (Catálogo carrusel + Carrito + Checkout + Sellos + Referidos) — ÚNICO index.js
 *
 * Lee Config y Catálogo desde Google Apps Script:
 *   DATA_API_URL?type=config
 *   DATA_API_URL?type=catalog
 *
 * ENV (Render):
 * - TELEGRAM_TOKEN  (obligatorio)
 * - PUBLIC_URL      (obligatorio) ej https://ezerbot-system.onrender.com   (sin barra final)
 * - DATA_API_URL    (obligatorio) ej https://script.google.com/macros/s/XXXX/exec (sin query)
 * - BOT_USERNAME    (opcional) sin @ (si no está, se detecta con getMe)
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "4mb" }));

const PORT = process.env.PORT || 10000;
const TOKEN = (process.env.TELEGRAM_TOKEN || "").trim();
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
let DATA_API_URL = (process.env.DATA_API_URL || "").trim().replace(/\/+$/, "");
let BOT_USERNAME = (process.env.BOT_USERNAME || "").replace("@", "").trim();

DATA_API_URL = DATA_API_URL.replace(/^"+|"+$/g, "").trim();

if (!TOKEN) console.error("❌ Falta ENV TELEGRAM_TOKEN");
if (!PUBLIC_URL) console.error("❌ Falta ENV PUBLIC_URL");
if (!DATA_API_URL) console.error("❌ Falta ENV DATA_API_URL");

const TG = (method) => `https://api.telegram.org/bot${TOKEN}/${method}`;

// ---------------- Telegram API ----------------
async function tgCall(method, payload) {
  const res = await fetch(TG(method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
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
async function editMessageMedia(chat_id, message_id, photo, caption, extra = {}) {
  return tgCall("editMessageMedia", {
    chat_id,
    message_id,
    media: { type: "photo", media: photo, caption, parse_mode: "HTML" },
    ...extra,
  });
}
async function editMessageCaption(chat_id, message_id, caption, extra = {}) {
  return tgCall("editMessageCaption", { chat_id, message_id, caption, ...extra });
}
async function editMessageReplyMarkup(chat_id, message_id, reply_markup) {
  return tgCall("editMessageReplyMarkup", { chat_id, message_id, reply_markup });
}
async function forwardMessage(chat_id, from_chat_id, message_id) {
  return tgCall("forwardMessage", { chat_id, from_chat_id, message_id });
}

// ---------------- Utils ----------------
function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
function urlEncode(s) {
  return encodeURIComponent(String(s || ""));
}
function isHttp(u) {
  return typeof u === "string" && /^https?:\/\//i.test(u.trim());
}
function normalizeUrl(u) {
  if (!u) return "";
  return String(u).trim().replace(/^"+|"+$/g, "");
}
function lower(s) {
  return String(s || "").trim().toLowerCase();
}
function toNumberSafe(v) {
  if (v === null || v === undefined) return 0;
  const s = String(v).trim().replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
function nowId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
    d.getMinutes()
  )}${pad(d.getSeconds())}`;
}
function base36(n) {
  try {
    return Math.abs(Number(n)).toString(36);
  } catch {
    return "";
  }
}
function unbase36(s) {
  try {
    return parseInt(String(s || ""), 36);
  } catch {
    return 0;
  }
}
function money(n, moneda = "$") {
  const x = Number(n || 0);
  return `${moneda} ${x.toLocaleString("es-AR")}`;
}

// ---------------- CSV Parser ----------------
function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQ = !inQ;
      }
    } else if (ch === "," && !inQ) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((x) => x.trim());
}
function parseCsv(text) {
  const lines = String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const row = {};
    for (let c = 0; c < headers.length; c++) row[headers[c]] = (cols[c] ?? "").trim();
    rows.push(row);
  }
  return { headers, rows };
}

// ---------------- Fetch JSON o CSV ----------------
async function fetchSmart(url) {
  const res = await fetch(url, { method: "GET" });
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const txt = await res.text();

  try {
    const j = JSON.parse(txt);
    return { kind: "json", data: j, contentType: ct, raw: txt };
  } catch (_) {}

  const maybe = parseCsv(txt);
  if (maybe.headers.length >= 2) return { kind: "csv", data: maybe, contentType: ct, raw: txt };

  console.error("❌ Respuesta NO JSON/CSV desde:", url);
  console.error("Content-Type:", ct);
  console.error("Primeros 200 chars:", txt.slice(0, 200));
  throw new Error("DATA_API_URL no devuelve JSON ni CSV válido.");
}

// ---------------- Cache Config / Catalog ----------------
let configCache = { at: 0, data: {} };
let catalogCache = { at: 0, data: { items: [], categories: [] } };

async function loadConfig() {
  const now = Date.now();
  if (Object.keys(configCache.data).length && now - configCache.at < 20_000) return configCache.data;

  const url = `${DATA_API_URL}?type=config`;
  const smart = await fetchSmart(url);

  let cfg = {};
  if (smart.kind === "json") {
    cfg = smart.data?.config && typeof smart.data.config === "object" ? smart.data.config : smart.data;
  } else {
    const { rows } = smart.data;
    for (const r of rows) {
      const k = r["CLAVE"] ?? r["Clave"] ?? r["KEY"] ?? r["key"] ?? "";
      const v = r["VALOR"] ?? r["Valor"] ?? r["VALUE"] ?? r["value"] ?? "";
      if (String(k || "").trim()) cfg[String(k).trim()] = String(v ?? "").trim();
    }
  }

  configCache = { at: now, data: cfg || {} };
  return configCache.data;
}

async function loadCatalog() {
  const now = Date.now();
  if (catalogCache.data.items?.length && now - catalogCache.at < 20_000) return catalogCache.data;

  const url = `${DATA_API_URL}?type=catalog`;
  const smart = await fetchSmart(url);

  let rawItems = [];
  let rawCats = [];

  if (smart.kind === "json") {
    const cat = smart.data?.catalog && typeof smart.data.catalog === "object" ? smart.data.catalog : smart.data;
    rawItems = Array.isArray(cat?.items) ? cat.items : [];
    rawCats = Array.isArray(cat?.categories) ? cat.categories : [];
  } else {
    rawItems = smart.data.rows;
    rawCats = [];
  }

  const items = rawItems
    .map((x) => {
      const codigo = String(x.codigo ?? x.CODIGO ?? x.id ?? x.ID ?? "").trim();
      const nombre = String(x.nombre ?? x.NOMBRE ?? "").trim();
      const precio = toNumberSafe(x.precio ?? x.PRECIO ?? 0);
      const unidad = String(x.unidad ?? x.UNIDAD ?? "").trim();
      const descripcion = String(x.descripcion ?? x.DESCRIPCION ?? "").trim();
      const imagen = normalizeUrl(
        x.imagen ??
          x.IMAGEN ??
          x.imagenUrl ??
          x.IMAGENURL ??
          x.imagen1 ??
          x.IMAGEN1 ??
          ""
      );
      const categoria = String(x.categoria ?? x.CATEGORIA ?? "Sin categoría").trim();
      const activoRaw = x.activo ?? x.ACTIVO;
      const activo =
        activoRaw === undefined || activoRaw === null || String(activoRaw).trim() === ""
          ? true
          : ["si", "true", "1"].includes(String(activoRaw).trim().toLowerCase());

      const precioPorKilo = toNumberSafe(
        x.precioPorKilo ?? x.PRECIOPORKILO ?? x.precioKilo ?? x.PRECIOKILO ?? 0
      );

      // pesable si unidad "kg" o trae precioPorKilo
      const pesable = lower(unidad).includes("kg") || precioPorKilo > 0;

      return { codigo, nombre, precio, unidad, descripcion, imagen, categoria, activo, precioPorKilo, pesable };
    })
    .filter((x) => x.activo && x.nombre);

  const categories = rawCats.length
    ? rawCats.map(String)
    : [...new Set(items.map((x) => x.categoria))].sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));

  catalogCache = { at: now, data: { items, categories } };
  return catalogCache.data;
}

function isPesable(item) {
  const u = lower(item?.unidad);
  if (item?.pesable === true) return true;
  if (Number(item?.precioPorKilo || 0) > 0) return true;
  if (u.includes("kg")) return true;
  if (u.includes("100g") || u.includes("100 g")) return true;
  return false;
}

// ---------------- Estado por usuario ----------------
const userState = new Map(); // chatId -> state (carrusel + flags)
const carts = new Map(); // chatId -> cart
const orders = new Map(); // chatId -> order draft
const ordersById = new Map(); // orderId -> { chatId, vendorChatId, status }
const lastReferrer = new Map(); // chatId -> referrerChatId (si entró por link de referido)

function getState(chatId) {
  if (!userState.has(chatId)) userState.set(chatId, {});
  return userState.get(chatId);
}
function getCart(chatId) {
  if (!carts.has(chatId)) carts.set(chatId, { items: [], total: 0 });
  return carts.get(chatId);
}
function recalcCart(cart) {
  cart.total = cart.items.reduce((a, x) => a + (Number(x.subtotal) || 0), 0);
}

// ---------------- Sellos (memoria por ahora) ----------------
const stampMap = new Map(); // chatId -> { stamps, lastUpdatedAt }

function getStamps(chatId) {
  return stampMap.get(chatId)?.stamps || 0;
}
function setStamps(chatId, value) {
  stampMap.set(chatId, { stamps: Math.max(0, Number(value) || 0), lastUpdatedAt: Date.now() });
}
function addStamps(chatId, n) {
  const cur = getStamps(chatId);
  setStamps(chatId, cur + (Number(n) || 0));
}

// ---------------- Config helpers ----------------
function cfgBool(cfg, key) {
  return ["si", "true", "1"].includes(lower(cfg?.[key]));
}
function cfgStr(cfg, key, fallback = "") {
  const v = cfg?.[key];
  return String(v ?? fallback).trim();
}
function parsePipeList(s) {
  return String(s || "")
    .split("|")
    .map((x) => x.trim())
    .filter(Boolean);
}
function computeLevel(cfg, stamps) {
  const names = parsePipeList(cfgStr(cfg, "NombresNiveles", ""));
  const reqs = parsePipeList(cfgStr(cfg, "SellosPorNivel", "")).map((x) => Number(x) || 0);
  const bens = parsePipeList(cfgStr(cfg, "BeneficiosPorNivel", ""));

  if (!names.length || !reqs.length) return { levelName: "", nextName: names[0] || "", nextAt: reqs[0] || 0, benefit: bens[0] || "" };

  // buscar el mayor nivel alcanzado
  let reachedIdx = -1;
  for (let i = 0; i < reqs.length; i++) if (stamps >= reqs[i]) reachedIdx = i;

  const nextIdx = Math.min(reachedIdx + 1, reqs.length - 1);
  const nextAt = reqs[nextIdx] || 0;
  const nextName = names[nextIdx] || "";
  const nextBenefit = bens[nextIdx] || "";

  const currentName = reachedIdx >= 0 ? (names[reachedIdx] || "") : "";
  const currentBenefit = reachedIdx >= 0 ? (bens[reachedIdx] || "") : "";

  return {
    levelName: currentName,
    levelBenefit: currentBenefit,
    nextName,
    nextAt,
    nextBenefit,
    reachedIdx,
    hasReachedAll: reachedIdx >= reqs.length - 1
  };
}

// ---------------- UI ----------------
function mainMenuKeyboardReply() {
  return {
    keyboard: [
      [{ text: "🛍️ Catálogo" }, { text: "🧾 Carrito" }],
      [{ text: "🏷️ Sellos" }, { text: "📣 Compartir bot" }],
      [{ text: "🆘 Ayuda" }],
    ],
    resize_keyboard: true,
  };
}

function categoriesKeyboard(categories) {
  const rows = [];
  rows.push([{ text: "📚 Todas", callback_data: "CAT:__ALL__" }]);
  for (let i = 0; i < categories.length; i += 2) {
    const a = categories[i];
    const b = categories[i + 1];
    const row = [{ text: a, callback_data: `CAT:${urlEncode(a)}` }];
    if (b) row.push({ text: b, callback_data: `CAT:${urlEncode(b)}` });
    rows.push(row);
  }
  rows.push([{ text: "🏠 Menú", callback_data: "HOME" }]);
  return { inline_keyboard: rows };
}

function productCaption(cfg, item, pos, total, categoryLabel) {
  const moneda = cfgStr(cfg, "Moneda", "ARS") === "ARS" ? "ARS" : cfgStr(cfg, "Moneda", "$");
  const mostrarPrecio = lower(cfgStr(cfg, "CatalogoMostrarPrecios", "SI")) !== "no";

  const unidadTxt = item.unidad ? `(${escapeHtml(item.unidad)})` : "";
  const priceLine = mostrarPrecio ? `💰 <b>${escapeHtml(moneda)} ${escapeHtml(item.precio || "-")}</b> ${unidadTxt}\n` : "";
  const desc = item.descripcion ? `\n📝 ${escapeHtml(item.descripcion)}` : "";
  const cat = categoryLabel ? `\n📁 <i>${escapeHtml(categoryLabel)}</i>` : "";

  const tip = isPesable(item)
    ? `\n✅ <b>Para agregar:</b> tocá <b>🟢 Quiero este</b> (te voy a pedir gramos)`
    : `\n✅ <b>Para agregar:</b> tocá <b>🟢 Quiero este</b> (te voy a pedir unidades)`;

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
      [{ text: "📁 Categorías", callback_data: "CAT_MENU" }, { text: "🏠 Menú", callback_data: "HOME" }],
    ],
  };
}

// --- Share links ---
function botStartLink(payload = "") {
  const p = payload ? `?start=${payload}` : "";
  return `https://t.me/${BOT_USERNAME}${p}`;
}

// payload compacto: R{ref}_P{code}  (ref en base36)
function buildProductPayload(refChatId, code) {
  const ref = refChatId ? base36(refChatId) : "";
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
    return { referrerChatId: unbase36(ref), code: code.trim(), kind: "PRODUCT" };
  }
  // Pyyy
  if (p.startsWith("P")) return { referrerChatId: 0, code: p.slice(1).trim(), kind: "PRODUCT" };
  // B
  if (p === "B") return { kind: "BOT" };
  return { kind: "NONE" };
}

function buildShareTextForProduct(cfg, item, refChatId) {
  const negocio = cfgStr(cfg, "NegocioNombre", "Todo Queso");
  const payload = buildProductPayload(refChatId, item.codigo || "");
  const link = botStartLink(payload);

  return (
    `🧀 ${negocio} — Mirá este producto:\n` +
    `${item.nombre}\n` +
    `💰 ${cfgStr(cfg, "Moneda", "ARS")} ${item.precio || "-"} ${item.unidad ? `(${item.unidad})` : ""}\n\n` +
    `Abrilo y pedilo acá 👉 ${link}`
  );
}

function shareMenuKeyboard(cfg, item, ownerChatId) {
  const text = buildShareTextForProduct(cfg, item, ownerChatId);
  const wa = `https://wa.me/?text=${urlEncode(text)}`;
  const tg = `https://t.me/share/url?url=${urlEncode(botStartLink(buildProductPayload(ownerChatId, item.codigo || "")))}&text=${urlEncode(text)}`;

  return {
    inline_keyboard: [
      [{ text: "📣 WhatsApp", url: wa }, { text: "✈️ Telegram", url: tg }],
      [{ text: "⬅️ Volver", callback_data: "SH:BACK" }],
    ],
  };
}

// ---------------- Carrusel ----------------
async function showProductCarousel(chat_id, list, index, categoryLabel) {
  const cfg = await loadConfig();
  const total = list.length;
  const item = list[index];
  const caption = productCaption(cfg, item, index + 1, total, categoryLabel);
  const kb = productNavKeyboard();

  if (isHttp(item.imagen)) {
    const msg = await sendPhoto(chat_id, item.imagen, caption, { parse_mode: "HTML", reply_markup: kb });
    return { messageId: msg?.result?.message_id || null };
  } else {
    const msg = await sendMessage(chat_id, caption + "\n\n⚠️ (Este producto no tiene imagen válida)", {
      parse_mode: "HTML",
      reply_markup: kb,
    });
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

  // siempre volvemos al nav normal al hojear
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
      parse_mode: "HTML",
      reply_markup: productNavKeyboard(),
    });
    if (!edited?.ok) {
      const created = await showProductCarousel(chat_id, list, index, categoryLabel);
      st.messageId = created.messageId;
      userState.set(chat_id, st);
    }
  }
}

// ---------------- Catálogo ----------------
async function handleCatalogMenu(chat_id) {
  const { categories } = await loadCatalog();
  return sendMessage(chat_id, "📚 <b>Categorías</b>\nElegí una para ver productos:", {
    parse_mode: "HTML",
    reply_markup: categoriesKeyboard(categories),
  });
}

async function handleCategory(chat_id, category) {
  const { items } = await loadCatalog();
  let list = items;
  let label = "Todas";

  if (category && category !== "__ALL__") {
    label = category;
    list = items.filter((x) => x.categoria === category);
  }

  if (!list.length) {
    return sendMessage(chat_id, "No hay productos en esta categoría.", { reply_markup: mainMenuKeyboardReply() });
  }

  const st = getState(chat_id);
  st.mode = "CATALOG";
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

// ---------------- Cantidad (pesable vs unidad) ----------------
function parseQty(text) {
  const t = String(text || "").trim().toLowerCase();

  // 200g / 200 g / 200gr
  const g = t.match(/^(\d+)\s*(g|gr|gramos)?$/);
  if (g) return { kind: "GRAMOS", value: Number(g[1]), text: `${Number(g[1])}g` };

  // 2 unidades
  const u = t.match(/^(\d+)$/);
  if (u) return { kind: "UNIDADES", value: Number(u[1]), text: `${Number(u[1])}` };

  return null;
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

  return sendMessage(chat_id, txt, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() });
}

// regla precio pesable:
// - si unidad contiene 100g => precio por 100g
// - si unidad contiene "g" (pero no 100g) y es numérico tipo "200g" => precio por ese paquete (no pesable real)
// - si unidad contiene kg => precio por kg
// - si hay precioPorKilo => precio por kg
function calcPesableSubtotal(item, grams) {
  const precio = Number(item.precio) || 0;
  const u = lower(item.unidad);

  if (Number(item.precioPorKilo || 0) > 0) {
    const kilos = grams / 1000;
    return Math.round((Number(item.precioPorKilo) || 0) * kilos);
  }

  if (u.includes("100g") || u.includes("100 g")) {
    const packs = grams / 100;
    return Math.round(precio * packs);
  }

  // si dice "200g" como unidad (paquete) lo tratamos como por unidad (no pesable real)
  const pack = u.match(/^(\d+)\s*(g|gr)$/);
  if (pack) {
    const packG = Number(pack[1]) || 0;
    if (packG > 0) {
      const packs = grams / packG;
      return Math.round(precio * packs);
    }
  }

  // default por kg
  const kilos = grams / 1000;
  return Math.round(precio * kilos);
}

async function addToCart(chat_id, item, qty) {
  const cart = getCart(chat_id);

  let subtotal = 0;
  if (isPesable(item)) {
    subtotal = calcPesableSubtotal(item, qty.value || 0);
  } else {
    subtotal = Math.round((Number(item.precio) || 0) * (qty.value || 0));
  }

  cart.items.push({
    codigo: item.codigo,
    nombre: item.nombre,
    unidad: item.unidad,
    pesable: isPesable(item),
    qtyText: qty.text,
    qtyValue: qty.value,
    subtotal,
  });
  recalcCart(cart);

  return sendMessage(chat_id, `✅ Listo 😊 Agregué <b>${escapeHtml(item.nombre)}</b> (${escapeHtml(qty.text)}).`, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🧾 Ver carrito", callback_data: "CART:VIEW" }],
        [{ text: "🛍️ Seguir comprando", callback_data: "CAT_MENU" }],
      ],
    },
  });
}

// ---------------- Carrito ----------------
async function showCart(chat_id) {
  const cfg = await loadConfig();
  const moneda = cfgStr(cfg, "Moneda", "ARS");
  const cart = getCart(chat_id);
  recalcCart(cart);

  if (!cart.items.length) {
    return sendMessage(chat_id, "🧾 <b>Carrito</b>\n\nTodavía no agregaste productos.\n👉 Tocá <b>Catálogo</b> para empezar 😊", {
      parse_mode: "HTML",
      reply_markup: mainMenuKeyboardReply(),
    });
  }

  const lines = cart.items.map((x) => {
    return `• <b>${escapeHtml(x.nombre)}</b> — <i>${escapeHtml(x.qtyText)}</i> — <b>${escapeHtml(moneda)} ${escapeHtml(x.subtotal)}</b>`;
  });

  const txt =
    `🧾 <b>Tu carrito</b>\n\n` +
    lines.join("\n") +
    `\n\n<b>Total:</b> ${escapeHtml(moneda)} ${escapeHtml(cart.total)}\n\n` +
    `✅ Tocá <b>Finalizar compra</b> para elegir envío/retiro y pago.`;

  return sendMessage(chat_id, txt, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Finalizar compra", callback_data: "CHECKOUT:START" }],
        [{ text: "🛍️ Seguir comprando", callback_data: "CAT_MENU" }],
      ],
    },
  });
}

// ---------------- Checkout ----------------
async function startCheckout(chat_id) {
  const cfg = await loadConfig();
  const cart = getCart(chat_id);
  recalcCart(cart);

  if (!cart.items.length) {
    return sendMessage(chat_id, "Tu carrito está vacío 😊 Tocá Catálogo para agregar productos.", {
      reply_markup: mainMenuKeyboardReply(),
    });
  }

  const usaEnvio = cfgBool(cfg, "UsaEnvíoDomicilio") || cfgBool(cfg, "UsaEnvioDomicilio");
  const usaRetiro = cfgBool(cfg, "UsaRetiroLocal");
  const costoEnvio = Number(cfgStr(cfg, "CostoEnvio", "0")) || 0;
  const moneda = cfgStr(cfg, "Moneda", "ARS");

  const opciones = [];
  if (usaRetiro) opciones.push([{ text: "🏠 Retiro en local", callback_data: "CHECKOUT:RETIRO" }]);
  if (usaEnvio) opciones.push([{ text: `🚚 Envío a domicilio (+${money(costoEnvio, moneda)})`, callback_data: "CHECKOUT:ENVIO" }]);
  if (!opciones.length) opciones.push([{ text: "✅ Continuar", callback_data: "CHECKOUT:RETIRO" }]);

  const od = orders.get(chat_id) || {};
  od.id = nowId();
  od.delivery = null;
  od.address = "";
  od.payment = null;
  od.pendingProof = false;
  od.referrerChatId = lastReferrer.get(chat_id) || 0;
  orders.set(chat_id, od);

  return sendMessage(chat_id, `✅ <b>Finalizar compra</b>\n\nElegí cómo querés recibir tu pedido:`, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: opciones },
  });
}

async function chooseDelivery(chat_id, delivery) {
  const cfg = await loadConfig();
  const od = orders.get(chat_id) || { id: nowId() };
  od.delivery = delivery;
  orders.set(chat_id, od);

  const st = getState(chat_id);

  if (delivery === "ENVIO") {
    const texto = cfgStr(cfg, "TextoEnvíoDomicilio", "Escribime la dirección completa (calle, número, localidad y referencia).");
    st.awaitingAddress = true;
    userState.set(chat_id, st);

    return sendMessage(
      chat_id,
      `🚚 <b>Envío a domicilio</b>\n\n📍 Ahora escribime tu <b>dirección completa</b>.\n${escapeHtml(texto)}`,
      { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() }
    );
  }

  // retiro
  st.awaitingAddress = false;
  userState.set(chat_id, st);
  return choosePaymentMenu(chat_id);
}

async function choosePaymentMenu(chat_id) {
  const cfg = await loadConfig();
  const cart = getCart(chat_id);
  recalcCart(cart);

  const permitirPagoOnline = cfgBool(cfg, "PermitirPagoOnline");
  const tipoPagoOnline = cfgStr(cfg, "TipoPagoOnline", "").toUpperCase();
  const moneda = cfgStr(cfg, "Moneda", "ARS");

  const od = orders.get(chat_id) || { id: nowId() };
  orders.set(chat_id, od);

  const costoEnvio = Number(cfgStr(cfg, "CostoEnvio", "0")) || 0;
  const total = od.delivery === "ENVIO" ? cart.total + costoEnvio : cart.total;

  const botones = [];
  botones.push([{ text: "💵 Efectivo", callback_data: "PAY:CASH" }]);
  if (permitirPagoOnline && tipoPagoOnline === "TRANSFERENCIA") {
    botones.push([{ text: "🏦 Transferencia", callback_data: "PAY:TRANSFER" }]);
  }

  return sendMessage(chat_id, `💳 <b>Forma de pago</b>\n\nTotal: <b>${escapeHtml(moneda)} ${escapeHtml(total)}</b>\nElegí una opción:`, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: botones },
  });
}

function buildOrderText(cfg, chat_id, statusLabel = "PENDIENTE") {
  const cart = getCart(chat_id);
  recalcCart(cart);

  const od = orders.get(chat_id) || {};
  const moneda = cfgStr(cfg, "Moneda", "ARS");
  const costoEnvio = Number(cfgStr(cfg, "CostoEnvio", "0")) || 0;
  const total = od.delivery === "ENVIO" ? cart.total + costoEnvio : cart.total;

  const itemsTxt = cart.items.map((x) => `- ${x.nombre} (${x.qtyText}) — ${moneda} ${x.subtotal}`).join("\n");

  const entrega =
    od.delivery === "ENVIO"
      ? `🚚 Envío a domicilio\n📍 Dirección: ${od.address || "(no informada)"}\n💲 Envío: ${moneda} ${costoEnvio}`
      : `🏠 Retiro en local`;

  const pago =
    od.payment === "TRANSFER"
      ? "🏦 Transferencia (pendiente confirmación)"
      : od.payment === "CASH"
      ? "💵 Efectivo"
      : "(no definido)";

  const negocio = cfgStr(cfg, "NegocioNombre", "Negocio");
  return (
    `🧾 <b>PEDIDO</b> — <b>${escapeHtml(negocio)}</b>\n` +
    `🆔 ID: <b>${escapeHtml(od.id || "")}</b>\n` +
    `📌 Estado: <b>${escapeHtml(statusLabel)}</b>\n\n` +
    `🛒 <b>Detalle</b>\n${escapeHtml(itemsTxt)}\n\n` +
    `📦 <b>Entrega</b>\n${escapeHtml(entrega)}\n\n` +
    `💳 <b>Pago</b>\n${escapeHtml(pago)}\n\n` +
    `💰 <b>Total:</b> ${escapeHtml(moneda)} ${escapeHtml(total)}`
  );
}

async function notifyBusinessWithButtons(cfg, buyerChatId, orderText, orderId) {
  const vendorChat = String(cfgStr(cfg, "VendedorChatId", "")).trim();
  if (!vendorChat) return { ok: false, reason: "No VendedorChatId" };

  const btnTextPending = cfgStr(cfg, "TextoAvisoVendedor", "Tenés un pedido para confirmar ✅");

  const msg = await sendMessage(
    vendorChat,
    `${orderText}\n\n🧠 ${escapeHtml(btnTextPending)}\n\n¿Confirmás este pedido?`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Confirmar", callback_data: `V:CONFIRM:${orderId}:${buyerChatId}` }],
          [{ text: "❌ Rechazar", callback_data: `V:REJECT:${orderId}:${buyerChatId}` }],
        ],
      },
    }
  );

  return { ok: true, vendorChatId: vendorChat, vendorMsgId: msg?.result?.message_id || null };
}

// ---------------- Sellos: sumar por compra + referido ----------------
function calcStampsFromTotal(cfg, total) {
  const montoPorSello = Number(cfgStr(cfg, "MontoPorSello", "10000")) || 10000;
  if (montoPorSello <= 0) return 0;
  return Math.floor(Number(total || 0) / montoPorSello);
}

async function applyStampsAfterConfirmed(cfg, buyerChatId) {
  const cart = getCart(buyerChatId);
  recalcCart(cart);
  const od = orders.get(buyerChatId) || {};
  const costoEnvio = Number(cfgStr(cfg, "CostoEnvio", "0")) || 0;
  const total = od.delivery === "ENVIO" ? cart.total + costoEnvio : cart.total;

  // sellos por compra
  if (cfgBool(cfg, "UsaSellos")) {
    const add = calcStampsFromTotal(cfg, total);
    if (add > 0) addStamps(buyerChatId, add);
  }

  // sellos por referido si vino desde link compartido
  const ref = Number(od.referrerChatId || 0);
  const bonus = Number(cfgStr(cfg, "BonusSellosShare", "0")) || 0;
  if (ref && ref !== buyerChatId && bonus > 0) {
    addStamps(ref, bonus);
    // aviso al referente
    await sendMessage(
      ref,
      `🎉 ¡Genial! Alguien compró desde tu recomendación.\nSumaste <b>${bonus}</b> sello(s) extra ✅`,
      { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() }
    );
  }
}

// ---------------- Pago: Transferencia / Efectivo ----------------
async function setPayment(chat_id, payment) {
  const cfg = await loadConfig();
  const cart = getCart(chat_id);
  recalcCart(cart);

  const od = orders.get(chat_id) || { id: nowId() };
  od.payment = payment;
  orders.set(chat_id, od);

  if (payment === "CASH") {
    // se manda al vendedor para confirmar, y se confirma cuando el vendedor aprueba
    const orderId = od.id;
    const orderText = buildOrderText(cfg, chat_id, "PENDIENTE");
    const notif = await notifyBusinessWithButtons(cfg, chat_id, orderText, orderId);

    ordersById.set(orderId, { chatId, vendorChatId: notif.vendorChatId || "", status: "PENDING" });

    return sendMessage(
      chat_id,
      `✅ <b>Pedido enviado</b>\n\nTu pedido quedó <b>pendiente de confirmación</b> del negocio.\nTe avisamos por acá apenas lo confirmen 😊`,
      { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() }
    );
  }

  if (payment === "TRANSFER") {
    const moneda = cfgStr(cfg, "Moneda", "ARS");
    const costoEnvio = Number(cfgStr(cfg, "CostoEnvio", "0")) || 0;
    const total = od.delivery === "ENVIO" ? cart.total + costoEnvio : cart.total;

    const alias = cfgStr(cfg, "AliasTransferencia", "");
    const cbu = cfgStr(cfg, "CBUPago", "");
    const msg = cfgStr(cfg, "MensajeTransferencia", "Hacé la transferencia y luego enviá el comprobante por acá.");

    // MUY IMPORTANTE: esto NO es confirmación. Es instrucción.
    const texto =
      `🏦 <b>Transferencia</b>\n\n` +
      `Total: <b>${escapeHtml(moneda)} ${escapeHtml(total)}</b>\n\n` +
      (alias ? `🔑 Alias: <b>${escapeHtml(alias)}</b>\n` : "") +
      (cbu ? `🏷️ CBU: <b>${escapeHtml(cbu)}</b>\n` : "") +
      `\n${escapeHtml(msg)}\n\n` +
      `📎 <b>Ahora enviá el comprobante</b> (foto o archivo) por este chat.\n` +
      `Cuando el negocio lo confirme, te avisamos por acá ✅`;

    const st = getState(chat_id);
    st.awaitingProof = true;
    userState.set(chat_id, st);

    return sendMessage(chat_id, texto, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() });
  }

  return choosePaymentMenu(chat_id);
}

// ---------------- Comprobante (foto/archivo) ----------------
async function handleProof(chat_id, updateMessage) {
  const cfg = await loadConfig();
  const st = getState(chat_id);
  if (!st.awaitingProof) return;

  st.awaitingProof = false;
  userState.set(chat_id, st);

  const od = orders.get(chat_id) || { id: nowId() };
  const orderId = od.id;

  // 1) mandamos pedido pendiente al vendedor + forward comprobante
  const orderText = buildOrderText(cfg, chat_id, "PENDIENTE (COMPROBANTE RECIBIDO)");
  const notif = await notifyBusinessWithButtons(cfg, chat_id, orderText, orderId);
  ordersById.set(orderId, { chatId, vendorChatId: notif.vendorChatId || "", status: "PENDING" });

  const vendorChat = String(cfgStr(cfg, "VendedorChatId", "")).trim();
  if (vendorChat) {
    await forwardMessage(vendorChat, chat_id, updateMessage.message_id);
  }

  // 2) avisamos al cliente
  return sendMessage(
    chat_id,
    `✅ <b>Comprobante recibido</b>\n\nQuedó <b>pendiente</b> hasta que el negocio confirme.\nTe avisamos por acá apenas esté ✅`,
    { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() }
  );
}

// ---------------- Sellos / Tarjeta ----------------
async function handleSellos(chat_id) {
  const cfg = await loadConfig();
  const usa = cfgBool(cfg, "UsaSellos");
  if (!usa) {
    return sendMessage(chat_id, "🏷️ Los sellos no están activos por el momento.", {
      reply_markup: mainMenuKeyboardReply(),
    });
  }

  const cardUrl = normalizeUrl(cfgStr(cfg, "CARD_URL", ""));
  const selloUrl = normalizeUrl(cfgStr(cfg, "SelloURL", "")); // por si querés usarlo luego
  const stamps = getStamps(chat_id);
  const monto = Number(cfgStr(cfg, "MontoPorSello", "10000")) || 10000;

  const levelInfo = computeLevel(cfg, stamps);
  const falta = Math.max(0, (levelInfo.nextAt || 0) - stamps);

  const base =
    `🏷️ <b>Tu tarjeta de sellos</b>\n\n` +
    `Sellos acumulados: <b>${stamps}</b>\n` +
    `💡 1 sello cada <b>${monto.toLocaleString("es-AR")}</b> de compra\n\n`;

  let lvl = "";
  if (cfgBool(cfg, "UsaNiveles")) {
    if (levelInfo.levelName) {
      lvl += `🎖️ Nivel actual: <b>${escapeHtml(levelInfo.levelName)}</b>\n`;
      if (levelInfo.levelBenefit) lvl += `🎁 Beneficio: ${escapeHtml(levelInfo.levelBenefit)}\n\n`;
    }
    if (!levelInfo.hasReachedAll && levelInfo.nextName) {
      lvl += `➡️ Próximo nivel: <b>${escapeHtml(levelInfo.nextName)}</b>\n`;
      lvl += `Te faltan <b>${falta}</b> sellos para llegar.\n`;
      if (levelInfo.nextBenefit) lvl += `🎁 Al llegar: ${escapeHtml(levelInfo.nextBenefit)}\n`;
    }
    if (levelInfo.hasReachedAll) {
      lvl += `🎉 ${escapeHtml(cfgStr(cfg, "MensajeNivelCompletado", "¡Felicitaciones! Completaste tu nivel ✅"))}\n`;
    }
  }

  const tip =
    `\n📣 Tip: si compartís un producto y alguien compra desde tu link, también podés sumar sellos extra 😉`;

  const txt = base + lvl + tip;

  if (isHttp(cardUrl)) {
    // mostramos la tarjeta (imagen) y abajo texto
    return sendPhoto(chat_id, cardUrl, txt, {
      parse_mode: "HTML",
      reply_markup: mainMenuKeyboardReply(),
    });
  }

  // fallback
  return sendMessage(chat_id, txt, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() });
}

// ---------------- Compartir BOT (solo “¿querés este sistema?”) ----------------
async function handleShareBot(chat_id) {
  const cfg = await loadConfig();
  if (!cfgBool(cfg, "CompartirBotActivo")) {
    return sendMessage(chat_id, "📣 Esta opción no está activa por el momento.", { reply_markup: mainMenuKeyboardReply() });
  }

  const email = cfgStr(cfg, "EmailSistema", "ezerbot.assistant@gmail.com");
  const textoSistema = cfgStr(cfg, "TextoSistema", "¿Querés este sistema para tu negocio? Contactanos");
  const botLink = cfgStr(cfg, "BotLink", botStartLink("B"));

  const msg =
    `🤖 <b>${escapeHtml(textoSistema)}</b>\n\n` +
    `📩 Email: <b>${escapeHtml(email)}</b>\n` +
    `🔗 Bot demo: ${escapeHtml(botLink)}\n\n` +
    `Si querés, lo compartís y te dejamos el mensaje listo 👇`;

  const wa = `https://wa.me/?text=${encodeURIComponent(`${textoSistema}\n\nEmail: ${email}\nDemo: ${botLink}`)}`;
  const tg = `https://t.me/share/url?url=${encodeURIComponent(botLink)}&text=${encodeURIComponent(`${textoSistema}\nEmail: ${email}`)}`;

  return sendMessage(chat_id, msg, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "📣 WhatsApp", url: wa }, { text: "✈️ Telegram", url: tg }]] },
  });
}

// ---------------- Ayuda (más humana) ----------------
async function handleHelp(chat_id) {
  const cfg = await loadConfig();
  const wa = cfgStr(cfg, "WhatsAppLink", "");
  const tel = cfgStr(cfg, "NegocioTelefono", "");
  const insta = cfgStr(cfg, "NegocioInstagram", "");
  const negocio = cfgStr(cfg, "NegocioNombre", "Todo Queso");

  const txt =
    `🆘 <b>Ayuda</b>\n\n` +
    `Estoy para ayudarte 😊\n\n` +
    `• Para comprar: entrá a <b>🛍️ Catálogo</b>, tocá <b>🟢 Quiero este</b> y agregá al <b>🧾 Carrito</b>.\n` +
    `• Para finalizar: abrí <b>🧾 Carrito</b> y tocá <b>Finalizar compra</b>.\n\n` +
    `📌 Si querés hacer una consulta, reclamo o avisar algo del pedido, escribinos directo:\n` +
    (wa ? `✅ WhatsApp: <b>${escapeHtml(wa)}</b>\n` : (tel ? `✅ WhatsApp: <b>${escapeHtml(tel)}</b>\n` : "")) +
    (insta ? `📷 Instagram: <b>${escapeHtml(insta)}</b>\n` : "") +
    `\nGracias por elegir <b>${escapeHtml(negocio)}</b> 🧀`;

  return sendMessage(chat_id, txt, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() });
}

// ---------------- Start / producto compartido ----------------
async function showSharedProduct(chat_id, code) {
  const cfg = await loadConfig();
  const { items } = await loadCatalog();
  const item = items.find((x) => lower(x.codigo) === lower(code));

  if (!item) {
    return sendMessage(chat_id, "🧀 Te compartieron un producto, pero no lo encontré. Tocá Catálogo para verlo.", {
      reply_markup: mainMenuKeyboardReply(),
    });
  }

  // seteamos carrusel con esa “lista” de 1, así el comprador puede “quedarse” en el flujo
  const st = getState(chat_id);
  st.mode = "CATALOG";
  st.categoryLabel = item.categoria || "Producto";
  st.list = [item];
  st.index = 0;
  st.messageId = null;
  st.shareMode = false;
  userState.set(chat_id, st);

  const caption = `🎁 <b>Te compartieron este producto</b>\n\n` + productCaption(cfg, item, 1, 1, item.categoria);
  const kb = {
    inline_keyboard: [
      [{ text: "🟢 Quiero este", callback_data: "P:BUY" }],
      [{ text: "🛍️ Ver catálogo", callback_data: "CAT_MENU" }],
      [{ text: "🧾 Ver carrito", callback_data: "CART:VIEW" }],
    ],
  };

  if (isHttp(item.imagen)) {
    const msg = await sendPhoto(chat_id, item.imagen, caption, { parse_mode: "HTML", reply_markup: kb });
    st.messageId = msg?.result?.message_id || null;
    userState.set(chat_id, st);
    return;
  }

  const msg = await sendMessage(chat_id, caption, { parse_mode: "HTML", reply_markup: kb });
  st.messageId = msg?.result?.message_id || null;
  userState.set(chat_id, st);
}

async function handleStart(chat_id, payload = "") {
  if (!BOT_USERNAME) {
    const me = await tgCall("getMe", {});
    BOT_USERNAME = me?.result?.username || BOT_USERNAME;
  }

  const cfg = await loadConfig();
  const negocio = cfgStr(cfg, "NegocioNombre", "Todo Queso");
  const logo = normalizeUrl(cfgStr(cfg, "LogoURL", ""));
  const desc = cfgStr(cfg, "Descripcion", "");
  const direccion = cfgStr(cfg, "NegocioDireccion", "");
  const horario = cfgStr(cfg, "NegocioHorario", "");
  const tel = cfgStr(cfg, "NegocioTelefono", "");
  const estado = lower(cfgStr(cfg, "Estado", ""));

  const estadoTxt =
    estado.includes("abier") ? "✅ <b>Estamos atendiendo</b>" :
    estado.includes("cerr") ? "🚫 <b>Ahora estamos cerrados</b>" :
    "";

  const bienvenida =
    `👋 <b>¡Hola!</b> Bienvenido/a a <b>${escapeHtml(negocio)}</b> 🧀\n` +
    (estadoTxt ? `${estadoTxt}\n` : "") +
    (direccion ? `📍 ${escapeHtml(direccion)}\n` : "") +
    (horario ? `🕒 ${escapeHtml(horario)}\n` : "") +
    (tel ? `📲 ${escapeHtml(tel)}\n` : "") +
    (desc ? `\n${escapeHtml(desc)}\n` : "\n") +
    `👉 Tocá <b>🛍️ Catálogo</b> para ver productos con foto.\n` +
    `👉 Tocá <b>🧾 Carrito</b> para finalizar.\n` +
    `👉 Tocá <b>🏷️ Sellos</b> para ver tu tarjeta.\n` +
    `👉 Si necesitás una mano, tocá <b>🆘 Ayuda</b>.`;

  const parsed = parseStartPayload(payload);

  // guardar referrer si viene
  if (parsed?.referrerChatId && parsed.referrerChatId > 0 && parsed.referrerChatId !== chat_id) {
    lastReferrer.set(chat_id, parsed.referrerChatId);
  }

  // saludo con logo
  if (isHttp(logo)) await sendPhoto(chat_id, logo, bienvenida, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() });
  else await sendMessage(chat_id, bienvenida, { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() });

  if (parsed.kind === "PRODUCT") return showSharedProduct(chat_id, parsed.code);
  return;
}

// ---------------- Callbacks ----------------
async function handleCallback(cb) {
  const chat_id = cb.message?.chat?.id;
  const data = cb.data || "";
  if (!chat_id) return;

  await tgCall("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});

  if (data === "HOME") return handleStart(chat_id, "");
  if (data === "CAT_MENU") return handleCatalogMenu(chat_id);

  if (data.startsWith("CAT:")) {
    const raw = data.slice(4);
    const cat = decodeURIComponent(raw);
    return handleCategory(chat_id, cat === "__ALL__" ? "__ALL__" : cat);
  }

  // carrusel
  if (data === "P:NEXT" || data === "P:PREV") {
    const st = getState(chat_id);
    if (!st?.list?.length) return;
    const total = st.list.length;
    st.index = data === "P:NEXT" ? (st.index + 1) % total : (st.index - 1 + total) % total;
    userState.set(chat_id, st);
    return updateCarousel(chat_id, st);
  }

  // abrir share menu del producto (edita el mismo mensaje)
  if (data === "P:SHARE_MENU") {
    const cfg = await loadConfig();
    const st = getState(chat_id);
    const item = st?.list?.[st?.index];
    if (!st?.messageId || !item) return;
    st.shareMode = true;
    userState.set(chat_id, st);
    return editMessageReplyMarkup(chat_id, st.messageId, shareMenuKeyboard(cfg, item, chat_id));
  }

  if (data === "SH:BACK") {
    const st = getState(chat_id);
    if (!st?.messageId) return;
    st.shareMode = false;
    userState.set(chat_id, st);
    return editMessageReplyMarkup(chat_id, st.messageId, productNavKeyboard());
  }

  if (data === "P:BUY") {
    const st = getState(chat_id);
    const item = st?.list?.[st?.index];
    if (!item) return;
    return askQuantity(chat_id, item);
  }

  // carrito / checkout
  if (data === "CART:VIEW") return showCart(chat_id);
  if (data === "CHECKOUT:START") return startCheckout(chat_id);
  if (data === "CHECKOUT:RETIRO") return chooseDelivery(chat_id, "RETIRO");
  if (data === "CHECKOUT:ENVIO") return chooseDelivery(chat_id, "ENVIO");
  if (data === "PAY:CASH") return setPayment(chat_id, "CASH");
  if (data === "PAY:TRANSFER") return setPayment(chat_id, "TRANSFER");

  // vendedor confirma/rechaza
  if (data.startsWith("V:CONFIRM:") || data.startsWith("V:REJECT:")) {
    const cfg = await loadConfig();

    const parts = data.split(":");
    const action = parts[1]; // CONFIRM / REJECT
    const orderId = parts[2];
    const buyerChatId = Number(parts[3] || 0);

    const rec = ordersById.get(orderId);
    if (!rec || rec.status !== "PENDING") {
      return sendMessage(chat_id, "ℹ️ Este pedido ya fue procesado o no existe.", { reply_markup: mainMenuKeyboardReply() });
    }

    if (action === "CONFIRM") {
      rec.status = "CONFIRMED";
      ordersById.set(orderId, rec);

      // sumar sellos + referido
      await applyStampsAfterConfirmed(cfg, buyerChatId);

      const okTxt = cfgStr(cfg, "TextoConfirmacionPedido", "Gracias. Tu compra fue confirmada y está en preparación ✅");
      await sendMessage(buyerChatId, `✅ <b>Pedido confirmado</b>\n\n${escapeHtml(okTxt)}`, {
        parse_mode: "HTML",
        reply_markup: mainMenuKeyboardReply(),
      });

      // limpiar carrito
      carts.set(buyerChatId, { items: [], total: 0 });

      // actualizar el mensaje del vendedor
      return editMessageCaption(chat_id, cb.message.message_id, `${cb.message.caption || cb.message.text || ""}\n\n✅ <b>CONFIRMADO</b>`, { parse_mode: "HTML" }).catch(async () => {
        return sendMessage(chat_id, "✅ Pedido confirmado.", { reply_markup: mainMenuKeyboardReply() });
      });
    }

    if (action === "REJECT") {
      rec.status = "REJECTED";
      ordersById.set(orderId, rec);

      await sendMessage(
        buyerChatId,
        `❌ <b>Pedido rechazado</b>\n\nEscribinos por <b>WhatsApp</b> para ayudarte a resolverlo.`,
        { parse_mode: "HTML", reply_markup: mainMenuKeyboardReply() }
      );

      return sendMessage(chat_id, "❌ Pedido rechazado y notificado al cliente.", { reply_markup: mainMenuKeyboardReply() });
    }
  }
}

// ---------------- Mensajes ----------------
async function handleTextMessage(chat_id, message) {
  const text = (message?.text || "").trim();
  const st = getState(chat_id);

  if (text === "/start") return handleStart(chat_id, "");
  if (text.startsWith("/start ")) return handleStart(chat_id, (text.split(" ")[1] || "").trim());

  // si está esperando dirección
  if (st.awaitingAddress) {
    const od = orders.get(chat_id) || { id: nowId() };
    od.address = text;
    orders.set(chat_id, od);
    st.awaitingAddress = false;
    userState.set(chat_id, st);
    return choosePaymentMenu(chat_id);
  }

  // si está esperando cantidad
  if (st.awaitingQty && st.pendingItem) {
    const qty = parseQty(text);
    if (!qty) {
      const pesable = isPesable(st.pendingItem);
      return sendMessage(chat_id, pesable ? "Decime gramos 😊 Ej: <b>200g</b>" : "Decime unidades 😊 Ej: <b>1</b> o <b>2</b>", {
        parse_mode: "HTML",
        reply_markup: mainMenuKeyboardReply(),
      });
    }
    if (!isPesable(st.pendingItem) && qty.kind === "GRAMOS") {
      return sendMessage(chat_id, "Este producto se pide por <b>unidades</b>. Ej: <b>1</b> o <b>2</b> 😊", {
        parse_mode: "HTML",
        reply_markup: mainMenuKeyboardReply(),
      });
    }
    if (isPesable(st.pendingItem) && qty.kind === "UNIDADES") {
      return sendMessage(chat_id, "Este producto es por peso 😊 Decime gramos. Ej: <b>200g</b>", {
        parse_mode: "HTML",
        reply_markup: mainMenuKeyboardReply(),
      });
    }

    st.awaitingQty = false;
    const item = st.pendingItem;
    st.pendingItem = null;
    userState.set(chat_id, st);
    return addToCart(chat_id, item, qty);
  }

  // menú
  if (text === "🛍️ Catálogo" || text.toUpperCase() === "CATÁLOGO" || text.toUpperCase() === "CATALOGO") return handleCatalogMenu(chat_id);
  if (text === "🧾 Carrito") return showCart(chat_id);
  if (text === "🏷️ Sellos") return handleSellos(chat_id);
  if (text === "📣 Compartir bot") return handleShareBot(chat_id);
  if (text === "🆘 Ayuda") return handleHelp(chat_id);

  return sendMessage(chat_id, "👋 Para empezar tocá <b>🛍️ Catálogo</b> o mirá <b>🧾 Carrito</b> 😊", {
    parse_mode: "HTML",
    reply_markup: mainMenuKeyboardReply(),
  });
}

// ---------------- Routes ----------------
app.get("/", (req, res) => res.status(200).send("OK - BOT LIVE"));

app.get("/debug", async (req, res) => {
  try {
    const cfg = await loadConfig();
    const cat = await loadCatalog();
    res.status(200).json({
      ok: true,
      env: { hasToken: Boolean(TOKEN), publicUrl: PUBLIC_URL || null, dataApiUrl: DATA_API_URL || null, botUsername: BOT_USERNAME || null },
      configKeysSample: Object.keys(cfg).slice(0, 80),
      catalogSample: { items: cat.items.slice(0, 3), categories: cat.categories },
    });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/", async (req, res) => {
  res.sendStatus(200);
  const upd = req.body || {};

  try {
    if (upd.callback_query) return handleCallback(upd.callback_query);

    if (upd.message) {
      const chat_id = upd.message.chat.id;
      const st = getState(chat_id);

      // comprobante (foto o archivo)
      if (st.awaitingProof && (upd.message.photo || upd.message.document)) {
        return handleProof(chat_id, upd.message);
      }

      if (upd.message.text) return handleTextMessage(chat_id, upd.message);
      return;
    }
  } catch (e) {
    console.error("Handler error:", e);
  }
});

// ---------------- Boot ----------------
async function boot() {
  console.log("✅ Server listo en puerto", PORT);
  console.log("✅ Webhook debería apuntar a:", PUBLIC_URL ? `${PUBLIC_URL}/` : "(PUBLIC_URL vacío)");

  const me = await tgCall("getMe", {});
  if (me?.ok && me?.result?.username) {
    BOT_USERNAME = me.result.username;
    console.log("✅ BOT_USERNAME:", BOT_USERNAME);
  }

  try {
    const cfg = await loadConfig();
    console.log("✅ CONFIG OK. Keys:", Object.keys(cfg).length);
  } catch (e) {
    console.log("❌ Error leyendo CONFIG:", String(e?.message || e));
  }

  try {
    const cat = await loadCatalog();
    console.log("✅ CATALOGO OK. Items:", cat.items.length, "Cats:", cat.categories.length);
  } catch (e) {
    console.log("❌ Error leyendo CATALOGO:", String(e?.message || e));
  }
}

app.listen(PORT, boot);

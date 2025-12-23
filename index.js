// index.js (ESM) — EzerBot Render Webhook + Config/Catalogo desde Google Sheets (Apps Script)
// Requisitos Render ENV: BOT_TOKEN, SHEETS_API_BASE, PUBLIC_URL
// PUBLIC_URL = https://ezerbot-system.onrender.com (SIN / al final)
// SHEETS_API_BASE = https://script.google.com/macros/s/XXXX/exec

import TelegramBot from "node-telegram-bot-api";
import http from "http";
import { URL } from "url";

// =====================
// 1) ENV
// =====================
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const SHEETS_API_BASE = process.env.SHEETS_API_BASE || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const PORT = Number(process.env.PORT || 10000);

const WEBHOOK_PATH = "/telegram";
const WEBHOOK_URL = PUBLIC_URL ? `${PUBLIC_URL}${WEBHOOK_PATH}` : "";

if (!BOT_TOKEN) console.log("❌ FALTA BOT_TOKEN en Render > Environment");
if (!SHEETS_API_BASE) console.log("❌ FALTA SHEETS_API_BASE en Render > Environment");
if (!PUBLIC_URL) console.log("❌ FALTA PUBLIC_URL en Render > Environment (ej: https://ezerbot-system.onrender.com)");

// =====================
// 2) BOT (WEBHOOK ONLY)
// =====================
const bot = new TelegramBot(BOT_TOKEN, { webHook: true });

// =====================
// 3) CACHE (Config + Catalogo)
// =====================
const CACHE_TTL_MS = 30 * 1000;
let cacheConfig = { at: 0, data: null };
let cacheCatalog = { at: 0, data: null };

async function fetchJSON(url) {
  const r = await fetch(url, { method: "GET" });
  const txt = await r.text();
  let j;
  try {
    j = JSON.parse(txt);
  } catch {
    throw new Error(`Respuesta no JSON desde ${url}: ${txt.slice(0, 200)}`);
  }
  return j;
}

async function getConfig() {
  const now = Date.now();
  if (cacheConfig.data && now - cacheConfig.at < CACHE_TTL_MS) return cacheConfig.data;
  if (!SHEETS_API_BASE) return {};
  const url = `${SHEETS_API_BASE}?type=config&_=${now}`;
  const data = await fetchJSON(url);
  cacheConfig = { at: now, data: data || {} };
  return cacheConfig.data;
}

async function getCatalog() {
  const now = Date.now();
  if (cacheCatalog.data && now - cacheCatalog.at < CACHE_TTL_MS) return cacheCatalog.data;
  if (!SHEETS_API_BASE) return [];
  const url = `${SHEETS_API_BASE}?type=catalog&_=${now}`;
  const data = await fetchJSON(url);
  cacheCatalog = { at: now, data: Array.isArray(data) ? data : [] };
  return cacheCatalog.data;
}

// =====================
// 4) HELPERS
// =====================
function safeStr(v) {
  return String(v ?? "").trim();
}

function upperSI(v) {
  return safeStr(v).toUpperCase() === "SI";
}

function moneyARS(n) {
  const v = Number(n || 0);
  try {
    return v.toLocaleString("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });
  } catch {
    return `$${Math.round(v)}`;
  }
}

function normalizeUnit(u) {
  const s = safeStr(u).toLowerCase();
  if (s.includes("kg")) return "kg";
  return "unidad";
}

function roundQty(q, unit) {
  const n = Number(q || 0);
  if (!isFinite(n) || n <= 0) return 0;
  if (unit === "kg") return Math.round(n * 100) / 100;
  return Math.round(n);
}

function pickCfg(cfg, keys, fallback = "") {
  for (const k of keys) {
    const v = safeStr(cfg?.[k]);
    if (v) return v;
  }
  return fallback;
}

function pickNumberCfg(cfg, keys, fallback = 0) {
  for (const k of keys) {
    const v = Number(cfg?.[k]);
    if (isFinite(v) && v !== 0) return v;
  }
  return fallback;
}

// =====================
// 5) IMAGEN ROBUSTA (sirve para Postimg, Drive, etc.)
// =====================
async function fetchImageAsBuffer(url) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`HTTP ${r.status} al bajar imagen`);
  const arr = await r.arrayBuffer();
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  let ext = "jpg";
  if (ct.includes("png")) ext = "png";
  else if (ct.includes("webp")) ext = "webp";
  return { buffer: Buffer.from(arr), ext };
}

async function sendPhotoSafe(chatId, url, opts = {}) {
  const u = safeStr(url);
  if (!u) throw new Error("url vacía");

  // 1) intento directo
  try {
    await bot.sendPhoto(chatId, u, opts);
    return true;
  } catch {
    // 2) fallback: descargar y enviar buffer
    const { buffer, ext } = await fetchImageAsBuffer(u);
    await bot.sendPhoto(chatId, buffer, { ...opts, filename: `img.${ext}` });
    return true;
  }
}

// =====================
// 6) STATE (RAM)
// =====================
const userState = new Map();

function getState(chatId) {
  if (!userState.has(chatId)) {
    userState.set(chatId, {
      catFilter: "ALL",
      catIndex: 0, // modo book: índice dentro de la lista filtrada
      cart: new Map(), // code -> { prod, qty }
      awaitingQtyFor: null,
      flow: null,
      lastCatalogListHash: "", // para evitar desfasajes si cambia catálogo
    });
  }
  return userState.get(chatId);
}

// =====================
// 7) MENÚ PRINCIPAL
// =====================
function mainMenuKeyboard() {
  return {
    keyboard: [
      [{ text: "🛍️ Catálogo" }, { text: "🛒 Mi carrito" }],
      [{ text: "✅ Finalizar compra" }],
      [{ text: "🎫 Tarjeta de sellos" }, { text: "📣 Compartir el bot" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

// =====================
// 8) SHARE
// =====================
function buildBotLink(cfg) {
  // Si en Config pusiste BotLink, lo usa. Si no, usa uno genérico.
  // (Telegram requiere el username real para que sea perfecto; si no lo sabemos, igual compartimos.)
  const byCfg = safeStr(cfg.BotLink);
  if (byCfg) return byCfg;

  // fallback: si tenés el username en Config
  const user = safeStr(cfg.BotUsername).replace("@", "");
  if (user) return `https://t.me/${user}`;

  // último fallback
  return "https://t.me/EzerBot";
}

function shareInlineButtons(cfg) {
  const botLink = buildBotLink(cfg);
  const negocio = safeStr(cfg.NegocioNombre) || "Todo Queso";
  const waText = encodeURIComponent(`🧀 Pedí por el bot de ${negocio} 👇\n${botLink}`);
  const mailSubj = encodeURIComponent(`Pedido por bot - ${negocio}`);
  const mailBody = encodeURIComponent(`Hola! Te comparto el bot para pedir:\n${botLink}`);

  return {
    inline_keyboard: [
      [{ text: "💬 WhatsApp", url: `https://wa.me/?text=${waText}` }],
      [{ text: "✈️ Telegram", url: `https://t.me/share/url?url=${encodeURIComponent(botLink)}&text=${encodeURIComponent("Pedí por el bot:")}` }],
      [{ text: "📧 Email", url: `mailto:?subject=${mailSubj}&body=${mailBody}` }],
    ],
  };
}

async function openShare(chatId) {
  const cfg = await getConfig();
  await bot.sendMessage(chatId, "📣 Compartí el bot con tus contactos 👇", {
    reply_markup: shareInlineButtons(cfg),
  });
}

// =====================
// 9) BIENVENIDA
// =====================
async function sendWelcome(chatId) {
  const cfg = await getConfig();

  const negocio = pickCfg(cfg, ["NegocioNombre", "NombreNegocio", "Nombre"], "Mi negocio");
  const dir = pickCfg(cfg, ["Direccion", "Dirección", "DireccionNegocio"], "Dirección no configurada");
  const hor = pickCfg(cfg, ["Horarios", "Horario", "HorarioNegocio"], "Horarios no configurados");
  const tel = pickCfg(cfg, ["TelefonoNegocio", "TelNegocio", "Telefono", "Teléfono"], "Teléfono no configurado");
  const ig = pickCfg(cfg, ["Instagram", "IG"], "");
  const logo = pickCfg(cfg, ["LogoURL", "Logo", "LogoUrl"], "");

  // Texto configurable (si existe)
  const textoBienvenida = pickCfg(cfg, ["TextoBienvenida", "SaludoBienvenida", "BienvenidaTexto"], "");

  let text = "";
  if (textoBienvenida) {
    text += `${textoBienvenida}\n\n`;
  } else {
    text += `¡Hola! 👋 Bienvenid@ a *${negocio}* 🧀✨\nElegí del catálogo, armá tu carrito y confirmá en 1 minuto.\n¿Arrancamos? 😋\n\n`;
  }

  text += `🧀 *${negocio}*\n`;
  text += `📍 ${dir}\n`;
  text += `🕒 ${hor}\n`;
  text += `📞 ${tel}\n`;
  if (ig && ig.toUpperCase() !== "NO") text += `📸 Instagram: ${ig.startsWith("@") ? ig : "@" + ig}\n`;

  const desc = pickCfg(cfg, ["Descripcion", "Descripción", "TextoDescripcion"], "");
  if (desc) text += `\n${desc}\n`;

  text += `\nElegí una opción del menú para empezar 👇`;

  // logo (si existe) con envío robusto
  if (logo) {
    try {
      await sendPhotoSafe(chatId, logo, {
        caption: text,
        parse_mode: "Markdown",
        reply_markup: mainMenuKeyboard(),
      });
      return;
    } catch {
      // fallback a texto
    }
  }

  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: mainMenuKeyboard(),
  });
}

// =====================
// 10) SELL0S (placeholder, como ya lo tenías)
// =====================
async function sendStampsCard(chatId) {
  const cfg = await getConfig();
  const usa = upperSI(pickCfg(cfg, ["UsaSellos", "UsaNiveles", "UsaTarjeta"], "NO"));
  const cardUrl = pickCfg(cfg, ["TarjetaURL", "SelloURL", "SelloUrl", "TarjetaSellosURL"], "");
  const premio = pickCfg(cfg, ["BeneficioCumple", "PremioSellos", "Premio"], "Un beneficio sorpresa");
  const meta = Number(pickCfg(cfg, ["SellosPorNivel", "SellosMeta"], "10")) || 10;

  if (!usa) {
    await bot.sendMessage(chatId, "Por ahora la tarjeta de sellos está desactivada.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  const sellos = 0;
  const bar = "🟩".repeat(Math.min(sellos, meta)) + "⬜".repeat(Math.max(0, meta - sellos));

  const text =
    `🎫 *Tarjeta de sellos*\n\n` +
    `${bar}\n\n` +
    `Sellos: *${sellos} / ${meta}*\n` +
    `Premio al completar: *${premio}*\n\n` +
    `Tip: cada compra confirmada suma 1 sello automático.`;

  if (cardUrl) {
    try {
      await sendPhotoSafe(chatId, cardUrl, { caption: text, parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
      return;
    } catch {
      // fallback
    }
  }

  await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
}

// =====================
// 11) CATÁLOGO MODO BOOK (carrusel)
// =====================
function uniqueCategories(list) {
  const set = new Set();
  for (const p of list) {
    const c = safeStr(p.categoria);
    if (c) set.add(c);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, "es"));
}

function filterCatalog(list, filter) {
  if (!filter || filter === "ALL") return list;
  return list.filter((p) => safeStr(p.categoria) === filter);
}

function listHash(list) {
  // hash simple para detectar cambios
  return String(list.length) + ":" + list.map((p) => safeStr(p.codigo || p.id)).join("|").slice(0, 500);
}

async function showCategories(chatId) {
  const st = getState(chatId);
  const full = await getCatalog();
  const cats = uniqueCategories(full);

  const rows = [];
  // primera fila: todas
  rows.push([{ text: "📚 Todas", callback_data: "CATF:ALL" }]);

  // categorías en filas de 2
  let row = [];
  for (const c of cats) {
    row.push({ text: c, callback_data: `CATF:${c}` });
    if (row.length === 2) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);

  rows.push([{ text: "🛒 Ver carrito", callback_data: "OPEN:CART" }]);

  await bot.sendMessage(chatId, "📦 *Categorías*\nElegí una categoría para ver productos 👇", {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: rows },
  });

  // al mostrar categorías, reseteo índice
  st.catIndex = 0;
}

function productCaption(p, idx, total, filterName) {
  const nombre = safeStr(p.nombre);
  const precio = Number(p.precio || 0);
  const unidad = normalizeUnit(p.unidad);
  const desc = safeStr(p.descripcion);

  const title = filterName && filterName !== "ALL" ? `🛍️ *Catálogo — ${filterName}*` : `🛍️ *Catálogo*`;
  let txt = `${title}\n📖 Producto *${idx + 1}* de *${total}*\n\n`;
  txt += `🧀 *${nombre}*\n`;
  txt += `💰 ${moneyARS(precio)} ${unidad === "kg" ? "(x kg)" : "(por unidad)"}\n`;
  if (desc) txt += `\n📝 ${desc}`;
  return txt;
}

async function showCatalogBook(chatId) {
  const st = getState(chatId);
  const full = await getCatalog();
  const list = filterCatalog(full, st.catFilter);

  if (!list.length) {
    await bot.sendMessage(chatId, "Todavía no hay productos cargados para esa categoría.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  // si cambió el catálogo, ajusto índice
  const h = listHash(list);
  if (st.lastCatalogListHash !== h) {
    st.lastCatalogListHash = h;
    if (st.catIndex >= list.length) st.catIndex = 0;
  }

  const total = list.length;
  if (st.catIndex < 0) st.catIndex = 0;
  if (st.catIndex >= total) st.catIndex = total - 1;

  const p = list[st.catIndex];
  const img = safeStr(p.imagen);

  const inline = {
    inline_keyboard: [
      [
        { text: "⬅️", callback_data: "BOOK:PREV" },
        { text: "➕ Quiero este", callback_data: `WANT:${safeStr(p.codigo || p.id)}` },
        { text: "➡️", callback_data: "BOOK:NEXT" },
      ],
      [
        { text: "📚 Categorías", callback_data: "OPEN:CATS" },
        { text: "🛒 Ver carrito", callback_data: "OPEN:CART" },
      ],
    ],
  };

  const caption = productCaption(p, st.catIndex, total, st.catFilter);

  // mando con foto si existe (robusto)
  if (img) {
    try {
      await sendPhotoSafe(chatId, img, { caption, parse_mode: "Markdown", reply_markup: inline });
      return;
    } catch {
      // fallback a texto
    }
  }

  await bot.sendMessage(chatId, caption, { parse_mode: "Markdown", reply_markup: inline });
}

// =====================
// 12) CARRITO
// =====================
function cartTotalProducts(st) {
  let total = 0;
  for (const { prod, qty } of st.cart.values()) {
    total += Number(prod.precio || 0) * Number(qty || 0);
  }
  return total;
}

async function showCart(chatId) {
  const st = getState(chatId);

  if (!st.cart.size) {
    await bot.sendMessage(chatId, "🛒 Tu carrito está vacío.\n\nEntrá a *Catálogo* para agregar productos.", {
      parse_mode: "Markdown",
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  let text = "🛒 *Tu carrito*\n\n";
  const rows = [];

  for (const [code, item] of st.cart.entries()) {
    const p = item.prod;
    const unit = normalizeUnit(p.unidad);
    const qty = item.qty;
    const lineTotal = Number(p.precio || 0) * Number(qty || 0);

    text += `• *${safeStr(p.nombre)}*\n Cant: *${qty}* ${unit === "kg" ? "kg" : "unidad"} — Subtotal: *${moneyARS(lineTotal)}*\n\n`;

    rows.push([
      { text: "➖", callback_data: `QTY:DEC:${code}` },
      { text: "✍️ Cantidad", callback_data: `QTY:SET:${code}` },
      { text: "➕", callback_data: `QTY:INC:${code}` },
      { text: "🗑️", callback_data: `DEL:${code}` },
    ]);
  }

  text += `Total productos: *${moneyARS(cartTotalProducts(st))}*`;

  const inline = {
    inline_keyboard: [
      ...rows,
      [{ text: "✅ Finalizar compra", callback_data: "OPEN:CHECKOUT" }],
      [{ text: "📚 Seguir comprando (Categorías)", callback_data: "OPEN:CATS" }],
    ],
  };

  await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: inline });
}

// =====================
// 13) AGREGAR PRODUCTO (pregunta cantidades con botones)
// =====================
async function askQtyButtons(chatId, prod) {
  const unit = normalizeUnit(prod.unidad);
  const code = safeStr(prod.codigo || prod.id);
  const name = safeStr(prod.nombre);

  const st = getState(chatId);
  st.awaitingQtyFor = code;

  if (unit === "kg") {
    await bot.sendMessage(chatId, `¿Cuántos gramos querés de *${name}*?`, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "100g", callback_data: `QBTN:${code}:0.1` },
            { text: "200g", callback_data: `QBTN:${code}:0.2` },
            { text: "300g", callback_data: `QBTN:${code}:0.3` },
          ],
          [
            { text: "400g", callback_data: `QBTN:${code}:0.4` },
            { text: "500g", callback_data: `QBTN:${code}:0.5` },
            { text: "✍️ Otro", callback_data: `QBTN:${code}:OTHER` },
          ],
        ],
      },
    });
  } else {
    await bot.sendMessage(chatId, `¿Cuántas unidades querés de *${name}*?`, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "1", callback_data: `QBTN:${code}:1` },
            { text: "2", callback_data: `QBTN:${code}:2` },
            { text: "3", callback_data: `QBTN:${code}:3` },
          ],
          [
            { text: "4", callback_data: `QBTN:${code}:4` },
            { text: "5", callback_data: `QBTN:${code}:5` },
            { text: "✍️ Otro", callback_data: `QBTN:${code}:OTHER` },
          ],
        ],
      },
    });
  }
}

async function setCartQty(chatId, code, qty) {
  const st = getState(chatId);
  const catalog = await getCatalog();
  const prod = catalog.find((p) => safeStr(p.codigo || p.id) === code);

  if (!prod) {
    await bot.sendMessage(chatId, "No encontré ese producto en el catálogo. Probá de nuevo desde *Catálogo*.", {
      parse_mode: "Markdown",
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  const unit = normalizeUnit(prod.unidad);
  const q = roundQty(qty, unit);
  if (q <= 0) {
    st.cart.delete(code);
    await bot.sendMessage(chatId, "Cantidad inválida. No se agregó.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  st.cart.set(code, { prod, qty: q });
  await bot.sendMessage(chatId, `✅ Agregado: *${safeStr(prod.nombre)}* → *${q}* ${unit === "kg" ? "kg" : "unidad"}`, {
    parse_mode: "Markdown",
    reply_markup: mainMenuKeyboard(),
  });
}

// =====================
// 14) CHECKOUT (con costo envío desde Config)
// =====================
function startCheckout(chatId) {
  const st = getState(chatId);
  if (!st.cart.size) {
    bot.sendMessage(chatId, "Tu carrito está vacío. Agregá productos desde *Catálogo*.", { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
    return;
  }

  st.flow = {
    step: "choose_delivery",
    deliveryType: null,
    address: null,
    name: null,
    phone: null,
    payment: null,
  };

  bot.sendMessage(chatId, "Elegí cómo querés recibir tu pedido 👇", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🚚 Envío a domicilio", callback_data: "CHK:DELIVERY" }],
        [{ text: "🏪 Retiro por el local", callback_data: "CHK:PICKUP" }],
      ],
    },
  });
}

async function finalizeOrder(chatId) {
  const st = getState(chatId);
  const cfg = await getConfig();
  const flow = st.flow;

  const negocio = pickCfg(cfg, ["NegocioNombre", "NombreNegocio", "Nombre"], "Todo Queso");
  const alias = pickCfg(cfg, ["AliasPago", "Alias", "AliasTransferencia"], "jennyocampos.mp");
  const waNegocio = pickCfg(cfg, ["WhatsAppLink", "WhatsApp", "WALink"], "");
  const chatVendedor = Number(pickCfg(cfg, ["ChatIdVendedor", "ChatVendedor", "VendedorChatId"], "0")) || 0;

  // costo envío desde Config (varios nombres posibles)
  const costoEnvio = pickNumberCfg(cfg, ["CostoEnvio", "CostoEnvioDomicilio", "EnvioCosto", "PrecioEnvio"], 0);

  let detalle = "";
  for (const { prod, qty } of st.cart.values()) {
    const unit = normalizeUnit(prod.unidad);
    const lt = Number(prod.precio || 0) * Number(qty || 0);
    detalle += `- ${safeStr(prod.nombre)} | ${qty} ${unit === "kg" ? "kg" : "unidad"} | ${moneyARS(lt)}\n`;
  }

  const totalProductosNum = cartTotalProducts(st);
  const totalProductos = moneyARS(totalProductosNum);

  const esEnvio = flow.deliveryType === "envio";
  const entregaTxt = esEnvio ? "🚚 Envío a domicilio" : "🏪 Retiro por el local";

  const envioNum = esEnvio ? Number(costoEnvio || 0) : 0;
  const totalFinalNum = totalProductosNum + envioNum;

  let resumen =
    `✅ *Pedido confirmado (pendiente de pago/validación)*\n\n` +
    `*${negocio}*\n` +
    `Entrega: *${entregaTxt}*\n` +
    (esEnvio ? `Dirección: *${safeStr(flow.address)}*\n` : "") +
    `Nombre: *${safeStr(flow.name)}*\n` +
    `Teléfono: *${safeStr(flow.phone)}*\n` +
    `Pago: *${safeStr(flow.payment)}*\n\n` +
    `🧾 *Detalle:*\n${detalle}\n` +
    `🧺 Total productos: *${totalProductos}*\n` +
    (esEnvio ? `🚚 Envío: *${moneyARS(envioNum)}*\n` : "") +
    `💰 *Total final: ${moneyARS(totalFinalNum)}*\n`;

  if (flow.payment === "Transferencia") {
    resumen += `\n🏦 Alias para transferir: \`${alias}\`\n📌 Cuando transfieras, mandá el comprobante por acá.`;
  } else {
    resumen += `\n💵 Pagás en efectivo al retirar o al recibir el pedido.`;
  }

  await bot.sendMessage(chatId, resumen, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });

  if (chatVendedor) {
    const vendedorMsg =
      `🛎️ *Nuevo pedido*\n\n` +
      `Cliente: *${safeStr(flow.name)}*\n` +
      `Tel: *${safeStr(flow.phone)}*\n` +
      `Entrega: *${entregaTxt}*\n` +
      (esEnvio ? `Dirección: *${safeStr(flow.address)}*\n` : "") +
      `Pago: *${safeStr(flow.payment)}*\n\n` +
      `🧾 *Detalle:*\n${detalle}\n` +
      `🧺 Total productos: *${totalProductos}*\n` +
      (esEnvio ? `🚚 Envío: *${moneyARS(envioNum)}*\n` : "") +
      `💰 *Total final: ${moneyARS(totalFinalNum)}*\n`;

    try {
      await bot.sendMessage(chatVendedor, vendedorMsg, { parse_mode: "Markdown" });
    } catch (e) {
      console.log("No pude avisar al vendedor:", e?.message || e);
    }
  }

  if (waNegocio && waNegocio.toUpperCase() !== "NO") {
    await bot.sendMessage(chatId, `📲 Si querés, también podés escribirnos por WhatsApp: ${waNegocio}`, { reply_markup: mainMenuKeyboard() });
  }

  st.flow = null;
}

// =====================
// 15) HANDLERS (TEXT)
// =====================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const textRaw = safeStr(msg.text);
  const text = textRaw.toLowerCase();
  const st = getState(chatId);

  // Si está esperando cantidad "Otro" manual
  if (st.awaitingQtyFor && !st.flow) {
    // si escribió un número manual (solo cuando apretó "Otro" o cuando se pide manual)
    const code = st.awaitingQtyFor;
    const it = st.cart.get(code); // puede existir o no
    const catalog = await getCatalog();
    const prod = (it?.prod) || catalog.find((p) => safeStr(p.codigo || p.id) === code);

    // Si no es número, ignoramos (para no romper otras opciones)
    const n = Number(String(textRaw).replace(",", "."));
    if (isFinite(n) && n > 0 && prod) {
      st.awaitingQtyFor = null;
      const unit = normalizeUnit(prod.unidad);
      const qty = unit === "kg" ? (n >= 10 ? n / 1000 : n) : n; // si pone 300 lo interpreto como gramos
      await setCartQty(chatId, code, qty);
      return;
    }
  }

  // Checkout steps
  if (st.flow && st.flow.step) {
    const flow = st.flow;

    if (flow.step === "ask_address") {
      flow.address = textRaw;
      flow.step = "ask_name";
      await bot.sendMessage(chatId, "🧾 Tu nombre:");
      return;
    }
    if (flow.step === "ask_name") {
      flow.name = textRaw;
      flow.step = "ask_phone";
      await bot.sendMessage(chatId, "📞 Tu teléfono:");
      return;
    }
    if (flow.step === "ask_phone") {
      flow.phone = textRaw;
      flow.step = "choose_payment";
      await bot.sendMessage(chatId, "Perfecto. Ahora elegí el método de pago:", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "💵 Efectivo", callback_data: "CHK:PAY:CASH" }],
            [{ text: "🏦 Transferencia", callback_data: "CHK:PAY:TRANSFER" }],
          ],
        },
      });
      return;
    }
  }

  // Start / saludos
  if (
    text === "/start" ||
    text === "hola" ||
    text === "buenas" ||
    text === "buen día" ||
    text === "buen dia" ||
    text === "buenas tardes" ||
    text === "buenas noches"
  ) {
    await sendWelcome(chatId);
    return;
  }

  // Menú principal
  if (textRaw === "🛍️ Catálogo") {
    await showCategories(chatId);
    return;
  }
  if (textRaw === "🛒 Mi carrito") {
    await showCart(chatId);
    return;
  }
  if (textRaw === "✅ Finalizar compra") {
    startCheckout(chatId);
    return;
  }
  if (textRaw === "🎫 Tarjeta de sellos") {
    await sendStampsCard(chatId);
    return;
  }
  if (textRaw === "📣 Compartir el bot") {
    await openShare(chatId);
    return;
  }

  await bot.sendMessage(chatId, "Elegí una opción del menú 👇", { reply_markup: mainMenuKeyboard() });
});

// =====================
// 16) HANDLERS (CALLBACKS)
// =====================
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const data = safeStr(q.data);
  const st = getState(chatId);

  try {
    await bot.answerCallbackQuery(q.id);
  } catch {}

  // Share (por si lo usás como callback en el futuro)
  if (data === "OPEN:SHARE") {
    await openShare(chatId);
    return;
  }

  // Categorías
  if (data === "OPEN:CATS") {
    await showCategories(chatId);
    return;
  }
  if (data.startsWith("CATF:")) {
    const f = data.slice("CATF:".length);
    st.catFilter = f === "ALL" ? "ALL" : f;
    st.catIndex = 0;
    await showCatalogBook(chatId);
    return;
  }

  // Book nav
  if (data === "BOOK:PREV") {
    st.catIndex -= 1;
    await showCatalogBook(chatId);
    return;
  }
  if (data === "BOOK:NEXT") {
    st.catIndex += 1;
    await showCatalogBook(chatId);
    return;
  }

  // Quiero este → preguntar cantidad con botones
  if (data.startsWith("WANT:")) {
    const code = data.slice("WANT:".length);
    const catalog = await getCatalog();
    const prod = catalog.find((p) => safeStr(p.codigo || p.id) === code);
    if (!prod) {
      await bot.sendMessage(chatId, "No encontré ese producto. Probá desde categorías otra vez.", { reply_markup: mainMenuKeyboard() });
      return;
    }
    await askQtyButtons(chatId, prod);
    return;
  }

  // Botones de cantidad (unidad / gramos)
  if (data.startsWith("QBTN:")) {
    // QBTN:CODE:VAL
    const parts = data.split(":");
    const code = parts[1];
    const val = parts[2];

    if (val === "OTHER") {
      const catalog = await getCatalog();
      const prod = catalog.find((p) => safeStr(p.codigo || p.id) === code);
      if (!prod) return;

      st.awaitingQtyFor = code;
      const unit = normalizeUnit(prod.unidad);

      if (unit === "kg") {
        await bot.sendMessage(chatId, "Escribí los *gramos* (ej: 300) o los *kilos* (ej: 0.3):", { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
      } else {
        await bot.sendMessage(chatId, "Escribí la cantidad de *unidades* (ej: 2):", { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
      }
      return;
    }

    const qty = Number(val);
    if (!isFinite(qty) || qty <= 0) return;

    st.awaitingQtyFor = null;
    await setCartQty(chatId, code, qty);
    return;
  }

  // Carrito
  if (data === "OPEN:CART") {
    await showCart(chatId);
    return;
  }
  if (data.startsWith("DEL:")) {
    const code = data.slice("DEL:".length);
    st.cart.delete(code);
    await bot.sendMessage(chatId, "🗑️ Producto eliminado del carrito.", { reply_markup: mainMenuKeyboard() });
    return;
  }
  if (data.startsWith("QTY:SET:")) {
    const code = data.slice("QTY:SET:".length);
    const it = st.cart.get(code);
    if (!it) return;

    st.awaitingQtyFor = code;
    const unit = normalizeUnit(it.prod.unidad);
    const example = unit === "kg" ? "300 (gramos) o 0.3 (kg)" : "2";
    await bot.sendMessage(chatId, `Escribí la cantidad para *${safeStr(it.prod.nombre)}*.\nEjemplo: ${example}`, {
      parse_mode: "Markdown",
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }
  if (data.startsWith("QTY:INC:") || data.startsWith("QTY:DEC:")) {
    const inc = data.startsWith("QTY:INC:");
    const code = data.split(":").pop();
    const it = st.cart.get(code);
    if (!it) return;

    const unit = normalizeUnit(it.prod.unidad);
    const step = unit === "kg" ? 0.1 : 1;
    const next = inc ? Number(it.qty) + step : Number(it.qty) - step;
    const qty = roundQty(next, unit);

    if (qty <= 0) st.cart.delete(code);
    else {
      it.qty = qty;
      st.cart.set(code, it);
    }
    await showCart(chatId);
    return;
  }

  // Checkout
  if (data === "OPEN:CHECKOUT") {
    startCheckout(chatId);
    return;
  }
  if (data === "CHK:DELIVERY") {
    st.flow = st.flow || {};
    st.flow.deliveryType = "envio";
    st.flow.step = "ask_address";
    await bot.sendMessage(chatId, "📍 Decime tu dirección completa:");
    return;
  }
  if (data === "CHK:PICKUP") {
    st.flow = st.flow || {};
    st.flow.deliveryType = "retiro";
    st.flow.step = "ask_name";
    await bot.sendMessage(chatId, "🧾 Tu nombre:");
    return;
  }
  if (data === "CHK:PAY:CASH" || data === "CHK:PAY:TRANSFER") {
    if (!st.flow || st.flow.step !== "choose_payment") return;

    st.flow.payment = data.endsWith("CASH") ? "Efectivo" : "Transferencia";
    await finalizeOrder(chatId);
    return;
  }
});

// =====================
// 17) HTTP SERVER (Render)
// =====================
const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (u.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("EzerBot está corriendo ✅");
      return;
    }

    if (u.pathname === WEBHOOK_PATH && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const update = JSON.parse(body || "{}");
          await bot.processUpdate(update);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
        }
      });
      return;
    }

    if (u.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, webhook: WEBHOOK_URL, sheets: !!SHEETS_API_BASE }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error_code: 404, description: "Not Found" }));
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Server error");
  }
});

server.listen(PORT, async () => {
  console.log(`HTTP escuchando en puerto ${PORT}`);

  if (WEBHOOK_URL) {
    try {
      await bot.setWebHook(WEBHOOK_URL);
      console.log("✅ Webhook seteado:", WEBHOOK_URL);
    } catch (e) {
      console.log("❌ Error setWebHook:", e?.message || e);
    }
  } else {
    console.log("❌ No hay PUBLIC_URL, no se puede setear webhook.");
  }

  try {
    const cfg = await getConfig();
    const cat = await getCatalog();
    console.log("✅ Warmup ok. Config keys:", Object.keys(cfg || {}).length, "Catalog items:", Array.isArray(cat) ? cat.length : 0);
  } catch (e) {
    console.log("❌ Warmup fetch error:", e?.message || e);
  }

  console.log("✅ EzerBot iniciado (WEBHOOK + Config/Catalogo desde Sheets)");
});

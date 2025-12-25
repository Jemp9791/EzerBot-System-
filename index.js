import TelegramBot from "node-telegram-bot-api";
import http from "http";
import { URL } from "url";


/**
 * ENV requeridas:
 * BOT_TOKEN
 * PUBLIC_URL          (ej: https://tu-app.onrender.com)
 * SHEETS_API_BASE     (tu endpoint que devuelve config y catalog)
 *
 * Opcionales:
 * BOT_USERNAME        (ej: EZER_IA_BOT) para armar BotLink si no está en Config
 */

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const SHEETS_API_BASE = process.env.SHEETS_API_BASE || "";
const BOT_USERNAME = (process.env.BOT_USERNAME || "").replace("@", "").trim();
const PORT = Number(process.env.PORT || 10000);

const WEBHOOK_PATH = "/telegram";
const WEBHOOK_URL = PUBLIC_URL ? `${PUBLIC_URL}${WEBHOOK_PATH}` : "";

if (!BOT_TOKEN) console.log("❌ Falta BOT_TOKEN");
if (!PUBLIC_URL) console.log("❌ Falta PUBLIC_URL");
if (!SHEETS_API_BASE) console.log("❌ Falta SHEETS_API_BASE");

const bot = new TelegramBot(BOT_TOKEN, { webHook: true });

// --------------------
// Cache
// --------------------
const CACHE_TTL_MS = 30_000;
let cacheConfig = { at: 0, data: null };
let cacheCatalog = { at: 0, data: null };

const safe = (v) => String(v ?? "").trim();

async function fetchJSON(url) {
  const r = await fetch(url, { method: "GET" });
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    throw new Error(`Respuesta no JSON: ${t.slice(0, 180)}`);
  }
}

async function getConfig() {
  const now = Date.now();
  if (cacheConfig.data && now - cacheConfig.at < CACHE_TTL_MS) return cacheConfig.data;
  const data = await fetchJSON(`${SHEETS_API_BASE}?type=config&_=${now}`);
  cacheConfig = { at: now, data: data || {} };
  return cacheConfig.data;
}

// normaliza un item del catálogo aunque venga con columnas en MAYÚSCULAS
function normalizeCatalogItem(p = {}) {
  const get = (...keys) => {
    for (const k of keys) {
      if (p[k] !== undefined && p[k] !== null && safe(p[k])) return p[k];
      // probamos también variantes por si el endpoint cambia
      const kl = String(k).toLowerCase();
      if (p[kl] !== undefined && p[kl] !== null && safe(p[kl])) return p[kl];
      const ku = String(k).toUpperCase();
      if (p[ku] !== undefined && p[ku] !== null && safe(p[ku])) return p[ku];
    }
    return "";
  };

  return {
    codigo: safe(get("codigo", "CODIGO", "id", "ID")),
    nombre: safe(get("nombre", "NOMBRE")),
    precio: Number(String(get("precio", "PRECIO", "price", "PRICE")).replace(",", ".")) || 0,
    unidad: safe(get("unidad", "UNIDAD")),
    descripcion: safe(get("descripcion", "DESCRIPCION", "desc", "DESC")),
    imagen: safe(get("imagen", "IMAGEN", "image", "Image", "IMG")),
    categoria: safe(get("categoria", "CATEGORIA", "cat", "CAT")),
    codigoBarras: safe(get("codigobarras", "CODIGOBARRAS", "barcode", "BARCODE")),
  };
}

async function getCatalog() {
  const now = Date.now();
  if (cacheCatalog.data && now - cacheCatalog.at < CACHE_TTL_MS) return cacheCatalog.data;

  const data = await fetchJSON(`${SHEETS_API_BASE}?type=catalog&_=${now}`);
  const list = Array.isArray(data) ? data.map(normalizeCatalogItem) : [];
  cacheCatalog = { at: now, data: list };
  return cacheCatalog.data;
}

// --------------------
// Util
// --------------------
function normalizeUnit(u) {
  const s = safe(u).toLowerCase();
  if (s.includes("kg") || s.includes("kilo")) return "kg";
  return "unidad";
}

function moneyARS(n) {
  const v = Number(n || 0);
  try {
    return v.toLocaleString("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });
  } catch {
    return `$${Math.round(v)}`;
  }
}

function normalizeImageUrl(url) {
  const u = safe(url);
  if (!u) return "";
  // tus links postimg funcionan tal cual; no pedimos “public url” ni cambiamos nada
  return u;
}

function pickConfig(cfg, key, fallback = "") {
  const v = safe(cfg?.[key]);
  return v || fallback;
}

function yes(cfgVal) {
  return safe(cfgVal).toUpperCase() === "SI";
}

function parsePipeList(str) {
  const s = safe(str);
  if (!s) return [];
  return s
    .split("|")
    .map((x) => safe(x))
    .filter(Boolean);
}

function parsePipeNums(str) {
  return parsePipeList(str)
    .map((x) => Number(String(x).replace(",", ".")))
    .filter((n) => isFinite(n) && n > 0);
}

function uniqueCategories(list) {
  const set = new Set();
  for (const p of list) {
    const c = safe(p.categoria);
    if (c) set.add(c);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, "es"));
}

function filterCatalog(list, filter) {
  if (!filter || filter === "ALL") return list;
  return list.filter((p) => safe(p.categoria) === filter);
}

// --------------------
// State
// --------------------
const state = new Map();

function getState(chatId) {
  if (!state.has(chatId)) {
    state.set(chatId, {
      catFilter: "ALL",
      catIndex: 0,
      viewMsgId: null,
      cart: new Map(),
      awaitingQty: null,
      checkout: null,
    });
  }
  return state.get(chatId);
}

// --------------------
// Keyboards (mínimo, sin ensuciar chat)
// --------------------
function mainMenuKeyboard(cfg) {
  const rows = [
    [{ text: "🛍️ Catálogo" }, { text: "🛒 Carrito" }],
    [{ text: "✅ Finalizar compra" }],
    [{ text: "🎫 Tarjeta de sellos" }, { text: "📣 Compartir bot" }],
  ];
  return { keyboard: rows, resize_keyboard: true, one_time_keyboard: false };
}

function navKeyboard(cfg) {
  // en el carrusel SOLO lo necesario
  const rows = [
    [
      { text: "⬅️ Anterior", callback_data: "CAT:PREV" },
      { text: "🟢 Quiero éste", callback_data: "ADD:CURRENT" },
      { text: "➡️ Siguiente", callback_data: "CAT:NEXT" },
    ],
    [
      { text: "📁 Categorías", callback_data: "OPEN:CATS" },
      { text: "🛒 Carrito", callback_data: "OPEN:CART" },
    ],
  ];

  // botón compartir del producto (promo) -> mismos canales que compartir bot
  rows.push([{ text: "📣 Compartir", callback_data: "SHARE:PRODUCT" }]);

  return { inline_keyboard: rows };
}

function afterAddKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🟢 Seguir comprando", callback_data: "OPEN:CATS" }],
      [{ text: "✅ Finalizar compra", callback_data: "CHECKOUT:START" }],
      [{ text: "🛒 Ver carrito", callback_data: "OPEN:CART" }],
    ],
  };
}

// --------------------
// Share (BOT y PRODUCTO)
// --------------------
function getBotLinkFromConfig(cfg) {
  // tu Config NO incluye BotLink en la lista, entonces:
  // 1) si existe cfg.BotLink o cfg.BOTLINK lo toma igual
  // 2) si no, usa BOT_USERNAME -> https://t.me/EZER_IA_BOT
  const direct =
    safe(cfg?.BotLink) ||
    safe(cfg?.BOTLINK) ||
    safe(cfg?.BotURL) ||
    safe(cfg?.BOTURL) ||
    safe(cfg?.Bot) ||
    "";

  if (direct) return direct;
  if (BOT_USERNAME) return `https://t.me/${BOT_USERNAME}`;
  return "";
}

async function sendShareBotOptions(chatId) {
  const cfg = await getConfig();

  if (!yes(cfg.CompartirBotActivo)) {
    await bot.sendMessage(chatId, "📣 Compartir bot está desactivado por ahora.", {
      reply_markup: mainMenuKeyboard(cfg),
    });
    return;
  }

  const botLink = getBotLinkFromConfig(cfg);
  const texto = pickConfig(cfg, "TextoCompartirBot", "Pedí por acá 👇");
  const baseText = botLink ? `${texto}\n${botLink}` : `${texto}\n(Configurá BOT_USERNAME o una key BotLink en Config)`;

  const shareMsg = botLink ? `Pedí por el bot 🧀👇\n${botLink}` : `Pedí por el bot 🧀👇`;
  const waUrl = `https://wa.me/?text=${encodeURIComponent(shareMsg)}`;
  const tgUrl = botLink
    ? `https://t.me/share/url?url=${encodeURIComponent(botLink)}&text=${encodeURIComponent(texto)}`
    : "";
  const emailUrl = `mailto:?subject=${encodeURIComponent("Pedí por Todo Queso")}&body=${encodeURIComponent(shareMsg)}`;
  const webUrl = PUBLIC_URL || "";

  const rows = [];
  rows.push([{ text: "💬 WhatsApp", url: waUrl }]);
  if (tgUrl) rows.push([{ text: "✈️ Telegram", url: tgUrl }]);
  rows.push([{ text: "✉️ Email", url: emailUrl }]);
  if (webUrl) rows.push([{ text: "🌐 Web", url: webUrl }]);

  await bot.sendMessage(chatId, `📣 *Compartí el bot:*\n\n${baseText}`, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: rows },
  });
}

async function sendShareProductOptions(chatId, prod) {
  const cfg = await getConfig();
  const negocio = pickConfig(cfg, "NegocioNombre", "Todo Queso");
  const botLink = getBotLinkFromConfig(cfg);

  const unit = normalizeUnit(prod.unidad);
  const priceLine = `${moneyARS(prod.precio)} ${unit === "kg" ? "x kg" : "por unidad"}`;

  const text = `🧀 ${negocio}\n${prod.nombre}\n${priceLine}\n${prod.descripcion ? prod.descripcion : ""}\n\n${botLink ? "Pedí acá: " + botLink : ""}`.trim();
  const waUrl = `https://wa.me/?text=${encodeURIComponent(text)}`;
  const tgUrl = botLink
    ? `https://t.me/share/url?url=${encodeURIComponent(botLink)}&text=${encodeURIComponent(`${prod.nombre} — ${priceLine}`)}`
    : "";
  const emailUrl = `mailto:?subject=${encodeURIComponent(`Promo: ${prod.nombre}`)}&body=${encodeURIComponent(text)}`;
  const webUrl = PUBLIC_URL || "";

  const rows = [];
  rows.push([{ text: "💬 WhatsApp", url: waUrl }]);
  if (tgUrl) rows.push([{ text: "✈️ Telegram", url: tgUrl }]);
  rows.push([{ text: "✉️ Email", url: emailUrl }]);
  if (webUrl) rows.push([{ text: "🌐 Web", url: webUrl }]);

  await bot.sendMessage(chatId, `📣 *Compartir producto:*\n*${prod.nombre}*`, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: rows },
  });
}

// --------------------
// Welcome (lee tus keys reales)
// --------------------
async function sendWelcome(chatId) {
  const cfg = await getConfig();

  const negocio = pickConfig(cfg, "NegocioNombre", "Todo Queso");
  const dir = pickConfig(cfg, "NegocioDireccion", "Dirección no configurada");
  const hor = pickConfig(cfg, "NegocioHorario", "Horarios no configurados");
  const tel = pickConfig(cfg, "NegocioTelefono", "Teléfono no configurado");
  const ig = pickConfig(cfg, "NegocioInstagram", "");
  const logo = pickConfig(cfg, "LogoURL", "");
  const descripcion = pickConfig(cfg, "Descripcion", "");

  let text = `🧀 *${negocio}*\n`;
  text += `📍 ${dir}\n`;
  text += `🕒 ${hor}\n`;
  text += `📞 ${tel}\n`;
  if (ig) text += `📸 Instagram: ${ig.startsWith("@") ? ig : "@" + ig}\n`;
  if (descripcion) text += `\n${descripcion}\n`;
  text += `\nElegí una opción del menú para empezar 👇`;

  if (logo) {
    try {
      await bot.sendPhoto(chatId, normalizeImageUrl(logo), {
        caption: text,
        parse_mode: "Markdown",
        reply_markup: mainMenuKeyboard(cfg),
      });
      return;
    } catch (e) {
      console.log("⚠️ Logo falló, sigo con texto:", e?.message || e);
    }
  }

  await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard(cfg) });
}

// --------------------
// Categorías
// --------------------
async function showCategories(chatId) {
  const full = await getCatalog();
  const cats = uniqueCategories(full);

  const rows = [];
  rows.push([{ text: "📚 Todas", callback_data: "CATF:ALL" }]);

  let r = [];
  for (const c of cats) {
    r.push({ text: c, callback_data: `CATF:${c}` });
    if (r.length === 2) {
      rows.push(r);
      r = [];
    }
  }
  if (r.length) rows.push(r);

  rows.push([{ text: "🛒 Ver carrito", callback_data: "OPEN:CART" }]);

  await bot.sendMessage(chatId, "📚 *Categorías*\nElegí una categoría para ver productos 👇", {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: rows },
  });
}

// --------------------
// Carrusel tipo book (un mensaje editable)
// --------------------
function productCaption(p, filter, index, total, cfg) {
  const nombre = safe(p.nombre);
  const precio = Number(p.precio || 0);
  const unidad = normalizeUnit(p.unidad);
  const desc = safe(p.descripcion);

  const head = filter && filter !== "ALL" ? `🛍️ *Catálogo — ${filter}*\n` : `🛍️ *Catálogo*\n`;
  const pos = `📖 Producto *${index + 1}* de *${total}*\n\n`;

  let cap = head + pos;
  cap += `🧀 *${nombre}*\n`;
  cap += `💰 ${moneyARS(precio)} ${unidad === "kg" ? "(x kg)" : "(por unidad)"}\n`;
  if (desc) cap += `📝 ${desc}\n`;
  return cap;
}

async function renderCurrentProduct(chatId, forceNew = false) {
  const cfg = await getConfig();
  const st = getState(chatId);
  const full = await getCatalog();
  const list = filterCatalog(full, st.catFilter);

  if (!list.length) {
    await bot.sendMessage(chatId, "No hay productos en esa categoría todavía.", {
      reply_markup: { inline_keyboard: [[{ text: "📁 Categorías", callback_data: "OPEN:CATS" }]] },
    });
    return;
  }

  if (st.catIndex < 0) st.catIndex = 0;
  if (st.catIndex >= list.length) st.catIndex = list.length - 1;

  const p = list[st.catIndex];
  const caption = productCaption(p, st.catFilter, st.catIndex, list.length, cfg);

  // 👇 ACÁ estaba el bug: ahora lee IMAGEN aunque venga en mayúsculas (ya normalizado igual)
  const img = normalizeImageUrl(p.imagen);

  try {
    if (!forceNew && st.viewMsgId) {
      if (img) {
        await bot.editMessageMedia(
          { type: "photo", media: img, caption, parse_mode: "Markdown" },
          { chat_id: chatId, message_id: st.viewMsgId, reply_markup: navKeyboard(cfg) }
        );
      } else {
        await bot.editMessageCaption(caption, {
          chat_id: chatId,
          message_id: st.viewMsgId,
          parse_mode: "Markdown",
          reply_markup: navKeyboard(cfg),
        });
      }
      return;
    }

    let sent;
    if (img) {
      sent = await bot.sendPhoto(chatId, img, { caption, parse_mode: "Markdown", reply_markup: navKeyboard(cfg) });
    } else {
      sent = await bot.sendMessage(chatId, caption, { parse_mode: "Markdown", reply_markup: navKeyboard(cfg) });
    }
    st.viewMsgId = sent.message_id;
  } catch (e) {
    console.log("❌ renderCurrentProduct error:", e?.message || e);
    const sent = await bot.sendMessage(chatId, caption, { parse_mode: "Markdown", reply_markup: navKeyboard(cfg) });
    st.viewMsgId = sent.message_id;
  }
}

// --------------------
// Carrito
// --------------------
function cartTotal(st) {
  let total = 0;
  for (const { prod, qty } of st.cart.values()) total += Number(prod.precio || 0) * Number(qty || 0);
  return total;
}

async function showCart(chatId) {
  const cfg = await getConfig();
  const st = getState(chatId);

  if (!st.cart.size) {
    await bot.sendMessage(chatId, "🛒 Tu carrito está vacío.\n\nEntrá a *Catálogo* para agregar productos.", {
      parse_mode: "Markdown",
      reply_markup: mainMenuKeyboard(cfg),
    });
    return;
  }

  let text = "🛒 *Tu carrito*\n\n";
  for (const { prod, qty } of st.cart.values()) {
    const unit = normalizeUnit(prod.unidad);
    const lineTotal = Number(prod.precio || 0) * Number(qty || 0);
    text += `• *${safe(prod.nombre)}*\n  Cant: *${qty}* ${unit === "kg" ? "kg" : "unid"} — Subtotal: *${moneyARS(lineTotal)}*\n\n`;
  }
  text += `Total productos: *${moneyARS(cartTotal(st))}*`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🟢 Seguir comprando", callback_data: "OPEN:CATS" }],
        [{ text: "✅ Finalizar compra", callback_data: "CHECKOUT:START" }],
      ],
    },
  });
}

// --------------------
// Cantidad (SIN botones): cliente escribe
// --------------------
async function askQty(chatId, prod) {
  const cfg = await getConfig();
  const st = getState(chatId);
  const unit = normalizeUnit(prod.unidad);
  const code = safe(prod.codigo);

  st.awaitingQty = { code, unit };

  if (unit === "kg") {
    const msg =
      `¿Cuántos *gramos* querés de *${safe(prod.nombre)}*?\n` +
      `Ejemplo: 250, 400, 1000\n\n` +
      `Escribí el número (desde 100g en adelante).`;
    await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard(cfg) });
  } else {
    const msg =
      `¿Cuántas *unidades* querés de *${safe(prod.nombre)}*?\n` +
      `Ejemplo: 1, 2, 3\n\n` +
      `Escribí el número.`;
    await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard(cfg) });
  }
}

function roundQty(q, unit) {
  const n = Number(q || 0);
  if (!isFinite(n) || n <= 0) return 0;
  if (unit === "kg") return Math.round(n * 100) / 100;
  return Math.round(n);
}

async function addToCart(chatId, prod, qty) {
  const st = getState(chatId);
  const code = safe(prod.codigo);
  const unit = normalizeUnit(prod.unidad);

  const q = roundQty(qty, unit);
  if (q <= 0) return;

  if (st.cart.has(code)) {
    const it = st.cart.get(code);
    it.qty = roundQty(Number(it.qty) + q, unit);
    st.cart.set(code, it);
  } else {
    st.cart.set(code, { prod, qty: q });
  }

  await bot.sendMessage(chatId, `✅ Agregado: *${safe(prod.nombre)}* — *${q}* ${unit === "kg" ? "kg" : "unid"}`, {
    parse_mode: "Markdown",
    reply_markup: afterAddKeyboard(),
  });
}

// --------------------
// Checkout (envío/retiro + pago)
// --------------------
function shippingCost(cfg) {
  const v = Number(String(pickConfig(cfg, "CostoEnvio", "0")).replace(",", "."));
  return isFinite(v) ? v : 0;
}

async function startCheckout(chatId) {
  const cfg = await getConfig();
  const st = getState(chatId);
  if (!st.cart.size) {
    await bot.sendMessage(chatId, "Tu carrito está vacío. Agregá productos desde el catálogo.", {
      reply_markup: mainMenuKeyboard(cfg),
    });
    return;
  }

  st.checkout = { step: "delivery", delivery: "", address: "", name: "", phone: "", payMethod: "" };

  const rows = [];

  if (yes(cfg.UsaEnvíoDomicilio)) rows.push([{ text: "🚚 Envío a domicilio", callback_data: "DELIVERY:HOME" }]);
  if (yes(cfg.UsaRetiroLocal)) rows.push([{ text: "🏪 Retiro por el local", callback_data: "DELIVERY:PICKUP" }]);

  // fallback por si en config no está seteado todavía
  if (!rows.length) {
    rows.push([{ text: "🚚 Envío a domicilio", callback_data: "DELIVERY:HOME" }]);
    rows.push([{ text: "🏪 Retiro por el local", callback_data: "DELIVERY:PICKUP" }]);
  }

  await bot.sendMessage(chatId, "Elegí cómo querés recibir tu pedido 👇", {
    reply_markup: { inline_keyboard: [...rows, [{ text: "🛒 Ver carrito", callback_data: "OPEN:CART" }]] },
  });
}

async function checkoutAskAddress(chatId) {
  const st = getState(chatId);
  st.checkout.step = "address";
  await bot.sendMessage(chatId, "📍 Decime tu *dirección completa* (calle y número).", { parse_mode: "Markdown" });
}

async function checkoutAskName(chatId) {
  const st = getState(chatId);
  st.checkout.step = "name";
  await bot.sendMessage(chatId, "👤 Decime tu *nombre*.", { parse_mode: "Markdown" });
}

async function checkoutAskPhone(chatId) {
  const st = getState(chatId);
  st.checkout.step = "phone";
  await bot.sendMessage(chatId, "📞 Escribí tu *teléfono* (solo números, con código de área).", { parse_mode: "Markdown" });
}

async function checkoutAskPayment(chatId) {
  const st = getState(chatId);
  st.checkout.step = "pay";
  await bot.sendMessage(chatId, "💳 Elegí método de pago 👇", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "💵 Efectivo", callback_data: "PAY:CASH" }],
        [{ text: "🏦 Transferencia", callback_data: "PAY:TRANSFER" }],
      ],
    },
  });
}

async function checkoutSummary(chatId) {
  const cfg = await getConfig();
  const st = getState(chatId);
  const c = st.checkout;

  const sub = cartTotal(st);
  const envio = c.delivery === "HOME" ? shippingCost(cfg) : 0;
  const total = sub + envio;

  const negocio = pickConfig(cfg, "NegocioNombre", "Todo Queso");
  const alias = pickConfig(cfg, "AliasTransferencia", "");
  const cbu = pickConfig(cfg, "CBUPago", "");
  const msgTransf = pickConfig(cfg, "MensajeTransferencia", "Cuando transfieras, mandá el comprobante por acá.");

  let text = `✅ *Pedido confirmado* (pendiente de pago/validación)\n\n`;
  text += `*${negocio}*\n`;
  text += `Entrega: ${c.delivery === "HOME" ? "🚚 Envío a domicilio" : "🏪 Retiro por el local"}\n`;
  if (c.delivery === "HOME") text += `Dirección: ${c.address}\n`;
  text += `Nombre: ${c.name}\n`;
  text += `Teléfono: ${c.phone}\n`;
  text += `Pago: ${c.payMethod === "TRANSFER" ? "Transferencia" : "Efectivo"}\n\n`;

  text += `🧾 *Detalle:*\n`;
  for (const { prod, qty } of st.cart.values()) {
    const unit = normalizeUnit(prod.unidad);
    const lineTotal = Number(prod.precio || 0) * Number(qty || 0);
    text += `- ${safe(prod.nombre)} | ${qty} ${unit === "kg" ? "kg" : "unid"} | ${moneyARS(lineTotal)}\n`;
  }

  text += `\n🧺 Total productos: *${moneyARS(sub)}*\n`;
  text += `🚚 Envío: *${moneyARS(envio)}*\n`;
  text += `💰 Total final: *${moneyARS(total)}*\n`;

  if (c.payMethod === "TRANSFER") {
    // mostrar alias / cbu si existen
    if (alias) text += `\n🏦 Alias: *${alias}*\n`;
    if (cbu) text += `🏦 CBU: *${cbu}*\n`;
    text += `📌 ${msgTransf}`;
  }

  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🏠 Menú", callback_data: "OPEN:MENU" }],
        [{ text: "📣 Compartir bot", callback_data: "SHARE:BOT" }],
      ],
    },
  });

  st.checkout = null;
}

// --------------------
// Tarjeta de sellos (sin NaN + usa Config)
// --------------------
async function sendStampsCard(chatId) {
  const cfg = await getConfig();

  if (!yes(cfg.UsaSellos)) {
    await bot.sendMessage(chatId, "Por ahora la tarjeta de sellos está desactivada.", { reply_markup: mainMenuKeyboard(cfg) });
    return;
  }

  const cardUrl = normalizeImageUrl(pickConfig(cfg, "TarjetaURL", ""));
  const nivelesNombres = parsePipeList(pickConfig(cfg, "NombresNiveles", ""));
  const nivelesSellos = parsePipeNums(pickConfig(cfg, "SellosPorNivel", ""));
  const nivelesBenef = parsePipeList(pickConfig(cfg, "BeneficiosPorNivel", ""));

  // hoy no estamos leyendo sellos reales por cliente (eso lo hará el POS/vendedor), así que:
  const sellos = 0;

  // meta: primer objetivo si existe; si no, 10
  const meta = nivelesSellos.length ? nivelesSellos[0] : 10;
  const premio = nivelesBenef.length ? nivelesBenef[0] : "Un beneficio sorpresa";

  const filled = Math.min(sellos, meta);
  const bar = "🟩".repeat(filled) + "⬜".repeat(Math.max(0, meta - filled));

  let text =
    `🎫 *Tarjeta de sellos*\n\n` +
    `${bar}\n\n` +
    `Sellos: *${sellos} / ${meta}*\n` +
    `Premio al completar: *${premio}*\n`;

  if (yes(cfg.UsaNiveles) && nivelesSellos.length && nivelesNombres.length) {
    text += `\n🏅 *Niveles*\n`;
    for (let i = 0; i < Math.min(nivelesSellos.length, nivelesNombres.length); i++) {
      const bn = nivelesBenef[i] ? ` — ${nivelesBenef[i]}` : "";
      text += `• ${nivelesNombres[i]}: ${nivelesSellos[i]} sellos${bn}\n`;
    }
  }

  text += `\nTip: cada compra confirmada suma sellos según Config.`;

  if (cardUrl) {
    try {
      await bot.sendPhoto(chatId, cardUrl, { caption: text, parse_mode: "Markdown", reply_markup: mainMenuKeyboard(cfg) });
      return;
    } catch (e) {
      console.log("⚠️ tarjeta sendPhoto falló:", e?.message || e);
    }
  }

  await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard(cfg) });
}

// --------------------
// Message handler
// --------------------
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const textRaw = safe(msg.text);
  const t = textRaw.toLowerCase();

  const cfg = await getConfig();
  const st = getState(chatId);

  // esperando cantidad escrita
  if (st.awaitingQty) {
    const full = await getCatalog();
    const code = st.awaitingQty.code;
    const prod = full.find((p) => safe(p.codigo) === code);

    const unit = st.awaitingQty.unit;
    st.awaitingQty = null;

    if (!prod) {
      await bot.sendMessage(chatId, "Ese producto ya no está disponible. Volvé a categorías.", {
        reply_markup: { inline_keyboard: [[{ text: "📁 Categorías", callback_data: "OPEN:CATS" }]] },
      });
      return;
    }

    const n = Number(String(textRaw).replace(",", "."));
    if (!isFinite(n) || n <= 0) {
      const hint =
        unit === "kg"
          ? "Cantidad inválida. Escribí gramos (ej: 250) o kg (ej: 0.5)."
          : "Cantidad inválida. Escribí un número (ej: 1, 2, 3).";
      await bot.sendMessage(chatId, hint, { reply_markup: mainMenuKeyboard(cfg) });
      return;
    }

    let qty = n;
    if (unit === "kg") {
      if (n >= 100) qty = n / 1000; // gramos -> kg
    }

    await addToCart(chatId, prod, qty);
    return;
  }

  // checkout pasos texto
  if (st.checkout && st.checkout.step) {
    const step = st.checkout.step;

    if (step === "address") {
      st.checkout.address = textRaw;
      await checkoutAskName(chatId);
      return;
    }
    if (step === "name") {
      st.checkout.name = textRaw;
      await checkoutAskPhone(chatId);
      return;
    }
    if (step === "phone") {
      st.checkout.phone = textRaw;
      await checkoutAskPayment(chatId);
      return;
    }
  }

  // comandos / menú
  if (t === "/start" || t === "hola" || t === "buen día" || t === "buen dia" || t === "buenas") {
    await sendWelcome(chatId);
    return;
  }

  if (textRaw === "🛍️ Catálogo") {
    await showCategories(chatId);
    return;
  }
  if (textRaw === "🛒 Carrito") {
    await showCart(chatId);
    return;
  }
  if (textRaw === "✅ Finalizar compra") {
    await startCheckout(chatId);
    return;
  }
  if (textRaw === "🎫 Tarjeta de sellos") {
    await sendStampsCard(chatId);
    return;
  }
  if (textRaw === "📣 Compartir bot") {
    await sendShareBotOptions(chatId);
    return;
  }

  // respuesta corta para no ensuciar
  await bot.sendMessage(chatId, "Elegí una opción del menú 👇", { reply_markup: mainMenuKeyboard(cfg) });
});

// --------------------
// Callback handler
// --------------------
bot.on("callback_query", async (q) => {
  const chatId = q.message?.chat?.id;
  const data = safe(q.data);
  const st = getState(chatId);

  try {
    await bot.answerCallbackQuery(q.id);
  } catch {}

  try {
    if (data === "OPEN:MENU") {
      const cfg = await getConfig();
      await bot.sendMessage(chatId, "🏠 Menú", { reply_markup: mainMenuKeyboard(cfg) });
      return;
    }

    if (data === "OPEN:CATS") {
      await showCategories(chatId);
      return;
    }

    if (data === "OPEN:CART") {
      await showCart(chatId);
      return;
    }

    if (data === "SHARE:BOT") {
      await sendShareBotOptions(chatId);
      return;
    }

    if (data === "SHARE:PRODUCT") {
      const full = await getCatalog();
      const list = filterCatalog(full, st.catFilter);
      const p = list[st.catIndex];
      if (p) await sendShareProductOptions(chatId, p);
      return;
    }

    if (data.startsWith("CATF:")) {
      const f = data.slice("CATF:".length);
      st.catFilter = f === "ALL" ? "ALL" : f;
      st.catIndex = 0;
      await renderCurrentProduct(chatId, true);
      return;
    }

    if (data === "CAT:PREV") {
      st.catIndex = Math.max(0, st.catIndex - 1);
      await renderCurrentProduct(chatId, false);
      return;
    }

    if (data === "CAT:NEXT") {
      st.catIndex = st.catIndex + 1;
      await renderCurrentProduct(chatId, false);
      return;
    }

    if (data === "ADD:CURRENT") {
      const full = await getCatalog();
      const list = filterCatalog(full, st.catFilter);
      const p = list[st.catIndex];
      if (!p) return;

      await askQty(chatId, p);
      return;
    }

    // Checkout callbacks
    if (data === "CHECKOUT:START") {
      await startCheckout(chatId);
      return;
    }

    if (data.startsWith("DELIVERY:")) {
      const mode = data.split(":")[1];
      if (!st.checkout) st.checkout = { step: "delivery", delivery: "", address: "", name: "", phone: "", payMethod: "" };
      st.checkout.delivery = mode;
      if (mode === "HOME") {
        await checkoutAskAddress(chatId);
      } else {
        st.checkout.address = "";
        await checkoutAskName(chatId);
      }
      return;
    }

    if (data.startsWith("PAY:")) {
      const pm = data.split(":")[1]; // CASH / TRANSFER
      if (!st.checkout) return;
      st.checkout.payMethod = pm;
      await checkoutSummary(chatId);
      return;
    }

    // fallback
    const cfg = await getConfig();
    await bot.sendMessage(chatId, "Listo ✅", { reply_markup: mainMenuKeyboard(cfg) });
  } catch (e) {
    console.log("❌ callback error:", data, e?.message || e);
    try {
      const cfg = await getConfig();
      await bot.sendMessage(chatId, "Hubo un error puntual. Probá de nuevo 👇", { reply_markup: mainMenuKeyboard(cfg) });
    } catch {}
  }
});

// --------------------
// Server (Render)
// --------------------
const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);

    if (u.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("EzerBot está corriendo ✅");
      return;
    }
    if (u.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, webhook: WEBHOOK_URL, sheets: !!SHEETS_API_BASE }));
      return;
    }

    if (u.pathname === WEBHOOK_PATH && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const update = JSON.parse(body || "{}");
          if (update?.update_id) console.log("📩 update", update.update_id);
          await bot.processUpdate(update);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          console.log("❌ webhook error:", e?.message || e);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false }));
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Not Found" }));
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Server error");
  }
});

server.listen(PORT, async () => {
  console.log(`HTTP listening on ${PORT}`);

  if (WEBHOOK_URL) {
    try {
      await bot.setWebHook(WEBHOOK_URL);
      console.log("✅ Webhook seteado:", WEBHOOK_URL);
    } catch (e) {
      console.log("❌ Error setWebHook:", e?.message || e);
    }
  } else {
    console.log("❌ No hay PUBLIC_URL, no se setea webhook.");
  }

  try {
    const cfg = await getConfig();
    const cat = await getCatalog();
    console.log("✅ Warmup ok. Config keys:", Object.keys(cfg || {}).length, "Catalog items:", Array.isArray(cat) ? cat.length : 0);
  } catch (e) {
    console.log("❌ Warmup error:", e?.message || e);
  }

  console.log("✅ EzerBot iniciado");
});

/**
 * EzerBot System - index.js (single file)
 * - Telegram webhook bot for Render
 * - Reads Config + Catalogo from Google Apps Script (GAS_URL) with fallbacks
 * - Warm WhatsApp-like UX
 * - Cart + kg/unidad + shipping + checkout
 *
 * ENV required:
 *   BOT_TOKEN   = Telegram bot token
 *   GAS_URL     = https://script.google.com/macros/s/XXXX/exec
 *   PUBLIC_URL  = https://ezerbot-system.onrender.com   (NO trailing slash)
 */

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const GAS_URL = (process.env.GAS_URL || "").trim();
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");

if (!BOT_TOKEN) throw new Error("Missing env BOT_TOKEN");
if (!GAS_URL) throw new Error("Missing env GAS_URL");
if (!PUBLIC_URL || !PUBLIC_URL.startsWith("https://")) {
  throw new Error("Missing/invalid env PUBLIC_URL (must be https://...)");
}

const app = express();
app.use(express.json({ limit: "2mb" }));

// Telegram bot (webhook mode)
const bot = new TelegramBot(BOT_TOKEN, { webHook: true });

// ---------- In-memory store ----------
const stateByChat = new Map(); // chatId -> { mode, pending, lastProductCode, ... }
const carts = new Map();       // chatId -> [{codigo,nombre,unidad,precio,precioporkg,qtyKg,qtyUn,subtotal}]
const cache = {
  config: { data: null, loadedAt: 0 },
  catalogo: { data: null, loadedAt: 0 },
};
const CACHE_TTL_MS = 60 * 1000;

// ---------- Helpers ----------
function nowISO() { return new Date().toISOString(); }

function asNumber(x, def = 0) {
  const n = Number(String(x).replace(",", "."));
  return Number.isFinite(n) ? n : def;
}
function moneyARS(n) {
  try {
    return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(n);
  } catch {
    return `$${Math.round(n)} ARS`;
  }
}
function norm(s) {
  return String(s || "").trim();
}
function lower(s) {
  return norm(s).toLowerCase();
}
function safeText(s, max = 3800) {
  const t = String(s || "");
  return t.length > max ? t.slice(0, max - 3) + "..." : t;
}

function getChatState(chatId) {
  if (!stateByChat.has(chatId)) stateByChat.set(chatId, { mode: "MENU", pending: null });
  return stateByChat.get(chatId);
}
function getCart(chatId) {
  if (!carts.has(chatId)) carts.set(chatId, []);
  return carts.get(chatId);
}
function clearCart(chatId) {
  carts.set(chatId, []);
}

// ---------- GAS fetch with fallbacks ----------
async function fetchJSON(url) {
  const res = await fetch(url, { method: "GET" });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // Some GAS returns plain text; wrap it
    return { ok: false, raw: text };
  }
}

async function gasTry(paths) {
  let lastErr = null;
  for (const u of paths) {
    try {
      const data = await fetchJSON(u);
      if (data && (data.ok === true || data.ok === undefined || typeof data === "object")) return data;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

/**
 * Expected possibilities (we support all):
 * - Config:
 *   { ok:true, config:{KEY:"VAL", ...} }
 *   { ok:true, data:{KEY:"VAL"} }
 *   { ok:true, rows:[{key:"LOGO_URL", value:"..."}, ...] }
 *   { ok:true, configRows:[{key,value}] }
 *
 * - Catalogo:
 *   { ok:true, productos:[{codigo,nombre,precio,unidad,precioporkg,codigobarras,descripcion,imagen,categoria}, ...] }
 *   { ok:true, catalogo:[...] }
 *   { ok:true, data:[...] }
 */
function parseConfig(any) {
  if (!any || typeof any !== "object") return {};
  if (any.config && typeof any.config === "object") return any.config;
  if (any.data && typeof any.data === "object" && !Array.isArray(any.data)) return any.data;

  const rows = any.rows || any.configRows || any.Config || any.CONFIG;
  if (Array.isArray(rows)) {
    const out = {};
    for (const r of rows) {
      const k = norm(r.key ?? r.KEY ?? r.clave ?? r.CLAVE ?? r[0]);
      const v = r.value ?? r.VALOR ?? r.valor ?? r[1];
      if (k) out[k] = String(v ?? "").trim();
    }
    return out;
  }
  return {};
}

function parseCatalogo(any) {
  if (!any || typeof any !== "object") return [];
  const arr =
    any.productos ||
    any.catalogo ||
    any.data ||
    any.items ||
    any.Catalogo ||
    any.CATALOGO;

  if (Array.isArray(arr)) return arr;

  // Some wrong responses: configRawPreview might contain productos
  if (typeof any === "object" && Array.isArray(any.productos)) return any.productos;

  return [];
}

async function loadConfig(force = false) {
  const fresh = cache.config.data && (Date.now() - cache.config.loadedAt) < CACHE_TTL_MS;
  if (!force && fresh) return cache.config.data;

  const base = GAS_URL.replace(/\/+$/, "");
  const tries = [
    `${base}?op=config`,
    `${base}?action=config`,
    `${base}?mode=config`,
    `${base}?sheet=Config`,
    `${base}?tab=Config`,
    `${base}?get=Config`,
    `${base}`, // fallback (some GAS returns both or config)
  ];

  const raw = await gasTry(tries);

  // If fallback returned catalogo, config may be missing. We'll still parse config if possible.
  const cfg = parseConfig(raw);

  cache.config.data = cfg;
  cache.config.loadedAt = Date.now();
  return cfg;
}

async function loadCatalogo(force = false) {
  const fresh = cache.catalogo.data && (Date.now() - cache.catalogo.loadedAt) < CACHE_TTL_MS;
  if (!force && fresh) return cache.catalogo.data;

  const base = GAS_URL.replace(/\/+$/, "");
  const tries = [
    `${base}?op=catalogo`,
    `${base}?action=catalogo`,
    `${base}?mode=catalogo`,
    `${base}?sheet=Catalogo`,
    `${base}?tab=Catalogo`,
    `${base}?get=Catalogo`,
    `${base}`, // fallback
  ];

  const raw = await gasTry(tries);
  const list = parseCatalogo(raw);

  cache.catalogo.data = list;
  cache.catalogo.loadedAt = Date.now();
  return list;
}

// ---------- Config getters ----------
function cfgGet(cfg, key, def = "") {
  // keys may come in different case; normalize
  const k = key;
  if (cfg[k] != null && cfg[k] !== "") return String(cfg[k]);
  const up = key.toUpperCase();
  if (cfg[up] != null && cfg[up] !== "") return String(cfg[up]);
  const lowKey = key.toLowerCase();
  // search case-insensitive
  for (const kk of Object.keys(cfg)) {
    if (kk.toLowerCase() === lowKey) return String(cfg[kk]);
  }
  return def;
}

function vendorWhatsapp(cfg) {
  // support multiple key names
  const w =
    cfgGet(cfg, "WHATSAPP_VENDEDOR") ||
    cfgGet(cfg, "WHATSAPP") ||
    cfgGet(cfg, "TEL_WHATSAPP") ||
    cfgGet(cfg, "CELULAR") ||
    "";
  return norm(w);
}

function logoUrl(cfg) {
  return norm(cfgGet(cfg, "LOGO_URL") || cfgGet(cfg, "LOGO") || cfgGet(cfg, "IMG_LOGO") || "");
}

function brandName(cfg) {
  return norm(cfgGet(cfg, "NOMBRE_LOCAL") || cfgGet(cfg, "NOMBRE") || cfgGet(cfg, "MARCA") || "Todo Queso");
}

function shippingCost(cfg) {
  // supports "ENVIO_COSTO", "COSTO_ENVIO"
  const val = cfgGet(cfg, "ENVIO_COSTO") || cfgGet(cfg, "COSTO_ENVIO") || "0";
  return Math.max(0, asNumber(val, 0));
}

// ---------- UI builders ----------
function mainMenuKeyboard() {
  return {
    keyboard: [
      [{ text: "🛍️ Catálogo" }, { text: "🛒 Mi carrito" }],
      [{ text: "✅ Finalizar compra" }],
      [{ text: "ℹ️ Información del local" }, { text: "💬 Hablar con el vendedor" }],
      [{ text: "📣 Compartir el bot" }, { text: "🔄 Recargar catálogo" }],
    ],
    resize_keyboard: true,
  };
}

function inlineButton(text, cb) {
  return { text, callback_data: cb };
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function categoriesFromCatalogo(list) {
  const set = new Set();
  for (const p of list) {
    const cat = norm(p.categoria ?? p.CATEGORIA);
    if (cat) set.add(cat);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, "es"));
}

function findProduct(list, code) {
  const c = norm(code);
  return list.find(p => norm(p.codigo ?? p.CODIGO) === c);
}

// ---------- Bot logic ----------
async function sendWelcome(chatId) {
  const cfg = await loadConfig(false);
  const brand = brandName(cfg);
  const logo = logoUrl(cfg);

  const saludo =
    cfgGet(cfg, "SALUDO_INICIAL") ||
    `Hola 😊 Soy el asistente de *${brand}*.\n\nDecime qué querés hacer y te guío paso a paso 👇`;

  const extra =
    cfgGet(cfg, "SALUDO_EXTRA") ||
    `• Ver el catálogo\n• Armar tu pedido\n• Finalizar compra\n• Hablar con un vendedor`;

  const msg = `${saludo}\n\n${extra}`;

  // If logo exists, send as photo first (Telegram photo with caption)
  if (logo) {
    try {
      await bot.sendPhoto(chatId, logo, {
        caption: safeText(msg, 900),
        parse_mode: "Markdown",
        reply_markup: mainMenuKeyboard(),
      });
      return;
    } catch {
      // fallback to text only
    }
  }

  await bot.sendMessage(chatId, msg, {
    parse_mode: "Markdown",
    reply_markup: mainMenuKeyboard(),
  });
}

async function showCategories(chatId) {
  const list = await loadCatalogo(false);
  const cats = categoriesFromCatalogo(list);

  if (!cats.length) {
    await bot.sendMessage(
      chatId,
      "⚠️ No encuentro categorías/productos cargados todavía.\n\nRevisá que tu GAS devuelva productos con: `categoria`, `codigo`, `nombre`, `precio` o `precioporkg`, `imagen`.",
      { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() }
    );
    return;
  }

  const buttons = chunk(
    cats.map(c => inlineButton(`📁 ${c}`, `CAT:${c}`)),
    2
  );

  await bot.sendMessage(chatId, "📁 Elegí una categoría:", {
    reply_markup: { inline_keyboard: buttons },
  });
}

async function showCategoryPage(chatId, category, page = 1) {
  const list = await loadCatalogo(false);
  const items = list.filter(p => norm(p.categoria ?? p.CATEGORIA) === category);

  if (!items.length) {
    await bot.sendMessage(chatId, `⚠️ No hay productos en “${category}”.`, { reply_markup: mainMenuKeyboard() });
    return;
  }

  const perPage = 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const pg = Math.min(Math.max(1, page), totalPages);
  const p = items[(pg - 1) * perPage];

  const codigo = norm(p.codigo ?? p.CODIGO);
  const nombre = norm(p.nombre ?? p.NOMBRE);
  const unidad = lower(p.unidad ?? p.UNIDAD);
  const precio = asNumber(p.precio ?? p.PRECIO, 0);
  const precioKg = asNumber(p.precioporkg ?? p.PRECIOPORKILO ?? p.precioporkg, 0);
  const img = norm(p.imagen ?? p.IMAGEN);
  const desc = norm(p.descripcion ?? p.DESCRIPCION);

  const showPrice = unidad === "kg" ? precioKg || precio : precio;

  const caption =
    `*${nombre}*\n` +
    `💰 ${moneyARS(showPrice)}${unidad === "kg" ? " / kg" : ""}\n` +
    `🆔 ${codigo}\n` +
    (desc ? `\n_${desc}_\n` : "");

  const navRow = [];
  if (pg > 1) navRow.push(inlineButton("⬅️ Anterior", `PAGE:${category}:${pg - 1}`));
  navRow.push(inlineButton("📁 Categorías", `CATS`));
  if (pg < totalPages) navRow.push(inlineButton("➡️ Siguiente", `PAGE:${category}:${pg + 1}`));

  const keyboard = {
    inline_keyboard: [
      [inlineButton("✅ Quiero este", `ADD:${codigo}`), inlineButton("📣 Compartir", `SHARE:${codigo}`)],
      [inlineButton("↩️ Volver a categoría", `CAT:${category}`)],
      navRow,
    ],
  };

  // send photo if possible
  if (img) {
    try {
      await bot.sendPhoto(chatId, img, { caption: safeText(caption, 900), parse_mode: "Markdown", reply_markup: keyboard });
      return;
    } catch {
      // fall back to text
    }
  }

  await bot.sendMessage(chatId, caption, { parse_mode: "Markdown", reply_markup: keyboard });
}

async function askQuantity(chatId, productCode) {
  const list = await loadCatalogo(false);
  const p = findProduct(list, productCode);
  if (!p) {
    await bot.sendMessage(chatId, "⚠️ No encuentro ese producto. Probá recargar catálogo.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  const st = getChatState(chatId);
  st.pending = { type: "QTY", code: norm(productCode) };

  const unidad = lower(p.unidad ?? p.UNIDAD);
  if (unidad === "kg") {
    await bot.sendMessage(
      chatId,
      `¿Cuánto querés de *${norm(p.nombre ?? p.NOMBRE)}*?\n\n✅ Respondé con:\n- gramos (ej: 250)\n- o kilos (ej: 0.5)\n\n(Te lo calculo y lo agrego al carrito)`,
      { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() }
    );
  } else {
    await bot.sendMessage(
      chatId,
      `¿Cuántas unidades de *${norm(p.nombre ?? p.NOMBRE)}* querés?\n\nRespondé con un número (ej: 1, 2, 3).`,
      { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() }
    );
  }
}

function parseKgInput(text) {
  const t = lower(text).replace(",", ".").trim();
  // if user writes "250" treat as grams if >= 10
  const n = asNumber(t, NaN);
  if (!Number.isFinite(n) || n <= 0) return null;

  // Heuristic:
  // - if n >= 10 -> grams
  // - else -> kilos
  if (n >= 10) return { kg: n / 1000, grams: n };
  return { kg: n, grams: Math.round(n * 1000) };
}

async function addToCart(chatId, productCode, qtyText) {
  const cfg = await loadConfig(false);
  const list = await loadCatalogo(false);
  const p = findProduct(list, productCode);
  if (!p) {
    await bot.sendMessage(chatId, "⚠️ No encuentro ese producto. Probá recargar catálogo.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  const codigo = norm(p.codigo ?? p.CODIGO);
  const nombre = norm(p.nombre ?? p.NOMBRE);
  const unidad = lower(p.unidad ?? p.UNIDAD);
  const precio = asNumber(p.precio ?? p.PRECIO, 0);
  const precioKg = asNumber(p.precioporkg ?? p.PRECIOPORKILO ?? p.precioporkg, 0);

  let line = { codigo, nombre, unidad, precio, precioporkg: precioKg || precio, qtyKg: 0, qtyUn: 0, subtotal: 0 };

  if (unidad === "kg") {
    const parsed = parseKgInput(qtyText);
    if (!parsed) {
      await bot.sendMessage(chatId, "⚠️ No entendí la cantidad. Ejemplos: 250 (gramos) o 0.5 (kilos).");
      return;
    }
    const kg = parsed.kg;
    const unitPrice = line.precioporkg || precioKg || precio;
    line.qtyKg = kg;
    line.subtotal = Math.round(unitPrice * kg);
    getCart(chatId).push(line);

    await bot.sendMessage(
      chatId,
      `✅ Agregado: *${nombre}*\nCantidad: *${parsed.grams}g* (${kg.toFixed(3)} kg)\nSubtotal: *${moneyARS(line.subtotal)}*`,
      { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() }
    );
  } else {
    const q = Math.max(1, Math.floor(asNumber(qtyText, 1)));
    line.qtyUn = q;
    line.subtotal = Math.round((line.precio || precio) * q);
    getCart(chatId).push(line);

    await bot.sendMessage(
      chatId,
      `✅ Agregado: *${nombre}*\nCantidad: *${q}*\nSubtotal: *${moneyARS(line.subtotal)}*`,
      { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() }
    );
  }

  // Gentle upsell/suggestion
  const sugerencia = cfgGet(cfg, "SUGERENCIA_POST_AGREGAR");
  if (sugerencia) {
    await bot.sendMessage(chatId, safeText(sugerencia, 1000), { reply_markup: mainMenuKeyboard() });
  } else {
    await bot.sendMessage(chatId, "¿Sumamos algo más? 😋 Tocá *Catálogo* para seguir.", { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
  }
}

async function showCart(chatId) {
  const cart = getCart(chatId);
  if (!cart.length) {
    await bot.sendMessage(chatId, "🛒 Tu carrito está vacío.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  let total = 0;
  let lines = cart.map((it, idx) => {
    total += it.subtotal;
    if (it.unidad === "kg") {
      return `${idx + 1}) ${it.nombre} (${it.codigo})\n   Cantidad: ${Math.round(it.qtyKg * 1000)}g\n   Subtotal: ${moneyARS(it.subtotal)}`;
    }
    return `${idx + 1}) ${it.nombre} (${it.codigo})\n   Cantidad: ${it.qtyUn}\n   Subtotal: ${moneyARS(it.subtotal)}`;
  });

  await bot.sendMessage(
    chatId,
    `🛒 *Tu carrito:*\n\n${lines.join("\n\n")}\n\n💰 *Total: ${moneyARS(total)}*`,
    { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() }
  );
}

async function startCheckout(chatId) {
  const cart = getCart(chatId);
  if (!cart.length) {
    await bot.sendMessage(chatId, "🛒 Tu carrito está vacío. Primero agregá algo desde *Catálogo*.", { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
    return;
  }

  const st = getChatState(chatId);
  st.pending = { type: "DELIVERY" };

  await bot.sendMessage(chatId, "¿Cómo querés recibir tu pedido? 🚚🏪", {
    reply_markup: {
      inline_keyboard: [
        [inlineButton("🚚 Envío a domicilio", "DELIVERY:ENVIO"), inlineButton("🏪 Retiro en el local", "DELIVERY:RETIRO")],
      ],
    },
  });
}

async function finishCheckout(chatId, deliveryType, addressText) {
  const cfg = await loadConfig(false);
  const cart = getCart(chatId);

  let total = cart.reduce((a, b) => a + (b.subtotal || 0), 0);
  const envio = deliveryType === "ENVIO" ? shippingCost(cfg) : 0;
  const totalFinal = total + envio;

  const alias = cfgGet(cfg, "ALIAS_MP") || cfgGet(cfg, "ALIAS") || cfgGet(cfg, "ALIAS_TRANSFERENCIA") || "";
  const cbu = cfgGet(cfg, "CBU") || "";
  const brand = brandName(cfg);

  let detalle = cart.map((it) => {
    if (it.unidad === "kg") return `• ${it.nombre} (${Math.round(it.qtyKg * 1000)}g) — ${moneyARS(it.subtotal)}`;
    return `• ${it.nombre} (x${it.qtyUn}) — ${moneyARS(it.subtotal)}`;
  }).join("\n");

  const ticket = `TQ-${Math.floor(100000 + Math.random() * 900000)}`;

  const mensaje =
`🧾 *${brand}*
Ticket N° *${ticket}*
📅 ${new Date().toLocaleString("es-AR")}

${detalle}

${deliveryType === "ENVIO" ? `🚚 Envío: ${moneyARS(envio)}\n📍 Dirección: ${addressText}\n` : `🏪 Retiro en el local\n`}
💰 *TOTAL: ${moneyARS(totalFinal)}*

${alias ? `💳 Alias: *${alias}*\n` : ""}${cbu ? `🏦 CBU: *${cbu}*\n` : ""}
📩 Enviá el comprobante para preparar tu pedido 🙌`;

  await bot.sendMessage(chatId, mensaje, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });

  // reset cart after checkout (optional behavior)
  const autoClear = lower(cfgGet(cfg, "VACIAR_CARRITO_POST_CHECKOUT", "no")) === "si";
  if (autoClear) clearCart(chatId);
}

async function infoLocal(chatId) {
  const cfg = await loadConfig(false);
  const brand = brandName(cfg);
  const logo = logoUrl(cfg);

  const dir = cfgGet(cfg, "DIRECCION") || cfgGet(cfg, "DOMICILIO") || "";
  const horarios = cfgGet(cfg, "HORARIOS") || cfgGet(cfg, "HORARIO") || "";
  const tel = cfgGet(cfg, "TELEFONO") || cfgGet(cfg, "TEL") || "";
  const ig = cfgGet(cfg, "INSTAGRAM") || "";
  const fb = cfgGet(cfg, "FACEBOOK") || "";

  const texto =
`🏪 *${brand}*
📍 ${dir || "Dirección no cargada"}
🕒 ${horarios || "Horarios no cargados"}
📞 ${tel || "Teléfono no cargado"}

📸 Instagram: ${ig || "NO"}
📘 Facebook: ${fb || "NO"}`;

  if (logo) {
    try {
      await bot.sendPhoto(chatId, logo, { caption: safeText(texto, 900), parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
      return;
    } catch {}
  }
  await bot.sendMessage(chatId, texto, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
}

async function hablarVendedor(chatId) {
  const cfg = await loadConfig(false);
  const w = vendorWhatsapp(cfg);

  if (!w) {
    await bot.sendMessage(chatId, "⚠️ Todavía no está configurado el WhatsApp del vendedor en Config.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  // normalize number: keep digits
  const phone = w.replace(/[^\d]/g, "");
  const msg = encodeURIComponent(cfgGet(cfg, "MENSAJE_WHATSAPP_VENDEDOR", "Hola 😊 Quiero hacer un pedido."));
  const link = `https://wa.me/${phone}?text=${msg}`;

  await bot.sendMessage(chatId, "💬 Hablá con nosotros por WhatsApp 👇", {
    reply_markup: {
      inline_keyboard: [[{ text: "📲 Abrir WhatsApp", url: link }]],
    },
  });
}

async function compartirBot(chatId) {
  const cfg = await loadConfig(false);
  const brand = brandName(cfg);
  const username = (await bot.getMe()).username;
  const link = `https://t.me/${username}`;

  const texto = cfgGet(cfg, "MENSAJE_COMPARTIR") || `Compartí este bot de *${brand}* con tus amigos 🙌`;

  await bot.sendMessage(chatId, texto, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [[{ text: "🔗 Compartir link", url: link }]] },
  });
}

async function answerFreeText(chatId, text) {
  const cfg = await loadConfig(false);
  const t = lower(text);

  // Common intents (human WhatsApp style)
  if (["hola", "holaa", "buenas", "buen día", "buen dia", "buenas tardes", "buenas noches", "que tal", "qué tal", "menu", "menú", "inicio"].includes(t)) {
    await sendWelcome(chatId);
    return;
  }
  if (t.includes("horario") || t.includes("hora")) {
    const horarios = cfgGet(cfg, "HORARIOS") || cfgGet(cfg, "HORARIO");
    if (horarios) {
      await bot.sendMessage(chatId, `🕒 Horarios: ${horarios}`, { reply_markup: mainMenuKeyboard() });
      return;
    }
  }
  if (t.includes("direccion") || t.includes("dirección") || t.includes("donde") || t.includes("ubicacion") || t.includes("ubicación")) {
    const dir = cfgGet(cfg, "DIRECCION") || cfgGet(cfg, "DOMICILIO");
    if (dir) {
      await bot.sendMessage(chatId, `📍 Dirección: ${dir}`, { reply_markup: mainMenuKeyboard() });
      return;
    }
  }
  if (t.includes("envio") || t.includes("envío")) {
    const c = shippingCost(cfg);
    await bot.sendMessage(chatId, `🚚 Envío: ${c ? moneyARS(c) : "A confirmar"}.\nSi querés, tocá *Finalizar compra* y te lo calculo en el total.`, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
    return;
  }

  // Default: guide user back (always respond)
  await bot.sendMessage(
    chatId,
    "Dale 😊 Decime qué necesitás o tocá una opción del menú 👇",
    { reply_markup: mainMenuKeyboard() }
  );
}

// ---------- Telegram handlers ----------
bot.onText(/\/start/i, async (msg) => {
  const chatId = msg.chat.id;
  await sendWelcome(chatId);
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  // ignore non-text
  if (!text) return;

  // menu buttons
  const t = norm(text);
  if (t === "🛍️ Catálogo") return showCategories(chatId);
  if (t === "🛒 Mi carrito") return showCart(chatId);
  if (t === "✅ Finalizar compra") return startCheckout(chatId);
  if (t === "ℹ️ Información del local") return infoLocal(chatId);
  if (t === "💬 Hablar con el vendedor") return hablarVendedor(chatId);
  if (t === "📣 Compartir el bot") return compartirBot(chatId);
  if (t === "🔄 Recargar catálogo") {
    await loadConfig(true);
    await loadCatalogo(true);
    await bot.sendMessage(chatId, "✅ Listo. Recargué Config y Catálogo.", { reply_markup: mainMenuKeyboard() });
    return showCategories(chatId);
  }

  // pending states (quantity / address)
  const st = getChatState(chatId);
  if (st.pending?.type === "QTY") {
    const code = st.pending.code;
    st.pending = null;
    return addToCart(chatId, code, t);
  }
  if (st.pending?.type === "ADDRESS" && st.pending.deliveryType === "ENVIO") {
    const addr = t;
    st.pending = null;
    return finishCheckout(chatId, "ENVIO", addr);
  }

  // default free text answer
  return answerFreeText(chatId, t);
});

bot.on("callback_query", async (q) => {
  const chatId = q.message?.chat?.id;
  const data = q.data || "";
  if (!chatId) return;

  try { await bot.answerCallbackQuery(q.id); } catch {}

  if (data === "CATS") return showCategories(chatId);

  if (data.startsWith("CAT:")) {
    const cat = data.slice(4);
    return showCategoryPage(chatId, cat, 1);
  }

  if (data.startsWith("PAGE:")) {
    const parts = data.split(":");
    const cat = parts[1];
    const page = Number(parts[2] || "1");
    return showCategoryPage(chatId, cat, page);
  }

  if (data.startsWith("ADD:")) {
    const code = data.slice(4);
    return askQuantity(chatId, code);
  }

  if (data.startsWith("SHARE:")) {
    const code = data.slice(6);
    const list = await loadCatalogo(false);
    const p = findProduct(list, code);
    const brand = brandName(await loadConfig(false));
    const txt = p ? `${brand} — ${norm(p.nombre ?? p.NOMBRE)} (${code})` : `${brand} — Producto ${code}`;
    await bot.sendMessage(chatId, `📣 ${txt}`, { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (data.startsWith("DELIVERY:")) {
    const choice = data.split(":")[1];
    const st = getChatState(chatId);
    st.pending = null;

    if (choice === "RETIRO") {
      return finishCheckout(chatId, "RETIRO", "");
    }

    if (choice === "ENVIO") {
      st.pending = { type: "ADDRESS", deliveryType: "ENVIO" };
      const cfg = await loadConfig(false);
      const costo = shippingCost(cfg);
      await bot.sendMessage(
        chatId,
        `Perfecto 🚚\nCosto de envío: *${costo ? moneyARS(costo) : "A confirmar"}*\n\nAhora pasame tu *dirección completa* (calle, número, barrio).`,
        { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() }
      );
      return;
    }
  }
});

// ---------- Express routes ----------
app.get("/", (req, res) => {
  res.json({ ok: true, service: "ezerbot-system", bootedAt: nowISO() });
});

// Debug status for YOU (browser)
app.get("/debug", async (req, res) => {
  let lastError = null;
  let cfg = {};
  let cat = [];
  try { cfg = await loadConfig(false); } catch (e) { lastError = String(e?.message || e); }
  try { cat = await loadCatalogo(false); } catch (e) { lastError = lastError || String(e?.message || e); }

  const keys = Object.keys(cfg || {});
  res.json({
    ok: true,
    bootedAt: nowISO(),
    gasUrlSet: !!GAS_URL,
    publicUrl: PUBLIC_URL,
    configLoadedAt: cache.config.loadedAt ? new Date(cache.config.loadedAt).toISOString() : null,
    configKeysCount: keys.length,
    sampleKeys: keys.slice(0, 25),
    catalogoLoadedAt: cache.catalogo.loadedAt ? new Date(cache.catalogo.loadedAt).toISOString() : null,
    catalogoCount: Array.isArray(cat) ? cat.length : 0,
    sampleCats: Array.isArray(cat) ? categoriesFromCatalogo(cat).slice(0, 20) : [],
    lastError,
  });
});

// Telegram webhook endpoint
app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ---------- Boot ----------
async function boot() {
  // preload (best effort)
  try { await loadConfig(true); } catch {}
  try { await loadCatalogo(true); } catch {}

  // set webhook (critical)
  const hookUrl = `${PUBLIC_URL}/webhook`;
  const info = await bot.getWebHookInfo();

  if (info?.url !== hookUrl) {
    await bot.setWebHook(hookUrl);
  }

  // start server
  const port = process.env.PORT || 10000;
  app.listen(port, () => {
    console.log("Server up on", port);
    console.log("Webhook set to:", hookUrl);
  });
}

boot().catch((e) => {
  console.error("BOOT ERROR:", e);
  process.exit(1);
});

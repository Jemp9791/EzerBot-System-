// index.js (ESM) — EzerBot Render Webhook + Config/Catalogo desde Google Sheets (Apps Script)
// Requisitos Render ENV: BOT_TOKEN, SHEETS_API_BASE, PUBLIC_URL
// PUBLIC_URL = https://ezerbot-system.onrender.com  (SIN / al final)
// SHEETS_API_BASE = https://script.google.com/macros/s/XXXX/exec

import TelegramBot from "node-telegram-bot-api";
import http from "http";
import { URL } from "url";

// =====================
// 1) ENV
// =====================
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const SHEETS_API_BASE = process.env.SHEETS_API_BASE || ""; // https://script.google.com/macros/s/.../exec
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, ""); // https://ezerbot-system.onrender.com
const PORT = Number(process.env.PORT || 10000);

// Webhook path fijo:
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

function safeStr(v) {
  return String(v ?? "").trim();
}

// Normaliza keys de config (por si vienen con espacios / mayúsculas)
function normalizeKey(k) {
  return safeStr(k)
    .replace(/\s+/g, "")
    .toLowerCase();
}

function cfgGet(cfg, ...keys) {
  if (!cfg || typeof cfg !== "object") return "";
  // map normalizado
  const normMap = new Map();
  for (const [k, v] of Object.entries(cfg)) normMap.set(normalizeKey(k), v);

  for (const k of keys) {
    const v = normMap.get(normalizeKey(k));
    if (v !== undefined && v !== null && safeStr(v) !== "") return safeStr(v);
  }
  return "";
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
// 4) STATE (RAM)
// =====================
const userState = new Map(); // chatId -> state

function getState(chatId) {
  if (!userState.has(chatId)) {
    userState.set(chatId, {
      // catálogo tipo book
      catFilter: "ALL",
      catIndex: 0,
      catsList: [],

      // carrito
      cart: new Map(), // code -> { prod, qty }

      // input manual
      awaitingQtyFor: null, // code
      awaitingQtyMode: null, // "unit" | "grams"

      // checkout
      flow: null,
    });
  }
  return userState.get(chatId);
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
  if (s.includes("kg") || s.includes("kilo")) return "kg";
  return "unidad";
}

function roundQty(q, unit) {
  const n = Number(q || 0);
  if (!isFinite(n) || n <= 0) return 0;
  if (unit === "kg") return Math.round(n * 100) / 100; // 2 dec
  return Math.round(n);
}

// =====================
// 5) UI builders
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

function shareInlineButtons(cfg) {
  // si en Config tenés BotLink lo usamos; si no, fallback al @EzerBot (cambiable)
  const botLink = cfgGet(cfg, "BotLink") || "https://t.me/EzerBot";
  const waText = encodeURIComponent(`Pedí por el bot 🧀👇\n${botLink}`);
  const mailSubj = encodeURIComponent("Pedido por bot");
  const mailBody = encodeURIComponent(`Hola! Te comparto el bot para pedir:\n${botLink}`);

  return {
    inline_keyboard: [
      [{ text: "💬 WhatsApp", url: `https://wa.me/?text=${waText}` }],
      [{ text: "✈️ Telegram", url: `https://t.me/share/url?url=${encodeURIComponent(botLink)}&text=${encodeURIComponent("Pedí por el bot:")}` }],
      [{ text: "📧 Email", url: `mailto:?subject=${mailSubj}&body=${mailBody}` }],
    ],
  };
}

async function sendWelcome(chatId) {
  const cfg = await getConfig();

  const negocio = cfgGet(cfg, "NegocioNombre", "NombreNegocio", "Nombre") || "Todo Queso";
  const dir = cfgGet(cfg, "Direccion", "Dirección") || "Dirección no configurada";
  const hor = cfgGet(cfg, "Horarios", "Horario") || "Horarios no configurados";
  const tel = cfgGet(cfg, "TelefonoNegocio", "TeléfonoNegocio", "Telefono", "Tel") || "Teléfono no configurado";
  const ig = cfgGet(cfg, "Instagram") || "";
  const logo = cfgGet(cfg, "LogoURL", "SelloURL", "TarjetaURL"); // si hay logo mejor, si no algo

  const desc = cfgGet(cfg, "Descripcion", "Descripción") || "";

  let text = `🧀 *${negocio}*\n`;
  text += `📍 ${dir}\n`;
  text += `🕒 ${hor}\n`;
  text += `📞 ${tel}\n`;
  if (ig && ig.toUpperCase() !== "NO") text += `📸 Instagram: ${ig.startsWith("@") ? ig : "@" + ig}\n`;
  if (desc) text += `\n${desc}\n`;
  text += `\nElegí una opción del menú para empezar 👇`;

  if (logo) {
    try {
      await bot.sendPhoto(chatId, logo, {
        caption: text,
        parse_mode: "Markdown",
        reply_markup: mainMenuKeyboard(),
      });
      return;
    } catch {
      // fallback abajo
    }
  }

  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: mainMenuKeyboard(),
  });
}

async function sendStampsCard(chatId) {
  const cfg = await getConfig();
  const usa = (cfgGet(cfg, "UsaSellos") || "NO").toUpperCase() === "SI";
  const cardUrl = cfgGet(cfg, "TarjetaURL");
  const premio = cfgGet(cfg, "BeneficioCumple", "PremioSellos", "SelloURL") || "Un beneficio sorpresa";
  const meta = Number(cfgGet(cfg, "SellosPorNivel") || 10);

  if (!usa) {
    await bot.sendMessage(chatId, "Por ahora la tarjeta de sellos está desactivada.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  const sellos = 0; // luego se conecta a puntos/sellos por cliente si querés
  const bar = "🟩".repeat(Math.min(sellos, meta)) + "⬜".repeat(Math.max(0, meta - sellos));

  const text =
    `🎫 *Tarjeta de sellos*\n\n` +
    `${bar}\n\n` +
    `Sellos: *${sellos} / ${meta}*\n` +
    `Premio al completar: *${premio}*\n\n` +
    `Tip: cada compra confirmada suma 1 sello automático.`;

  if (cardUrl) {
    try {
      await bot.sendPhoto(chatId, cardUrl, { caption: text, parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
      return;
    } catch {}
  }
  await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
}

// =====================
// 6) CATÁLOGO BOOK (foto + botones)
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

function getProdCode(p) {
  return safeStr(p.codigo || p.id);
}

function prodPrice(p) {
  // usamos "precio" (tu sheet ya lo tiene)
  const v = Number(p.precio || 0);
  return isFinite(v) ? v : 0;
}

async function showCategories(chatId) {
  const st = getState(chatId);
  const full = await getCatalog();
  const cats = uniqueCategories(full);

  st.catsList = ["ALL", ...cats];

  const pageSize = 8;
  const pages = Math.ceil(st.catsList.length / pageSize);
  const page = Math.max(0, Math.min(st.catIndex || 0, pages - 1));
  st.catIndex = page;

  const start = page * pageSize;
  const slice = st.catsList.slice(start, start + pageSize);

  const rows = [];
  for (let i = 0; i < slice.length; i += 2) {
    const a = slice[i];
    const b = slice[i + 1];
    const row = [];
    row.push({ text: a === "ALL" ? "📚 Todas" : a, callback_data: `CATI:${start + i}` });
    if (b) row.push({ text: b === "ALL" ? "📚 Todas" : b, callback_data: `CATI:${start + i + 1}` });
    rows.push(row);
  }

  const nav = [];
  if (page > 0) nav.push({ text: "⬅️", callback_data: "CATS:PREV" });
  if (page < pages - 1) nav.push({ text: "➡️", callback_data: "CATS:NEXT" });

  const text = `📦 *Categorías*\nElegí una categoría para ver productos 👇`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [...rows, nav.length ? nav : [], [{ text: "🛒 Ver carrito", callback_data: "OPEN:CART" }]].filter((r) => r.length) },
  });
}

function buildProductCaption(p, idx, total, filter) {
  const nombre = safeStr(p.nombre);
  const precio = prodPrice(p);
  const unit = normalizeUnit(p.unidad);
  const extra = unit === "kg" ? " (x kg)" : " (por unidad)";
  const desc = safeStr(p.descripcion);

  let head = `🛍️ *Catálogo*`;
  if (filter && filter !== "ALL") head += ` — _${filter}_`;
  head += `\n📖 Producto *${idx + 1}* de *${total}*\n\n`;

  let text = head;
  text += `🧀 *${nombre}*\n`;
  text += `💰 ${moneyARS(precio)}${extra}\n`;
  if (desc) text += `\n📝 ${desc}\n`;
  return text;
}

function productBookButtons(p) {
  const code = getProdCode(p);
  return [
    [{ text: "⬅️", callback_data: "BOOK:PREV" }, { text: "➕ Quiero este", callback_data: `WANT:${code}` }, { text: "➡️", callback_data: "BOOK:NEXT" }],
    [{ text: "📚 Categorías", callback_data: "OPEN:CATS" }, { text: "🛒 Ver carrito", callback_data: "OPEN:CART" }],
  ];
}

async function showCatalogBook(chatId) {
  const st = getState(chatId);
  const full = await getCatalog();
  const list = filterCatalog(full, st.catFilter);

  if (!list.length) {
    await bot.sendMessage(chatId, "No hay productos en esa categoría. Probá otra 👇", { reply_markup: mainMenuKeyboard() });
    await showCategories(chatId);
    return;
  }

  const idx = Math.max(0, Math.min(st.catIndex || 0, list.length - 1));
  st.catIndex = idx;

  const p = list[idx];
  const img = safeStr(p.imagen);
  const caption = buildProductCaption(p, idx, list.length, st.catFilter);

  const reply_markup = { inline_keyboard: productBookButtons(p) };

  // Si hay imagen, mandamos foto. Si no, texto.
  if (img) {
    try {
      await bot.sendPhoto(chatId, img, { caption, parse_mode: "Markdown", reply_markup });
      return;
    } catch (e) {
      console.log("⚠️ No pude enviar imagen de producto:", e?.message || e);
    }
  }

  await bot.sendMessage(chatId, caption, { parse_mode: "Markdown", reply_markup });
}

// =====================
// 7) CARRITO + CANTIDADES
// =====================
function cartTotal(st) {
  let total = 0;
  for (const { prod, qty } of st.cart.values()) {
    total += prodPrice(prod) * Number(qty || 0);
  }
  return total;
}

function deliveryCostFromConfig(cfg) {
  const raw = cfgGet(cfg, "CostoEnvio", "EnvioCosto", "CostoDeEnvio", "DeliveryCosto", "CostoDelivery");
  const n = Number(String(raw).replace(",", "."));
  return isFinite(n) && n > 0 ? n : 0;
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

  for (const [code, item] of st.cart.entries()) {
    const p = item.prod;
    const unit = normalizeUnit(p.unidad);
    const qty = item.qty;
    const lineTotal = prodPrice(p) * Number(qty || 0);

    text += `• *${safeStr(p.nombre)}*\n`;
    text += `  Cant: *${qty}* ${unit === "kg" ? "kg" : "unidad"} — Subtotal: *${moneyARS(lineTotal)}*\n\n`;
  }

  const totalProd = cartTotal(st);
  text += `Total productos: *${moneyARS(totalProd)}*`;

  const inline = {
    inline_keyboard: [
      [{ text: "✍️ Cambiar cantidades", callback_data: "CART:EDIT" }],
      [{ text: "✅ Finalizar compra", callback_data: "OPEN:CHECKOUT" }],
      [{ text: "📚 Categorías", callback_data: "OPEN:CATS" }],
    ],
  };

  await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: inline });
}

async function askQtyButtons(chatId, prod) {
  const unit = normalizeUnit(prod.unidad);
  const code = getProdCode(prod);
  const name = safeStr(prod.nombre);

  if (unit === "kg") {
    await bot.sendMessage(chatId, `¿Cuántos gramos querés de *${name}*?`, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "100g", callback_data: `QG:${code}:100` },
            { text: "200g", callback_data: `QG:${code}:200` },
            { text: "300g", callback_data: `QG:${code}:300` },
          ],
          [
            { text: "400g", callback_data: `QG:${code}:400` },
            { text: "500g", callback_data: `QG:${code}:500` },
            { text: "✍️ Otro", callback_data: `QG:${code}:OTHER` },
          ],
          [{ text: "📚 Volver a categorías", callback_data: "OPEN:CATS" }],
        ],
      },
    });
  } else {
    await bot.sendMessage(chatId, `¿Cuántas unidades querés de *${name}*?`, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "1", callback_data: `QU:${code}:1` },
            { text: "2", callback_data: `QU:${code}:2` },
            { text: "3", callback_data: `QU:${code}:3` },
            { text: "4", callback_data: `QU:${code}:4` },
            { text: "5", callback_data: `QU:${code}:5` },
          ],
          [{ text: "✍️ Otro", callback_data: `QU:${code}:OTHER` }],
          [{ text: "📚 Volver a categorías", callback_data: "OPEN:CATS" }],
        ],
      },
    });
  }
}

async function addToCartWithQty(chatId, prod, qty) {
  const st = getState(chatId);
  const code = getProdCode(prod);
  const unit = normalizeUnit(prod.unidad);

  const q = roundQty(qty, unit);
  if (!q) {
    await bot.sendMessage(chatId, "Cantidad inválida.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  st.cart.set(code, { prod, qty: q });

  await bot.sendMessage(chatId, `✅ Agregado: *${safeStr(prod.nombre)}* → *${q}* ${unit === "kg" ? "kg" : "unidad"}`, {
    parse_mode: "Markdown",
    reply_markup: mainMenuKeyboard(),
  });

  // mini tip + botón para seguir comprando hacia categorías
  await bot.sendMessage(chatId, "💡 Si querés, sumá algo más del catálogo 👇", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📚 Seguir comprando", callback_data: "OPEN:CATS" }],
        [{ text: "🛒 Ver carrito", callback_data: "OPEN:CART" }],
      ],
    },
  });
}

// =====================
// 8) CHECKOUT (flow)
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

  const negocio = cfgGet(cfg, "NegocioNombre", "NombreNegocio") || "Todo Queso";
  const alias = cfgGet(cfg, "AliasPago") || "jennyocampos.mp";
  const waNegocio = cfgGet(cfg, "WhatsAppLink"); // ya viene armado en Config
  const chatVendedor = Number(cfgGet(cfg, "ChatIdVendedor") || 0);

  // Detalle carrito
  let detalle = "";
  for (const { prod, qty } of st.cart.values()) {
    const unit = normalizeUnit(prod.unidad);
    const lt = prodPrice(prod) * Number(qty || 0);
    detalle += `- ${safeStr(prod.nombre)} | ${qty} ${unit === "kg" ? "kg" : "unidad"} | ${moneyARS(lt)}\n`;
  }

  const totalProductos = cartTotal(st);
  const entregaTxt = flow.deliveryType === "envio" ? "🚚 Envío a domicilio" : "🏪 Retiro por el local";

  const costoEnvio = flow.deliveryType === "envio" ? deliveryCostFromConfig(cfg) : 0;
  const totalFinal = totalProductos + costoEnvio;

  let resumen =
    `✅ *Pedido confirmado (pendiente de pago/validación)*\n\n` +
    `*${negocio}*\n` +
    `Entrega: *${entregaTxt}*\n` +
    (flow.deliveryType === "envio" ? `Dirección: *${safeStr(flow.address)}*\n` : "") +
    `Nombre: *${safeStr(flow.name)}*\n` +
    `Teléfono: *${safeStr(flow.phone)}*\n` +
    `Pago: *${safeStr(flow.payment)}*\n\n` +
    `🧾 *Detalle:*\n${detalle}\n` +
    `🧀 Total productos: *${moneyARS(totalProductos)}*\n` +
    `🚚 Envío: *${moneyARS(costoEnvio)}*\n` +
    `💰 *Total final: ${moneyARS(totalFinal)}*\n`;

  if (flow.payment === "Transferencia") {
    resumen += `\n🏦 Alias para transferir: \`${alias}\`\n📌 Cuando transfieras, mandá el comprobante por acá.`;
  } else {
    resumen += `\n💵 Pagás en efectivo al retirar o al recibir el pedido.`;
  }

  await bot.sendMessage(chatId, resumen, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });

  // Aviso al vendedor (si existe ChatIdVendedor)
  if (chatVendedor) {
    const vendedorMsg =
      `🛎️ *Nuevo pedido*\n\n` +
      `Cliente: *${safeStr(flow.name)}*\n` +
      `Tel: *${safeStr(flow.phone)}*\n` +
      `Entrega: *${entregaTxt}*\n` +
      (flow.deliveryType === "envio" ? `Dirección: *${safeStr(flow.address)}*\n` : "") +
      `Pago: *${safeStr(flow.payment)}*\n\n` +
      `🧾 *Detalle:*\n${detalle}\n` +
      `🧀 Total productos: *${moneyARS(totalProductos)}*\n` +
      `🚚 Envío: *${moneyARS(costoEnvio)}*\n` +
      `💰 *Total final: ${moneyARS(totalFinal)}*\n`;

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
// 9) HANDLERS (text)
// =====================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const textRaw = safeStr(msg.text);
  const text = textRaw.toLowerCase();
  const st = getState(chatId);

  // Input manual de cantidad
  if (st.awaitingQtyFor) {
    const code = st.awaitingQtyFor;
    const it = st.cart.get(code);
    st.awaitingQtyFor = null;

    if (!it) {
      await bot.sendMessage(chatId, "Ese producto ya no está en el carrito.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    const unit = normalizeUnit(it.prod.unidad);

    // si venía en modo gramos, convertimos a kg
    let n = Number(String(textRaw).replace(",", "."));
    if (!isFinite(n) || n <= 0) {
      await bot.sendMessage(chatId, "Cantidad inválida. Probá con un número.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    if (st.awaitingQtyMode === "grams") {
      n = n / 1000; // gramos -> kg
    }

    st.awaitingQtyMode = null;

    it.qty = roundQty(n, unit);
    st.cart.set(code, it);

    await bot.sendMessage(chatId, `✅ Cantidad actualizada: *${safeStr(it.prod.nombre)}* → *${it.qty}* ${unit === "kg" ? "kg" : "unidad"}`, {
      parse_mode: "Markdown",
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  // Checkout: pedir datos
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

  // Menú principal (reply keyboard)
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
    const cfg = await getConfig();
    await bot.sendMessage(chatId, "Compartí el bot con tus contactos 👇", {
      reply_markup: { inline_keyboard: shareInlineButtons(cfg).inline_keyboard },
    });
    return;
  }

  // Default
  await bot.sendMessage(chatId, "Elegí una opción del menú 👇", { reply_markup: mainMenuKeyboard() });
});

// =====================
// 10) HANDLERS (callbacks)
// =====================
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const data = safeStr(q.data);
  const st = getState(chatId);

  try {
    await bot.answerCallbackQuery(q.id);
  } catch {}

  // Categorías
  if (data === "OPEN:CATS") {
    await showCategories(chatId);
    return;
  }
  if (data === "CATS:PREV") {
    st.catIndex = Math.max(0, (st.catIndex || 0) - 1);
    await showCategories(chatId);
    return;
  }
  if (data === "CATS:NEXT") {
    st.catIndex = (st.catIndex || 0) + 1;
    await showCategories(chatId);
    return;
  }
  if (data.startsWith("CATI:")) {
    const idx = Number(data.slice("CATI:".length));
    const cat = st.catsList?.[idx] || "ALL";
    st.catFilter = cat;
    st.catIndex = 0;
    await showCatalogBook(chatId);
    return;
  }

  // Book nav
  if (data === "BOOK:PREV" || data === "BOOK:NEXT") {
    const full = await getCatalog();
    const list = filterCatalog(full, st.catFilter);
    if (!list.length) {
      await showCategories(chatId);
      return;
    }
    const max = list.length - 1;
    if (data === "BOOK:PREV") st.catIndex = Math.max(0, (st.catIndex || 0) - 1);
    if (data === "BOOK:NEXT") st.catIndex = Math.min(max, (st.catIndex || 0) + 1);
    await showCatalogBook(chatId);
    return;
  }

  // Quiero este (pregunta cantidad según unidad)
  if (data.startsWith("WANT:")) {
    const code = data.slice("WANT:".length);
    const catalog = await getCatalog();
    const prod = catalog.find((p) => getProdCode(p) === code);
    if (!prod) {
      await bot.sendMessage(chatId, "No encontré ese producto. Volvé a categorías 👇", { reply_markup: mainMenuKeyboard() });
      await showCategories(chatId);
      return;
    }
    await askQtyButtons(chatId, prod);
    return;
  }

  // Cantidad unidad
  if (data.startsWith("QU:")) {
    const parts = data.split(":"); // QU:code:value
    const code = parts[1];
    const val = parts[2];

    const catalog = await getCatalog();
    const prod = catalog.find((p) => getProdCode(p) === code);
    if (!prod) return;

    if (val === "OTHER") {
      const st2 = getState(chatId);
      st2.cart.set(code, { prod, qty: 1 });
      st2.awaitingQtyFor = code;
      st2.awaitingQtyMode = "unit";
      await bot.sendMessage(chatId, `Escribí la cantidad de unidades para *${safeStr(prod.nombre)}*.\nEj: 2`, {
        parse_mode: "Markdown",
        reply_markup: mainMenuKeyboard(),
      });
      return;
    }

    const qty = Number(val);
    await addToCartWithQty(chatId, prod, qty);
    return;
  }

  // Cantidad gramos (kg)
  if (data.startsWith("QG:")) {
    const parts = data.split(":"); // QG:code:value
    const code = parts[1];
    const val = parts[2];

    const catalog = await getCatalog();
    const prod = catalog.find((p) => getProdCode(p) === code);
    if (!prod) return;

    if (val === "OTHER") {
      const st2 = getState(chatId);
      st2.cart.set(code, { prod, qty: 0.1 });
      st2.awaitingQtyFor = code;
      st2.awaitingQtyMode = "grams";
      await bot.sendMessage(chatId, `Escribí los *gramos* para *${safeStr(prod.nombre)}*.\nEj: 350`, {
        parse_mode: "Markdown",
        reply_markup: mainMenuKeyboard(),
      });
      return;
    }

    const grams = Number(val);
    const kg = grams / 1000;
    await addToCartWithQty(chatId, prod, kg);
    return;
  }

  // Carrito
  if (data === "OPEN:CART") {
    await showCart(chatId);
    return;
  }

  if (data === "CART:EDIT") {
    const st2 = getState(chatId);
    if (!st2.cart.size) {
      await showCart(chatId);
      return;
    }

    // muestra una lista de items para cambiar
    const rows = [];
    for (const [code, item] of st2.cart.entries()) {
      const name = safeStr(item.prod.nombre).slice(0, 20);
      rows.push([{ text: `✍️ ${name}`, callback_data: `EDIT:${code}` }]);
    }
    rows.push([{ text: "🛒 Ver carrito", callback_data: "OPEN:CART" }]);
    rows.push([{ text: "📚 Categorías", callback_data: "OPEN:CATS" }]);

    await bot.sendMessage(chatId, "¿Qué producto querés editar?", {
      reply_markup: { inline_keyboard: rows },
    });
    return;
  }

  if (data.startsWith("EDIT:")) {
    const code = data.slice("EDIT:".length);
    const it = st.cart.get(code);
    if (!it) return;
    await askQtyButtons(chatId, it.prod);
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

  // fallback silencioso
});

// =====================
// 11) HTTP SERVER (Render)
// =====================
const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (u.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("EzerBot está corriendo ✅");
      return;
    }

    // Webhook endpoint
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
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Server error");
  }
});

server.listen(PORT, async () => {
  console.log(`HTTP escuchando en puerto ${PORT}`);

  // Set webhook
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

  // Warmup fetch
  try {
    const cfg = await getConfig();
    const cat = await getCatalog();
    console.log("✅ Warmup ok. Config keys:", Object.keys(cfg || {}).length, "Catalog items:", Array.isArray(cat) ? cat.length : 0);
  } catch (e) {
    console.log("❌ Warmup fetch error:", e?.message || e);
  }

  console.log("✅ EzerBot iniciado (WEBHOOK + Config/Catalogo desde Sheets)");
});



El mar, 23 dic 2025, 08:50, Jenny Ocampos <jennyocampos@gmail.com> escribió:
// index.js (ESM) — EzerBot Render Webhook + Config/Catalogo desde Google Sheets (Apps Script)
// Requisitos Render ENV: BOT_TOKEN, SHEETS_API_BASE, PUBLIC_URL
// PUBLIC_URL = https://ezerbot-system.onrender.com  (SIN / al final)
// SHEETS_API_BASE = https://script.google.com/macros/s/XXXX/exec

import TelegramBot from "node-telegram-bot-api";
import http from "http";
import { URL } from "url";

// =====================
// 1) ENV
// =====================
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const SHEETS_API_BASE = process.env.SHEETS_API_BASE || ""; // https://script.google.com/macros/s/.../exec
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, ""); // https://ezerbot-system.onrender.com
const PORT = Number(process.env.PORT || 10000);

// Webhook path fijo:
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
  cacheConfig = { at: now, data };
  return data;
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
// 4) STATE (RAM)
// =====================
const userState = new Map(); // chatId -> state

function getState(chatId) {
  if (!userState.has(chatId)) {
    userState.set(chatId, {
      catFilter: "ALL",
      bookIndex: 0,
      bookMsgId: null,
      bookHasPhoto: false,
      cart: new Map(), // code -> { prod, qty }
      awaitingQtyFor: null, // code
      flow: null, // checkout object
    });
  }
  return userState.get(chatId);
}

function moneyARS(n) {
  const v = Number(n || 0);
  try {
    return v.toLocaleString("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });
  } catch {
    return `$${Math.round(v)}`;
  }
}

function safeStr(v) {
  return String(v ?? "").trim();
}

function normalizeUnit(u) {
  const s = safeStr(u).toLowerCase();
  if (s.includes("kg") || s.includes("kilo")) return "kg";
  return "unidad";
}

function qtyStepForUnit(unit) {
  return unit === "kg" ? 0.1 : 1;
}

function roundQty(q, unit) {
  const n = Number(q || 0);
  if (!isFinite(n) || n <= 0) return 0;
  if (unit === "kg") return Math.round(n * 100) / 100;
  return Math.round(n);
}

function pickFirstNumber(v, fallback = 10) {
  const s = safeStr(v);
  if (!s) return fallback;
  const m = s.match(/(\d+(\.\d+)?)/);
  if (!m) return fallback;
  const n = Number(m[1]);
  return isFinite(n) && n > 0 ? n : fallback;
}

function parseMoneyNumber(v, fallback = 0) {
  const s = safeStr(v);
  if (!s) return fallback;
  // Acepta "2000", "$2.000", "2.000", "2000,50"
  const cleaned = s.replace(/\$/g, "").replace(/\./g, "").replace(",", ".");
  const n = Number(cleaned);
  return isFinite(n) ? n : fallback;
}

// =====================
// 5) UI builders
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

async function sendWelcome(chatId) {
  const cfg = await getConfig();

  const negocio = safeStr(cfg.NegocioNombre) || "Mi negocio";
  const dir = safeStr(cfg.Direccion) || "Dirección no configurada";
  const hor = safeStr(cfg.Horarios) || "Horarios no configurados";
  const tel = safeStr(cfg.TelefonoNegocio) || "Teléfono no configurado";
  const ig = safeStr(cfg.Instagram) || "";
  const logo = safeStr(cfg.LogoURL);

  const saludoConfig = safeStr(cfg.SaludoInicial) || safeStr(cfg.TextoSaludo) || "";
  const saludoDefault = `¡Hola! 👋 Bienvenid@ a *${negocio}* 🧀✨\nElegí del *Catálogo*, armá tu carrito y confirmá en 1 minuto. ¿Arrancamos? 😄`;

  let text = "";
  text += saludoConfig ? `${saludoConfig}\n\n` : `${saludoDefault}\n\n`;

  text += `🧀 *${negocio}*\n`;
  text += `📍 ${dir}\n`;
  text += `🕒 ${hor}\n`;
  text += `📞 ${tel}\n`;
  if (ig && ig.toUpperCase() !== "NO") text += `📸 Instagram: ${ig.startsWith("@") ? ig : "@" + ig}\n`;
  const desc = safeStr(cfg.Descripcion);
  if (desc) text += `\n${desc}\n`;
  text += `\nElegí una opción del menú para empezar 👇`;

  if (logo) {
    try {
      await bot.sendPhoto(chatId, logo, {
        caption: text,
        parse_mode: "Markdown",
        reply_markup: mainMenuKeyboard(),
      });
      return;
    } catch {}
  }

  await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
}

function shareInlineButtons(cfg = {}) {
  const botLink = safeStr(cfg.BotLink) || safeStr(cfg.LinkBot) || "https://t.me/EzerBot";
  const waText = encodeURIComponent(`Pedí por el bot 🧀👇\n${botLink}`);
  const mailSubj = encodeURIComponent("Te comparto el bot para pedir");
  const mailBody = encodeURIComponent(`Hola! Te comparto el bot para pedir:\n${botLink}`);

  return {
    inline_keyboard: [
      [{ text: "💬 WhatsApp", url: `https://wa.me/?text=${waText}` }],
      [{ text: "✈️ Telegram", url: `https://t.me/share/url?url=${encodeURIComponent(botLink)}&text=${encodeURIComponent("Pedí por el bot:")}` }],
      [{ text: "📧 Email", url: `mailto:?subject=${mailSubj}&body=${mailBody}` }],
    ],
  };
}

async function sendStampsCard(chatId) {
  const cfg = await getConfig();
  const usa = (safeStr(cfg.UsaSellos) || "NO").toUpperCase() === "SI";

  const cardUrl = safeStr(cfg.TarjetaURL) || safeStr(cfg.SelloURL);
  const premio =
    safeStr(cfg.PremioSellos) ||
    safeStr(cfg.BeneficioSellos) ||
    safeStr(cfg.BeneficioCumple) ||
    "Premio configurable";

  const meta = pickFirstNumber(cfg.SellosPorNivel, 10);

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
      await bot.sendPhoto(chatId, cardUrl, { caption: text, parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
      return;
    } catch {}
  }
  await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
}

// =====================
// 6) CATÁLOGO (tipo libro con imágenes)
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

function productCaption(p, idx, total, filterLabel) {
  const nombre = safeStr(p.nombre);
  const precio = Number(p.precio || 0);
  const unidad = normalizeUnit(p.unidad);
  const extra = unidad === "kg" ? " (x kg)" : "";
  const desc = safeStr(p.descripcion);

  let cap = `🛍️ *Catálogo*${filterLabel ? ` — _${filterLabel}_` : ""}\n`;
  cap += `📖 Producto *${idx + 1}* de *${total}*\n\n`;
  cap += `🧀 *${nombre}*\n`;
  cap += `💰 ${moneyARS(precio)}${extra}\n`;
  cap += `📦 Unidad: *${unidad === "kg" ? "Pesable (kg)" : "Por unidad"}*\n`;
  if (desc) cap += `\n📝 ${desc}\n`;
  return cap;
}

function bookButtons(code) {
  return {
    inline_keyboard: [
      [
        { text: "⬅️", callback_data: "BOOK:PREV" },
        { text: "➕ Quiero este", callback_data: `BOOK:ADD:${code}` },
        { text: "➡️", callback_data: "BOOK:NEXT" },
      ],
      [
        { text: "📤 Compartir", callback_data: `BOOK:SHARE:${code}` },
        { text: "🛒 Ver carrito", callback_data: "OPEN:CART" },
      ],
      [{ text: "🏷️ Categorías", callback_data: "BOOK:CATS" }],
    ].map((row) => row.filter(Boolean)),
  };
}

async function renderBook(chatId, forceNewMessage = false) {
  const st = getState(chatId);
  const full = await getCatalog();
  const list = filterCatalog(full, st.catFilter);

  if (!list.length) {
    await bot.sendMessage(chatId, "Por ahora no hay productos cargados en el catálogo.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (st.bookIndex < 0) st.bookIndex = 0;
  if (st.bookIndex >= list.length) st.bookIndex = list.length - 1;

  const p = list[st.bookIndex];
  const code = safeStr(p.codigo || p.id);
  const img = safeStr(p.imagen);
  const caption = productCaption(p, st.bookIndex, list.length, st.catFilter !== "ALL" ? st.catFilter : "");
  const markup = bookButtons(code);

  if (!img) {
    if (st.bookMsgId && !forceNewMessage) {
      try {
        await bot.editMessageText(caption, {
          chat_id: chatId,
          message_id: st.bookMsgId,
          parse_mode: "Markdown",
          reply_markup: markup,
        });
        st.bookHasPhoto = false;
        return;
      } catch {}
    }
    const sent = await bot.sendMessage(chatId, caption, { parse_mode: "Markdown", reply_markup: markup });
    st.bookMsgId = sent.message_id;
    st.bookHasPhoto = false;
    return;
  }

  if (st.bookMsgId && !forceNewMessage) {
    try {
      if (st.bookHasPhoto) {
        await bot.editMessageMedia(
          { type: "photo", media: img, caption, parse_mode: "Markdown" },
          { chat_id: chatId, message_id: st.bookMsgId, reply_markup: markup }
        );
        return;
      }
    } catch {}
  }

  const sent = await bot.sendPhoto(chatId, img, { caption, parse_mode: "Markdown", reply_markup: markup });
  st.bookMsgId = sent.message_id;
  st.bookHasPhoto = true;
}

async function sendCategoriesInline(chatId) {
  const st = getState(chatId);
  const full = await getCatalog();
  const cats = uniqueCategories(full);

  if (!cats.length) {
    await bot.sendMessage(chatId, "No hay categorías cargadas todavía.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  const rows = [];
  rows.push([{ text: "📚 Todas", callback_data: "CATF:ALL" }]);

  let row = [];
  for (const c of cats) {
    row.push({ text: c.slice(0, 14), callback_data: `CATF:${c}` });
    if (row.length === 3) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);

  rows.push([{ text: "⬅️ Volver al catálogo", callback_data: "OPEN:CAT" }]);

  await bot.sendMessage(chatId, "🏷️ Elegí una categoría:", {
    reply_markup: { inline_keyboard: rows },
  });
}

async function addToCart(chatId, code, askQty = true) {
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

  if (askQty) {
    if (!st.cart.has(code)) st.cart.set(code, { prod, qty: 0 });

    st.awaitingQtyFor = code;

    const unit = normalizeUnit(prod.unidad);
    if (unit === "kg") {
      await bot.sendMessage(
        chatId,
        `✅ Elegiste *${safeStr(prod.nombre)}*.\n\n🧀 Es *pesable*.\nEscribí cuánto querés (en kg o gramos).\nEjemplos:\n• 0.3 (300g)\n• 0.5 (500g)\n• 1 (1kg)`,
        { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() }
      );
    } else {
      await bot.sendMessage(
        chatId,
        `✅ Elegiste *${safeStr(prod.nombre)}*.\n\n📦 Es *por unidad*.\nEscribí cuántas unidades querés.\nEjemplos:\n• 1\n• 2\n• 3`,
        { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() }
      );
    }
    return;
  }

  const unit = normalizeUnit(prod.unidad);
  const step = qtyStepForUnit(unit);

  if (st.cart.has(code)) {
    const it = st.cart.get(code);
    it.qty = roundQty(Number(it.qty) + step, unit);
    st.cart.set(code, it);
  } else {
    st.cart.set(code, { prod, qty: step });
  }

  await bot.sendMessage(chatId, `✅ Agregado: *${safeStr(prod.nombre)}*`, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
}

// =====================
// 7) CARRITO
// =====================
function cartTotal(st) {
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

    text += `• *${safeStr(p.nombre)}*\n  Cant: *${qty}* ${unit} — Subtotal: *${moneyARS(lineTotal)}*\n\n`;

    rows.push([
      { text: "➖", callback_data: `QTY:DEC:${code}` },
      { text: "✍️ Cantidad", callback_data: `QTY:SET:${code}` },
      { text: "➕", callback_data: `QTY:INC:${code}` },
      { text: "🗑️", callback_data: `DEL:${code}` },
    ]);
  }

  text += `Total productos: *${moneyARS(cartTotal(st))}*`;

  const inline = {
    inline_keyboard: [
      ...rows,
      [{ text: "✅ Finalizar compra", callback_data: "OPEN:CHECKOUT" }],
      [{ text: "🛍️ Seguir comprando", callback_data: "OPEN:CAT" }],
    ],
  };

  await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: inline });
}

// =====================
// 8) CHECKOUT (flow)
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

  const negocio = safeStr(cfg.NegocioNombre) || "Todo Queso";
  const alias = safeStr(cfg.AliasPago) || "jennyocampos.mp";
  const waNegocio = safeStr(cfg.WhatsAppLink);
  const chatVendedor = Number(cfg.ChatIdVendedor || 0);

  // ✅ Costo envío desde Config (soporta CostoEnvio o EnvioCosto)
  const costoEnvio = parseMoneyNumber(cfg.CostoEnvio ?? cfg.EnvioCosto, 0);
  const aplicaEnvio = flow.deliveryType === "envio";
  const envioFinal = aplicaEnvio ? costoEnvio : 0;

  // detalle carrito
  let detalle = "";
  for (const { prod, qty } of st.cart.values()) {
    const unit = normalizeUnit(prod.unidad);
    const lt = Number(prod.precio || 0) * Number(qty || 0);
    detalle += `- ${safeStr(prod.nombre)} | ${qty} ${unit} | ${moneyARS(lt)}\n`;
  }

  const totalProductosNum = cartTotal(st);
  const totalFinalNum = totalProductosNum + envioFinal;

  const totalProductos = moneyARS(totalProductosNum);
  const totalFinal = moneyARS(totalFinalNum);
  const entregaTxt = aplicaEnvio ? "🚚 Envío a domicilio" : "🏪 Retiro por el local";

  let resumen =
    `✅ *Pedido confirmado (pendiente de pago/validación)*\n\n` +
    `*${negocio}*\n` +
    `Entrega: *${entregaTxt}*\n` +
    (aplicaEnvio ? `Dirección: *${safeStr(flow.address)}*\n` : "") +
    `Nombre: *${safeStr(flow.name)}*\n` +
    `Teléfono: *${safeStr(flow.phone)}*\n` +
    `Pago: *${safeStr(flow.payment)}*\n\n` +
    `🧾 *Detalle:*\n${detalle}\n` +
    `🧮 Total productos: *${totalProductos}*\n` +
    (aplicaEnvio ? `🚚 Envío: *${moneyARS(envioFinal)}*\n` : "") +
    `💰 *Total final: ${totalFinal}*\n`;

  if (flow.payment === "Transferencia") {
    resumen += `\n🏦 Alias para transferir: \`${alias}\`\n📌 Cuando transfieras, mandá el comprobante por acá.`;
  } else {
    resumen += `\n💵 Pagás en efectivo al retirar o al recibir el pedido.`;
  }

  await bot.sendMessage(chatId, resumen, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });

  // Aviso al vendedor
  if (chatVendedor) {
    const vendedorMsg =
      `🛎️ *Nuevo pedido*\n\n` +
      `Cliente: *${safeStr(flow.name)}*\n` +
      `Tel: *${safeStr(flow.phone)}*\n` +
      `Entrega: *${entregaTxt}*\n` +
      (aplicaEnvio ? `Dirección: *${safeStr(flow.address)}*\n` : "") +
      `Pago: *${safeStr(flow.payment)}*\n\n` +
      `🧾 *Detalle:*\n${detalle}\n` +
      `🧮 Total productos: *${totalProductos}*\n` +
      (aplicaEnvio ? `🚚 Envío: *${moneyARS(envioFinal)}*\n` : "") +
      `💰 *Total final: ${totalFinal}*\n`;

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
// 9) HANDLERS (text)
// =====================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const textRaw = safeStr(msg.text);
  const text = textRaw.toLowerCase();

  const st = getState(chatId);

  // esperando cantidad
  if (st.awaitingQtyFor) {
    const code = st.awaitingQtyFor;
    const it = st.cart.get(code);
    st.awaitingQtyFor = null;

    if (!it) {
      await bot.sendMessage(chatId, "Ese producto ya no está en el carrito.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    const unit = normalizeUnit(it.prod.unidad);

    const raw = safeStr(textRaw).toLowerCase().replace(",", ".");
    let n = Number(raw.replace(/[^0-9.]/g, ""));

    if (!isFinite(n) || n <= 0) {
      await bot.sendMessage(chatId, "Cantidad inválida. Probá con un número.\nEj: 2 (unidades) o 0.5 (kg) o 300g.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    if (unit === "kg") {
      if (raw.includes("g") && !raw.includes("kg")) n = n / 1000;
      else if (n >= 10) n = n / 1000;
    }

    it.qty = roundQty(n, unit);
    if (it.qty <= 0) {
      st.cart.delete(code);
      await bot.sendMessage(chatId, "🗑️ Cantidad en 0. Producto eliminado.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    st.cart.set(code, it);
    await bot.sendMessage(chatId, `✅ Agregado: *${safeStr(it.prod.nombre)}* → *${it.qty}* ${unit}`, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });

    const cfg = await getConfig();
    const suger = safeStr(cfg.TextoSugerenciaVendedor) || "💡 Tip: si querés, sumá algo más del catálogo y aprovechás el pedido 😉";
    await bot.sendMessage(chatId, suger, { reply_markup: mainMenuKeyboard() });
    return;
  }

  // checkout flow
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

  // start / saludos
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

  // menú
  if (textRaw === "🛍️ Catálogo") {
    st.bookIndex = 0;
    await renderBook(chatId, true);
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
    const cfg = await getConfig();
    await bot.sendMessage(chatId, "Compartí el bot con tus contactos 👇", { reply_markup: shareInlineButtons(cfg) });
    return;
  }

  await bot.sendMessage(chatId, "Elegí una opción del menú 👇", { reply_markup: mainMenuKeyboard() });
});

// =====================
// 10) HANDLERS (callbacks)
// =====================
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const data = safeStr(q.data);
  const st = getState(chatId);

  try { await bot.answerCallbackQuery(q.id); } catch {}

  if (data === "OPEN:CAT") { await renderBook(chatId, false); return; }

  if (data === "BOOK:CATS") { await sendCategoriesInline(chatId); return; }

  if (data.startsWith("CATF:")) {
    const f = data.slice("CATF:".length);
    st.catFilter = f === "ALL" ? "ALL" : f;
    st.bookIndex = 0;
    await renderBook(chatId, true);
    return;
  }

  if (data === "BOOK:PREV") { st.bookIndex = Math.max(0, st.bookIndex - 1); await renderBook(chatId, false); return; }
  if (data === "BOOK:NEXT") { st.bookIndex = st.bookIndex + 1; await renderBook(chatId, false); return; }

  if (data.startsWith("BOOK:ADD:")) {
    const code = data.slice("BOOK:ADD:".length);
    await addToCart(chatId, code, true);
    return;
  }

  if (data.startsWith("BOOK:SHARE:")) {
    const cfg = await getConfig();
    await bot.sendMessage(chatId, "📤 Compartilo por donde quieras 👇", { reply_markup: shareInlineButtons(cfg) });
    return;
  }

  if (data === "OPEN:CART") { await showCart(chatId); return; }

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
    const example = unit === "kg" ? "0.5 o 300g" : "2";
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
    const step = qtyStepForUnit(unit);
    const next = inc ? Number(it.qty) + step : Number(it.qty) - step;
    const qty = roundQty(next, unit);

    if (qty <= 0) st.cart.delete(code);
    else { it.qty = qty; st.cart.set(code, it); }

    await showCart(chatId);
    return;
  }

  if (data === "OPEN:CHECKOUT") { startCheckout(chatId); return; }

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
// 11) HTTP SERVER (Render)
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

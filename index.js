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
const userState = new Map(); // chatId -> { mode, catPage, catFilter, cart: Map(code-> {prod, qty}), checkout... }

function getState(chatId) {
  if (!userState.has(chatId)) {
    userState.set(chatId, {
      catPage: 0,
      catFilter: "ALL",
      cart: new Map(),
      awaitingQtyFor: null, // codigo
      flow: null, // checkout
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
  if (s.includes("kg")) return "kg";
  return "unidad";
}

function qtyStepForUnit(unit) {
  return unit === "kg" ? 0.1 : 1;
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

async function sendWelcome(chatId) {
  const cfg = await getConfig();

  const negocio = safeStr(cfg.NegocioNombre) || "Mi negocio";
  const dir = safeStr(cfg.Direccion) || "Dirección no configurada";
  const hor = safeStr(cfg.Horarios) || "Horarios no configurados";
  const tel = safeStr(cfg.TelefonoNegocio) || "Teléfono no configurado";
  const ig = safeStr(cfg.Instagram) || "";
  const logo = safeStr(cfg.LogoURL);

  let text = `🧀 *${negocio}*\n`;
  text += `📍 ${dir}\n`;
  text += `🕒 ${hor}\n`;
  text += `📞 ${tel}\n`;
  if (ig && ig.toUpperCase() !== "NO") text += `📸 Instagram: ${ig.startsWith("@") ? ig : "@" + ig}\n`;
  const desc = safeStr(cfg.Descripcion);
  if (desc) text += `\n${desc}\n`;
  text += `\nElegí una opción del menú para empezar 👇`;

  if (logo) {
    // Intentar con foto + caption; si falla, manda texto
    try {
      await bot.sendPhoto(chatId, logo, {
        caption: text,
        parse_mode: "Markdown",
        reply_markup: mainMenuKeyboard(),
      });
      return;
    } catch {
      // sigue abajo
    }
  }

  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: mainMenuKeyboard(),
  });
}

function shareInlineButtons() {
  const botLink = "https://t.me/EzerBot";
  const waText = encodeURIComponent(`Pedí por el bot de Todo Queso Club 🧀👇\n${botLink}`);
  const mailSubj = encodeURIComponent("Pedido por bot - Todo Queso Club");
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
  const cardUrl = safeStr(cfg.TarjetaURL);
  const premio = safeStr(cfg.SelloURL) || safeStr(cfg.BeneficioCumple) || "Premio configurable";
  const meta = Number(cfg.SellosPorNivel || 10);

  if (!usa) {
    await bot.sendMessage(chatId, "Por ahora la tarjeta de sellos está desactivada.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  const sellos = 0; // (si después lo conectás a Sheets por cliente, acá se reemplaza)
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
    } catch {
      // fallback
    }
  }
  await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
}

// =====================
// 6) CATÁLOGO (tipo libro)
// =====================
const PAGE_SIZE = 6;

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

function productLine(p) {
  const nombre = safeStr(p.nombre);
  const precio = Number(p.precio || 0);
  const unidad = normalizeUnit(p.unidad);
  const extra = unidad === "kg" ? " (x kg)" : "";
  return `• *${nombre}* — ${moneyARS(precio)}${extra}`;
}

async function showCatalogPage(chatId, page = 0, filter = null) {
  const st = getState(chatId);
  if (filter !== null) st.catFilter = filter;
  st.catPage = Math.max(0, page);

  const full = await getCatalog();
  const cats = uniqueCategories(full);
  const list = filterCatalog(full, st.catFilter);

  if (!list.length) {
    await bot.sendMessage(
      chatId,
      "Por ahora no hay productos cargados en el catálogo. (Pero tu endpoint sí tiene datos: esto pasa si el bot no puede leerlos. Avisame si vuelve a ocurrir).",
      { reply_markup: mainMenuKeyboard() }
    );
    return;
  }

  const totalPages = Math.ceil(list.length / PAGE_SIZE);
  if (st.catPage >= totalPages) st.catPage = totalPages - 1;

  const start = st.catPage * PAGE_SIZE;
  const pageItems = list.slice(start, start + PAGE_SIZE);

  let title = `🛍️ *Catálogo*`;
  if (st.catFilter !== "ALL") title += ` — _${st.catFilter}_`;
  title += `\nPágina *${st.catPage + 1}* de *${totalPages}*\n\n`;

  let text = title + pageItems.map(productLine).join("\n");

  // Botones de agregar por producto
  const addButtons = pageItems.map((p) => {
    const code = safeStr(p.codigo || p.id);
    const name = safeStr(p.nombre).slice(0, 26);
    return [{ text: `➕ ${name}`, callback_data: `ADD:${code}` }];
  });

  // Navegación
  const navRow = [];
  if (st.catPage > 0) navRow.push({ text: "⬅️ Atrás", callback_data: "CAT:PREV" });
  if (st.catPage < totalPages - 1) navRow.push({ text: "Siguiente ➡️", callback_data: "CAT:NEXT" });

  // Filtros categorías (máx 2 filas)
  const catButtons = [];
  const catRow1 = [{ text: "📚 Todas", callback_data: "CATF:ALL" }];
  const sample = cats.slice(0, 5);
  for (const c of sample) catRow1.push({ text: c.slice(0, 10), callback_data: `CATF:${c}` });
  catButtons.push(catRow1);

  const inline = {
    inline_keyboard: [
      ...catButtons.map((row) => row.map((b) => b)),
      ...addButtons,
      navRow.length ? navRow : [],
      [{ text: "🛒 Ver carrito", callback_data: "OPEN:CART" }],
    ].filter((r) => r.length),
  };

  await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: inline });
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

    text += `• *${safeStr(p.nombre)}*\n  Cant: *${qty}* ${unit}${unit === "kg" ? "" : ""} — Subtotal: *${moneyARS(lineTotal)}*\n\n`;

    rows.push([
      { text: "➖", callback_data: `QTY:DEC:${code}` },
      { text: "✍️ Cantidad", callback_data: `QTY:SET:${code}` },
      { text: "➕", callback_data: `QTY:INC:${code}` },
      { text: "🗑️", callback_data: `DEL:${code}` },
    ]);
  }

  text += `Total: *${moneyARS(cartTotal(st))}*`;

  const inline = {
    inline_keyboard: [
      ...rows,
      [{ text: "✅ Finalizar compra", callback_data: "OPEN:CHECKOUT" }],
      [{ text: "🛍️ Seguir comprando", callback_data: "OPEN:CAT" }],
    ],
  };

  await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: inline });
}

async function addToCart(chatId, code) {
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
  const waNegocio = safeStr(cfg.WhatsAppLink); // ya viene armado en Config
  const chatVendedor = Number(cfg.ChatIdVendedor || 0);

  // Armado del detalle carrito
  let detalle = "";
  for (const { prod, qty } of st.cart.values()) {
    const unit = normalizeUnit(prod.unidad);
    const lt = Number(prod.precio || 0) * Number(qty || 0);
    detalle += `- ${safeStr(prod.nombre)} | ${qty} ${unit} | ${moneyARS(lt)}\n`;
  }

  const total = moneyARS(cartTotal(st));
  const entregaTxt = flow.deliveryType === "envio" ? "🚚 Envío a domicilio" : "🏪 Retiro por el local";

  let resumen =
    `✅ *Pedido confirmado (pendiente de pago/validación)*\n\n` +
    `*${negocio}*\n` +
    `Entrega: *${entregaTxt}*\n` +
    (flow.deliveryType === "envio" ? `Dirección: *${safeStr(flow.address)}*\n` : "") +
    `Nombre: *${safeStr(flow.name)}*\n` +
    `Teléfono: *${safeStr(flow.phone)}*\n` +
    `Pago: *${safeStr(flow.payment)}*\n\n` +
    `🧾 *Detalle:*\n${detalle}\n` +
    `💰 *Total: ${total}*\n`;

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
      `💰 *Total: ${total}*\n`;

    try {
      await bot.sendMessage(chatVendedor, vendedorMsg, { parse_mode: "Markdown" });
    } catch (e) {
      console.log("No pude avisar al vendedor:", e?.message || e);
    }
  }

  // WhatsApp negocio (si querés link directo al negocio)
  if (waNegocio && waNegocio.toUpperCase() !== "NO") {
    await bot.sendMessage(chatId, `📲 Si querés, también podés escribirnos por WhatsApp: ${waNegocio}`, { reply_markup: mainMenuKeyboard() });
  }

  // limpiar flow (no borro carrito automáticamente; si querés lo cambio)
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

  // Si está esperando cantidad manual:
  if (st.awaitingQtyFor) {
    const code = st.awaitingQtyFor;
    const it = st.cart.get(code);
    st.awaitingQtyFor = null;

    if (!it) {
      await bot.sendMessage(chatId, "Ese producto ya no está en el carrito.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    const unit = normalizeUnit(it.prod.unidad);
    const n = Number(String(textRaw).replace(",", "."));

    if (!isFinite(n) || n <= 0) {
      await bot.sendMessage(chatId, "Cantidad inválida. Probá con un número, por ejemplo: 2 (unidades) o 0.5 (kg).", { reply_markup: mainMenuKeyboard() });
      return;
    }

    it.qty = roundQty(n, unit);
    st.cart.set(code, it);
    await bot.sendMessage(chatId, `✅ Cantidad actualizada: *${safeStr(it.prod.nombre)}* → *${it.qty}* ${unit}`, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
    return;
  }

  // Si está en checkout pidiendo datos:
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
  if (text === "/start" || text === "hola" || text === "buenas" || text === "buen día" || text === "buen dia" || text === "buenas tardes" || text === "buenas noches") {
    await sendWelcome(chatId);
    return;
  }

  // Menú principal (reply keyboard)
  if (textRaw === "🛍️ Catálogo") {
    await showCatalogPage(chatId, 0, getState(chatId).catFilter || "ALL");
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
    await bot.sendMessage(chatId, "Compartí el bot con tus contactos 👇", { reply_markup: { inline_keyboard: shareInlineButtons().inline_keyboard } });
    return;
  }

  // Default: re-mostrar menú
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

  // Catálogo
  if (data === "OPEN:CAT") {
    await showCatalogPage(chatId, st.catPage, st.catFilter);
    return;
  }
  if (data === "CAT:PREV") {
    await showCatalogPage(chatId, Math.max(0, st.catPage - 1), st.catFilter);
    return;
  }
  if (data === "CAT:NEXT") {
    await showCatalogPage(chatId, st.catPage + 1, st.catFilter);
    return;
  }
  if (data.startsWith("CATF:")) {
    const f = data.slice("CATF:".length);
    await showCatalogPage(chatId, 0, f === "ALL" ? "ALL" : f);
    return;
  }
  if (data.startsWith("ADD:")) {
    const code = data.slice("ADD:".length);
    await addToCart(chatId, code);
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
    const example = unit === "kg" ? "0.5" : "2";
    await bot.sendMessage(chatId, `Escribí la cantidad para *${safeStr(it.prod.nombre)}*.\nEjemplo: ${example}`, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
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

    // Debug endpoints (opcional)
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

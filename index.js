/**
 * EzerBot System — index.js (UN SOLO ARCHIVO)
 * Telegram Bot + Webhook (Render) o Polling (local)
 * Lee TODO desde CONFIG_URL (Apps Script Web App que devuelve JSON)
 *
 * ENV (Render):
 * - BOT_TOKEN
 * - CONFIG_URL
 * - PUBLIC_URL (ej https://tuapp.onrender.com) -> habilita webhook
 * - ADMIN_CHAT_ID (opcional: chatId del vendedor/admin)
 * - PORT (Render lo define)
 */

import TelegramBot from "node-telegram-bot-api";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// -------------------- ENV --------------------
const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const CONFIG_URL = (process.env.CONFIG_URL || "").trim();
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim();
const ADMIN_CHAT_ID = (process.env.ADMIN_CHAT_ID || "").trim();
const PORT = Number(process.env.PORT || 10000);

if (!BOT_TOKEN) {
  console.error("Falta BOT_TOKEN en variables de entorno.");
  process.exit(1);
}
if (!CONFIG_URL) {
  console.error("Falta CONFIG_URL en variables de entorno.");
  process.exit(1);
}

// -------------------- PERSISTENCIA SIMPLE --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_PATH = path.join(__dirname, "data.json");

function loadData() {
  try {
    if (!fs.existsSync(DATA_PATH)) return { users: {}, tickets: {} };
    const raw = fs.readFileSync(DATA_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.users) parsed.users = {};
    if (!parsed.tickets) parsed.tickets = {};
    return parsed;
  } catch {
    return { users: {}, tickets: {} };
  }
}
function saveData(data) {
  try {
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error("No pude guardar data.json:", e?.message || e);
  }
}
const DB = loadData();

// -------------------- HELPERS --------------------
const money = (n) => Number(n || 0).toLocaleString("es-AR", { maximumFractionDigits: 0 });
const safeText = (s, max = 3900) => {
  const t = String(s ?? "");
  return t.length > max ? t.slice(0, max - 3) + "..." : t;
};
const nowAR = () => {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return { d, yyyy, mm, dd, hh, mi };
};
const rand4 = () => Math.floor(1000 + Math.random() * 9000);

function isKg(p) {
  return String(p?.unidad || "").toLowerCase().trim() === "kg";
}

function getUser(db, userId) {
  const key = String(userId);
  if (!db.users[key]) {
    db.users[key] = {
      cart: [], // [{codigo, tipo:"unidad", qtyUnidad}] OR [{codigo, tipo:"kg", gramos}]
      profile: { nombre: "", telefono: "" },
      checkout: { paso: "", envioTipo: "", direccion: "", pago: "", horario: "" },
      pending: { mode: "", codigo: "" }, // "kg" | "unidad"
      lastOrder: { ticket: "" },
      lastSeen: Date.now(),
    };
    saveData(db);
  }
  db.users[key].lastSeen = Date.now();
  return db.users[key];
}

function addToCartUnidad(user, codigo, qty = 1) {
  const q = Math.max(1, Number(qty || 1));
  const it = user.cart.find((x) => x.codigo === codigo && x.tipo === "unidad");
  if (it) it.qtyUnidad += q;
  else user.cart.push({ codigo, tipo: "unidad", qtyUnidad: q });
}

function addToCartGramos(user, codigo, gramos) {
  const g = Math.max(1, Number(gramos || 0));
  const it = user.cart.find((x) => x.codigo === codigo && x.tipo === "kg");
  if (it) it.gramos += g;
  else user.cart.push({ codigo, tipo: "kg", gramos: g });
}

function removeFromCartItem(user, idx) {
  if (idx < 0 || idx >= user.cart.length) return;
  user.cart.splice(idx, 1);
}

function clearCart(user) {
  user.cart = [];
}

function generateTicket(prefix = "TQ") {
  const { yyyy, mm, dd, hh, mi } = nowAR();
  return `${prefix}-${yyyy}${mm}${dd}-${hh}${mi}-${rand4()}`;
}

// -------------------- CONFIG CACHE --------------------
let CONFIG_CACHE = null;
let CONFIG_CACHE_AT = 0;
const CONFIG_TTL_MS = 20_000;

async function fetchConfig() {
  const now = Date.now();
  if (CONFIG_CACHE && now - CONFIG_CACHE_AT < CONFIG_TTL_MS) return CONFIG_CACHE;

  const res = await fetch(CONFIG_URL, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`No pude leer config (HTTP ${res.status})`);
  const json = await res.json();

  if (!json.negocio) json.negocio = {};
  if (!Array.isArray(json.catalogo)) json.catalogo = [];
  if (!json.ui) json.ui = {};
  if (!Array.isArray(json.promos)) json.promos = [];
  if (!json.envios) json.envios = { activo: false };
  if (!json.pagos) json.pagos = { metodos: [] };
  if (!json.textos) json.textos = {};

  // default: 3 por pagina
  if (!Number.isFinite(Number(json.ui.itemsPorPagina))) json.ui.itemsPorPagina = 3;

  CONFIG_CACHE = json;
  CONFIG_CACHE_AT = now;
  return json;
}

function findProduct(config, codigo) {
  return (config.catalogo || []).find((p) => String(p.codigo) === String(codigo));
}

function getCatalogByCategory(config) {
  const map = new Map();
  for (const p of config.catalogo || []) {
    const cat = (p.categoria || "Otros").trim() || "Otros";
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat).push(p);
  }
  for (const [k, arr] of map.entries()) {
    arr.sort((a, b) => String(a.nombre || "").localeCompare(String(b.nombre || ""), "es"));
    map.set(k, arr);
  }
  return map;
}

function calcCartTotals(config, user) {
  let subtotal = 0;
  const lines = [];

  for (let i = 0; i < user.cart.length; i++) {
    const it = user.cart[i];
    const p = findProduct(config, it.codigo);
    if (!p) continue;

    if (it.tipo === "kg" || isKg(p)) {
      const priceKg = Number(p.precioPorKilo || p.precio || 0);
      const gramos = Number(it.gramos || 0);
      const line = (gramos / 1000) * priceKg;
      subtotal += line;
      lines.push({ idx: i, p, tipo: "kg", gramos, line, priceKg });
    } else {
      const price = Number(p.precio || 0);
      const qty = Number(it.qtyUnidad || 1);
      const line = qty * price;
      subtotal += line;
      lines.push({ idx: i, p, tipo: "unidad", qty, line, price });
    }
  }

  return { subtotal, lines };
}

function calcShipping(config, subtotal, checkout) {
  const env = config.envios || { activo: false };
  if (!env.activo) return { costo: 0, label: "Retiro" };

  if (checkout.envioTipo === "retiro") return { costo: 0, label: "Retiro" };

  const gratisDesde = Number(env.gratisDesde || 0);
  if (gratisDesde > 0 && subtotal >= gratisDesde) return { costo: 0, label: `Envío gratis desde $${money(gratisDesde)}` };

  // zonas opcional
  const zonas = Array.isArray(env.zonas) ? env.zonas : [];
  if (checkout.zona && zonas.length) {
    const z = zonas.find((x) => String(x.nombre) === String(checkout.zona));
    if (z) return { costo: Number(z.costo || 0), label: `Envío (${z.nombre})` };
  }

  const costoFijo = Number(env.costo || 0);
  return { costo: costoFijo, label: "Envío a domicilio" };
}

// -------------------- SHARE --------------------
function buildShareLinks(botUsername, negocioNombre, text) {
  const base = `https://t.me/${botUsername}`;
  const msg = encodeURIComponent(`🧀 ${negocioNombre}\n${text}\n\nAbrí el bot acá: ${base}`);
  return {
    wa: `https://wa.me/?text=${msg}`,
    tg: `https://t.me/share/url?url=${encodeURIComponent(base)}&text=${msg}`,
    mail: `mailto:?subject=${encodeURIComponent(`Pedido / Consulta — ${negocioNombre}`)}&body=${msg}`,
  };
}

// -------------------- BOT SETUP --------------------
const bot = new TelegramBot(BOT_TOKEN, { polling: !PUBLIC_URL });

async function ensureWebhook() {
  if (!PUBLIC_URL) return;
  const hookPath = `/telegram/${BOT_TOKEN}`;
  const hookUrl = `${PUBLIC_URL.replace(/\/$/, "")}${hookPath}`;
  await bot.setWebHook(hookUrl);
  console.log("Webhook:", hookUrl);
}

// -------------------- UI --------------------
function mainMenuKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🛍️ Catálogo" }, { text: "🔥 Promos" }],
        [{ text: "🛒 Mi carrito" }, { text: "✅ Finalizar compra" }],
        [{ text: "📍 Horarios y dirección" }, { text: "📣 Compartir bot" }],
      ],
      resize_keyboard: true,
    },
  };
}

function inlineCategoriesKeyboard(categories) {
  const rows = categories.map((cat) => [{ text: cat, callback_data: `cat:${cat}` }]);
  rows.push([{ text: "🏠 Menú", callback_data: "menu:main" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function inlineNavKeyboard(cat, page, totalPages) {
  const nav = [];
  if (page > 1) nav.push({ text: "⬅️ Anterior", callback_data: `page:${cat}:${page - 1}` });
  nav.push({ text: `📄 ${page}/${totalPages}`, callback_data: "noop" });
  if (page < totalPages) nav.push({ text: "Siguiente ➡️", callback_data: `page:${cat}:${page + 1}` });

  return {
    reply_markup: {
      inline_keyboard: [
        nav,
        [{ text: "⬅️ Categorías", callback_data: "cats:list" }],
        [{ text: "🛒 Carrito", callback_data: "cart:view" }],
        [{ text: "🏠 Menú", callback_data: "menu:main" }],
      ],
    },
  };
}

function inlineProductActionsKeyboard(codigo) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🟢 Quiero éste", callback_data: `want:${codigo}` }],
        [{ text: "📣 Compartir", callback_data: `sharep:${codigo}` }],
        [
          { text: "🛒 Carrito", callback_data: "cart:view" },
          { text: "🏠 Menú", callback_data: "menu:main" },
        ],
      ],
    },
  };
}

function inlineCartKeyboard(lines) {
  const rows = [];
  for (const it of lines) {
    rows.push([
      { text: "❌ Quitar", callback_data: `rmline:${it.idx}` },
      { text: "➕ Agregar", callback_data: `plus:${it.p.codigo}` },
    ]);
  }
  rows.push([{ text: "🧹 Vaciar carrito", callback_data: "cart:clear" }]);
  rows.push([{ text: "✅ Finalizar compra", callback_data: "checkout:start" }]);
  rows.push([{ text: "⬅️ Categorías", callback_data: "cats:list" }]);
  rows.push([{ text: "🏠 Menú", callback_data: "menu:main" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function inlineCheckoutDeliveryKeyboard(config) {
  const rows = [];
  rows.push([{ text: "🏪 Retiro en el local", callback_data: "ship:retiro" }]);
  if (config.envios?.activo) rows.push([{ text: "🚚 Envío a domicilio", callback_data: "ship:envio" }]);
  rows.push([{ text: "❌ Cancelar", callback_data: "checkout:cancel" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function inlinePaymentKeyboard(config) {
  const methods = Array.isArray(config.pagos?.metodos) ? config.pagos.metodos : [];
  const rows = methods.map((m) => [
    { text: m.label || m.nombre || m.id || "Pago", callback_data: `pay:${m.id || m.label}` },
  ]);
  rows.push([{ text: "❌ Cancelar", callback_data: "checkout:cancel" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function inlineConfirmOrderKeyboard(ticket) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Confirmar pedido", callback_data: `order:confirm:${ticket}` }],
        [{ text: "❌ Cancelar", callback_data: "checkout:cancel" }],
      ],
    },
  };
}

function inlineAdminOrderKeyboard(buyerChatId, ticket) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Pago recibido", callback_data: `admin:paid:${buyerChatId}:${ticket}` }],
        [{ text: "📦 Pedido en preparación", callback_data: `admin:prep:${buyerChatId}:${ticket}` }],
      ],
    },
  };
}

function inlineShareKeyboard(links) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📲 WhatsApp", url: links.wa }],
        [{ text: "📨 Telegram", url: links.tg }],
        [{ text: "✉️ Email", url: links.mail }],
      ],
    },
  };
}

// -------------------- MENSAJES --------------------
async function sendWelcome(chatId, config) {
  const negocio = config.negocio || {};
  const txt =
    config.textos?.bienvenida ||
    `👋 *¡Hola! Soy el bot de ${negocio.nombre || "Todo Queso"}*\n\n` +
      `🛍️ Elegís productos por categorías, armás tu carrito y confirmás el pedido.\n` +
      `🚚 Podés pedir *envío* o *retiro*.\n\n` +
      `👇 Tocá *Catálogo* para empezar.`;

  if (negocio.logo) {
    try {
      await bot.sendPhoto(chatId, negocio.logo, { caption: safeText(txt, 900), parse_mode: "Markdown" });
      await bot.sendMessage(chatId, "👇 Elegí una opción:", { ...mainMenuKeyboard() });
      return;
    } catch {}
  }
  await bot.sendMessage(chatId, safeText(txt), { parse_mode: "Markdown", ...mainMenuKeyboard() });
}

async function showBusinessInfo(chatId, config) {
  const n = config.negocio || {};
  const lines = [];
  lines.push(`🏪 *${n.nombre || "Negocio"}*`);
  if (n.direccion) lines.push(`📍 ${n.direccion}`);
  if (n.horarios) lines.push(`🕒 ${n.horarios}`);
  if (n.telefono) lines.push(`📞 ${n.telefono}`);
  if (n.instagram) lines.push(`📸 ${n.instagram}`);
  await bot.sendMessage(chatId, lines.join("\n"), { parse_mode: "Markdown", ...mainMenuKeyboard() });
}

async function showCategories(chatId, config) {
  const map = getCatalogByCategory(config);
  const cats = Array.from(map.keys());
  if (!cats.length) {
    await bot.sendMessage(chatId, "⏳ Todavía no hay productos cargados en el catálogo.", { ...mainMenuKeyboard() });
    return;
  }
  await bot.sendMessage(chatId, "🛍️ Elegí una categoría:", inlineCategoriesKeyboard(cats));
}

// estado de navegación por chat
const LAST_VIEW = new Map(); // chatId -> {cat,page}

async function sendProductCard(chatId, config, p) {
  const unidad = String(p.unidad || "unidad").toLowerCase();
  const priceLine =
    unidad === "kg"
      ? `💰 $${money(p.precioPorKilo || p.precio || 0)} / kg`
      : `💰 $${money(p.precio || 0)} c/u`;

  const desc = p.descripcion ? `\n📝 ${p.descripcion}` : "";
  const txt = `*${p.nombre}*\n${priceLine}${desc}`;

  if (p.imagen) {
    try {
      await bot.sendPhoto(chatId, p.imagen, {
        caption: safeText(txt, 950),
        parse_mode: "Markdown",
        ...inlineProductActionsKeyboard(p.codigo),
      });
      return;
    } catch {}
  }
  await bot.sendMessage(chatId, txt, { parse_mode: "Markdown", ...inlineProductActionsKeyboard(p.codigo) });
}

async function showCatalogPage(chatId, config, cat, page = 1) {
  const map = getCatalogByCategory(config);
  const items = map.get(cat) || [];
  if (!items.length) {
    await bot.sendMessage(chatId, `No hay productos en *${cat}* por ahora.`, { parse_mode: "Markdown" });
    return;
  }

  const perPage = Math.max(1, Number(config.ui?.itemsPorPagina || 3));
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const p = Math.min(Math.max(1, Number(page || 1)), totalPages);

  LAST_VIEW.set(chatId, { cat, page: p });

  const slice = items.slice((p - 1) * perPage, (p - 1) * perPage + perPage);

  await bot.sendMessage(chatId, `🛍️ *${cat}* — página *${p}/${totalPages}*`, { parse_mode: "Markdown" });

  // ✅ 3 productos por página, cada uno con imagen + botones
  for (const pr of slice) {
    await sendProductCard(chatId, config, pr);
  }

  // navegación
  await bot.sendMessage(chatId, "Navegación:", inlineNavKeyboard(cat, p, totalPages));
}

async function showPromos(chatId, config) {
  // Si config.promos trae códigos los usamos; sino categoría Promos
  let promoItems = [];
  if (Array.isArray(config.promos) && config.promos.length) {
    for (const pr of config.promos) {
      const code = pr.codigo || pr;
      const p = findProduct(config, code);
      if (p) promoItems.push(p);
    }
  } else {
    const map = getCatalogByCategory(config);
    promoItems = map.get("Promos") || map.get("PROMOS") || [];
  }

  if (!promoItems.length) {
    await bot.sendMessage(chatId, "🔥 Todavía no hay promos cargadas.", { ...mainMenuKeyboard() });
    return;
  }

  // promos paginadas también (3)
  const perPage = Math.max(1, Number(config.ui?.itemsPorPagina || 3));
  const totalPages = Math.max(1, Math.ceil(promoItems.length / perPage));
  const p = 1;
  const slice = promoItems.slice(0, perPage);

  LAST_VIEW.set(chatId, { cat: "Promos", page: p });

  await bot.sendMessage(chatId, `🔥 *Promos* — página *${p}/${totalPages}*`, { parse_mode: "Markdown" });
  for (const pr of slice) {
    await sendProductCard(chatId, config, pr);
  }
  await bot.sendMessage(chatId, "Navegación:", inlineNavKeyboard("Promos", p, totalPages));
}

async function showCart(chatId, config, user) {
  const { subtotal, lines } = calcCartTotals(config, user);
  if (!lines.length) {
    await bot.sendMessage(chatId, "🛒 Tu carrito está vacío. Tocá *Catálogo* para elegir productos.", {
      parse_mode: "Markdown",
      ...mainMenuKeyboard(),
    });
    return;
  }

  const msg = [];
  msg.push("🛒 *Tu carrito*");
  msg.push("");
  for (const it of lines) {
    if (it.tipo === "kg") msg.push(`• ${it.gramos}g × ${it.p.nombre} — $${money(it.line)}`);
    else msg.push(`• ${it.qty} × ${it.p.nombre} — $${money(it.line)}`);
  }
  msg.push("");
  msg.push(`Subtotal: *$${money(subtotal)}*`);

  await bot.sendMessage(chatId, msg.join("\n"), { parse_mode: "Markdown", ...inlineCartKeyboard(lines) });
}

// -------------------- CHECKOUT --------------------
async function startCheckout(chatId, config, user) {
  const { lines } = calcCartTotals(config, user);
  if (!lines.length) {
    await bot.sendMessage(chatId, "Tu carrito está vacío. Primero agregá algo 🙂", { ...mainMenuKeyboard() });
    return;
  }
  user.checkout = { paso: "envio_tipo", envioTipo: "", direccion: "", pago: "", horario: "" };
  saveData(DB);

  await bot.sendMessage(chatId, "✅ *Finalizar compra*\nElegí cómo querés recibir tu pedido:", {
    parse_mode: "Markdown",
    ...inlineCheckoutDeliveryKeyboard(config),
  });
}

async function askName(chatId) {
  await bot.sendMessage(chatId, "🧾 Decime tu *nombre* para el pedido.", { parse_mode: "Markdown" });
}
async function askPhone(chatId) {
  await bot.sendMessage(chatId, "📞 Pasame tu *teléfono*.", { parse_mode: "Markdown" });
}
async function askAddress(chatId) {
  await bot.sendMessage(chatId, "📍 Pasame tu *dirección completa* (calle + número + referencia).", { parse_mode: "Markdown" });
}
async function askTime(chatId, envioTipo) {
  const txt =
    envioTipo === "envio"
      ? "🕒 ¿En qué *horario* te conviene recibir el envío? (Ej: 18:00 a 20:00)"
      : "🕒 ¿En qué *horario* te conviene pasar a retirar? (Ej: 19:00)";
  await bot.sendMessage(chatId, txt, { parse_mode: "Markdown" });
}

async function askPayment(chatId, config) {
  const methods = Array.isArray(config.pagos?.metodos) ? config.pagos.metodos : [];
  if (!methods.length) {
    await bot.sendMessage(chatId, "💳 No hay métodos de pago configurados todavía.", { ...mainMenuKeyboard() });
    return;
  }
  await bot.sendMessage(chatId, "💳 Elegí método de pago:", inlinePaymentKeyboard(config));
}

function buildPOSTicket(config, user, chatId, username, ticket) {
  const negocio = config.negocio || {};
  const { subtotal, lines } = calcCartTotals(config, user);
  const ship = calcShipping(config, subtotal, user.checkout);
  const total = subtotal + Number(ship.costo || 0);
  const { yyyy, mm, dd, hh, mi } = nowAR();

  const parts = [];
  parts.push(`🧾 *TICKET ${ticket}*`);
  parts.push(`🏪 ${negocio.nombre || "Negocio"}`);
  parts.push(`📅 ${dd}/${mm}/${yyyy}  🕒 ${hh}:${mi}`);
  parts.push("");
  parts.push(`👤 ${user.profile?.nombre || (username ? `@${username}` : "-")}`);
  if (user.profile?.telefono) parts.push(`📞 ${user.profile.telefono}`);
  parts.push("");

  parts.push("*Detalle:*");
  for (const it of lines) {
    if (it.tipo === "kg") parts.push(`• ${it.gramos}g ${it.p.nombre}  $${money(it.line)}`);
    else parts.push(`• ${it.qty}u ${it.p.nombre}  $${money(it.line)}`);
  }

  parts.push("");
  parts.push(`Subtotal: *$${money(subtotal)}*`);
  if (user.checkout.envioTipo === "envio") parts.push(`${ship.label}: *$${money(ship.costo)}*`);
  parts.push(`TOTAL: *$${money(total)}*`);
  parts.push("");

  if (user.checkout.envioTipo === "envio") {
    parts.push("🚚 Envío a domicilio");
    parts.push(`📍 ${user.checkout.direccion || "-"}`);
  } else {
    parts.push("🏪 Retiro en el local");
  }

  if (user.checkout.horario) parts.push(`🕒 Horario: ${user.checkout.horario}`);
  if (user.checkout.pago) parts.push(`💳 Pago: ${user.checkout.pago}`);

  parts.push(`🆔 ChatID: ${chatId}`);
  return parts.join("\n");
}

async function sendOrderToSheetsIfConfigured(config, payload) {
  const url = config?.pedidosUrl || "";
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {}
}

async function finalizeOrder(chatId, config, user, username, ticket) {
  const ticketText = buildPOSTicket(config, user, chatId, username, ticket);

  // Guardar ticket para el usuario
  user.lastOrder = { ticket };
  saveData(DB);

  // Enviar al admin
  if (ADMIN_CHAT_ID) {
    try {
      await bot.sendMessage(ADMIN_CHAT_ID, ticketText, { parse_mode: "Markdown", ...inlineAdminOrderKeyboard(chatId, ticket) });
    } catch (e) {
      console.error("No pude enviar al ADMIN_CHAT_ID:", e?.message || e);
    }
  }

  // Guardar en Sheets si está configurado
  const { subtotal, lines } = calcCartTotals(config, user);
  const ship = calcShipping(config, subtotal, user.checkout);
  const total = subtotal + Number(ship.costo || 0);

  await sendOrderToSheetsIfConfigured(config, {
    ticket,
    chatId,
    username: username || "",
    nombre: user.profile?.nombre || "",
    telefono: user.profile?.telefono || "",
    envioTipo: user.checkout.envioTipo || "",
    direccion: user.checkout.direccion || "",
    horario: user.checkout.horario || "",
    pago: user.checkout.pago || "",
    subtotal,
    envioCosto: ship.costo,
    total,
    items: lines.map((it) => ({
      codigo: it.p.codigo,
      nombre: it.p.nombre,
      tipo: it.tipo,
      gramos: it.tipo === "kg" ? it.gramos : null,
      qty: it.tipo === "unidad" ? it.qty : null,
      importe: it.line,
    })),
    createdAt: new Date().toISOString(),
  });

  // Confirmación al cliente
  const confirmText =
    config.textos?.pedidoConfirmado ||
    "✅ ¡Listo! Ya tomé tu pedido.\n\nEn breve te confirmamos la preparación y coordinación. 🙌";

  await bot.sendMessage(chatId, safeText(confirmText), { ...mainMenuKeyboard() });

  // limpiar carrito/checkout (NO rompemos nada)
  clearCart(user);
  user.checkout = { paso: "", envioTipo: "", direccion: "", pago: "", horario: "" };
  user.pending = { mode: "", codigo: "" };
  saveData(DB);
}

// -------------------- HANDLERS --------------------
bot.onText(/\/start/, async (msg) => {
  try {
    const config = await fetchConfig();
    await sendWelcome(msg.chat.id, config);
  } catch (e) {
    console.error(e);
    bot.sendMessage(msg.chat.id, "Hubo un problema cargando la configuración. Probá de nuevo en unos segundos.");
  }
});

bot.on("message", async (msg) => {
  try {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    if (!userId) return;

    if (msg.text && msg.text.startsWith("/start")) return;

    const config = await fetchConfig();
    const user = getUser(DB, userId);
    const text = (msg.text || "").trim();

    // Si escribe "hola/buenas" -> saludo lindo siempre
    if (/^(hola|holaa|buenas|buen día|buen dia|buenas tardes|buenas noches)\b/i.test(text)) {
      await sendWelcome(chatId, config);
      return;
    }

    // Si estamos esperando cantidad (kg o unidades) del producto
    if (user.pending?.mode && user.pending?.codigo && text) {
      const p = findProduct(config, user.pending.codigo);

      if (user.pending.mode === "kg") {
        const g = Number(String(text).replace(/[^\d]/g, ""));
        if (!g || g <= 0) {
          await bot.sendMessage(chatId, "Escribí solo la cantidad en *gramos* (ej: 250).", { parse_mode: "Markdown" });
          return;
        }
        addToCartGramos(user, user.pending.codigo, g);
        user.pending = { mode: "", codigo: "" };
        saveData(DB);
        await bot.sendMessage(chatId, `✅ Agregado: *${p?.nombre || user.pending.codigo}* (${g}g)`, { parse_mode: "Markdown" });
        return;
      }

      if (user.pending.mode === "unidad") {
        const u = Number(String(text).replace(/[^\d]/g, ""));
        if (!u || u <= 0) {
          await bot.sendMessage(chatId, "Escribí solo la cantidad en *unidades* (ej: 2).", { parse_mode: "Markdown" });
          return;
        }
        addToCartUnidad(user, user.pending.codigo, u);
        user.pending = { mode: "", codigo: "" };
        saveData(DB);
        await bot.sendMessage(chatId, `✅ Agregado: *${p?.nombre || user.pending.codigo}* (${u} unid.)`, { parse_mode: "Markdown" });
        return;
      }
    }

    // Flujo checkout por texto
    if (user.checkout?.paso) {
      if (user.checkout.paso === "esperando_nombre") {
        user.profile.nombre = text;
        user.checkout.paso = "esperando_telefono";
        saveData(DB);
        await askPhone(chatId);
        return;
      }
      if (user.checkout.paso === "esperando_telefono") {
        user.profile.telefono = text;

        // si envío -> pedir dirección; si retiro -> pedir horario
        if (user.checkout.envioTipo === "envio") {
          user.checkout.paso = "esperando_direccion";
          saveData(DB);
          await askAddress(chatId);
          return;
        } else {
          user.checkout.paso = "esperando_horario";
          saveData(DB);
          await askTime(chatId, "retiro");
          return;
        }
      }
      if (user.checkout.paso === "esperando_direccion") {
        user.checkout.direccion = text;
        user.checkout.paso = "esperando_horario";
        saveData(DB);
        await askTime(chatId, "envio");
        return;
      }
      if (user.checkout.paso === "esperando_horario") {
        user.checkout.horario = text;
        user.checkout.paso = "pago";
        saveData(DB);
        await askPayment(chatId, config);
        return;
      }
    }

    // Menú principal
    if (text === "🛍️ Catálogo") return await showCategories(chatId, config);
    if (text === "🔥 Promos") return await showPromos(chatId, config);
    if (text === "🛒 Mi carrito") return await showCart(chatId, config, user);
    if (text === "✅ Finalizar compra") return await startCheckout(chatId, config, user);
    if (text === "📍 Horarios y dirección") return await showBusinessInfo(chatId, config);

    if (text === "📣 Compartir bot") {
      let me;
      try {
        me = await bot.getMe();
      } catch {
        await bot.sendMessage(chatId, "No pude obtener el link del bot en este momento. Probá de nuevo.", { ...mainMenuKeyboard() });
        return;
      }
      const links = buildShareLinks(
        me.username,
        config.negocio?.nombre || "el negocio",
        config.textos?.textoCompartir || "Te lo comparto:"
      );
      return await bot.sendMessage(chatId, "📣 Elegí cómo querés compartir el bot:", inlineShareKeyboard(links));
    }

    const fallback = config.textos?.fallback || "🙂 Tocá *Catálogo* para ver productos por categoría.";
    await bot.sendMessage(chatId, fallback, { parse_mode: "Markdown", ...mainMenuKeyboard() });
  } catch (e) {
    console.error(e);
    try {
      await bot.sendMessage(msg.chat.id, "Hubo un error. Probá de nuevo en unos segundos.");
    } catch {}
  }
});

bot.on("callback_query", async (q) => {
  try {
    const data = q.data || "";
    const msg = q.message;
    if (!msg) return;

    const chatId = msg.chat.id;
    const userId = q.from?.id;
    if (!userId) return;

    const config = await fetchConfig();
    const user = getUser(DB, userId);

    const ack = async () => {
      try { await bot.answerCallbackQuery(q.id); } catch {}
    };

    if (data === "noop") return await ack();

    if (data === "menu:main") {
      await ack();
      return await sendWelcome(chatId, config);
    }

    if (data === "cats:list") {
      await ack();
      return await showCategories(chatId, config);
    }

    if (data.startsWith("cat:")) {
      await ack();
      const cat = data.slice(4);
      return await showCatalogPage(chatId, config, cat, 1);
    }

    if (data.startsWith("page:")) {
      await ack();
      const [, cat, p] = data.split(":");
      // si cat es Promos, hacemos promos paginadas simples
      if (cat === "Promos" || cat === "PROMOS") {
        // reconstruimos promos
        let promoItems = [];
        if (Array.isArray(config.promos) && config.promos.length) {
          for (const pr of config.promos) {
            const code = pr.codigo || pr;
            const prod = findProduct(config, code);
            if (prod) promoItems.push(prod);
          }
        } else {
          const map = getCatalogByCategory(config);
          promoItems = map.get("Promos") || map.get("PROMOS") || [];
        }

        const perPage = Math.max(1, Number(config.ui?.itemsPorPagina || 3));
        const totalPages = Math.max(1, Math.ceil(promoItems.length / perPage));
        const page = Math.min(Math.max(1, Number(p || 1)), totalPages);
        const slice = promoItems.slice((page - 1) * perPage, (page - 1) * perPage + perPage);

        LAST_VIEW.set(chatId, { cat: "Promos", page });

        await bot.sendMessage(chatId, `🔥 *Promos* — página *${page}/${totalPages}*`, { parse_mode: "Markdown" });
        for (const pr of slice) await sendProductCard(chatId, config, pr);
        await bot.sendMessage(chatId, "Navegación:", inlineNavKeyboard("Promos", page, totalPages));
        return;
      }

      return await showCatalogPage(chatId, config, cat, Number(p || 1));
    }

    // QUIERO ESTE -> pregunta por texto (sin menú)
    if (data.startsWith("want:")) {
      await ack();
      const codigo = data.slice(5);
      const p = findProduct(config, codigo);
      if (!p) return await bot.sendMessage(chatId, "No encontré ese producto.");

      if (isKg(p)) {
        user.pending = { mode: "kg", codigo };
        saveData(DB);
        await bot.sendMessage(chatId, `✍️ ¿Cuántos *gramos* querés de *${p.nombre}*?\nEj: 250`, { parse_mode: "Markdown" });
        return;
      } else {
        user.pending = { mode: "unidad", codigo };
        saveData(DB);
        await bot.sendMessage(chatId, `✍️ ¿Cuántas *unidades* querés de *${p.nombre}*?\nEj: 2`, { parse_mode: "Markdown" });
        return;
      }
    }

    // + desde carrito -> misma pregunta por texto
    if (data.startsWith("plus:")) {
      await ack();
      const codigo = data.slice(5);
      const p = findProduct(config, codigo);
      if (!p) return await bot.sendMessage(chatId, "No encontré ese producto.");

      if (isKg(p)) {
        user.pending = { mode: "kg", codigo };
        saveData(DB);
        await bot.sendMessage(chatId, `✍️ ¿Cuántos *gramos* querés sumar de *${p.nombre}*?\nEj: 250`, { parse_mode: "Markdown" });
        return;
      } else {
        user.pending = { mode: "unidad", codigo };
        saveData(DB);
        await bot.sendMessage(chatId, `✍️ ¿Cuántas *unidades* querés sumar de *${p.nombre}*?\nEj: 1`, { parse_mode: "Markdown" });
        return;
      }
    }

    if (data.startsWith("sharep:")) {
      await ack();
      const codigo = data.slice(7);
      const p = findProduct(config, codigo);
      if (!p) return await bot.sendMessage(chatId, "No encontré ese producto.");

      let me;
      try { me = await bot.getMe(); } catch {
        return await bot.sendMessage(chatId, "No pude armar el link para compartir ahora. Probá de nuevo.");
      }

      const unidadTxt = isKg(p) ? "por kg" : "c/u";
      const price = isKg(p) ? (p.precioPorKilo || p.precio || 0) : (p.precio || 0);
      const text = `Producto: ${p.nombre}\nPrecio: $${money(price)} ${unidadTxt}\n\nSi querés pedirlo, entrá al bot 👇`;

      const links = buildShareLinks(me.username, config.negocio?.nombre || "el negocio", text);
      await bot.sendMessage(chatId, "📣 Compartir este producto:", inlineShareKeyboard(links));
      return;
    }

    if (data === "cart:view") {
      await ack();
      return await showCart(chatId, config, user);
    }

    if (data === "cart:clear") {
      await ack();
      clearCart(user);
      saveData(DB);
      return await bot.sendMessage(chatId, "🧹 Listo, vacié el carrito.", { ...mainMenuKeyboard() });
    }

    if (data.startsWith("rmline:")) {
      await ack();
      const idx = Number(data.slice(7));
      removeFromCartItem(user, idx);
      saveData(DB);
      return await showCart(chatId, config, user);
    }

    if (data === "checkout:start") {
      await ack();
      return await startCheckout(chatId, config, user);
    }

    if (data === "checkout:cancel") {
      await ack();
      user.checkout = { paso: "", envioTipo: "", direccion: "", pago: "", horario: "" };
      user.pending = { mode: "", codigo: "" };
      saveData(DB);
      return await bot.sendMessage(chatId, "Listo, cancelé el checkout.", { ...mainMenuKeyboard() });
    }

    if (data.startsWith("ship:")) {
      await ack();
      const tipo = data.split(":")[1]; // retiro / envio
      user.checkout.envioTipo = tipo;

      // siempre nombre y teléfono, luego dirección (si envío) y horario para ambos
      user.checkout.paso = "esperando_nombre";
      saveData(DB);
      await askName(chatId);
      return;
    }

    if (data.startsWith("pay:")) {
      await ack();
      const payId = data.slice(4);
      const methods = Array.isArray(config.pagos?.metodos) ? config.pagos.metodos : [];
      const method = methods.find((m) => String(m.id || m.label) === String(payId)) || null;
      const label = method?.label || method?.nombre || String(payId);

      user.checkout.pago = label;
      saveData(DB);

      // si es transferencia: mostrar alias/cbu/titular
      const isTransfer =
        /transfer/i.test(String(label)) || /transfer/i.test(String(method?.id || "")) || /transfer/i.test(String(method?.label || ""));
      if (isTransfer) {
        const alias = config.pagos?.alias || "";
        const cbu = config.pagos?.cbu || "";
        const titular = config.pagos?.titular || "";
        const lines = [];
        lines.push("🏦 *Transferencia*");
        if (alias) lines.push(`• Alias: *${alias}*`);
        if (cbu) lines.push(`• CBU: *${cbu}*`);
        if (titular) lines.push(`• Titular: *${titular}*`);
        lines.push("");
        lines.push("✅ Cuando hagas la transferencia, confirmás el pedido y te avisamos cuando se verifique el pago.");
        await bot.sendMessage(chatId, lines.join("\n"), { parse_mode: "Markdown" });
      }

      // construir ticket + resumen POS antes de confirmar
      const ticketPrefix = config.negocio?.ticketPrefix || "TQ";
      const ticket = generateTicket(ticketPrefix);

      // guardo ticket “reservado” por si hace falta
      DB.tickets[ticket] = { chatId, createdAt: Date.now() };
      saveData(DB);

      const pos = buildPOSTicket(config, user, chatId, q.from?.username, ticket);
      await bot.sendMessage(chatId, pos, { parse_mode: "Markdown" });
      await bot.sendMessage(chatId, "¿Confirmás el pedido?", inlineConfirmOrderKeyboard(ticket));
      return;
    }

    if (data.startsWith("order:confirm:")) {
      await ack();
      const ticket = data.split(":")[2];
      return await finalizeOrder(chatId, config, user, q.from?.username, ticket);
    }

    // -------- ADMIN ACTIONS (pago confirmado / preparación) --------
    if (data.startsWith("admin:")) {
      await ack();

      // solo admin
      if (!ADMIN_CHAT_ID || String(userId) !== String(ADMIN_CHAT_ID)) {
        await bot.sendMessage(chatId, "Acción solo para el administrador.");
        return;
      }

      const parts = data.split(":"); // admin:paid:buyerChatId:ticket
      const action = parts[1];
      const buyerChatId = parts[2];
      const ticket = parts[3];

      if (action === "paid") {
        const txt =
          config.textos?.pagoConfirmado ||
          `✅ *Pago confirmado*\nTu pedido *${ticket}* está siendo preparado. 🙌`;
        await bot.sendMessage(buyerChatId, txt, { parse_mode: "Markdown" });
        await bot.sendMessage(chatId, `Listo ✅ Avisé al cliente que el pago del ticket ${ticket} fue confirmado.`);
        return;
      }

      if (action === "prep") {
        const txt =
          config.textos?.pedidoEnPreparacion ||
          `📦 *Tu pedido ${ticket}* está en preparación.\nEn breve te avisamos cuando esté listo.`;
        await bot.sendMessage(buyerChatId, txt, { parse_mode: "Markdown" });
        await bot.sendMessage(chatId, `Listo ✅ Avisé al cliente que el pedido ${ticket} está en preparación.`);
        return;
      }
    }

    await ack();
  } catch (e) {
    console.error(e);
    try { await bot.answerCallbackQuery(q.id, { text: "Hubo un error. Probá de nuevo." }); } catch {}
  }
});

// -------------------- WEBHOOK SERVER (Render) --------------------
async function start() {
  const config = await fetchConfig();
  console.log(
    `Config OK: negocio="${config.negocio?.nombre || "-"}", catalogo=${config.catalogo?.length || 0}, itemsPorPagina=${config.ui?.itemsPorPagina || 3}`
  );

  if (PUBLIC_URL) {
    await ensureWebhook();

    const hookPath = `/telegram/${BOT_TOKEN}`;
    const server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === hookPath) {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", async () => {
          try {
            const update = JSON.parse(body);
            await bot.processUpdate(update);
          } catch {}
          res.writeHead(200);
          res.end("OK");
        });
        return;
      }

      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end("EzerBot System OK");
        return;
      }

      res.writeHead(404);
      res.end("Not Found");
    });

    server.listen(PORT, () => console.log(`Escuchando puerto ${PORT} (webhook)`));
  } else {
    console.log("Bot activo (polling).");
  }
}

start().catch((e) => {
  console.error("Error iniciando:", e?.message || e);
  process.exit(1);
});

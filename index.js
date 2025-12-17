/**
 * EzerBot System — index.js (UN SOLO ARCHIVO)
 * - Telegram Bot + Webhook (Render) o Polling (local)
 * - Lee TODO desde CONFIG_URL (config.json)
 * - Catálogo por categorías + paginado
 * - Carrito + checkout + envío + pago
 * - Pago con comprobante + aprobación del vendedor (ADMIN)
 * - Imágenes visibles: botón "👁 Ver" (sendPhoto) + "➕ Agregar"
 * - Tarjeta virtual de sellos (data.json)
 * - Botones para compartir el bot (WhatsApp / Email / Telegram) con start del negocio
 *
 * VARIABLES DE ENTORNO (Render > Environment):
 * - BOT_TOKEN            ✅
 * - CONFIG_URL           ✅ (URL directa al config.json)
 * - PUBLIC_URL           ✅ (ej: https://ezerbot-system.onrender.com)
 * - ADMIN_CHAT_ID        (opcional pero recomendado) chatId del vendedor/admin
 * - PORT                 (Render la define sola)
 */

import TelegramBot from "node-telegram-bot-api";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// -------------------- ENV --------------------
const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const CONFIG_URL = (process.env.CONFIG_URL || "").trim();
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim(); // ej: https://ezerbot-system.onrender.com
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
    if (!fs.existsSync(DATA_PATH)) return { users: {}, orders: {} };
    const raw = fs.readFileSync(DATA_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.users) parsed.users = {};
    if (!parsed.orders) parsed.orders = {};
    return parsed;
  } catch {
    return { users: {}, orders: {} };
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
const money = (n) => {
  const num = Number(n || 0);
  return num.toLocaleString("es-AR", { maximumFractionDigits: 0 });
};

function safeText(s, max = 4000) {
  const t = String(s ?? "");
  return t.length > max ? t.slice(0, max - 3) + "..." : t;
}

function getUser(db, userId) {
  const key = String(userId);
  if (!db.users[key]) {
    db.users[key] = {
      cart: [], // [{codigo, qty}]
      stamps: 0,
      profile: { nombre: "", telefono: "" },
      checkout: {
        paso: "",
        envioTipo: "",
        zona: "",
        direccion: "",
        pago: "",
        orderId: "",
      },
      lastSeen: Date.now(),
    };
    saveData(db);
  }
  db.users[key].lastSeen = Date.now();
  return db.users[key];
}

function addToCart(user, codigo, qty = 1) {
  const q = Math.max(1, Number(qty || 1));
  const item = user.cart.find((x) => x.codigo === codigo);
  if (item) item.qty += q;
  else user.cart.push({ codigo, qty: q });
}

function removeFromCart(user, codigo, qty = 1) {
  const q = Math.max(1, Number(qty || 1));
  const idx = user.cart.findIndex((x) => x.codigo === codigo);
  if (idx === -1) return;
  user.cart[idx].qty -= q;
  if (user.cart[idx].qty <= 0) user.cart.splice(idx, 1);
}

function clearCart(user) {
  user.cart = [];
}

function genOrderId() {
  const rnd = Math.floor(Math.random() * 90000 + 10000);
  return `PED-${Date.now()}-${rnd}`;
}

// ✅ Admin ids permitidos: env + config.admins[]
function getAdminIds(config) {
  const ids = new Set();
  if (ADMIN_CHAT_ID) ids.add(String(ADMIN_CHAT_ID));
  const arr = Array.isArray(config.admins) ? config.admins : [];
  for (const x of arr) ids.add(String(x));
  return ids;
}
function isAdmin(config, chatId) {
  return getAdminIds(config).has(String(chatId));
}

function buildShareLinks(botUsername, negocioId, negocioNombre) {
  // ✅ Link con start (para identificar negocio)
  const deep = `https://t.me/${botUsername}?start=${encodeURIComponent(negocioId || "inicio")}`;
  const text = encodeURIComponent(
    `Te comparto el bot de ${negocioNombre} 🤖✨\n\nAbrilo acá: ${deep}\n`
  );
  const wa = `https://wa.me/?text=${text}`;
  const tg = `https://t.me/share/url?url=${encodeURIComponent(deep)}&text=${text}`;
  const mail = `mailto:?subject=${encodeURIComponent(`Bot de ${negocioNombre}`)}&body=${text}`;
  return { wa, tg, mail, deep };
}

// -------------------- CONFIG CACHE --------------------
let CONFIG_CACHE = null;
let CONFIG_CACHE_AT = 0;
const CONFIG_TTL_MS = 30_000; // 30s

async function fetchConfig() {
  const now = Date.now();
  if (CONFIG_CACHE && now - CONFIG_CACHE_AT < CONFIG_TTL_MS) return CONFIG_CACHE;

  const url = new URL(CONFIG_URL);
  const res = await fetch(url.toString(), { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`No pude leer config.json (HTTP ${res.status})`);
  const json = await res.json();

  // Normalización mínima
  if (!json.negocio) json.negocio = {};
  if (!Array.isArray(json.catalogo)) json.catalogo = [];
  if (!Array.isArray(json.promos)) json.promos = [];
  if (!json.envios) json.envios = { activo: false };
  if (!json.pagos) json.pagos = { metodos: [] };
  if (!json.sellos) json.sellos = { activo: false };
  if (!json.textos) json.textos = {};
  if (!json.ui) json.ui = {};
  if (!Array.isArray(json.admins)) json.admins = [];

  CONFIG_CACHE = json;
  CONFIG_CACHE_AT = now;
  return json;
}

function getCatalogByCategory(config) {
  const map = new Map();
  for (const p of config.catalogo || []) {
    const cat = (p.categoria || "Otros").trim() || "Otros";
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat).push(p);
  }
  for (const [k, arr] of map.entries()) {
    arr.sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), "es"));
    map.set(k, arr);
  }
  return map;
}

function findProduct(config, codigo) {
  return (config.catalogo || []).find((p) => String(p.codigo) === String(codigo));
}

function calcCartTotals(config, user) {
  let subtotal = 0;
  const lines = [];
  for (const it of user.cart) {
    const p = findProduct(config, it.codigo);
    if (!p) continue;
    const precio = Number(p.precio || 0);
    const qty = Number(it.qty || 1);
    const line = precio * qty;
    subtotal += line;
    lines.push({ p, qty, line });
  }
  return { subtotal, lines };
}

function calcShipping(config, subtotal, checkout) {
  const env = config.envios || { activo: false };
  if (!env.activo) return { costo: 0, label: "Retiro/Envío no configurado" };

  if (checkout.envioTipo === "retiro") return { costo: 0, label: "Retiro en el local" };

  const gratisDesde = Number(env.gratisDesde || 0);
  if (gratisDesde > 0 && subtotal >= gratisDesde) {
    return { costo: 0, label: `Envío gratis (desde $${money(gratisDesde)})` };
  }

  const zonas = Array.isArray(env.zonas) ? env.zonas : [];
  if (checkout.zona && zonas.length) {
    const z = zonas.find((x) => String(x.nombre) === String(checkout.zona));
    if (z) return { costo: Number(z.costo || 0), label: `Envío (${z.nombre})` };
  }

  const costoFijo = Number(env.costo || 0);
  return { costo: costoFijo, label: "Envío" };
}

// ✅ Telegram: mandar foto si hay URL válida
async function sendProductCard(chatId, config, p) {
  const precio = `$${money(p.precio)}`;
  const desc = p.descripcion ? `\n${p.descripcion}` : "";
  const txt = `🧀 *${p.nombre}*\n💰 ${precio}${desc}\n\nCódigo: \`${p.codigo}\``;

  const rows = [
    [{ text: "➕ Agregar", callback_data: `add:${p.codigo}` }],
    [{ text: "🛒 Ver carrito", callback_data: "cart:view" }],
    [{ text: "⬅️ Categorías", callback_data: "cats:list" }],
  ];

  const img = (p.imagen || p.foto || p.image || "").trim();
  if (img) {
    try {
      await bot.sendPhoto(chatId, img, {
        caption: txt,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: rows },
      });
      return;
    } catch {
      // si falla la foto, caemos a texto
    }
  }

  await bot.sendMessage(chatId, txt, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: rows },
  });
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

// -------------------- UI (BOTONES) --------------------
function mainMenuKeyboard(config) {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🛍️ Catálogo" }, { text: "🔥 Promos" }],
        [{ text: "🛒 Mi carrito" }, { text: "✅ Finalizar compra" }],
        [{ text: "🎫 Tarjeta de sellos" }, { text: "📍 Horarios y dirección" }],
        [{ text: "📣 Compartir el bot" }],
      ],
      resize_keyboard: true,
    },
  };
}

function inlineCategoriesKeyboard(categories) {
  const rows = [];
  for (const cat of categories) rows.push([{ text: cat, callback_data: `cat:${cat}` }]);
  rows.push([{ text: "🔎 Buscar", callback_data: "search:ask" }]);
  rows.push([{ text: "⬅️ Menú", callback_data: "menu:main" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function inlineCatalogPageKeyboard(cat, page, totalPages, items) {
  const rows = [];

  // ✅ Ahora: cada producto tiene "👁 Ver" para mostrar imagen + "Agregar"
  for (const p of items) {
    rows.push([
      { text: `👁 Ver`, callback_data: `view:${p.codigo}` },
      { text: `➕ ${p.nombre} ($${money(p.precio)})`, callback_data: `add:${p.codigo}` },
    ]);
  }

  const nav = [];
  if (page > 1) nav.push({ text: "⬅️", callback_data: `page:${cat}:${page - 1}` });
  nav.push({ text: `📄 ${page}/${totalPages}`, callback_data: "noop" });
  if (page < totalPages) nav.push({ text: "➡️", callback_data: `page:${cat}:${page + 1}` });
  rows.push(nav);

  rows.push([{ text: "🛒 Ver carrito", callback_data: "cart:view" }]);
  rows.push([{ text: "⬅️ Categorías", callback_data: "cats:list" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function inlineCartKeyboard(user) {
  const rows = [];
  for (const it of user.cart) {
    rows.push([
      { text: `➖`, callback_data: `dec:${it.codigo}` },
      { text: `❌ Quitar`, callback_data: `rm:${it.codigo}` },
      { text: `➕`, callback_data: `inc:${it.codigo}` },
    ]);
  }
  rows.push([{ text: "🧹 Vaciar carrito", callback_data: "cart:clear" }]);
  rows.push([{ text: "✅ Finalizar compra", callback_data: "checkout:start" }]);
  rows.push([{ text: "⬅️ Menú", callback_data: "menu:main" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function inlineCheckoutDeliveryKeyboard(config) {
  const env = config.envios || { activo: false };
  const rows = [];
  rows.push([{ text: "🏪 Retiro en el local", callback_data: "ship:retiro" }]);
  if (env.activo) rows.push([{ text: "🚚 Envío a domicilio", callback_data: "ship:envio" }]);
  rows.push([{ text: "⬅️ Cancelar", callback_data: "checkout:cancel" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function inlineZonesKeyboard(config) {
  const zonas = Array.isArray(config.envios?.zonas) ? config.envios.zonas : [];
  const rows = [];
  for (const z of zonas) rows.push([{ text: `${z.nombre} ($${money(z.costo)})`, callback_data: `zone:${z.nombre}` }]);
  rows.push([{ text: "⬅️ Volver", callback_data: "checkout:start" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function inlinePaymentKeyboard(config) {
  const methods = Array.isArray(config.pagos?.metodos) ? config.pagos.metodos : [];
  const rows = [];
  for (const m of methods) {
    rows.push([{ text: m.label || m.nombre || m.id || "Pago", callback_data: `pay:${m.id || m.label}` }]);
  }
  rows.push([{ text: "⬅️ Cancelar", callback_data: "checkout:cancel" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function inlineShareKeyboard(links) {
  const rows = [
    [{ text: "📲 WhatsApp", url: links.wa }],
    [{ text: "✉️ Email", url: links.mail }],
    [{ text: "📨 Telegram", url: links.tg }],
    [{ text: "🔗 Abrir bot", url: links.deep }],
  ];
  return { reply_markup: { inline_keyboard: rows } };
}

// ✅ Botones admin para aprobar/rechazar comprobante
function inlineAdminPaymentReview(orderId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Pago OK", callback_data: `admin:payok:${orderId}` }],
        [{ text: "❌ Rechazar", callback_data: `admin:payno:${orderId}` }],
      ],
    },
  };
}

// -------------------- MENSAJES PRINCIPALES --------------------
async function sendWelcome(chatId, config, username) {
  const negocio = config.negocio || {};
  const bienvenida =
    config.textos?.bienvenida ||
    `😊 Decime qué estás buscando y te ayudo.\n\nPodés tocar *Catálogo* para ver todo lo disponible en *${negocio.nombre || "nuestro local"}*.`;

  await bot.sendMessage(chatId, bienvenida, {
    parse_mode: "Markdown",
    ...mainMenuKeyboard(config),
  });
}

async function showBusinessInfo(chatId, config) {
  const n = config.negocio || {};
  const lines = [];
  lines.push(`🏪 *${n.nombre || "Negocio"}*`);
  if (n.direccion) lines.push(`📍 ${n.direccion}`);
  if (n.horarios) lines.push(`🕒 ${n.horarios}`);
  if (n.telefono) lines.push(`📞 ${n.telefono}`);
  if (n.instagram) lines.push(`📸 ${n.instagram}`);
  await bot.sendMessage(chatId, lines.join("\n"), { parse_mode: "Markdown", ...mainMenuKeyboard(config) });
}

async function showCategories(chatId, config) {
  const map = getCatalogByCategory(config);
  const cats = Array.from(map.keys());
  if (!cats.length) {
    await bot.sendMessage(chatId, "⏳ Todavía no hay productos cargados en el catálogo.", mainMenuKeyboard(config));
    return;
  }
  await bot.sendMessage(chatId, "🛍️ Elegí una categoría:", inlineCategoriesKeyboard(cats));
}

async function showCatalogPage(chatId, config, cat, page = 1) {
  const map = getCatalogByCategory(config);
  const items = map.get(cat) || [];
  if (!items.length) {
    await bot.sendMessage(chatId, `No hay productos en *${cat}* por ahora.`, { parse_mode: "Markdown" });
    return;
  }

  const perPage = Number(config.ui?.itemsPorPagina || 6);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const p = Math.min(Math.max(1, Number(page || 1)), totalPages);
  const slice = items.slice((p - 1) * perPage, (p - 1) * perPage + perPage);

  const header = `*${cat}* — tocá "👁 Ver" para ver foto, o "➕" para agregar:`;
  await bot.sendMessage(chatId, header, { parse_mode: "Markdown", ...inlineCatalogPageKeyboard(cat, p, totalPages, slice) });
}

async function showPromos(chatId, config) {
  const promoItems = [];
  const promos = Array.isArray(config.promos) ? config.promos : [];

  if (promos.length) {
    for (const pr of promos) {
      const code = pr.codigo || pr;
      const p = findProduct(config, code);
      if (p) promoItems.push(p);
    }
  } else {
    const map = getCatalogByCategory(config);
    const fromCat = map.get("Promos") || map.get("PROMOS") || [];
    promoItems.push(...fromCat);
  }

  if (!promoItems.length) {
    await bot.sendMessage(chatId, "🔥 Todavía no hay promos cargadas. ¿Querés que te muestre el catálogo?", mainMenuKeyboard(config));
    return;
  }

  const rows = [];
  for (const p of promoItems.slice(0, 12)) {
    rows.push([
      { text: `👁 Ver`, callback_data: `view:${p.codigo}` },
      { text: `➕ ${p.nombre} ($${money(p.precio)})`, callback_data: `add:${p.codigo}` },
    ]);
  }
  rows.push([{ text: "🛒 Ver carrito", callback_data: "cart:view" }]);
  rows.push([{ text: "⬅️ Menú", callback_data: "menu:main" }]);

  await bot.sendMessage(chatId, "🔥 *Promos disponibles*:", {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: rows },
  });
}

async function showCart(chatId, config, user) {
  const { subtotal, lines } = calcCartTotals(config, user);
  if (!lines.length) {
    await bot.sendMessage(chatId, "🛒 Tu carrito está vacío. ¿Querés que te muestre el catálogo?", mainMenuKeyboard(config));
    return;
  }

  const msg = [];
  msg.push("🛒 *Tu carrito*");
  msg.push("");
  for (const it of lines) msg.push(`• ${it.qty} × ${it.p.nombre} — $${money(it.line)}`);
  msg.push("");
  msg.push(`Subtotal: *$${money(subtotal)}*`);

  await bot.sendMessage(chatId, msg.join("\n"), { parse_mode: "Markdown", ...inlineCartKeyboard(user) });
}

async function showStamps(chatId, config, user) {
  const sellos = config.sellos || { activo: false };
  if (!sellos.activo) {
    await bot.sendMessage(chatId, "🎫 La tarjeta de sellos todavía no está activa en este negocio.", mainMenuKeyboard(config));
    return;
  }
  const meta = Number(sellos.meta || 10);
  const premio = sellos.premio || "un beneficio especial";
  const actuales = Number(user.stamps || 0);

  const filled = Math.min(meta, actuales);
  const bar = "🟩".repeat(filled) + "⬜️".repeat(Math.max(0, meta - filled));

  const txt =
    `🎫 *${sellos.nombre || "Tarjeta de Sellos"}*\n` +
    `${bar}\n\n` +
    `Sellos: *${actuales} / ${meta}*\n` +
    `Premio al completar: *${premio}*\n\n` +
    `Tip: al finalizar una compra, se suma 1 sello automáticamente (configurable).`;

  await bot.sendMessage(chatId, txt, { parse_mode: "Markdown", ...mainMenuKeyboard(config) });
}

// -------------------- CHECKOUT --------------------
async function startCheckout(chatId, config, user) {
  const { lines } = calcCartTotals(config, user);
  if (!lines.length) {
    await bot.sendMessage(chatId, "Tu carrito está vacío. Primero agregá algo del catálogo 🙂", mainMenuKeyboard(config));
    return;
  }
  user.checkout = { paso: "envio_tipo", envioTipo: "", zona: "", direccion: "", pago: "", orderId: "" };
  saveData(DB);

  await bot.sendMessage(chatId, "✅ *Finalizar compra*\nElegí cómo querés recibir tu pedido:", {
    parse_mode: "Markdown",
    ...inlineCheckoutDeliveryKeyboard(config),
  });
}

async function askAddress(chatId) {
  await bot.sendMessage(chatId, "📍 Pasame tu *dirección completa* (calle + número + entre calles / referencia).", {
    parse_mode: "Markdown",
  });
}

async function askName(chatId) {
  await bot.sendMessage(chatId, "🧾 Decime tu *nombre* para el pedido.", { parse_mode: "Markdown" });
}

async function askPhone(chatId) {
  await bot.sendMessage(chatId, "📞 Pasame tu *teléfono*.", { parse_mode: "Markdown" });
}

async function askPayment(chatId, config) {
  const methods = Array.isArray(config.pagos?.metodos) ? config.pagos.metodos : [];
  if (!methods.length) {
    await bot.sendMessage(chatId, "💳 No hay métodos de pago configurados todavía. (Configurá `pagos.metodos` en config.json)", mainMenuKeyboard(config));
    return;
  }
  await bot.sendMessage(chatId, "💳 Elegí método de pago:", inlinePaymentKeyboard(config));
}

function buildOrderSummary(config, user, chatId, username) {
  const negocio = config.negocio || {};
  const { subtotal, lines } = calcCartTotals(config, user);
  const ship = calcShipping(config, subtotal, user.checkout);
  const total = subtotal + Number(ship.costo || 0);

  const profileName = user.profile?.nombre || "";
  const profilePhone = user.profile?.telefono || "";

  const parts = [];
  parts.push(`🧾 *Pedido — ${negocio.nombre || "Negocio"}*`);
  parts.push(`👤 Cliente: ${profileName || (username ? `@${username}` : "")}`.trim());
  if (profilePhone) parts.push(`📞 Tel: ${profilePhone}`);
  parts.push("");

  parts.push("*Detalle:*");
  for (const it of lines) parts.push(`• ${it.qty} × ${it.p.nombre} — $${money(it.line)}`);
  parts.push("");
  parts.push(`Subtotal: *$${money(subtotal)}*`);
  parts.push(`${ship.label}: *$${money(ship.costo)}*`);
  parts.push(`TOTAL: *$${money(total)}*`);
  parts.push("");

  if (user.checkout.envioTipo === "envio") {
    if (user.checkout.zona) parts.push(`🗺️ Zona: ${user.checkout.zona}`);
    parts.push(`📍 Dirección: ${user.checkout.direccion || "-"}`);
  } else {
    parts.push("🏪 Entrega: Retiro en el local");
  }

  if (user.checkout.pago) parts.push(`💳 Pago: ${user.checkout.pago}`);
  parts.push("");
  parts.push(`🆔 ChatID cliente: ${chatId}`);

  return parts.join("\n");
}

// ✅ decide si ese método requiere comprobante
function paymentRequiresProof(config, payId) {
  const methods = Array.isArray(config.pagos?.metodos) ? config.pagos.metodos : [];
  const m = methods.find((x) => String(x.id || x.label) === String(payId)) || null;
  // si viene en config: { id:"transferencia", label:"Transferencia", requiereComprobante:true }
  if (m && (m.requiereComprobante === true || m.comprobante === true)) return true;

  // fallback: si id o label contiene "transfer" / "mercado pago" / "mp" / "alias"
  const s = String(m?.id || m?.label || payId || "").toLowerCase();
  if (s.includes("transfer") || s.includes("alias") || s.includes("cbu")) return true;

  return false;
}

async function createOrderRecord(chatId, userId, config, user, username) {
  const orderId = genOrderId();
  const summary = buildOrderSummary(config, user, chatId, username);

  DB.orders[orderId] = {
    orderId,
    createdAt: Date.now(),
    status: "CREATED",
    chatId: String(chatId),
    userId: String(userId),
    username: username ? String(username) : "",
    summary,
    pago: user.checkout.pago || "",
    envioTipo: user.checkout.envioTipo || "",
  };
  saveData(DB);
  return orderId;
}

async function sendOrderToAdmin(config, orderId, extraText = "") {
  const admins = Array.from(getAdminIds(config));
  if (!admins.length) return;

  const order = DB.orders[orderId];
  if (!order) return;

  const txt = `${order.summary}${extraText ? `\n\n${extraText}` : ""}`;

  for (const adminId of admins) {
    try {
      await bot.sendMessage(adminId, txt, { parse_mode: "Markdown" });
    } catch {}
  }
}

// ✅ cuando el admin aprueba, se finaliza y se suma sello + se limpia carrito
async function finalizeOrderAfterAdminOK(config, orderId) {
  const order = DB.orders[orderId];
  if (!order) return;

  const user = getUser(DB, order.userId);
  const chatId = Number(order.chatId);

  // sumar sello (si activo)
  if (config.sellos?.activo) {
    const suma = Number(config.sellos?.sumaPorCompra || 1);
    user.stamps = Number(user.stamps || 0) + (Number.isFinite(suma) ? suma : 1);

    const meta = Number(config.sellos?.meta || 10);
    if (meta > 0 && user.stamps >= meta) {
      const premio = config.sellos?.premio || "un beneficio";
      const reset = config.sellos?.resetAlCompletar ?? true;
      await bot.sendMessage(chatId, `🎉 ¡Felicitaciones! Completaste tu tarjeta de sellos y ganaste: *${premio}*`, {
        parse_mode: "Markdown",
      });
      if (reset) user.stamps = 0;
    }
  }

  const confirmText =
    config.textos?.pedidoConfirmado ||
    "✅ ¡Listo! Pedido confirmado.\n\nEn un momento te confirmamos preparación y coordinación. 🙌";

  await bot.sendMessage(chatId, safeText(confirmText), { ...mainMenuKeyboard(config) });

  // limpiar carrito y checkout
  clearCart(user);
  user.checkout = { paso: "", envioTipo: "", zona: "", direccion: "", pago: "", orderId: "" };
  saveData(DB);

  order.status = "CONFIRMED";
  saveData(DB);
}

// -------------------- HANDLERS --------------------
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  try {
    const config = await fetchConfig();
    const chatId = msg.chat.id;
    await sendWelcome(chatId, config, msg.from?.username);
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

    // ✅ Paso: esperando comprobante (foto/documento)
    if (user.checkout?.paso === "esperando_comprobante") {
      const orderId = user.checkout.orderId;
      if (!orderId || !DB.orders[orderId]) {
        user.checkout.paso = "";
        user.checkout.orderId = "";
        saveData(DB);
      } else {
        const hasPhoto = Array.isArray(msg.photo) && msg.photo.length;
        const hasDoc = !!msg.document;

        if (!hasPhoto && !hasDoc) {
          await bot.sendMessage(chatId, "📎 Enviame *la foto o PDF del comprobante* para confirmar el pago.", {
            parse_mode: "Markdown",
          });
          return;
        }

        const order = DB.orders[orderId];
        order.status = "PROOF_RECEIVED";
        saveData(DB);

        const admins = Array.from(getAdminIds(config));
        if (!admins.length) {
          await bot.sendMessage(chatId, "Recibí el comprobante ✅ (pero falta configurar ADMIN_CHAT_ID para que lo apruebe el vendedor).");
          return;
        }

        const caption =
          `🧾 *Comprobante recibido*\n` +
          `Pedido: *${orderId}*\n` +
          `Cliente: ${order.username ? `@${order.username}` : order.chatId}\n\n` +
          `🔻 Revisar y tocar: ✅ Pago OK / ❌ Rechazar`;

        // reenviar comprobante a todos los admins con botones
        for (const adminId of admins) {
          try {
            if (hasPhoto) {
              const best = msg.photo[msg.photo.length - 1];
              await bot.sendPhoto(adminId, best.file_id, {
                caption,
                parse_mode: "Markdown",
                ...inlineAdminPaymentReview(orderId),
              });
            } else if (hasDoc) {
              await bot.sendDocument(adminId, msg.document.file_id, {
                caption,
                parse_mode: "Markdown",
                ...inlineAdminPaymentReview(orderId),
              });
            }
            await bot.sendMessage(adminId, order.summary, { parse_mode: "Markdown" });
          } catch {}
        }

        await bot.sendMessage(chatId, "✅ Comprobante enviado al vendedor. En un momento te confirmamos el pago.");
        return;
      }
    }

    // Flujo de checkout por texto
    if (user.checkout?.paso) {
      if (user.checkout.paso === "esperando_direccion") {
        user.checkout.direccion = text;
        user.checkout.paso = "esperando_nombre";
        saveData(DB);
        await bot.sendMessage(chatId, "🧾 Decime tu *nombre* para el pedido.", { parse_mode: "Markdown" });
        return;
      }
      if (user.checkout.paso === "esperando_nombre") {
        user.profile.nombre = text;
        user.checkout.paso = "esperando_telefono";
        saveData(DB);
        await bot.sendMessage(chatId, "📞 Pasame tu *teléfono*.", { parse_mode: "Markdown" });
        return;
      }
      if (user.checkout.paso === "esperando_telefono") {
        user.profile.telefono = text;
        user.checkout.paso = "pago";
        saveData(DB);
        await askPayment(chatId, config);
        return;
      }
    }

    // Botones teclado principal
    if (text === "🛍️ Catálogo") return await showCategories(chatId, config);
    if (text === "🔥 Promos") return await showPromos(chatId, config);
    if (text === "🛒 Mi carrito") return await showCart(chatId, config, user);
    if (text === "✅ Finalizar compra") return await startCheckout(chatId, config, user);
    if (text === "📍 Horarios y dirección") return await showBusinessInfo(chatId, config);
    if (text === "🎫 Tarjeta de sellos") return await showStamps(chatId, config, user);

    if (text === "📣 Compartir el bot") {
      const me = await bot.getMe();
      const negocioId = config.negocio?.id || "inicio";
      const negocioNombre = config.negocio?.nombre || "el negocio";
      const links = buildShareLinks(me.username, negocioId, negocioNombre);
      return await bot.sendMessage(chatId, "📣 Elegí cómo querés compartir el bot:", inlineShareKeyboard(links));
    }

    // fallback amable
    if (text) {
      const fallback =
        config.textos?.fallback ||
        "🙂 Decime qué estás buscando (por ejemplo: *picada*, *queso*, *promo*) o tocá una opción del menú.";
      await bot.sendMessage(chatId, fallback, { parse_mode: "Markdown", ...mainMenuKeyboard(config) });
    }
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
      try {
        await bot.answerCallbackQuery(q.id);
      } catch {}
    };

    if (data === "noop") return await ack();

    // ---------------- ADMIN callbacks ----------------
    if (data.startsWith("admin:")) {
      await ack();

      if (!isAdmin(config, chatId)) {
        try { await bot.sendMessage(chatId, "⛔ No autorizado."); } catch {}
        return;
      }

      const [, action, orderId] = data.split(":");
      const order = DB.orders[orderId];
      if (!order) {
        await bot.sendMessage(chatId, "Ese pedido ya no existe o venció.");
        return;
      }

      if (action === "payok") {
        order.status = "PAYMENT_OK";
        saveData(DB);

        // avisar al cliente
        const clientChatId = Number(order.chatId);
        await bot.sendMessage(clientChatId, "✅ *Pago confirmado.* Ya estamos preparando tu pedido. 🙌", { parse_mode: "Markdown" });

        // finalizar (sello + limpieza)
        await finalizeOrderAfterAdminOK(config, orderId);

        await bot.sendMessage(chatId, `✅ Pago OK registrado para ${orderId}`);
        return;
      }

      if (action === "payno") {
        order.status = "PAYMENT_REJECTED";
        saveData(DB);

        const clientChatId = Number(order.chatId);
        await bot.sendMessage(
          clientChatId,
          "❌ *No pudimos validar el comprobante.*\nPor favor reenviá el comprobante (foto o PDF).",
          { parse_mode: "Markdown" }
        );

        // volver a esperar comprobante en el usuario
        const u = getUser(DB, order.userId);
        u.checkout.paso = "esperando_comprobante";
        u.checkout.orderId = orderId;
        saveData(DB);

        await bot.sendMessage(chatId, `❌ Rechazado. Se pidió reenvío al cliente (${orderId}).`);
        return;
      }

      return;
    }

    // ---------------- User callbacks ----------------
    if (data === "menu:main") {
      await ack();
      return await sendWelcome(chatId, config, q.from?.username);
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
      return await showCatalogPage(chatId, config, cat, Number(p || 1));
    }

    // ✅ Ver producto (con imagen)
    if (data.startsWith("view:")) {
      await ack();
      const codigo = data.slice(5);
      const p = findProduct(config, codigo);
      if (!p) return await bot.sendMessage(chatId, "Ese producto no existe (revisá el config).");
      return await sendProductCard(chatId, config, p);
    }

    if (data.startsWith("add:")) {
      await ack();
      const codigo = data.slice(4);
      const p = findProduct(config, codigo);
      if (!p) return await bot.sendMessage(chatId, "Ese producto no existe (revisá el config).");

      addToCart(user, codigo, 1);
      saveData(DB);

      // ✅ si tiene imagen, se la mostramos (queda “pro”)
      try {
        await sendProductCard(chatId, config, p);
      } catch {
        await bot.sendMessage(chatId, `✅ Agregado: *${p.nombre}*`, { parse_mode: "Markdown" });
      }
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
      return await bot.sendMessage(chatId, "🧹 Listo, vacié el carrito.", mainMenuKeyboard(config));
    }

    if (data.startsWith("inc:")) {
      await ack();
      const codigo = data.slice(4);
      addToCart(user, codigo, 1);
      saveData(DB);
      return await showCart(chatId, config, user);
    }

    if (data.startsWith("dec:")) {
      await ack();
      const codigo = data.slice(4);
      removeFromCart(user, codigo, 1);
      saveData(DB);
      return await showCart(chatId, config, user);
    }

    if (data.startsWith("rm:")) {
      await ack();
      const codigo = data.slice(3);
      user.cart = user.cart.filter((x) => x.codigo !== codigo);
      saveData(DB);
      return await showCart(chatId, config, user);
    }

    if (data === "checkout:start") {
      await ack();
      return await startCheckout(chatId, config, user);
    }

    if (data === "checkout:cancel") {
      await ack();
      user.checkout = { paso: "", envioTipo: "", zona: "", direccion: "", pago: "", orderId: "" };
      saveData(DB);
      return await bot.sendMessage(chatId, "Listo, cancelé el checkout.", mainMenuKeyboard(config));
    }

    if (data.startsWith("ship:")) {
      await ack();
      const tipo = data.split(":")[1]; // retiro / envio
      user.checkout.envioTipo = tipo;

      if (tipo === "retiro") {
        user.checkout.paso = "esperando_nombre";
        saveData(DB);
        await askName(chatId);
        return;
      }

      const zonas = Array.isArray(config.envios?.zonas) ? config.envios.zonas : [];
      if (zonas.length) {
        user.checkout.paso = "zona";
        saveData(DB);
        await bot.sendMessage(chatId, "🗺️ Elegí tu zona de envío:", inlineZonesKeyboard(config));
        return;
      } else {
        user.checkout.paso = "esperando_direccion";
        saveData(DB);
        await askAddress(chatId);
        return;
      }
    }

    if (data.startsWith("zone:")) {
      await ack();
      const zona = data.slice(5);
      user.checkout.zona = zona;
      user.checkout.paso = "esperando_direccion";
      saveData(DB);
      await askAddress(chatId);
      return;
    }

    if (data.startsWith("pay:")) {
      await ack();
      const payId = data.slice(4);
      const methods = Array.isArray(config.pagos?.metodos) ? config.pagos.metodos : [];
      const method = methods.find((m) => String(m.id || m.label) === String(payId)) || null;
      user.checkout.pago = method?.label || method?.nombre || String(payId);
      saveData(DB);

      // Resumen + confirmar
      const summary = buildOrderSummary(config, user, chatId, q.from?.username);
      await bot.sendMessage(chatId, summary, { parse_mode: "Markdown" });

      const rows = [
        [{ text: "✅ Confirmar pedido", callback_data: "order:confirm" }],
        [{ text: "❌ Cancelar", callback_data: "checkout:cancel" }],
      ];
      await bot.sendMessage(chatId, "¿Confirmás el pedido?", { reply_markup: { inline_keyboard: rows } });
      return;
    }

    if (data === "order:confirm") {
      await ack();

      // crear pedido
      const orderId = await createOrderRecord(chatId, userId, config, user, q.from?.username);
      user.checkout.orderId = orderId;
      saveData(DB);

      // enviar al admin (si hay)
      await sendOrderToAdmin(config, orderId, "\n\n🟡 Estado: Pedido creado");

      // si el método requiere comprobante, pedirlo
      const requires = paymentRequiresProof(config, user.checkout.pago || "");
      if (requires) {
        DB.orders[orderId].status = "WAITING_PROOF";
        saveData(DB);

        user.checkout.paso = "esperando_comprobante";
        saveData(DB);

        await bot.sendMessage(
          chatId,
          "📎 Perfecto. Ahora enviame *la foto o PDF del comprobante* para confirmar el pago.",
          { parse_mode: "Markdown" }
        );
        return;
      }

      // si no requiere comprobante, confirmamos directo
      DB.orders[orderId].status = "CONFIRMED_NO_PROOF";
      saveData(DB);

      await bot.sendMessage(chatId, "✅ ¡Pedido confirmado! En un momento lo preparamos y coordinamos. 🙌");
      await finalizeOrderAfterAdminOK(config, orderId);
      return;
    }

    if (data === "search:ask") {
      await ack();
      await bot.sendMessage(chatId, "🔎 Escribime qué estás buscando (ej: *picada*, *queso*, *pan*).", {
        parse_mode: "Markdown",
      });
      return;
    }

    await ack();
  } catch (e) {
    console.error(e);
    try {
      await bot.answerCallbackQuery(q.id, { text: "Hubo un error. Probá de nuevo." });
    } catch {}
  }
});

// -------------------- WEBHOOK SERVER (Render) --------------------
async function start() {
  const config = await fetchConfig();
  console.log(
    `Config cargado OK: negocio="${config.negocio?.nombre || "-"}", catalogo=${config.catalogo?.length || 0}, promos=${(config.promos || []).length || 0}`
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
            res.writeHead(200);
            res.end("OK");
          } catch {
            res.writeHead(200);
            res.end("OK");
          }
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

    server.listen(PORT, () => console.log(`Escuchando en puerto ${PORT} (webhook)`));
  } else {
    console.log("Bot activo (polling).");
  }
}

start().catch((e) => {
  console.error("Error iniciando:", e?.message || e);
  process.exit(1);
});

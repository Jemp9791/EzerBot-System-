/**
 * EzerBot System — index.js (UN SOLO ARCHIVO)
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
  console.error("Falta BOT_TOKEN");
  process.exit(1);
}
if (!CONFIG_URL) {
  console.error("Falta CONFIG_URL");
  process.exit(1);
}

// -------------------- PERSISTENCIA SIMPLE --------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_PATH = path.join(__dirname, "data.json");

function loadData() {
  try {
    if (!fs.existsSync(DATA_PATH)) return { users: {} };
    const raw = fs.readFileSync(DATA_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.users) parsed.users = {};
    return parsed;
  } catch {
    return { users: {} };
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

const safeText = (s, max = 4000) => {
  const t = String(s ?? "");
  return t.length > max ? t.slice(0, max - 3) + "..." : t;
};

function getUser(db, userId) {
  const key = String(userId);
  if (!db.users[key]) {
    db.users[key] = {
      cart: [],
      stamps: 0,
      profile: { nombre: "", telefono: "" },
      checkout: { paso: "", envioTipo: "", zona: "", direccion: "", pago: "" },
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

/**
 * Enlaces para compartir el bot
 */
function buildShareLinks(botUsername, negocioNombre, publicUrl) {
  const botUrl = `https://t.me/${botUsername}`;
  const text = encodeURIComponent(
    `Te comparto el bot de ${negocioNombre} 🤖✨\n\nAbrilo acá: ${botUrl}`
  );
  const wa = `https://wa.me/?text=${text}`;
  const tg = `https://t.me/share/url?url=${encodeURIComponent(
    botUrl
  )}&text=${text}`;
  const mail = `mailto:?subject=${encodeURIComponent(
    `Bot de ${negocioNombre}`
  )}&body=${text}`;
  const web = publicUrl ? publicUrl : "";
  return { wa, tg, mail, web };
}

// -------------------- CONFIG CACHE --------------------

let CONFIG_CACHE = null;
let CONFIG_CACHE_AT = 0;
const CONFIG_TTL_MS = 30000;

async function fetchConfig() {
  const now = Date.now();
  if (CONFIG_CACHE && now - CONFIG_CACHE_AT < CONFIG_TTL_MS) return CONFIG_CACHE;

  const url = new URL(CONFIG_URL);
  const res = await fetch(url.toString(), { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`No pude leer config.json (${res.status})`);

  const json = await res.json();
  if (!json.negocio) json.negocio = {};
  if (!Array.isArray(json.catalogo)) json.catalogo = [];
  if (!Array.isArray(json.promos)) json.promos = [];
  if (!json.envios) json.envios = { activo: false };
  if (!json.pagos) json.pagos = { metodos: [] };
  if (!json.sellos) json.sellos = { activo: false };
  if (!json.textos) json.textos = {};
  if (!json.ui) json.ui = {};

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
    arr.sort((a, b) =>
      String(a.nombre).localeCompare(String(b.nombre), "es")
    );
    map.set(k, arr);
  }
  return map;
}

function findProduct(config, codigo) {
  return (config.catalogo || []).find(
    (p) => String(p.codigo) === String(codigo)
  );
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
  if (!env.activo) return { costo: 0, label: "Envío no configurado" };

  if (checkout.envioTipo === "retiro") {
    return { costo: 0, label: "Retiro en el local" };
  }

  const gratisDesde = Number(env.gratisDesde || 0);
  if (gratisDesde > 0 && subtotal >= gratisDesde) {
    return { costo: 0, label: `Envío gratis (desde $${money(gratisDesde)})` };
  }

  const zonas = Array.isArray(env.zonas) ? env.zonas : [];
  if (checkout.zona && zonas.length) {
    const z = zonas.find((x) => String(x.nombre) === String(checkout.zona));
    if (z) return { costo: Number(z.costo || 0), label: `Envío (${z.nombre})` };
  }

  const costoFijo = Number(env.costo || env.costoBase || 0);
  return { costo: costoFijo, label: "Envío" };
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

function mainMenuKeyboard(config) {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🛍️ Catálogo" }],
        [{ text: "🛒 Mi carrito" }, { text: "✅ Finalizar compra" }],
        [{ text: "🎫 Tarjeta de sellos" }],
        [{ text: "📣 Compartir el bot" }],
      ],
      resize_keyboard: true,
    },
  };
}

function inlineCategoriesKeyboard(categories) {
  const rows = [];
  for (const cat of categories) {
    rows.push([{ text: cat, callback_data: `cat:${cat}` }]);
  }
  rows.push([{ text: "🔎 Buscar", callback_data: "search:ask" }]);
  rows.push([{ text: "⬅️ Menú", callback_data: "menu:main" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function inlineCatalogPageKeyboard(cat, page, totalPages, items) {
  const rows = [];
  for (const p of items) {
    rows.push([
      {
        text: `➕ ${p.nombre} ($${money(p.precio)})`,
        callback_data: `add:${p.codigo}`,
      },
      { text: "📤 Compartir", callback_data: `share:${p.codigo}` },
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
      { text: "➖", callback_data: `dec:${it.codigo}` },
      { text: "❌ Quitar", callback_data: `rm:${it.codigo}` },
      { text: "➕", callback_data: `inc:${it.codigo}` },
    ]);
  }
  rows.push([{ text: "🧹 Vaciar carrito", callback_data: "cart:clear" }]);
  rows.push([{ text: "✅ Finalizar compra", callback_data: "checkout:start" }]);
  rows.push([{ text: "⬅️ Menú", callback_data: "menu:main" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function inlineCheckoutDeliveryKeyboard(config) {
  const rows = [];
  rows.push([
    { text: "🚚 Envío a domicilio", callback_data: "ship:envio" },
    { text: "🏪 Retiro en el local", callback_data: "ship:retiro" },
  ]);
  rows.push([{ text: "⬅️ Cancelar", callback_data: "checkout:cancel" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function inlineZonesKeyboard(config) {
  const zonas = Array.isArray(config.envios?.zonas) ? config.envios.zonas : [];
  const rows = [];
  for (const z of zonas) {
    rows.push([
      {
        text: `${z.nombre} ($${money(z.costo)})`,
        callback_data: `zone:${z.nombre}`,
      },
    ]);
  }
  rows.push([{ text: "⬅️ Volver", callback_data: "checkout:start" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function inlinePaymentKeyboard(config) {
  const methods = Array.isArray(config.pagos?.metodos)
    ? config.pagos.metodos
    : [];
  const rows = [];
  for (const m of methods) {
    const id = m.id || m.label || m.nombre || "pago";
    const label = m.label || m.nombre || id;
    rows.push([{ text: label, callback_data: `pay:${id}` }]);
  }
  rows.push([{ text: "⬅️ Cancelar", callback_data: "checkout:cancel" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function inlineShareKeyboard(links) {
  const rows = [
    [{ text: "📲 WhatsApp", url: links.wa }],
    [{ text: "✉️ Email", url: links.mail }],
    [{ text: "📨 Telegram", url: links.tg }],
  ];
  if (links.web) rows.push([{ text: "🌐 Abrir página", url: links.web }]);
  return { reply_markup: { inline_keyboard: rows } };
}

// -------------------- SMART SUGGEST --------------------

function smartSuggest(config, text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return null;

  const intents = [
    { keys: ["promo", "promos", "oferta", "ofertas"], action: "PROMOS" },
    { keys: ["catalogo", "catálogo", "menu", "menú"], action: "CAT" },
    { keys: ["carrito"], action: "CART" },
    { keys: ["sello", "sellos", "tarjeta"], action: "STAMPS" },
    { keys: ["finalizar", "comprar", "checkout", "pagar"], action: "CHECKOUT" },
  ];

  for (const it of intents) {
    if (it.keys.some((k) => t.includes(k))) return { type: "intent", action: it.action };
  }

  const hits = (config.catalogo || [])
    .filter((p) => {
      const name = String(p.nombre || "").toLowerCase();
      const code = String(p.codigo || "").toLowerCase();
      return name.includes(t) || code === t || t.includes(code);
    })
    .slice(0, 5);

  if (hits.length) return { type: "products", items: hits };

  return null;
}

// -------------------- MENSAJES PRINCIPALES --------------------

async function sendWelcome(chatId, config, username) {
  const negocio = config.negocio || {};
  const bienvenida =
    config.textos?.bienvenida ||
    `👋 Hola, soy el asistente de *${negocio.nombre || "tu negocio favorito"}*.\n\nTocá los botones de abajo para ver el catálogo, armar tu pedido y sumar sellos.`;
  await bot.sendMessage(chatId, bienvenida, {
    parse_mode: "Markdown",
    ...mainMenuKeyboard(config),
  });
}

/**
 * Info del negocio: ahora NO manda datos de dirección/horarios,
 * solo recuerda que están en el flyer/pantalla inicial.
 */
async function showBusinessInfo(chatId, config) {
  const negocio = config.negocio || {};
  const txt =
    `🏪 *${negocio.nombre || "Negocio"}*\n\n` +
    "Toda la info del local (logo, horarios, dirección y redes) aparece en la pantalla de bienvenida y en el flyer inicial. 🧀";
  await bot.sendMessage(chatId, txt, {
    parse_mode: "Markdown",
    ...mainMenuKeyboard(config),
  });
}

async function showCategories(chatId, config) {
  const map = getCatalogByCategory(config);
  const cats = Array.from(map.keys());
  if (!cats.length) {
    await bot.sendMessage(
      chatId,
      "⏳ Todavía no hay productos cargados en el catálogo.",
      mainMenuKeyboard(config)
    );
    return;
  }
  await bot.sendMessage(
    chatId,
    "🛍️ Elegí una categoría:",
    inlineCategoriesKeyboard(cats)
  );
}

async function showCatalogPage(chatId, config, cat, page = 1) {
  const map = getCatalogByCategory(config);
  const items = map.get(cat) || [];
  if (!items.length) {
    await bot.sendMessage(chatId, `No hay productos en *${cat}* por ahora.`, {
      parse_mode: "Markdown",
    });
    return;
  }
  const perPage = Number(config.ui?.itemsPorPagina || 6);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const p = Math.min(Math.max(1, Number(page || 1)), totalPages);
  const slice = items.slice((p - 1) * perPage, (p - 1) * perPage + perPage);

  await bot.sendMessage(
    chatId,
    `*${cat}* — elegí qué querés agregar al carrito:`,
    {
      parse_mode: "Markdown",
      ...inlineCatalogPageKeyboard(cat, p, totalPages, slice),
    }
  );
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
    await bot.sendMessage(
      chatId,
      "🔥 Todavía no hay promos cargadas. ¿Querés que te muestre el catálogo?",
      mainMenuKeyboard(config)
    );
    return;
  }

  const rows = [];
  for (const p of promoItems.slice(0, 12)) {
    rows.push([
      {
        text: `➕ ${p.nombre} ($${money(p.precio)})`,
        callback_data: `add:${p.codigo}`,
      },
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
    await bot.sendMessage(
      chatId,
      "🛒 Tu carrito está vacío. ¿Querés que te muestre el catálogo?",
      mainMenuKeyboard(config)
    );
    return;
  }

  const msg = [];
  msg.push("🛒 *Tu carrito*");
  msg.push("");
  for (const it of lines) {
    msg.push(`• ${it.qty} × ${it.p.nombre} — $${money(it.line)}`);
  }
  msg.push("");
  msg.push(`Subtotal: *$${money(subtotal)}*`);

  await bot.sendMessage(chatId, msg.join("\n"), {
    parse_mode: "Markdown",
    ...inlineCartKeyboard(user),
  });
}

async function showStamps(chatId, config, user) {
  const sellos = config.sellos || { activo: false };
  if (!sellos.activo) {
    await bot.sendMessage(
      chatId,
      "🎫 La tarjeta de sellos todavía no está activa en este negocio.",
      mainMenuKeyboard(config)
    );
    return;
  }
  const meta = Number(sellos.meta || 10);
  const premio = sellos.premio || "un beneficio especial";
  const actuales = Number(user.stamps || 0);
  const filled = Math.min(meta, actuales);
  const bar =
    "🟩".repeat(filled) + "⬜️".repeat(Math.max(0, meta - filled));

  const txt =
    `🎫 *${sellos.nombre || "Tarjeta de Sellos"}*\n` +
    `${bar}\n\n` +
    `Sellos: *${actuales} / ${meta}*\n` +
    `Premio al completar: *${premio}*\n\n` +
    `Tip: al finalizar una compra, se suma 1 sello automáticamente (configurable).`;

  await bot.sendMessage(chatId, txt, {
    parse_mode: "Markdown",
    ...mainMenuKeyboard(config),
  });
}

// -------------------- CHECKOUT + TICKET POS --------------------

async function startCheckout(chatId, config, user) {
  const { subtotal, lines } = calcCartTotals(config, user);
  if (!lines.length) {
    await bot.sendMessage(
      chatId,
      "Tu carrito está vacío. Primero agregá algo del catálogo 🙂",
      mainMenuKeyboard(config)
    );
    return;
  }

  user.checkout = {
    paso: "envio_tipo",
    envioTipo: "",
    zona: "",
    direccion: "",
    pago: "",
  };
  saveData(DB);

  await bot.sendMessage(
    chatId,
    "✅ *Finalizar compra*\nElegí cómo querés recibir tu pedido:",
    {
      parse_mode: "Markdown",
      ...inlineCheckoutDeliveryKeyboard(config),
    }
  );
}

const askAddress = (chatId) =>
  bot.sendMessage(
    chatId,
    "📍 Pasame tu *dirección completa* (calle + número + entre calles / referencia).",
    { parse_mode: "Markdown" }
  );

const askName = (chatId) =>
  bot.sendMessage(chatId, "🧾 Decime tu *nombre* para el pedido.", {
    parse_mode: "Markdown",
  });

const askPhone = (chatId) =>
  bot.sendMessage(
    chatId,
    "📞 Pasame tu *teléfono* (así coordinamos si hace falta).",
    { parse_mode: "Markdown" }
  );

async function askPayment(chatId, config) {
  const methods = Array.isArray(config.pagos?.metodos)
    ? config.pagos.metodos
    : [];
  if (!methods.length) {
    await bot.sendMessage(
      chatId,
      "💳 No hay métodos de pago configurados todavía (configuralos en config.json).",
      mainMenuKeyboard(config)
    );
    return;
  }
  await bot.sendMessage(chatId, "💳 Elegí método de pago:", inlinePaymentKeyboard(config));
}

/**
 * Ticket POS (para cliente y vendedor)
 */
function buildOrderSummary(config, user, chatId, username, opts = {}) {
  const negocio = config.negocio || {};
  const { subtotal, lines } = calcCartTotals(config, user);
  const ship = calcShipping(config, subtotal, user.checkout);
  const total = subtotal + Number(ship.costo || 0);

  const profileName = user.profile?.nombre || "";
  const profilePhone = user.profile?.telefono || "";
  const pago = user.checkout.pago || "-";
  const envioTipo =
    user.checkout.envioTipo === "envio"
      ? "Envío a domicilio"
      : "Retiro en el local";

  const parts = [];
  parts.push("🧾 *Ticket de compra*");
  parts.push(`*${negocio.nombre || "Negocio"}*`);
  parts.push("────────────────────");
  parts.push(
    `👤 Cliente: ${
      profileName || (username ? `@${username}` : "sin nombre")
    }`
  );
  if (profilePhone) parts.push(`📞 Tel: ${profilePhone}`);
  parts.push(`🆔 ChatID: ${chatId}`);
  parts.push("────────────────────");
  parts.push("*Detalle:*");
  for (const it of lines) {
    parts.push(`• ${it.qty} × ${it.p.nombre} — $${money(it.line)}`);
  }
  parts.push("────────────────────");
  parts.push(`Subtotal:      *$${money(subtotal)}*`);
  parts.push(`${ship.label}:  *$${money(ship.costo)}*`);
  parts.push(`TOTAL:         *$${money(total)}*`);
  parts.push("────────────────────");
  parts.push(`🚚 Entrega: *${envioTipo}*`);
  if (user.checkout.envioTipo === "envio") {
    if (user.checkout.zona) parts.push(`🗺️ Zona: ${user.checkout.zona}`);
    if (user.checkout.direccion)
      parts.push(`📍 Dirección: ${user.checkout.direccion}`);
  }
  parts.push(`💳 Pago: *${pago}*`);

  if (opts.tipo === "vendedor" && pago.toLowerCase().includes("transfer")) {
    parts.push("");
    parts.push(
      "⚠️ Pago por *transferencia* — esperar confirmación antes de preparar el pedido."
    );
  }
  if (opts.tipo === "cliente" && pago.toLowerCase().includes("transfer")) {
    parts.push("");
    parts.push(
      "ℹ️ Elegiste *transferencia*. Recordá enviar el comprobante al vendedor."
    );
  }

  return parts.join("\n");
}

async function finalizeOrder(chatId, config, user, username) {
  // sellos
  if (config.sellos?.activo) {
    const suma = Number(config.sellos?.sumaPorCompra || 1);
    user.stamps = Number(user.stamps || 0) + (Number.isFinite(suma) ? suma : 1);
    const meta = Number(config.sellos?.meta || 10);
    if (meta > 0 && user.stamps >= meta) {
      const premio = config.sellos?.premio || "un beneficio";
      const reset = config.sellos?.resetAlCompletar ?? true;
      await bot.sendMessage(
        chatId,
        `🎉 ¡Felicitaciones! Completaste tu tarjeta de sellos y ganaste: *${premio}*`,
        { parse_mode: "Markdown" }
      );
      if (reset) user.stamps = 0;
    }
  }

  // TICKET POS para cliente
  const ticketCliente = buildOrderSummary(config, user, chatId, username, {
    tipo: "cliente",
  });
  await bot.sendMessage(chatId, ticketCliente, {
    parse_mode: "Markdown",
  });

  // TICKET POS para vendedor (ADMIN)
  if (ADMIN_CHAT_ID) {
    try {
      const ticketVendedor = buildOrderSummary(
        config,
        user,
        chatId,
        username,
        { tipo: "vendedor" }
      );
      await bot.sendMessage(ADMIN_CHAT_ID, ticketVendedor, {
        parse_mode: "Markdown",
      });
    } catch (e) {
      console.error("No pude enviar ticket al ADMIN:", e?.message || e);
    }
  }

  const confirmText =
    config.textos?.pedidoConfirmado ||
    "✅ ¡Listo! Te envié tu ticket de compra.\nCuando el vendedor confirme el pago, va a preparar tu pedido. 🙌";

  await bot.sendMessage(chatId, confirmText, {
    parse_mode: "Markdown",
    ...mainMenuKeyboard(config),
  });

  clearCart(user);
  user.checkout = { paso: "", envioTipo: "", zona: "", direccion: "", pago: "" };
  saveData(DB);
}

// -------------------- HANDLERS --------------------

bot.onText(/\/start/, async (msg) => {
  try {
    const config = await fetchConfig();
    await sendWelcome(msg.chat.id, config, msg.from?.username);
  } catch (e) {
    console.error(e);
    bot.sendMessage(
      msg.chat.id,
      "Hubo un problema cargando la configuración. Probá de nuevo en unos segundos."
    );
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

    // flujo de checkout
    if (user.checkout?.paso) {
      if (user.checkout.paso === "esperando_direccion") {
        user.checkout.direccion = text;
        user.checkout.paso = "esperando_nombre";
        saveData(DB);
        await askName(chatId);
        return;
      }
      if (user.checkout.paso === "esperando_nombre") {
        user.profile.nombre = text;
        user.checkout.paso = "esperando_telefono";
        saveData(DB);
        await askPhone(chatId);
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

    // teclado principal
    if (text === "🛍️ Catálogo") return await showCategories(chatId, config);
    if (text === "🛒 Mi carrito") return await showCart(chatId, config, user);
    if (text === "✅ Finalizar compra")
      return await startCheckout(chatId, config, user);
    if (text === "🎫 Tarjeta de sellos")
      return await showStamps(chatId, config, user);

    if (text === "📣 Compartir el bot") {
      const me = await bot.getMe();
      const links = buildShareLinks(
        me.username,
        config.negocio?.nombre || "el negocio",
        PUBLIC_URL
      );
      return await bot.sendMessage(
        chatId,
        "📣 Elegí cómo querés compartir el bot:",
        inlineShareKeyboard(links)
      );
    }

    // smart
    if (text) {
      const s = smartSuggest(config, text);
      if (s?.type === "intent") {
        if (s.action === "PROMOS") return await showPromos(chatId, config);
        if (s.action === "CAT") return await showCategories(chatId, config);
        if (s.action === "CART") return await showCart(chatId, config, user);
        if (s.action === "STAMPS")
          return await showStamps(chatId, config, user);
        if (s.action === "CHECKOUT")
          return await startCheckout(chatId, config, user);
      }

      if (s?.type === "products") {
        const rows = [];
        for (const p of s.items) {
          rows.push([
            {
              text: `➕ ${p.nombre} ($${money(p.precio)})`,
              callback_data: `add:${p.codigo}`,
            },
          ]);
        }
        rows.push([{ text: "🛒 Ver carrito", callback_data: "cart:view" }]);
        rows.push([{ text: "🛍️ Ver categorías", callback_data: "cats:list" }]);

        await bot.sendMessage(
          chatId,
          `Encontré estas opciones para *"${safeText(text, 40)}"* (tocá para agregar):`,
          {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: rows },
          }
        );
        return;
      }

      const fallback =
        config.textos?.fallback ||
        "🙂 Decime qué estás buscando (ej: *picada*, *queso*, *pan*) o tocá una opción del menú.";
      await bot.sendMessage(chatId, fallback, {
        parse_mode: "Markdown",
        ...mainMenuKeyboard(config),
      });
    }
  } catch (e) {
    console.error(e);
    try {
      await bot.sendMessage(
        msg.chat.id,
        "Hubo un error. Probá de nuevo en unos segundos."
      );
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

    if (data.startsWith("add:")) {
      await ack();
      const codigo = data.slice(4);
      const p = findProduct(config, codigo);
      if (!p)
        return await bot.sendMessage(
          chatId,
          "Ese producto no existe (revisá el config)."
        );
      addToCart(user, codigo, 1);
      saveData(DB);
      await bot.sendMessage(
        chatId,
        `✅ Agregado: *${p.nombre}*\n¿Querés seguir mirando el catálogo o ir al carrito?`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🛍️ Seguir viendo", callback_data: "cats:list" }],
              [{ text: "🛒 Ver carrito", callback_data: "cart:view" }],
            ],
          },
        }
      );
      return;
    }

    if (data.startsWith("share:")) {
      await ack();
      const codigo = data.slice(6);
      const p = findProduct(config, codigo);
      if (!p) {
        return await bot.sendMessage(
          chatId,
          "No encontré ese producto para compartir."
        );
      }
      const negocioNombre = config.negocio?.nombre || "el negocio";
      const text = encodeURIComponent(
        `Mirá este producto de ${negocioNombre}:\n\n${p.nombre} - $${money(
          p.precio
        )}`
      );
      const wa = `https://wa.me/?text=${text}`;
      const me = await bot.getMe();
      const botUrl = `https://t.me/${me.username}`;
      const tg = `https://t.me/share/url?url=${encodeURIComponent(
        botUrl
      )}&text=${text}`;
      const mail = `mailto:?subject=${encodeURIComponent(
        "Te comparto un producto"
      )}&body=${text}`;
      const rows = [
        [{ text: "📲 WhatsApp", url: wa }],
        [{ text: "✉️ Email", url: mail }],
        [{ text: "📨 Telegram", url: tg }],
      ];
      await bot.sendMessage(
        chatId,
        "Elegí cómo querés compartir este producto:",
        { reply_markup: { inline_keyboard: rows } }
      );
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
      return await bot.sendMessage(
        chatId,
        "🧹 Listo, vacié el carrito.",
        mainMenuKeyboard(config)
      );
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
      user.checkout = {
        paso: "",
        envioTipo: "",
        zona: "",
        direccion: "",
        pago: "",
      };
      saveData(DB);
      return await bot.sendMessage(
        chatId,
        "Listo, cancelé el checkout.",
        mainMenuKeyboard(config)
      );
    }

    if (data.startsWith("ship:")) {
      await ack();
      const tipo = data.split(":")[1];
      user.checkout.envioTipo = tipo;

      if (tipo === "retiro") {
        user.checkout.paso = "esperando_nombre";
        saveData(DB);
        await askName(chatId);
        return;
      }

      const zonas = Array.isArray(config.envios?.zonas)
        ? config.envios.zonas
        : [];
      if (zonas.length) {
        user.checkout.paso = "zona";
        saveData(DB);
        await bot.sendMessage(
          chatId,
          "🗺️ Elegí tu zona de envío:",
          inlineZonesKeyboard(config)
        );
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
      const methods = Array.isArray(config.pagos?.metodos)
        ? config.pagos.metodos
        : [];
      const method =
        methods.find((m) => String(m.id || m.label) === String(payId)) ||
        null;
      user.checkout.pago =
        method?.label || method?.nombre || String(payId);
      saveData(DB);

      const summary = buildOrderSummary(config, user, chatId, q.from?.username, {
        tipo: "cliente",
      });
      await bot.sendMessage(chatId, summary, { parse_mode: "Markdown" });

      const rows = [
        [{ text: "✅ Confirmar pedido", callback_data: "order:confirm" }],
        [{ text: "❌ Cancelar", callback_data: "checkout:cancel" }],
      ];
      await bot.sendMessage(chatId, "¿Confirmás el pedido?", {
        reply_markup: { inline_keyboard: rows },
      });
      return;
    }

    if (data === "order:confirm") {
      await ack();
      return await finalizeOrder(chatId, config, user, q.from?.username);
    }

    if (data === "search:ask") {
      await ack();
      await bot.sendMessage(
        chatId,
        "🔎 Escribime qué estás buscando (ej: *picada*, *queso*, *pan*).",
        { parse_mode: "Markdown" }
      );
      return;
    }

    await ack();
  } catch (e) {
    console.error(e);
    try {
      await bot.answerCallbackQuery(q.id, {
        text: "Hubo un error. Probá de nuevo.",
      });
    } catch {}
  }
});

// -------------------- WEBHOOK SERVER --------------------

async function start() {
  const config = await fetchConfig();
  console.log(
    `Config OK: negocio="${config.negocio?.nombre || "-"}", productos=${
      config.catalogo?.length || 0
    }`
  );

  if (PUBLIC_URL) {
    await ensureWebhook();
    const hookPath = `/telegram/${BOT_TOKEN}`;
    const server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === hookPath) {
        let body = "";
        req.on("data", (c) => (body += c));
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
    server.listen(PORT, () =>
      console.log(`Escuchando en puerto ${PORT} (webhook)`)
    );
  } else {
    console.log("Bot activo (polling).");
  }
}

start().catch((e) => {
  console.error("Error iniciando:", e?.message || e);
  process.exit(1);
});

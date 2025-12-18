/**
 * EzerBot System — index.js (UN SOLO ARCHIVO)
 *
 * - Telegram Bot + Webhook (Render) o Polling (local)
 * - Lee TODO desde CONFIG_URL (config.json generado desde tu hoja EZERBOT-SYSTEM)
 * - Catálogo por categorías + fichas con imagen
 * - Carrito + cantidad en UNIDADES o GRAMOS
 * - Checkout: Retiro / Envío a domicilio (con costo)
 * - Pago: Efectivo + Transferencia (Alias/CBU desde Config)
 * - Ticket tipo POS al vendedor + confirmación al cliente
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
      cart: [], // [{codigo, qty, unitType:'u'|'g'}]
      stamps: 0,
      profile: { nombre: "", telefono: "" },
      checkout: {
        paso: "",
        envioTipo: "", // retiro | envio
        zona: "",
        direccion: "",
        horario: "",
        pago: "",
        pagoId: "",
      },
      pendingQty: null, // {codigo, unitType, nombre}
      lastSeen: Date.now(),
    };
    saveData(db);
  }
  db.users[key].lastSeen = Date.now();
  return db.users[key];
}

function addToCartUnits(user, codigo, units) {
  const q = Math.max(1, Number(units || 1));
  const item = user.cart.find(
    (x) => x.codigo === codigo && x.unitType === "u"
  );
  if (item) item.qty += q;
  else user.cart.push({ codigo, qty: q, unitType: "u" });
}

function addToCartGrams(user, codigo, grams) {
  const g = Math.max(1, Number(grams || 1));
  const item = user.cart.find(
    (x) => x.codigo === codigo && x.unitType === "g"
  );
  if (item) item.qty += g;
  else user.cart.push({ codigo, qty: g, unitType: "g" });
}

function removeFromCart(user, codigo) {
  user.cart = user.cart.filter((x) => x.codigo !== codigo);
}

function clearCart(user) {
  user.cart = [];
}

let BOT_USERNAME = "";

// -------------------- CONFIG CACHE --------------------
let CONFIG_CACHE = null;
let CONFIG_CACHE_AT = 0;
const CONFIG_TTL_MS = 30_000; // 30s

async function fetchConfig() {
  const now = Date.now();
  if (CONFIG_CACHE && now - CONFIG_CACHE_AT < CONFIG_TTL_MS) return CONFIG_CACHE;

  const url = new URL(CONFIG_URL);
  const res = await fetch(url.toString(), {
    headers: { "cache-control": "no-cache" },
  });
  if (!res.ok) throw new Error(`No pude leer config.json (HTTP ${res.status})`);
  const cfg = await res.json();

  // ---------- Normalización usando tu hoja Config ----------
  if (!cfg.negocio) cfg.negocio = {};
  if (cfg.NegocioNombre && !cfg.negocio.nombre)
    cfg.negocio.nombre = cfg.NegocioNombre;
  if (cfg.Dirección && !cfg.negocio.direccion)
    cfg.negocio.direccion = cfg.Dirección;
  if (cfg.Horarios && !cfg.negocio.horarios)
    cfg.negocio.horarios = cfg.Horarios;
  if (cfg.TeléfonoNegocio && !cfg.negocio.telefono)
    cfg.negocio.telefono = cfg.TeléfonoNegocio;
  if (cfg.Instagram && !cfg.negocio.instagram)
    cfg.negocio.instagram = cfg.Instagram;
  if (cfg.LogoURL && !cfg.negocio.logoUrl) cfg.negocio.logoUrl = cfg.LogoURL;

  if (!Array.isArray(cfg.catalogo)) cfg.catalogo = cfg.catalogo || [];
  if (!Array.isArray(cfg.promos)) cfg.promos = cfg.promos || [];

  if (!cfg.textos) cfg.textos = {};
  if (!cfg.textos.bienvenida) {
    const desc =
      cfg.Descripcion ||
      "Aquí encontrás los mejores precios, picadas ricas y beneficios por ser parte del club.";
    const nom = cfg.negocio.nombre || "nuestro local";
    cfg.textos.bienvenida =
      `👋 ¡Hola!\nSoy el bot de *${nom}*.\n\n` +
      `${desc}\n\n` +
      `✅ Podés ver el catálogo por categorías, armar tu carrito y finalizar tu pedido.\n` +
      `👇 Elegí una opción del menú para empezar:`;
  }
  if (!cfg.textos.pedidoConfirmado && cfg.TextoConfirmacionPedido)
    cfg.textos.pedidoConfirmado = cfg.TextoConfirmacionPedido;

  // ENVÍOS
  if (!cfg.envios) cfg.envios = {};
  const usaEnvio =
    cfg.UsaEnvíoDomicilio === "SI" || cfg.UsaEnvioDomicilio === "SI";
  if (usaEnvio) cfg.envios.activo = true;
  if (!cfg.envios.costo && cfg.CostoEnvíoBase)
    cfg.envios.costo = Number(cfg.CostoEnvíoBase || 0);
  if (!cfg.envios.texto && cfg.TextoEnvíoDomicilio)
    cfg.envios.texto = cfg.TextoEnvíoDomicilio;

  // PAGOS
  if (!cfg.pagos) cfg.pagos = {};
  if (!Array.isArray(cfg.pagos.metodos) || !cfg.pagos.metodos.length) {
    cfg.pagos.metodos = [{ id: "efectivo", label: "Efectivo" }];
    const permiteOnline = cfg.PermitirPagoOnline === "SI";
    const tipo = String(cfg.TipoPagoOnline || "").toUpperCase();
    if (permiteOnline && tipo.includes("TRANSFER")) {
      cfg.pagos.metodos.push({
        id: "transferencia",
        label: "Transferencia",
        alias: cfg.AliasPago || "",
        cbu: cfg.CBUPago || "",
      });
    }
  } else {
    cfg.pagos.metodos = cfg.pagos.metodos.map((m) => ({
      ...m,
      id:
        m.id ||
        (m.label || m.nombre || "").toLowerCase().replace(/\s+/g, "_"),
    }));
  }

  // SELLOS (solo activación simple)
  if (!cfg.sellos) cfg.sellos = {};
  if (cfg.UsaSellos === "SI") cfg.sellos.activo = true;

  CONFIG_CACHE = cfg;
  CONFIG_CACHE_AT = now;
  return cfg;
}

// -------------------- CATALOGO HELPERS --------------------
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

// qty: unidades o gramos
function calcCartTotals(config, user) {
  let subtotal = 0;
  const lines = [];
  for (const it of user.cart) {
    const p = findProduct(config, it.codigo);
    if (!p) continue;
    const precioBase = Number(p.precio || p.precioPorKg || 0);
    let line = 0;
    let labelQty = "";
    if (it.unitType === "g") {
      const kg = it.qty / 1000;
      line = precioBase * kg;
      labelQty = `${it.qty}g ×`;
    } else {
      line = precioBase * it.qty;
      labelQty = `${it.qty} ×`;
    }
    subtotal += line;
    lines.push({ p, qty: it.qty, unitType: it.unitType, line, labelQty });
  }
  return { subtotal, lines };
}

function calcShipping(config, subtotal, checkout) {
  const env = config.envios || {};
  const activo =
    env.activo ||
    config.UsaEnvíoDomicilio === "SI" ||
    config.UsaEnvioDomicilio === "SI";
  if (!activo) return { costo: 0, label: "Retiro en el local" };

  if (checkout.envioTipo === "retiro")
    return { costo: 0, label: "Retiro en el local" };

  const base =
    Number(env.costo || 0) || Number(config.CostoEnvíoBase || 0) || 0;
  return { costo: base, label: "Envío a domicilio" };
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

// -------------------- UI (TECLADOS) --------------------
function mainMenuKeyboard(config) {
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
  const rows = [];
  for (const cat of categories) {
    rows.push([{ text: cat, callback_data: `cat:${cat}` }]);
  }
  rows.push([{ text: "⬅️ Menú", callback_data: "menu:main" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

// Ficha de producto (una por vez)
function productCardKeyboard(cat, index, total) {
  const rows = [];
  rows.push([
    { text: "🟢 Quiero éste", callback_data: `padd:${cat}:${index}` },
    { text: "📣 Compartir", callback_data: `pshare:${cat}:${index}` },
  ]);

  const nav = [];
  nav.push({
    text: "⬅️ Anterior",
    callback_data: `pnav:${cat}:${Math.max(index - 1, 0)}`,
  });
  nav.push({
    text: `📄 ${index + 1}/${total}`,
    callback_data: "noop",
  });
  nav.push({
    text: "➡️ Siguiente",
    callback_data: `pnav:${cat}:${Math.min(index + 1, total - 1)}`,
  });
  rows.push(nav);
  rows.push([{ text: "🛍️ Categorías", callback_data: "cats:list" }]);

  return { reply_markup: { inline_keyboard: rows } };
}

function inlineCartKeyboard(user) {
  const rows = [];
  for (const it of user.cart) {
    rows.push([
      { text: "❌ Quitar", callback_data: `rm:${it.codigo}` },
    ]);
  }
  rows.push([{ text: "🧹 Vaciar carrito", callback_data: "cart:clear" }]);
  rows.push([{ text: "✅ Finalizar compra", callback_data: "checkout:start" }]);
  rows.push([{ text: "⬅️ Menú", callback_data: "menu:main" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function inlineCheckoutDeliveryKeyboard(config) {
  const env = config.envios || {};
  const rows = [];
  rows.push([
    { text: "🏬 Retiro en el local", callback_data: "ship:retiro" },
  ]);

  const envioActivo =
    env.activo ||
    config.UsaEnvíoDomicilio === "SI" ||
    config.UsaEnvioDomicilio === "SI";
  if (envioActivo) {
    const base =
      Number(env.costo || 0) || Number(config.CostoEnvíoBase || 0) || 0;
    const label =
      base > 0
        ? `🚚 Envío a domicilio (+$${money(base)})`
        : "🚚 Envío a domicilio";
    rows.push([{ text: label, callback_data: "ship:envio" }]);
  }
  rows.push([{ text: "❌ Cancelar", callback_data: "checkout:cancel" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function inlinePaymentKeyboard(config) {
  const methods = Array.isArray(config.pagos?.metodos)
    ? config.pagos.metodos
    : [];
  const rows = [];
  for (const m of methods) {
    rows.push([
      {
        text: m.label || m.nombre || "Pago",
        callback_data: `pay:${m.id || m.label}`,
      },
    ]);
  }
  rows.push([{ text: "❌ Cancelar", callback_data: "checkout:cancel" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function inlineShareKeyboardForBot() {
  const url = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}` : "";
  return {
    reply_markup: {
      inline_keyboard: [
        ...(url
          ? [[{ text: "🤖 Abrir el bot", url }]]
          : []),
      ],
    },
  };
}

// -------------------- MENSAJES PRINCIPALES --------------------
async function sendWelcome(chatId, config) {
  const negocio = config.negocio || {};
  const bienvenida = config.textos?.bienvenida;
  const opts = { parse_mode: "Markdown", ...mainMenuKeyboard(config) };

  const logo = negocio.logoUrl || config.LogoURL;
  if (logo) {
    await bot.sendPhoto(chatId, logo, { caption: bienvenida, ...opts });
  } else {
    await bot.sendMessage(chatId, bienvenida, opts);
  }
}

async function showBusinessInfo(chatId, config) {
  const n = config.negocio || {};
  const lines = [];
  lines.push(`🏪 *${n.nombre || "Negocio"}*`);
  if (n.direccion) lines.push(`📍 ${n.direccion}`);
  if (n.horarios) lines.push(`🕒 ${n.horarios}`);
  if (n.telefono) lines.push(`📞 ${n.telefono}`);
  if (n.instagram) lines.push(`📸 ${n.instagram}`);
  await bot.sendMessage(chatId, lines.join("\n"), {
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

async function showProductCard(chatId, config, cat, index) {
  const map = getCatalogByCategory(config);
  const items = map.get(cat) || [];
  if (!items.length) {
    await bot.sendMessage(
      chatId,
      `No hay productos en *${cat}* por ahora.`,
      { parse_mode: "Markdown" }
    );
    return;
  }
  const total = items.length;
  let i = Number(index || 0);
  if (i < 0) i = 0;
  if (i >= total) i = total - 1;
  const p = items[i];

  const unidad = (p.unidad || "").toLowerCase();
  let precioLine = `$${money(p.precio)}`;
  if (unidad === "kg") precioLine = `$${money(p.precio)} / kg`;
  else if (unidad) precioLine = `$${money(p.precio)} ${unidad}`;

  const caption =
    `*${p.nombre}*\n` +
    `💰 ${precioLine}\n` +
    (p.descripcion ? `📝 ${p.descripcion}` : "");

  if (p.imagen) {
    await bot.sendPhoto(chatId, p.imagen, {
      caption,
      parse_mode: "Markdown",
      ...productCardKeyboard(cat, i, total),
    });
  } else {
    await bot.sendMessage(chatId, caption, {
      parse_mode: "Markdown",
      ...productCardKeyboard(cat, i, total),
    });
  }
}

async function showPromos(chatId, config) {
  // promos desde array o categoría "Promos"
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

  // mostramos la primera promo como ficha, usando categoría especial "Promos"
  const tempConfig = {
    ...config,
    catalogo: promoItems.map((p) => ({ ...p, categoria: "Promos" })),
  };
  await showProductCard(chatId, tempConfig, "Promos", 0);
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
    msg.push(
      `• ${it.labelQty} ${it.p.nombre} — $${money(it.line)}`
    );
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
  const bar = "🟩".repeat(filled) + "⬜️".repeat(Math.max(0, meta - filled));

  const txt =
    `🎫 *${sellos.nombre || "Tarjeta de Sellos"}*\n` +
    `${bar}\n\n` +
    `Sellos: *${actuales} / ${meta}*\n` +
    `Premio al completar: *${premio}*`;

  await bot.sendMessage(chatId, txt, {
    parse_mode: "Markdown",
    ...mainMenuKeyboard(config),
  });
}

// -------------------- CHECKOUT --------------------
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
    horario: "",
    pago: "",
    pagoId: "",
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

async function askAddress(chatId) {
  await bot.sendMessage(
    chatId,
    "📍 Pasame tu *dirección completa* (calle + número + entre calles / referencia).",
    { parse_mode: "Markdown" }
  );
}

async function askName(chatId) {
  await bot.sendMessage(chatId, "🧾 Decime tu *nombre* para el pedido.", {
    parse_mode: "Markdown",
  });
}

async function askPhone(chatId) {
  await bot.sendMessage(
    chatId,
    "📞 Pasame tu *teléfono* (así coordinamos si hace falta).",
    { parse_mode: "Markdown" }
  );
}

async function askHorario(chatId) {
  await bot.sendMessage(
    chatId,
    "⏰ ¿En qué horario te queda mejor pasar o recibir el pedido?",
    { parse_mode: "Markdown" }
  );
}

async function askPayment(chatId, config) {
  const methods = Array.isArray(config.pagos?.metodos)
    ? config.pagos.metodos
    : [];
  if (!methods.length) {
    await bot.sendMessage(
      chatId,
      "💳 No hay métodos de pago configurados todavía.",
      mainMenuKeyboard(config)
    );
    return;
  }
  await bot.sendMessage(chatId, "💳 Elegí método de pago:", {
    ...inlinePaymentKeyboard(config),
  });
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
  parts.push(
    `👤 Cliente: ${profileName || (username ? `@${username}` : "")}`.trim()
  );
  if (profilePhone) parts.push(`📞 Tel: ${profilePhone}`);
  parts.push("");

  parts.push("*Detalle:*");
  for (const it of lines) {
    parts.push(
      `• ${it.labelQty} ${it.p.nombre} — $${money(it.line)}`
    );
  }
  parts.push("");
  parts.push(`Subtotal: *$${money(subtotal)}*`);
  parts.push(`${ship.label}: *$${money(ship.costo)}*`);
  parts.push(`TOTAL: *$${money(total)}*`);
  parts.push("");

  if (user.checkout.envioTipo === "envio") {
    parts.push("🏠 Entrega: Envío a domicilio");
    if (user.checkout.direccion)
      parts.push(`📍 Dirección: ${user.checkout.direccion}`);
  } else {
    parts.push("🏬 Entrega: Retiro en el local");
  }
  if (user.checkout.horario)
    parts.push(`⏰ Horario preferido: ${user.checkout.horario}`);

  if (user.checkout.pago)
    parts.push(`💳 Pago: ${user.checkout.pago}`);

  // Datos de transferencia si corresponde
  const isTransfer =
    user.checkout.pagoId === "transferencia" ||
    /transfer/i.test(user.checkout.pago || "");
  if (isTransfer && (config.AliasPago || config.CBUPago)) {
    parts.push("");
    parts.push("📄 *Datos para transferencia:*");
    if (config.AliasPago)
      parts.push(`• Alias: \`${config.AliasPago}\``);
    if (config.CBUPago)
      parts.push(`• CBU: \`${config.CBUPago}\``);
  }

  parts.push("");
  parts.push(`🆔 ChatID cliente: ${chatId}`);

  return parts.join("\n");
}

async function finalizeOrder(chatId, config, user, username) {
  // sellos simples
  if (config.sellos?.activo) {
    const suma = Number(config.sellos?.sumaPorCompra || 1);
    user.stamps = Number(user.stamps || 0) + (Number.isFinite(suma) ? suma : 1);
  }

  const summary = buildOrderSummary(config, user, chatId, username);

  if (ADMIN_CHAT_ID) {
    try {
      await bot.sendMessage(ADMIN_CHAT_ID, summary, { parse_mode: "Markdown" });
    } catch (e) {
      console.error("No pude enviar al ADMIN_CHAT_ID:", e?.message || e);
    }
  }

  const confirmText =
    config.textos?.pedidoConfirmado ||
    "✅ ¡Listo! Ya tomé tu pedido.\n\nEn un momento te confirmamos la preparación. 🙌";

  await bot.sendMessage(chatId, safeText(confirmText), {
    ...mainMenuKeyboard(config),
  });

  clearCart(user);
  user.checkout = {
    paso: "",
    envioTipo: "",
    zona: "",
    direccion: "",
    horario: "",
    pago: "",
    pagoId: "",
  };
  saveData(DB);
}

// -------------------- HANDLERS --------------------
bot.onText(/\/start/, async (msg) => {
  try {
    const config = await fetchConfig();
    const chatId = msg.chat.id;
    await sendWelcome(chatId, config);
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

    // Atajo: si dice "hola" mandamos bienvenida
    if (/^hola\b/i.test(text)) {
      await sendWelcome(chatId, config);
      return;
    }

    // Si estamos esperando cantidad para un producto
    if (user.pendingQty && text) {
      const num = parseInt(text.replace(/[^\d]/g, ""), 10);
      if (!Number.isFinite(num) || num <= 0) {
        await bot.sendMessage(
          chatId,
          "Necesito un número válido. Ejemplo: 250 o 1."
        );
        return;
      }
      if (user.pendingQty.unitType === "g") {
        addToCartGrams(user, user.pendingQty.codigo, num);
        await bot.sendMessage(
          chatId,
          `✅ Agregué ${num}g de *${user.pendingQty.nombre}* al carrito.`,
          { parse_mode: "Markdown" }
        );
      } else {
        addToCartUnits(user, user.pendingQty.codigo, num);
        await bot.sendMessage(
          chatId,
          `✅ Agregué ${num} unidad(es) de *${user.pendingQty.nombre}* al carrito.`,
          { parse_mode: "Markdown" }
        );
      }
      user.pendingQty = null;
      saveData(DB);
      return;
    }

    // Flujo de checkout por texto
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
        user.checkout.paso = "esperando_horario";
        saveData(DB);
        await askHorario(chatId);
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

    // Botones de teclado principal
    if (text === "🛍️ Catálogo") return await showCategories(chatId, config);
    if (text === "🔥 Promos") return await showPromos(chatId, config);
    if (text === "🛒 Mi carrito") return await showCart(chatId, config, user);
    if (text === "✅ Finalizar compra")
      return await startCheckout(chatId, config, user);
    if (text === "📍 Horarios y dirección")
      return await showBusinessInfo(chatId, config);
    if (text === "📣 Compartir bot") {
      try {
        const url = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}` : "";
        const msgShare =
          url
            ? `📣 Podés compartir este bot con tus contactos reenviando este mensaje o pasando este enlace:\n${url}`
            : "📣 Podés compartir este bot reenviando este mensaje a tus contactos.";
        await bot.sendMessage(chatId, msgShare, inlineShareKeyboardForBot());
      } catch (e) {
        console.error("Error en Compartir bot:", e?.message || e);
        await bot.sendMessage(
          chatId,
          "Podés compartir este bot reenviando este mensaje a tus contactos."
        );
      }
      return;
    }

    // Texto libre: intentamos sugerir o simplemente respondemos amable
    if (text) {
      const fallback =
        "🙂 Decime qué estás buscando (por ejemplo: *picada*, *queso*, *promo*) o tocá una opción del menú.";
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
      return await sendWelcome(chatId, config);
    }

    if (data === "cats:list") {
      await ack();
      return await showCategories(chatId, config);
    }

    if (data.startsWith("cat:")) {
      await ack();
      const cat = data.slice(4);
      return await showProductCard(chatId, config, cat, 0);
    }

    // Navegación de fichas
    if (data.startsWith("pnav:")) {
      await ack();
      const [, cat, idx] = data.split(":");
      return await showProductCard(chatId, config, cat, Number(idx || 0));
    }

    // Agregar producto (padd:cat:index)
    if (data.startsWith("padd:")) {
      await ack();
      const [, cat, idx] = data.split(":");
      const map = getCatalogByCategory(config);
      const items = map.get(cat) || [];
      const i = Number(idx || 0);
      const p = items[i];
      if (!p)
        return await bot.sendMessage(
          chatId,
          "Ese producto no existe (revisá el catálogo)."
        );

      const unidad = (p.unidad || "").toLowerCase();
      if (unidad === "kg") {
        user.pendingQty = {
          codigo: p.codigo,
          unitType: "g",
          nombre: p.nombre,
        };
        saveData(DB);
        await bot.sendMessage(
          chatId,
          `⚖️ ¿Cuántos *gramos* querés de *${p.nombre}*?\n\nEscribí solo el número (ej: 250, 500, 1000).`,
          { parse_mode: "Markdown" }
        );
      } else {
        user.pendingQty = {
          codigo: p.codigo,
          unitType: "u",
          nombre: p.nombre,
        };
        saveData(DB);
        await bot.sendMessage(
          chatId,
          `🔢 ¿Cuántas *unidades* querés de *${p.nombre}*?\n\nEscribí solo el número (ej: 1, 2, 3).`,
          { parse_mode: "Markdown" }
        );
      }
      return;
    }

    // Compartir ficha (mensaje simple)
    if (data.startsWith("pshare:")) {
      await ack();
      const [, cat, idx] = data.split(":");
      const map = getCatalogByCategory(config);
      const items = map.get(cat) || [];
      const i = Number(idx || 0);
      const p = items[i];
      const url = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}` : "";
      const txt =
        `📣 Compartí este producto de *${config.negocio?.nombre || "Todo Queso"}*:\n\n` +
        `• ${p?.nombre || "Producto"}\n` +
        (url ? `Abrí el bot acá: ${url}` : "");
      await bot.sendMessage(chatId, txt, { parse_mode: "Markdown" });
      return;
    }

    // Carrito
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

    if (data.startsWith("rm:")) {
      await ack();
      const codigo = data.slice(3);
      removeFromCart(user, codigo);
      saveData(DB);
      return await showCart(chatId, config, user);
    }

    // Checkout
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
        horario: "",
        pago: "",
        pagoId: "",
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
      const tipo = data.split(":")[1]; // retiro | envio
      user.checkout.envioTipo = tipo;

      if (tipo === "retiro") {
        user.checkout.paso = "esperando_nombre";
        saveData(DB);
        await askName(chatId);
        return;
      }

      // envío domicilio
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
        methods.find(
          (m) => String(m.id || m.label) === String(payId)
        ) || null;
      user.checkout.pagoId = method?.id || String(payId);
      user.checkout.pago = method?.label || method?.nombre || String(payId);
      saveData(DB);

      const summary = buildOrderSummary(config, user, chatId, q.from?.username);
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

// -------------------- WEBHOOK SERVER (Render) --------------------
async function start() {
  const config = await fetchConfig();
  console.log(
    `Config cargado OK: negocio="${config.negocio?.nombre || "-"}", catalogo=${
      config.catalogo?.length || 0
    }`
  );

  try {
    const me = await bot.getMe();
    BOT_USERNAME = me.username || "";
    console.log("Bot username:", BOT_USERNAME);
  } catch (e) {
    console.error("No pude obtener username del bot:", e?.message || e);
  }

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
          } catch (e) {
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
...

[Mensaje recortado]  Ver todo el mensaje

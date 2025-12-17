/**
 * EzerBot System — index.js (UN SOLO ARCHIVO)
 * - Telegram Bot + Webhook (Render) o Polling (local)
 * - Lee TODO desde CONFIG_URL (config.json)
 * - Catálogo por categorías paginado: 3 productos por página, con FOTOS
 * - Botones por producto: Quiero éste / Compartir
 * - Cantidad por texto (gramos o unidades) para no llenar el chat
 * - Checkout completo: retiro o envío con costo + horario
 * - Pago: Efectivo + Transferencia (alias desde Config)
 * - Ticket tipo POS + confirmación de pago por el vendedor (botón)
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
function safeText(s, max = 3900) {
  const t = String(s ?? "");
  return t.length > max ? t.slice(0, max - 3) + "..." : t;
}
function nowISO() {
  const d = new Date();
  return d.toISOString();
}
function normalizePhoneForWa(phone) {
  const p = String(phone || "").replace(/[^\d]/g, "");
  return p.startsWith("54") ? p : p ? `54${p}` : "";
}
function truncate(s, n = 60) {
  const t = String(s || "");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

// -------------------- USER STATE --------------------
function getUser(userId) {
  const key = String(userId);
  if (!DB.users[key]) {
    DB.users[key] = {
      cart: [], // [{codigo, qty, unit:'g'|'u'}]  qty: number (gramos o unidades)
      profile: { nombre: "", telefono: "" },
      flow: {
        mode: "", // 'qty' | 'checkout'
        qty: { codigo: "", unit: "", cat: "", page: 1 }, // cuando pide cantidad
        checkout: {
          paso: "", // 'envio_tipo'|'direccion'|'nombre'|'telefono'|'horario'|'pago'|'confirm'
          envioTipo: "", // 'retiro'|'envio'
          direccion: "",
          horario: "",
          pago: "", // 'Efectivo'|'Transferencia'
        },
      },
      lastSeen: Date.now(),
    };
    saveData(DB);
  }
  DB.users[key].lastSeen = Date.now();
  return DB.users[key];
}

function addToCart(user, codigo, qty, unit) {
  const q = Number(qty || 0);
  if (!Number.isFinite(q) || q <= 0) return false;

  // si es gramos, guardamos en gramos (ej 250); si es unidad, en unidades
  const item = user.cart.find((x) => x.codigo === codigo && x.unit === unit);
  if (item) item.qty += q;
  else user.cart.push({ codigo, qty: q, unit });
  return true;
}
function clearCart(user) {
  user.cart = [];
}
function removeCartLine(user, idx) {
  if (idx < 0 || idx >= user.cart.length) return;
  user.cart.splice(idx, 1);
}

// -------------------- CONFIG CACHE + NORMALIZACIÓN --------------------
let CONFIG_CACHE = null;
let CONFIG_CACHE_AT = 0;
const CONFIG_TTL_MS = 30_000;

function normalizeConfig(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};

  // Si ya viene “nuevo estilo”
  const hasNested = !!cfg.negocio || Array.isArray(cfg.catalogo);

  // Base
  const out = {
    negocio: cfg.negocio || {},
    catalogo: Array.isArray(cfg.catalogo) ? cfg.catalogo : [],
    promos: Array.isArray(cfg.promos) ? cfg.promos : [],
    envios: cfg.envios || {},
    pagos: cfg.pagos || {},
    sellos: cfg.sellos || {},
    textos: cfg.textos || {},
    ui: cfg.ui || {},
    _flat: cfg,
  };

  // Fallback: si viene “plano” (como tu hoja Config)
  // NO CAMBIAMOS TU CONFIG, solo la interpretamos si el JSON está plano.
  const f = cfg;

  if (!hasNested) {
    out.negocio = {
      nombre: f.NegocioNombre || f.negocioNombre || f.nombre || "Negocio",
      logoUrl: f.LogoURL || f.logoUrl || "",
      direccion: f["Dirección"] || f.Direccion || "",
      horarios: f.Horarios || "",
      telefono: f.TeléfonoNegocio || f.TelefonoNegocio || "",
      instagram: f.Instagram || "",
      facebook: f.Facebook || "",
      descripcion: f.Descripcion || "",
      whatsappLink: f.WhatsAppLink || "",
    };
    out.textos = {
      pedidoConfirmado: f.TextoConfirmacionPedido || "",
      avisoVendedor: f.TextoAvisoVendedor || "",
      compartirBot: f.TextoCompartirBot || "",
      postCompra: f.MensajePostCompra || "",
      envioDomicilio: f.TextoEnvíoDomicilio || f.TextoEnvioDomicilio || "",
      retiroLocal: f.TextoRetiroLocal || "",
      bienvenida: "", // la armamos nosotros con logo+descripcion
    };
    out.envios = {
      activo: String(f.UsaEnvíoDomicilio || f.UsaEnvioDomicilio || "NO").toUpperCase() === "SI",
      costo: Number(f.CostoEnvíoBase || f.CostoEnvioBase || 0),
      zonas: Array.isArray(f.Zonas) ? f.Zonas : [],
      gratisDesde: Number(f.EnvioGratisDesde || 0),
      retiroActivo: String(f.UsaRetiroLocal || "NO").toUpperCase() === "SI",
    };
    const permitirOnline = String(f.PermitirPagoOnline || "NO").toUpperCase() === "SI";
    const tipoOnline = String(f.TipoPagoOnline || "").toUpperCase().trim();
    const alias = String(f.AliasPago || "").trim();
    out.pagos = {
      metodos: [
        { id: "EFECTIVO", label: "Efectivo" },
        ...(permitirOnline && tipoOnline === "TRANSFERENCIA"
          ? [{ id: "TRANSFERENCIA", label: "Transferencia", alias }]
          : []),
      ],
    };
    out.sellos = {
      activo: String(f.UsaSellos || "NO").toUpperCase() === "SI",
      meta: 0,
    };
    out.ui = { itemsPorPagina: 3 };
    out.chatIdVendedor = String(f.ChatIdVendedor || "").trim();
    return out;
  }

  // Si viene “nuevo estilo”, completamos defaults y compatibilidades
  if (!out.negocio) out.negocio = {};
  if (!out.envios) out.envios = {};
  if (!out.pagos) out.pagos = {};
  if (!out.textos) out.textos = {};
  if (!out.ui) out.ui = {};

  // itemsPorPagina fijo en 3 como pediste
  out.ui.itemsPorPagina = 3;

  // Compat: chat vendedor
  out.chatIdVendedor = String(cfg.ChatIdVendedor || cfg.chatIdVendedor || "").trim();

  // Compat: pagos si vienen vacíos
  if (!Array.isArray(out.pagos.metodos)) out.pagos.metodos = [];
  if (!out.pagos.metodos.length) {
    // mínimo efectivo
    out.pagos.metodos.push({ id: "EFECTIVO", label: "Efectivo" });
    // transferencia si hay alias
    const alias = cfg.AliasPago || cfg.pagos?.alias || "";
    const permitir = String(cfg.PermitirPagoOnline || cfg.pagos?.permitirOnline || "NO").toUpperCase() === "SI";
    const tipo = String(cfg.TipoPagoOnline || cfg.pagos?.tipo || "").toUpperCase();
    if (permitir && tipo === "TRANSFERENCIA") out.pagos.metodos.push({ id: "TRANSFERENCIA", label: "Transferencia", alias });
  }

  // Compat: envío
  out.envios.activo = !!out.envios.activo || String(cfg.UsaEnvíoDomicilio || cfg.UsaEnvioDomicilio || "NO").toUpperCase() === "SI";
  out.envios.costo = Number(out.envios.costo || cfg.CostoEnvíoBase || cfg.CostoEnvioBase || 0);
  out.envios.retiroActivo = !!out.envios.retiroActivo || String(cfg.UsaRetiroLocal || "NO").toUpperCase() === "SI";

  return out;
}

async function fetchConfig() {
  const now = Date.now();
  if (CONFIG_CACHE && now - CONFIG_CACHE_AT < CONFIG_TTL_MS) return CONFIG_CACHE;

  const url = new URL(CONFIG_URL);
  const res = await fetch(url.toString(), { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`No pude leer config (HTTP ${res.status})`);

  const json = await res.json();
  const normalized = normalizeConfig(json);

  // Normalización de catálogo mínimo
  if (!Array.isArray(normalized.catalogo)) normalized.catalogo = [];

  CONFIG_CACHE = normalized;
  CONFIG_CACHE_AT = now;
  return normalized;
}

// -------------------- CATÁLOGO HELPERS --------------------
function getCatalogByCategory(config) {
  const map = new Map();
  for (const p of config.catalogo || []) {
    const cat = (p.categoria || p.CATEGORIA || "Otros").trim() || "Otros";
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat).push(p);
  }
  for (const [k, arr] of map.entries()) {
    arr.sort((a, b) => String(a.nombre || a.NOMBRE || "").localeCompare(String(b.nombre || b.NOMBRE || ""), "es"));
    map.set(k, arr);
  }
  return map;
}

function findProduct(config, codigo) {
  return (config.catalogo || []).find((p) => String(p.codigo || p.CODIGO) === String(codigo));
}

function productName(p) {
  return String(p.nombre || p.NOMBRE || "Producto");
}
function productPrice(p) {
  return Number(p.precio ?? p.PRECIO ?? 0);
}
function productUnit(p) {
  const u = String(p.unidad || p.UNIDAD || "").trim().toLowerCase();
  return u; // 'kg' o 'unidad'
}
function productImage(p) {
  return String(p.imagen || p.IMAGEN || p.image || p.Image || "").trim();
}
function productDesc(p) {
  return String(p.descripcion || p.DESCRIPCION || "").trim();
}

// gramos vs unidad
function isWeighable(p) {
  const u = productUnit(p);
  return u === "kg" || u.includes("kg") || u.includes("kilo");
}

// -------------------- CÁLCULOS --------------------
function calcCartTotals(config, user) {
  let subtotal = 0;
  const lines = [];

  for (const it of user.cart) {
    const p = findProduct(config, it.codigo);
    if (!p) continue;

    const precioBase = productPrice(p);
    const weigh = isWeighable(p);

    let line = 0;
    let labelQty = "";

    if (weigh && it.unit === "g") {
      // precio por kg -> gramos
      const grams = Number(it.qty || 0);
      const kg = grams / 1000;
      line = precioBase * kg;
      labelQty = `${grams}g`;
    } else {
      // unidad
      const units = Number(it.qty || 0);
      line = precioBase * units;
      labelQty = `${units}u`;
    }

    subtotal += line;
    lines.push({ p, it, line, labelQty });
  }

  return { subtotal, lines };
}

function calcShipping(config, subtotal, envioTipo) {
  const env = config.envios || {};
  if (envioTipo !== "envio") return { costo: 0, label: "Retiro en el local" };

  // Gratis desde (si existiera)
  const gratisDesde = Number(env.gratisDesde || 0);
  if (gratisDesde > 0 && subtotal >= gratisDesde) {
    return { costo: 0, label: `Envío gratis (desde $${money(gratisDesde)})` };
  }

  const costo = Number(env.costo || 0);
  return { costo, label: "Envío a domicilio" };
}

// -------------------- BOT SETUP --------------------
const bot = new TelegramBot(BOT_TOKEN, { polling: !PUBLIC_URL });
let BOT_USERNAME = "";

async function ensureWebhook() {
  if (!PUBLIC_URL) return;
  const hookPath = `/telegram/${BOT_TOKEN}`;
  const hookUrl = `${PUBLIC_URL.replace(/\/$/, "")}${hookPath}`;
  await bot.setWebHook(hookUrl);
  console.log("Webhook:", hookUrl);
}

// -------------------- SHARE LINKS --------------------
function buildShareLinks(botUsername, negocioNombre, extraText = "") {
  const base = `https://t.me/${botUsername}`;
  const text = encodeURIComponent(
    `🧀 ${negocioNombre}\n${extraText ? extraText + "\n" : ""}\nAbrilo acá: ${base}`
  );
  const wa = `https://wa.me/?text=${text}`;
  const tg = `https://t.me/share/url?url=${encodeURIComponent(base)}&text=${text}`;
  const mail = `mailto:?subject=${encodeURIComponent(`Todo Queso — Bot`)}&body=${text}`;
  return { wa, tg, mail };
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

// -------------------- UI (KEYBOARDS) --------------------
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
  const rows = categories.map((cat) => [{ text: cat, callback_data: `cats:open:${cat}:1` }]);
  rows.push([{ text: "🏠 Menú", callback_data: "menu:main" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function inlineCatalogNavKeyboard(cat, page, totalPages, pageItems) {
  // 3 productos => 2 botones por producto: quiero / compartir
  const rows = [];

  pageItems.forEach((p, idx) => {
    const n = idx + 1;
    rows.push([
      { text: `🟢 Quiero éste #${n}`, callback_data: `prod:want:${cat}:${page}:${p.codigo || p.CODIGO}` },
      { text: `📣 Compartir #${n}`, callback_data: `prod:share:${cat}:${page}:${p.codigo || p.CODIGO}` },
    ]);
  });

  const nav = [];
  if (page > 1) nav.push({ text: "⬅️ Anterior", callback_data: `cats:open:${cat}:${page - 1}` });
  nav.push({ text: `📄 ${page}/${totalPages}`, callback_data: "noop" });
  if (page < totalPages) nav.push({ text: "➡️ Siguiente", callback_data: `cats:open:${cat}:${page + 1}` });
  rows.push(nav);

  rows.push([
    { text: "📂 Categorías", callback_data: "cats:list" },
    { text: "🛒 Carrito", callback_data: "cart:view" },
    { text: "🏠 Menú", callback_data: "menu:main" },
  ]);

  return { reply_markup: { inline_keyboard: rows } };
}

function inlineCartKeyboard(user) {
  const rows = [];
  user.cart.forEach((it, idx) => {
    rows.push([{ text: `❌ Quitar línea ${idx + 1}`, callback_data: `cart:rm:${idx}` }]);
  });
  rows.push([{ text: "🧹 Vaciar carrito", callback_data: "cart:clear" }]);
  rows.push([{ text: "✅ Finalizar compra", callback_data: "checkout:start" }]);
  rows.push([{ text: "📂 Categorías", callback_data: "cats:list" }, { text: "🏠 Menú", callback_data: "menu:main" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function inlineCheckoutDeliveryKeyboard(config, subtotal) {
  const env = config.envios || {};
  const rows = [];

  // Retiro
  if (env.retiroActivo !== false) rows.push([{ text: "🏪 Retiro en el local", callback_data: "ship:retiro" }]);

  // Envío
  if (env.activo) {
    const costo = Number(env.costo || 0);
    const ship = calcShipping(config, subtotal, "envio");
    rows.push([{ text: `🚚 Envío a domicilio (+$${money(ship.costo)})`, callback_data: "ship:envio" }]);
  }

  rows.push([{ text: "❌ Cancelar", callback_data: "checkout:cancel" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function inlinePaymentKeyboard(config) {
  const methods = Array.isArray(config.pagos?.metodos) ? config.pagos.metodos : [];
  const rows = methods.map((m) => [{ text: m.label || m.nombre || m.id || "Pago", callback_data: `pay:${m.id || m.label}` }]);
  rows.push([{ text: "❌ Cancelar", callback_data: "checkout:cancel" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

// -------------------- MENSAJES (WELCOME/INFO) --------------------
async function sendWelcome(chatId, config) {
  const n = config.negocio || {};
  const nombre = n.nombre || "Negocio";
  const desc = n.descripcion || config.textos?.Descripcion || "";
  const logo = n.logoUrl || n.logoURL || config._flat?.LogoURL || "";

  // 1) Enviamos logo si existe
  if (logo) {
    try {
      await bot.sendPhoto(chatId, logo, {
        caption: `🧀 *${nombre}*\n${desc ? safeText(desc, 500) : ""}`,
        parse_mode: "Markdown",
      });
    } catch {
      // si la foto falla, seguimos igual
      await bot.sendMessage(chatId, `🧀 *${nombre}*\n${desc ? safeText(desc, 800) : ""}`, { parse_mode: "Markdown" });
    }
  }

  // 2) Mensaje corto + menú
  const msg =
    `👋 Hola!\n` +
    `Soy el bot de *${nombre}*.\n\n` +
    `✅ Podés ver el catálogo por categorías, armar tu carrito y finalizar tu pedido.\n` +
    `👇 Elegí una opción del menú para empezar:`;

  await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", ...mainMenuKeyboard() });
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

// -------------------- CATEGORÍAS + CATÁLOGO (3 POR PÁGINA CON FOTOS) --------------------
async function showCategories(chatId, config) {
  const map = getCatalogByCategory(config);
  const cats = Array.from(map.keys());
  if (!cats.length) {
    await bot.sendMessage(chatId, "⏳ Todavía no hay productos cargados en el catálogo.", mainMenuKeyboard());
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

  const perPage = 3;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const p = Math.min(Math.max(1, Number(page || 1)), totalPages);
  const pageItems = items.slice((p - 1) * perPage, (p - 1) * perPage + perPage);

  // 1) Enviamos 3 fotos en grupo (si hay imágenes), para que sea “3 productos por página”
  const media = [];
  for (const prod of pageItems) {
    const img = productImage(prod);
    if (!img) continue;
    const price = productPrice(prod);
    const unit = productUnit(prod);
    const desc = productDesc(prod);
    const cap =
      `*${truncate(productName(prod), 60)}*\n` +
      `💰 $${money(price)}${unit ? ` / ${unit}` : ""}\n` +
      `${desc ? `📝 ${truncate(desc, 120)}` : ""}`;
    media.push({
      type: "photo",
      media: img,
      caption: cap,
      parse_mode: "Markdown",
    });
  }

  // si tenemos 2 o más, usamos mediaGroup; si no, mandamos texto
  if (media.length >= 2) {
    try {
      await bot.sendMediaGroup(chatId, media.slice(0, 3));
    } catch {
      // fallback a mensaje texto
    }
  } else if (media.length === 1) {
    try {
      await bot.sendPhoto(chatId, media[0].media, { caption: media[0].caption, parse_mode: "Markdown" });
    } catch {
      // ignore
    }
  }

  // 2) Mensaje con botones (Quiero / Compartir + nav)
  const header = `🧀 *${cat}* — página *${p}/${totalPages}*\nTocá un botón para elegir:`;
  await bot.sendMessage(chatId, header, {
    parse_mode: "Markdown",
    ...inlineCatalogNavKeyboard(cat, p, totalPages, pageItems),
  });
}

// -------------------- PROMOS --------------------
async function showPromos(chatId, config) {
  // tomamos promos como categoría "Promos" si existe
  const map = getCatalogByCategory(config);
  const items = map.get("Promos") || map.get("PROMOS") || [];
  if (!items.length) {
    await bot.sendMessage(chatId, "🔥 Todavía no hay promos cargadas. ¿Querés ver el catálogo?", mainMenuKeyboard());
    return;
  }
  // mostramos como catálogo paginado igual
  await showCatalogPage(chatId, config, "Promos", 1);
}

// -------------------- CANTIDAD POR TEXTO --------------------
async function askQuantity(chatId, config, user, cat, page, codigo) {
  const p = findProduct(config, codigo);
  if (!p) {
    await bot.sendMessage(chatId, "Ese producto no existe. Probá de nuevo.", mainMenuKeyboard());
    return;
  }

  const weigh = isWeighable(p);
  user.flow.mode = "qty";
  user.flow.qty = { codigo, unit: weigh ? "g" : "u", cat, page };
  saveData(DB);

  const question = weigh
    ? `🧾 ¿Cuántos *gramos* querés de *${productName(p)}*?\n(Ej: 250)`
    : `🧾 ¿Cuántas *unidades* querés de *${productName(p)}*?\n(Ej: 1)`;

  await bot.sendMessage(chatId, question, { parse_mode: "Markdown" });
}

// -------------------- CARRITO --------------------
async function showCart(chatId, config, user) {
  const { subtotal, lines } = calcCartTotals(config, user);
  if (!lines.length) {
    await bot.sendMessage(chatId, "🛒 Tu carrito está vacío. ¿Querés que te muestre el catálogo?", mainMenuKeyboard());
    return;
  }

  const msg = [];
  msg.push("🛒 *Tu carrito*");
  msg.push("");

  lines.forEach((ln, i) => {
    msg.push(`• ${ln.labelQty} × ${productName(ln.p)} — $${money(ln.line)}`);
  });

  msg.push("");
  msg.push(`Subtotal: *$${money(subtotal)}*`);

  await bot.sendMessage(chatId, msg.join("\n"), { parse_mode: "Markdown", ...inlineCartKeyboard(user) });
}

// -------------------- CHECKOUT --------------------
async function startCheckout(chatId, config, user) {
  const { subtotal, lines } = calcCartTotals(config, user);
  if (!lines.length) {
    await bot.sendMessage(chatId, "Tu carrito está vacío. Primero agregá algo del catálogo 🙂", mainMenuKeyboard());
    return;
  }

  user.flow.mode = "checkout";
  user.flow.checkout = {
    paso: "envio_tipo",
    envioTipo: "",
    direccion: "",
    horario: "",
    pago: "",
  };
  saveData(DB);

  await bot.sendMessage(chatId, "✅ *Finalizar compra*\nElegí cómo querés recibir tu pedido:", {
    parse_mode: "Markdown",
    ...inlineCheckoutDeliveryKeyboard(config, subtotal),
  });
}

async function askName(chatId) {
  await bot.sendMessage(chatId, "🧾 Decime tu *nombre* para el pedido.", { parse_mode: "Markdown" });
}
async function askPhone(chatId) {
  await bot.sendMessage(chatId, "📞 Pasame tu *teléfono* (así coordinamos si hace falta).", { parse_mode: "Markdown" });
}
async function askAddress(chatId) {
  await bot.sendMessage(chatId, "📍 Pasame tu *dirección completa* (calle + número + referencia).", { parse_mode: "Markdown" });
}
async function askSchedule(chatId, envioTipo) {
  const q =
    envioTipo === "envio"
      ? "🕒 ¿En qué *horario* te conviene *recibir* el envío? (Ej: 16:30)"
      : "🕒 ¿En qué *horario* te conviene *pasar a retirar*? (Ej: 18:00)";
  await bot.sendMessage(chatId, q, { parse_mode: "Markdown" });
}

async function askPayment(chatId, config) {
  const methods = Array.isArray(config.pagos?.metodos) ? config.pagos.metodos : [];
  if (!methods.length) {
    await bot.sendMessage(chatId, "💳 No hay métodos de pago configurados todavía.", mainMenuKeyboard());
    return;
  }
  await bot.sendMessage(chatId, "💳 Elegí método de pago:", inlinePaymentKeyboard(config));
}

function makeTicketId(config) {
  // Ticket tipo POS: TQ-YYYYMMDD-HHMMSS-XXXX
  const pref = (config._flat?.PrefijoCodigoCanje || config.prefijo || "TQ").toString().trim().replace(/\s+/g, "") || "TQ";
  const d = new Date();
  const YYYY = d.getFullYear();
  const MM = String(d.getMonth() + 1).padStart(2, "0");
  const DD = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const rnd = String(Math.floor(Math.random() * 9000) + 1000);
  return `${pref}-${YYYY}${MM}${DD}-${hh}${mm}${ss}-${rnd}`;
}

function buildPosTicket(config, user, chatId, username, ticketId) {
  const n = config.negocio || {};
  const { subtotal, lines } = calcCartTotals(config, user);
  const ship = calcShipping(config, subtotal, user.flow.checkout.envioTipo);
  const total = subtotal + Number(ship.costo || 0);

  const items = lines
    .map((ln) => {
      const nm = truncate(productName(ln.p), 22).padEnd(22, " ");
      const qty = String(ln.labelQty).padStart(6, " ");
      const pr = String(money(ln.line)).padStart(8, " ");
      return `${qty}  ${nm}  $${pr}`;
    })
    .join("\n");

  const head = `${(n.nombre || "NEGOCIO").toUpperCase()}\n${n.direccion || ""}\n${n.telefono ? `Tel: ${n.telefono}` : ""}`.trim();
  const cliente = user.profile?.nombre || (username ? `@${username}` : "");
  const tel = user.profile?.telefono || "";
  const envioTipo = user.flow.checkout.envioTipo === "envio" ? "ENVÍO" : "RETIRO";
  const dir = user.flow.checkout.envioTipo === "envio" ? user.flow.checkout.direccion : "";
  const hor = user.flow.checkout.horario || "";
  const pago = user.flow.checkout.pago || "";

  const linesTicket = [];
  linesTicket.push("🧾 *TICKET POS*");
  linesTicket.push("```");
  linesTicket.push(head);
  linesTicket.push("--------------------------------");
  linesTicket.push(`Ticket: ${ticketId}`);
  linesTicket.push(`Fecha: ${new Date().toLocaleString("es-AR")}`);
  linesTicket.push("--------------------------------");
  linesTicket.push(`Cliente: ${cliente}`);
  if (tel) linesTicket.push(`Tel: ${tel}`);
  linesTicket.push(`Entrega: ${envioTipo}`);
  if (dir) linesTicket.push(`Dir: ${dir}`);
  if (hor) linesTicket.push(`Horario: ${hor}`);
  linesTicket.push("--------------------------------");
  linesTicket.push(items || "(sin items)");
  linesTicket.push("--------------------------------");
  linesTicket.push(`SUBTOTAL: $${money(subtotal)}`);
  linesTicket.push(`${ship.label}: $${money(ship.costo)}`);
  linesTicket.push(`TOTAL:   $${money(total)}`);
  linesTicket.push("--------------------------------");
  linesTicket.push(`Pago: ${pago}`);
  linesTicket.push(`ChatID: ${chatId}`);
  linesTicket.push("```");

  return linesTicket.join("\n");
}

async function sendVendorOrder(config, chatId, ticketId, posTicket) {
  const vendorId = String(config.chatIdVendedor || config._flat?.ChatIdVendedor || "").trim();
  if (!vendorId) return;

  const textoAviso = config._flat?.TextoAvisoVendedor || config.textos?.avisoVendedor || "Tenés un pago pendiente de confirmación ✅";

  const rows = [
    [{ text: "✅ Confirmar pago", callback_data: `admin:paid:${ticketId}` }],
    [{ text: "❌ Cancelar pedido", callback_data: `admin:cancel:${ticketId}` }],
  ];

  try {
    await bot.sendMessage(vendorId, `${textoAviso}\n\n${posTicket}`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } });
  } catch (e) {
    console.error("No pude avisar al vendedor:", e?.message || e);
  }
}

async function finalizeOrder(chatId, config, user, username) {
  const { subtotal, lines } = calcCartTotals(config, user);
  if (!lines.length) {
    await bot.sendMessage(chatId, "Tu carrito está vacío.", mainMenuKeyboard());
    return;
  }

  const ship = calcShipping(config, subtotal, user.flow.checkout.envioTipo);
  const total = subtotal + Number(ship.costo || 0);

  const ticketId = makeTicketId(config);
  const posTicket = buildPosTicket(config, user, chatId, username, ticketId);

  // Guardar pedido en DB para poder confirmar pago luego
  DB.orders[ticketId] = {
    ticketId,
    createdAt: nowISO(),
    status: "PENDIENTE",
    chatId,
    username: username || "",
    customer: { ...user.profile },
    checkout: { ...user.flow.checkout },
    cart: [...user.cart],
    totals: { subtotal, envio: ship.costo, total },
  };
  saveData(DB);

  // Si eligió transferencia, mostrar alias
  if ((user.flow.checkout.pago || "").toUpperCase().includes("TRANSFER")) {
    const alias =
      config._flat?.AliasPago ||
      (Array.isArray(config.pagos?.metodos)
        ? config.pagos.metodos.find((m) => String(m.id).toUpperCase() === "TRANSFERENCIA")?.alias
        : "") ||
      "—";
    await bot.sendMessage(chatId, `🏦 *Transferencia*\nAlias: *${alias}*`, { parse_mode: "Markdown" });
  }

  // Ticket POS al cliente + confirmación
  await bot.sendMessage(chatId, posTicket, { parse_mode: "Markdown" });

  // Pregunta final de confirmación
  const rows = [
    [{ text: "✅ Confirmar pedido", callback_data: `order:confirm:${ticketId}` }],
    [{ text: "❌ Cancelar", callback_data: "checkout:cancel" }],
  ];
  await bot.sendMessage(chatId, "¿Confirmás el pedido?", { reply_markup: { inline_keyboard: rows } });

  // Aviso al vendedor con botón para confirmar pago
  await sendVendorOrder(config, chatId, ticketId, posTicket);

  // Importante: NO limpiamos carrito hasta que el cliente confirme pedido.
}

async function afterClientConfirms(chatId, config, user, ticketId) {
  // Marcamos confirmado (pero pago pendiente si transferencia)
  if (DB.orders[ticketId]) {
    DB.orders[ticketId].status = "CONFIRMADO";
    saveData(DB);
  }

  const msg = config._flat?.MensajePostCompra || config.textos?.postCompra || "Agradecemos tu compra. Ya sumaste tus puntos.";
  await bot.sendMessage(chatId, safeText(msg), mainMenuKeyboard());

  // limpiamos carrito + flow
  clearCart(user);
  user.flow.mode = "";
  user.flow.checkout = { paso: "", envioTipo: "", direccion: "", horario: "", pago: "" };
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

    const text = (msg.text || "").trim();
    if (text.startsWith("/start")) return;

    const config = await fetchConfig();
    const user = getUser(userId);

    // Si escribe “hola”, siempre mostramos bienvenida (como pediste)
    if (text.toLowerCase() === "hola" || text.toLowerCase() === "buenas" || text.toLowerCase() === "buen día" || text.toLowerCase() === "buenas tardes") {
      await sendWelcome(chatId, config);
      return;
    }

    // 1) Si estamos esperando cantidad por texto
    if (user.flow.mode === "qty" && user.flow.qty?.codigo) {
      const n = Number(String(text).replace(",", "."));
      if (!Number.isFinite(n) || n <= 0) {
        await bot.sendMessage(chatId, "Escribí solo un número válido 🙂 (ej: 250 o 1)");
        return;
      }

      const codigo = user.flow.qty.codigo;
      const unit = user.flow.qty.unit;
      const ok = addToCart(user, codigo, n, unit);
      if (!ok) {
        await bot.sendMessage(chatId, "No pude agregar esa cantidad. Probá de nuevo.");
        return;
      }

      const p = findProduct(config, codigo);
      saveData(DB);

      user.flow.mode = "";
      const backCat = user.flow.qty.cat;
      const backPage = user.flow.qty.page;
      user.flow.qty = { codigo: "", unit: "", cat: "", page: 1 };
      saveData(DB);

      const label = unit === "g" ? `${n}g` : `${n}u`;
      await bot.sendMessage(chatId, `✅ Agregado al carrito: *${label}* de *${productName(p)}*`, { parse_mode: "Markdown" });

      // volver a la misma página del catálogo
      if (backCat) {
        await showCatalogPage(chatId, config, backCat, backPage || 1);
      }
      return;
    }

    // 2) Checkout por texto
    if (user.flow.mode === "checkout" && user.flow.checkout?.paso) {
      const paso = user.flow.checkout.paso;

      if (paso === "direccion") {
        user.flow.checkout.direccion = text;
        user.flow.checkout.paso = "nombre";
        saveData(DB);
        await askName(chatId);
        return;
      }

      if (paso === "nombre") {
        user.profile.nombre = text;
        user.flow.checkout.paso = "telefono";
        saveData(DB);
        await askPhone(chatId);
        return;
      }

      if (paso === "telefono") {
        user.profile.telefono = text;
        user.flow.checkout.paso = "horario";
        saveData(DB);
        await askSchedule(chatId, user.flow.checkout.envioTipo);
        return;
      }

      if (paso === "horario") {
        user.flow.checkout.horario = text;
        user.flow.checkout.paso = "pago";
        saveData(DB);
        await askPayment(chatId, config);
        return;
      }
    }

    // 3) Botones de teclado principal
    if (text === "🛍️ Catálogo") return await showCategories(chatId, config);
    if (text === "🔥 Promos") return await showPromos(chatId, config);
    if (text === "🛒 Mi carrito") return await showCart(chatId, config, user);
    if (text === "✅ Finalizar compra") return await startCheckout(chatId, config, user);
    if (text === "📍 Horarios y dirección") return await showBusinessInfo(chatId, config);

    if (text === "📣 Compartir bot") {
      const links = buildShareLinks(BOT_USERNAME || (await bot.getMe()).username, config.negocio?.nombre || "Todo Queso");
      return await bot.sendMessage(chatId, "📣 Elegí cómo querés compartir el bot:", inlineShareKeyboard(links));
    }

    // fallback amable
    await bot.sendMessage(chatId, "🙂 Tocá una opción del menú para empezar.", mainMenuKeyboard());
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
    const user = getUser(userId);

    const ack = async () => {
      try {
        await bot.answerCallbackQuery(q.id);
      } catch {}
    };

    if (data === "noop") return await ack();

    // Menú
    if (data === "menu:main") {
      await ack();
      return await sendWelcome(chatId, config);
    }

    // Categorías
    if (data === "cats:list") {
      await ack();
      return await showCategories(chatId, config);
    }

    // Abrir categoría + página
    if (data.startsWith("cats:open:")) {
      await ack();
      const [, , cat, page] = data.split(":");
      return await showCatalogPage(chatId, config, cat, Number(page || 1));
    }

    // Ver carrito
    if (data === "cart:view") {
      await ack();
      return await showCart(chatId, config, user);
    }

    // Vaciar carrito
    if (data === "cart:clear") {
      await ack();
      clearCart(user);
      saveData(DB);
      return await bot.sendMessage(chatId, "🧹 Listo, vacié el carrito.", mainMenuKeyboard());
    }

    // Quitar línea del carrito
    if (data.startsWith("cart:rm:")) {
      await ack();
      const idx = Number(data.split(":")[2]);
      removeCartLine(user, idx);
      saveData(DB);
      return await showCart(chatId, config, user);
    }

    // Quiero éste (pide cantidad por texto)
    if (data.startsWith("prod:want:")) {
      await ack();
      const [, , cat, page, codigo] = data.split(":");
      return await askQuantity(chatId, config, user, cat, Number(page || 1), codigo);
    }

    // Compartir producto
    if (data.startsWith("prod:share:")) {
      await ack();
      const [, , cat, page, codigo] = data.split(":");
      const p = findProduct(config, codigo);
      if (!p) return await bot.sendMessage(chatId, "No encontré ese producto.");
      const extra = `Producto: ${productName(p)} — $${money(productPrice(p))}${productUnit(p) ? ` / ${productUnit(p)}` : ""}`;
      const links = buildShareLinks(BOT_USERNAME || (await bot.getMe()).username, config.negocio?.nombre || "Todo Queso", extra);
      return await bot.sendMessage(chatId, "📣 Elegí cómo querés compartir este producto:", inlineShareKeyboard(links));
    }

    // Checkout start
    if (data === "checkout:start") {
      await ack();
      return await startCheckout(chatId, config, user);
    }

    // Cancelar checkout
    if (data === "checkout:cancel") {
      await ack();
      user.flow.mode = "";
      user.flow.checkout = { paso: "", envioTipo: "", direccion: "", horario: "", pago: "" };
      saveData(DB);
      return await bot.sendMessage(chatId, "Listo, cancelé la compra.", mainMenuKeyboard());
    }

    // Elegir tipo de envío
    if (data.startsWith("ship:")) {
      await ack();
      const tipo = data.split(":")[1]; // retiro / envio

      user.flow.mode = "checkout";
      user.flow.checkout.envioTipo = tipo;
      user.flow.checkout.direccion = "";
      user.flow.checkout.horario = "";
      user.flow.checkout.pago = "";

      // Pedimos nombre y teléfono SIEMPRE (como pediste)
      // Si es envío, pedimos dirección antes del nombre
      if (tipo === "envio") {
        user.flow.checkout.paso = "direccion";
        saveData(DB);
        await askAddress(chatId);
        return;
      } else {
        user.flow.checkout.paso = "nombre";
        saveData(DB);
        await askName(chatId);
        return;
      }
    }

    // Elegir pago
    if (data.startsWith("pay:")) {
      await ack();
      const payId = data.slice(4);
      const methods = Array.isArray(config.pagos?.metodos) ? config.pagos.metodos : [];
      const method = methods.find((m) => String(m.id || m.label) === String(payId)) || null;

      user.flow.checkout.pago = method?.label || method?.nombre || String(payId);
      saveData(DB);

      // Generamos ticket y pedimos confirmación
      return await finalizeOrder(chatId, config, user, q.from?.username);
    }

    // Cliente confirma pedido
    if (data.startsWith("order:confirm:")) {
      await ack();
      const ticketId = data.split(":")[2];
      return await afterClientConfirms(chatId, config, user, ticketId);
    }

    // ADMIN: confirmar pago
    if (data.startsWith("admin:paid:")) {
      await ack();

      const vendorId = String(config.chatIdVendedor || config._flat?.ChatIdVendedor || "").trim();
      // Solo el vendedor puede tocar esto
      if (vendorId && String(chatId) !== String(vendorId)) {
        return await bot.sendMessage(chatId, "⛔ Solo el vendedor puede confirmar pagos.");
      }

      const ticketId = data.split(":")[2];
      const order = DB.orders[ticketId];
      if (!order) return await bot.sendMessage(chatId, "No encontré ese pedido.");

      order.status = "PAGO_CONFIRMADO";
      saveData(DB);

      // Avisar al comprador que está en preparación (texto desde Config)
      const texto = config._flat?.TextoConfirmacionPedido || config.textos?.pedidoConfirmado || "Gracias. Tu compra fue confirmada y está en preparación ✅";
      try {
        await bot.sendMessage(order.chatId, texto, mainMenuKeyboard());
      } catch {}

      return await bot.sendMessage(chatId, `✅ Pago confirmado para ${ticketId}. Avisé al cliente.`);
    }

    // ADMIN: cancelar pedido
    if (data.startsWith("admin:cancel:")) {
      await ack();

      const vendorId = String(config.chatIdVendedor || config._flat?.ChatIdVendedor || "").trim();
      if (vendorId && String(chatId) !== String(vendorId)) {
        return await bot.sendMessage(chatId, "⛔ Solo el vendedor puede cancelar pedidos.");
      }

      const ticketId = data.split(":")[2];
      const order = DB.orders[ticketId];
      if (!order) return await bot.sendMessage(chatId, "No encontré ese pedido.");

      order.status = "CANCELADO";
      saveData(DB);

      try {
        await bot.sendMessage(order.chatId, "❌ Tu pedido fue cancelado. Si querés, hacelo de nuevo desde el catálogo.", mainMenuKeyboard());
      } catch {}

      return await bot.sendMessage(chatId, `❌ Pedido cancelado: ${ticketId}`);
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
  const me = await bot.getMe();
  BOT_USERNAME = me.username || "";
  console.log(`Bot: @${BOT_USERNAME}`);

  console.log(`Config OK: negocio="${config.negocio?.nombre || "-"}", catalogo=${config.catalogo?.length || 0}`);

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

    server.listen(PORT, () => console.log(`Escuchando en puerto ${PORT} (webhook)`));
  } else {
    console.log("Bot activo (polling).");
  }
}

start().catch((e) => {
  console.error("Error iniciando:", e?.message || e);
  process.exit(1);
});

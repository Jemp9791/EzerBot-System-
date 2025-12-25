import TelegramBot from "node-telegram-bot-api";
import http from "http";
import { URL } from "url";

/**
 * ENV requeridas (Render):
 * BOT_TOKEN
 * PUBLIC_URL          (ej: https://tu-app.onrender.com)
 * SHEETS_API_BASE     (endpoint que devuelve config y catalog)
 *
 * Endpoints esperados en SHEETS_API_BASE:
 *  - ?type=config   => objeto { ...keys }
 *  - ?type=catalog  => array de items (pueden venir keys en MAYUS o minus)
 */

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const SHEETS_API_BASE = process.env.SHEETS_API_BASE || "";
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

async function getCatalog() {
  const now = Date.now();
  if (cacheCatalog.data && now - cacheCatalog.at < CACHE_TTL_MS) return cacheCatalog.data;
  const data = await fetchJSON(`${SHEETS_API_BASE}?type=catalog&_=${now}`);
  cacheCatalog = { at: now, data: Array.isArray(data) ? data : [] };
  return cacheCatalog.data;
}

// --------------------
// Util
// --------------------
const safe = (v) => String(v ?? "").trim();

/** Lee una propiedad aunque venga en MAYUS o minus */
function getAny(obj, keys, fallback = "") {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return fallback;
}

/** Limpia Markdown tipo: [url](url) -> url */
function stripMarkdownUrl(s) {
  const t = safe(s);
  // match: [xxxx](yyyy) => devuelve yyyy
  const m = t.match(/^\s*\[[^\]]*\]\((https?:\/\/[^)]+)\)\s*$/i);
  if (m && m[1]) return m[1].trim();
  return t;
}

/** Telegram a veces se pone exquisito con caracteres ( ) y espacios: los codificamos */
function normalizeImageUrl(url) {
  const raw = stripMarkdownUrl(url);
  if (!raw) return "";
  try {
    return encodeURI(raw);
  } catch {
    return raw;
  }
}

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

function uniqueCategories(list) {
  const set = new Set();
  for (const p of list) {
    const c = safe(getAny(p, ["categoria", "CATEGORIA"], ""));
    if (c) set.add(c);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, "es"));
}

function filterCatalog(list, filter) {
  if (!filter || filter === "ALL") return list;
  return list.filter((p) => safe(getAny(p, ["categoria", "CATEGORIA"], "")) === filter);
}

function pickConfig(cfg, keys, fallback = "") {
  for (const k of keys) {
    const v = safe(cfg?.[k]);
    if (v) return v;
  }
  return fallback;
}

// --------------------
// State
// --------------------
/**
 * state:
 * - catFilter, catIndex
 * - viewMsgId, viewMsgType ('photo'|'text'|null)
 * - cart: Map(code->{prod, qty})
 * - awaitingQty: { code, unit } | null
 * - checkout: { step, delivery, address, name, phone, payMethod } | null
 */
const state = new Map();

function getState(chatId) {
  if (!state.has(chatId)) {
    state.set(chatId, {
      catFilter: "ALL",
      catIndex: 0,
      viewMsgId: null,
      viewMsgType: null,
      cart: new Map(),
      awaitingQty: null,
      checkout: null,
    });
  }
  return state.get(chatId);
}

// --------------------
// Keyboards
// --------------------
function mainMenuKeyboard(cfg) {
  return {
    keyboard: [
      [{ text: "🛍️ Catálogo" }, { text: "🛒 Carrito" }],
      [{ text: "✅ Finalizar compra" }],
      [{ text: "🎫 Tarjeta de sellos" }, { text: "📣 Compartir bot" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

/**
 * Inline del carrusel:
 * - SIN "Carrito" y SIN "Menú" (los que marcaste en rojo)
 * - SIN "Compartir" extra (dejamos solo compartir bot cuando el usuario lo pide)
 */
function navKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "⬅️ Anterior", callback_data: "CAT:PREV" },
        { text: "🟢 Quiero éste", callback_data: "ADD:CURRENT" },
        { text: "➡️ Siguiente", callback_data: "CAT:NEXT" },
      ],
      [{ text: "📁 Categorías", callback_data: "OPEN:CATS" }],
    ],
  };
}

function afterAddKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🟢 Seguir comprando", callback_data: "OPEN:CATS" }],
      [{ text: "✅ Finalizar compra", callback_data: "CHECKOUT:START" }],
    ],
  };
}

// --------------------
// Share (WhatsApp / Telegram / Email)
// --------------------
async function sendShareOptions(chatId) {
  const cfg = await getConfig();

  const activo = safe(pickConfig(cfg, ["CompartirBotActivo"], "SI")).toUpperCase() !== "NO";
  if (!activo) {
    await bot.sendMessage(chatId, "📣 Compartir bot está desactivado.", { reply_markup: mainMenuKeyboard(cfg) });
    return;
  }

  // Username del bot (vos dijiste: EZER_IA_BOT)
  const botUser = pickConfig(cfg, ["BotUsername"], "EZER_IA_BOT").replace("@", "");
  const botLink = `https://t.me/${botUser}`;

  const textoBase = pickConfig(cfg, ["TextoCompartirBot"], "Pedí por el bot de Todo Queso 🧀👇");
  const shareText = `${textoBase}\n${botLink}`;

  const waUrl = `https://wa.me/?text=${encodeURIComponent(shareText)}`;
  const tgUrl = `https://t.me/share/url?url=${encodeURIComponent(botLink)}&text=${encodeURIComponent(textoBase)}`;
  const emailUrl = `mailto:?subject=${encodeURIComponent("Pedido por bot")} &body=${encodeURIComponent(shareText)}`.replace(" ", "");

  await bot.sendMessage(chatId, "📣 Compartí el bot (propaganda pasiva) 👇", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "💬 WhatsApp", url: waUrl }],
        [{ text: "✈️ Telegram", url: tgUrl }],
        [{ text: "✉️ Email", url: emailUrl }],
      ],
    },
  });
}

// --------------------
// Welcome
// --------------------
async function sendWelcome(chatId) {
  const cfg = await getConfig();

  const negocio = pickConfig(cfg, ["NegocioNombre"], "Todo Queso");
  const dir = pickConfig(cfg, ["NegocioDireccion"], "");
  const hor = pickConfig(cfg, ["NegocioHorario"], "");
  const tel = pickConfig(cfg, ["NegocioTelefono"], "");
  const ig = pickConfig(cfg, ["NegocioInstagram"], "");
  const logo = pickConfig(cfg, ["LogoURL"], "");
  const descripcion = pickConfig(cfg, ["Descripcion"], "");

  let text = `🧀 *${negocio}*\n`;
  if (dir) text += `📍 ${dir}\n`;
  if (hor) text += `🕒 ${hor}\n`;
  if (tel) text += `📞 ${tel}\n`;
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

  // 🔴 Sacamos "Ver carrito" (lo marcaste en rojo)
  await bot.sendMessage(chatId, "📚 *Categorías*\nElegí una categoría para ver productos 👇", {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: rows },
  });
}

// --------------------
// Carrusel (un solo mensaje que se edita)
// --------------------
function productCaption(p, filter, index, total, cfg) {
  const nombre = safe(getAny(p, ["nombre", "NOMBRE"], ""));
  const precio = Number(getAny(p, ["precio", "PRECIO", "PRECIOPORKILO", "precioPorKilo"], "0") || 0);
  const unidad = normalizeUnit(getAny(p, ["unidad", "UNIDAD"], "unidad"));
  const desc = safe(getAny(p, ["descripcion", "DESCRIPCION"], ""));

  const head = filter && filter !== "ALL" ? `🛍️ *Catálogo — ${filter}*\n` : `🛍️ *Catálogo*\n`;
  const pos = `📖 Producto *${index + 1}* de *${total}*\n\n`;

  let cap = head + pos;
  cap += `🧀 *${nombre}*\n`;

  const mostrarPrecios = safe(pickConfig(cfg, ["CatalogoMostrarPrecios"], "SI")).toUpperCase() !== "NO";
  if (mostrarPrecios) {
    cap += `💰 ${moneyARS(precio)} ${unidad === "kg" ? "(x kg)" : "(por unidad)"}\n`;
  }

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

  const imgRaw = getAny(p, ["imagen", "IMAGEN", "image", "IMAGE"], "");
  const img = normalizeImageUrl(imgRaw);

  // Si la imagen está vacía o vino en markdown inválido, NO intentes sendPhoto.
  const hasImg = !!img && img.startsWith("http");

  try {
    // Editar SIEMPRE el mismo mensaje (carrusel real, sin llenar el chat)
    if (!forceNew && st.viewMsgId) {
      if (hasImg) {
        // Solo si el mensaje actual es foto o lo convertimos a foto
        await bot.editMessageMedia(
          { type: "photo", media: img, caption, parse_mode: "Markdown" },
          { chat_id: chatId, message_id: st.viewMsgId, reply_markup: navKeyboard() }
        );
        st.viewMsgType = "photo";
      } else {
        // Texto: editamos texto, no caption (así no se rompe)
        await bot.editMessageText(caption, {
          chat_id: chatId,
          message_id: st.viewMsgId,
          parse_mode: "Markdown",
          reply_markup: navKeyboard(),
        });
        st.viewMsgType = "text";
      }
      return;
    }

    // Crear mensaje inicial único
    let sent;
    if (hasImg) {
      sent = await bot.sendPhoto(chatId, img, { caption, parse_mode: "Markdown", reply_markup: navKeyboard() });
      st.viewMsgType = "photo";
    } else {
      sent = await bot.sendMessage(chatId, caption, { parse_mode: "Markdown", reply_markup: navKeyboard() });
      st.viewMsgType = "text";
    }
    st.viewMsgId = sent.message_id;
  } catch (e) {
    console.log("❌ renderCurrentProduct error:", e?.message || e);
    // Fallback: 1 solo mensaje nuevo, y guardamos el id para seguir editando
    const sent = await bot.sendMessage(chatId, caption, { parse_mode: "Markdown", reply_markup: navKeyboard() });
    st.viewMsgId = sent.message_id;
    st.viewMsgType = "text";
  }
}

// --------------------
// Carrito
// --------------------
function cartTotal(st) {
  let total = 0;
  for (const { prod, qty } of st.cart.values()) {
    const price = Number(getAny(prod, ["precio", "PRECIO", "PRECIOPORKILO"], "0") || 0);
    total += price * Number(qty || 0);
  }
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
    const unit = normalizeUnit(getAny(prod, ["unidad", "UNIDAD"], "unidad"));
    const price = Number(getAny(prod, ["precio", "PRECIO", "PRECIOPORKILO"], "0") || 0);
    const lineTotal = price * Number(qty || 0);
    text += `• *${safe(getAny(prod, ["nombre", "NOMBRE"], ""))}*\n  Cant: *${qty}* ${unit === "kg" ? "kg" : "unid"} — Subtotal: *${moneyARS(lineTotal)}*\n\n`;
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
// Cantidad (cliente escribe)
// --------------------
async function askQty(chatId, prod) {
  const cfg = await getConfig();
  const st = getState(chatId);

  const unit = normalizeUnit(getAny(prod, ["unidad", "UNIDAD"], "unidad"));
  const code = safe(getAny(prod, ["codigo", "CODIGO", "id", "ID"], ""));

  st.awaitingQty = { code, unit };

  if (unit === "kg") {
    await bot.sendMessage(
      chatId,
      `¿Cuántos *gramos* querés de *${safe(getAny(prod, ["nombre", "NOMBRE"], ""))}*?\nEjemplo: 250, 400, 1000\n\nEscribí el número (desde 100g en adelante).`,
      { parse_mode: "Markdown", reply_markup: mainMenuKeyboard(cfg) }
    );
  } else {
    await bot.sendMessage(
      chatId,
      `¿Cuántas *unidades* querés de *${safe(getAny(prod, ["nombre", "NOMBRE"], ""))}*?\nEjemplo: 1, 2, 3\n\nEscribí el número.`,
      { parse_mode: "Markdown", reply_markup: mainMenuKeyboard(cfg) }
    );
  }
}

function roundQty(q, unit) {
  const n = Number(q || 0);
  if (!isFinite(n) || n <= 0) return 0;
  if (unit === "kg") return Math.round(n * 100) / 100;
  return Math.round(n);
}

async function addToCart(chatId, prod, qty) {
  const cfg = await getConfig();
  const st = getState(chatId);

  const code = safe(getAny(prod, ["codigo", "CODIGO", "id", "ID"], ""));
  const unit = normalizeUnit(getAny(prod, ["unidad", "UNIDAD"], "unidad"));

  const q = roundQty(qty, unit);
  if (q <= 0) return;

  if (st.cart.has(code)) {
    const it = st.cart.get(code);
    it.qty = roundQty(Number(it.qty) + q, unit);
    st.cart.set(code, it);
  } else {
    st.cart.set(code, { prod, qty: q });
  }

  await bot.sendMessage(chatId, `✅ Agregado: *${safe(getAny(prod, ["nombre", "NOMBRE"], ""))}* — *${q}* ${unit === "kg" ? "kg" : "unid"}`, {
    parse_mode: "Markdown",
    reply_markup: afterAddKeyboard(),
  });
}

// --------------------
// Checkout (envío/retiro + pago)
// --------------------
function shippingCost(cfg) {
  const v = Number(pickConfig(cfg, ["CostoEnvio"], "0").replace(",", "."));
  return isFinite(v) ? v : 0;
}

async function startCheckout(chatId) {
  const cfg = await getConfig();
  const st = getState(chatId);
  if (!st.cart.size) {
    await bot.sendMessage(chatId, "Tu carrito está vacío. Agregá productos desde el catálogo.", { reply_markup: mainMenuKeyboard(cfg) });
    return;
  }

  st.checkout = { step: "delivery", delivery: "", address: "", name: "", phone: "", payMethod: "" };

  const usaEnvio = safe(pickConfig(cfg, ["UsaEnvíoDomicilio", "UsaEnvioDomicilio"], "SI")).toUpperCase() !== "NO";
  const usaRetiro = safe(pickConfig(cfg, ["UsaRetiroLocal"], "SI")).toUpperCase() !== "NO";

  const rows = [];
  if (usaEnvio) rows.push([{ text: "🚚 Envío a domicilio", callback_data: "DELIVERY:HOME" }]);
  if (usaRetiro) rows.push([{ text: "🏪 Retiro por el local", callback_data: "DELIVERY:PICKUP" }]);

  await bot.sendMessage(chatId, "Elegí cómo querés recibir tu pedido 👇", {
    reply_markup: { inline_keyboard: rows.length ? rows : [[{ text: "🏪 Retiro por el local", callback_data: "DELIVERY:PICKUP" }]] },
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
    reply_markup: { inline_keyboard: [[{ text: "💵 Efectivo", callback_data: "PAY:CASH" }], [{ text: "🏦 Transferencia", callback_data: "PAY:TRANSFER" }]] },
  });
}

async function checkoutSummary(chatId) {
  const cfg = await getConfig();
  const st = getState(chatId);
  const c = st.checkout;

  const sub = cartTotal(st);
  const envio = c.delivery === "HOME" ? shippingCost(cfg) : 0;
  const total = sub + envio;

  const negocio = pickConfig(cfg, ["NegocioNombre"], "Todo Queso");
  const alias = pickConfig(cfg, ["AliasTransferencia"], "");
  const nota = pickConfig(cfg, ["MensajeTransferencia"], "Cuando transfieras, mandá el comprobante por acá.");

  // ✅ CAMBIO CLAVE: NO decir “pagado”
  let text = `🧾 *Pedido registrado* (pendiente de confirmación del vendedor)\n\n`;
  text += `*${negocio}*\n`;
  text += `Entrega: ${c.delivery === "HOME" ? "🚚 Envío a domicilio" : "🏪 Retiro por el local"}\n`;
  if (c.delivery === "HOME") text += `Dirección: ${c.address}\n`;
  text += `Nombre: ${c.name}\n`;
  text += `Teléfono: ${c.phone}\n`;
  text += `Pago: ${c.payMethod === "TRANSFER" ? "Transferencia" : "Efectivo"}\n\n`;

  text += `🧾 *Detalle:*\n`;
  for (const { prod, qty } of st.cart.values()) {
    const unit = normalizeUnit(getAny(prod, ["unidad", "UNIDAD"], "unidad"));
    const price = Number(getAny(prod, ["precio", "PRECIO", "PRECIOPORKILO"], "0") || 0);
    const lineTotal = price * Number(qty || 0);
    text += `- ${safe(getAny(prod, ["nombre", "NOMBRE"], ""))} | ${qty} ${unit === "kg" ? "kg" : "unid"} | ${moneyARS(lineTotal)}\n`;
  }

  text += `\n🧺 Total productos: *${moneyARS(sub)}*\n`;
  if (c.delivery === "HOME") text += `🚚 Envío: *${moneyARS(envio)}*\n`;
  text += `💰 Total final: *${moneyARS(total)}*\n`;

  if (c.payMethod === "TRANSFER" && alias) {
    text += `\n🏦 Alias para transferir: *${alias}*\n`;
    text += `📌 ${nota}\n`;
    text += `\n✅ *Importante:* el pedido queda *pendiente* hasta que el vendedor confirme el pago.`;
  } else {
    text += `\n✅ *Importante:* el pedido queda *pendiente* hasta confirmación del vendedor.`;
  }

  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [[{ text: "📣 Compartir bot", callback_data: "SHARE:BOT" }]] },
  });

  st.checkout = null;
}

// --------------------
// Tarjeta de sellos (como ya te funcionó)
// --------------------
async function sendStampsCard(chatId) {
  const cfg = await getConfig();
  const usa = safe(cfg.UsaSellos).toUpperCase() === "SI";
  if (!usa) {
    await bot.sendMessage(chatId, "Por ahora la tarjeta de sellos está desactivada.", { reply_markup: mainMenuKeyboard(cfg) });
    return;
  }

  const cardUrl = normalizeImageUrl(pickConfig(cfg, ["TarjetaURL"], ""));
  const meta = Number(pickConfig(cfg, ["SellosPorNivel"], "10"));
  const premio = pickConfig(cfg, ["BeneficiosPorNivel"], "");

  const sellos = 0; // (cuando conectes con clientes reales, se calcula)
  const bar = "🟩".repeat(Math.min(sellos, meta)) + "⬜".repeat(Math.max(0, meta - sellos));

  let text = `🎫 *Tarjeta de sellos*\n\n${bar}\n\nSellos: *${sellos} / ${meta}*\n`;
  if (premio) text += `Premio al completar: *${premio}*\n`;
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

  // esperando cantidad
  if (st.awaitingQty) {
    const full = await getCatalog();
    const code = st.awaitingQty.code;
    const prod = full.find((p) => safe(getAny(p, ["codigo", "CODIGO", "id", "ID"], "")) === code);

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
      await bot.sendMessage(
        chatId,
        unit === "kg" ? "Cantidad inválida. Escribí gramos (ej: 250) o kg (ej: 0.5)." : "Cantidad inválida. Escribí un número (ej: 1, 2, 3).",
        { reply_markup: mainMenuKeyboard(cfg) }
      );
      return;
    }

    let qty = n;
    if (unit === "kg") {
      if (n >= 100) qty = n / 1000; // gramos => kg
    }

    await addToCart(chatId, prod, qty);
    return;
  }

  // Checkout por pasos (texto)
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
    await sendShareOptions(chatId);
    return;
  }

  await bot.sendMessage(chatId, "Elegí una opción del menú 👇", { reply_markup: mainMenuKeyboard(cfg) });
});

// --------------------
// Callback handler
// --------------------
bot.on("callback_query", async (q) => {
  const chatId = q.message?.chat?.id;
  const data = safe(q.data);
  const st = getState(chatId);

  try { await bot.answerCallbackQuery(q.id); } catch {}

  try {
    if (data === "OPEN:CATS") {
      await showCategories(chatId);
      return;
    }

    if (data === "SHARE:BOT") {
      await sendShareOptions(chatId);
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
      const pm = data.split(":")[1];
      if (!st.checkout) return;
      st.checkout.payMethod = pm;
      await checkoutSummary(chatId);
      return;
    }

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

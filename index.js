/**
 * EzerBot System - index.js (Render)
 * - Webhook Telegram
 * - Lee TODO desde Google Sheets (Config + Catalogo)
 * - Catalogo por categorias, paginado
 * - Carrito + Checkout (Módulo A: envío/retiro + ticket)
 * - Fallback: responde a cualquier texto (no solo /start)
 */

import express from "express";
import TelegramBot from "node-telegram-bot-api";

// =====================
// ENV
// =====================
const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const GAS_URL = (process.env.GAS_URL || "").trim(); // tu WebApp GAS (exec)
const PORT = process.env.PORT || 10000;

if (!BOT_TOKEN) console.log("❌ Falta BOT_TOKEN en Render Environment");
if (!GAS_URL) console.log("❌ Falta GAS_URL en Render Environment");

const app = express();
app.use(express.json({ limit: "2mb" }));

const bot = new TelegramBot(BOT_TOKEN, { webHook: true });

// =====================
// In-memory state (simple, rápido)
// =====================
const state = {
  cfg: null,
  cfgLoadedAt: 0,
  products: [],
  categories: [],
  productsLoadedAt: 0,
  chats: new Map(), // chatId -> { cart: [{codigo,nombre,precio,qty,unidad}] , lastCategory, lastPage }
  lastUpdateAt: null,
  lastUpdateChatId: null,
  lastText: null,
  lastError: null,
};

const CACHE_MS = 60 * 1000; // 1 minuto cache (para que responda rápido)

// =====================
// Utils
// =====================
function nowISO() {
  return new Date().toISOString();
}

function safeNum(x) {
  const n = Number(String(x || "").replace(/[^\d.,-]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function moneyARS(n) {
  try {
    return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 }).format(n);
  } catch {
    return `$${Math.round(n)} ARS`;
  }
}

function getChat(chatId) {
  if (!state.chats.has(chatId)) {
    state.chats.set(chatId, { cart: [], lastCategory: null, lastPage: 1 });
  }
  return state.chats.get(chatId);
}

function norm(s) {
  return String(s || "").trim();
}

function normalizeCategory(cat) {
  return norm(cat).replace(/\s+/g, " ");
}

function pickCfg(key, fallback = "") {
  if (!state.cfg) return fallback;
  const v = state.cfg[key];
  return v === undefined || v === null || String(v).trim() === "" ? fallback : String(v);
}

// =====================
// Fetch Config + Catalogo via GAS
// =====================
async function fetchJSON(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { ok: false, error: "Respuesta no-JSON", raw: text }; }
  return { status: res.status, data };
}

async function loadConfig(force = false) {
  if (!force && state.cfg && Date.now() - state.cfgLoadedAt < CACHE_MS) return state.cfg;

  const url = `${GAS_URL}?action=config`;
  const { status, data } = await fetchJSON(url);
  if (status !== 200 || !data || data.ok === false) {
    throw new Error(`Config no disponible: ${data?.error || "status " + status}`);
  }
  state.cfg = data.config || {};
  state.cfgLoadedAt = Date.now();
  return state.cfg;
}

async function loadCatalog(force = false) {
  if (!force && state.products.length && Date.now() - state.productsLoadedAt < CACHE_MS) return state.products;

  const url = `${GAS_URL}?action=catalogo`;
  const { status, data } = await fetchJSON(url);
  if (status !== 200 || !data || data.ok === false) {
    throw new Error(`Catálogo no disponible: ${data?.error || "status " + status}`);
  }

  // data.productos: [{CODIGO,NOMBRE,PRECIO,UNIDAD,PRECIOPORKILO,CODIGOBARRAS,DESCRIPCION,IMAGEN,CATEGORIA}, ...]
  const raw = Array.isArray(data.productos) ? data.productos : [];

  // ✅ ANTES filtrábamos por IMAGEN y eso te dejaba afuera categorías enteras
  const cleaned = raw
    .map(p => ({
      codigo: norm(p.CODIGO || p.codigo),
      nombre: norm(p.NOMBRE || p.nombre),
      precio: safeNum(p.PRECIO ?? p.precio),
      unidad: norm(p.UNIDAD || p.unidad || "unidad"),
      precioPorKilo: safeNum(p.PRECIOPORKILO ?? p.precioporkilo),
      barcode: norm(p.CODIGOBARRAS || p.codigobarras),
      descripcion: norm(p.DESCRIPCION || p.descripcion),
      imagen: norm(p.IMAGEN || p.imagen),
      categoria: normalizeCategory(p.CATEGORIA || p.categoria),
    }))
    .filter(p => p.codigo && p.nombre && p.categoria); // ✅ SOLO esto es obligatorio

  // categorías
  const cats = [...new Set(cleaned.map(p => p.categoria))].sort((a, b) => a.localeCompare(b, "es"));
  state.products = cleaned;
  state.categories = cats;
  state.productsLoadedAt = Date.now();
  return cleaned;
}

async function refreshAll(force = false) {
  await loadConfig(force);
  await loadCatalog(force);
}

// =====================
// Keyboard builders
// =====================
function mainMenuKeyboard() {
  return {
    keyboard: [
      [{ text: "🛍️ Catálogo" }, { text: "🛒 Mi carrito" }],
      [{ text: "🎁 Mis sellos" }],
      [{ text: "💬 Hablar con el vendedor" }],
      [{ text: "🏪 Información del local" }, { text: "📣 Compartir el bot" }],
      [{ text: "🔄 Recargar catálogo" }],
    ],
    resize_keyboard: true,
  };
}

function categoriesKeyboard() {
  const rows = [];
  const cats = state.categories || [];
  // 2 por fila
  for (let i = 0; i < cats.length; i += 2) {
    const row = [{ text: `🎁 ${cats[i]}` }];
    if (cats[i + 1]) row.push({ text: `🎁 ${cats[i + 1]}` });
    rows.push(row);
  }
  rows.push([{ text: "⬅️ Menú" }]);
  return { keyboard: rows, resize_keyboard: true };
}

function cartActionsKeyboard() {
  return {
    keyboard: [
      [{ text: "✅ Finalizar compra" }],
      [{ text: "🛍️ Seguir comprando" }, { text: "🧹 Vaciar carrito" }],
      [{ text: "⬅️ Menú" }],
    ],
    resize_keyboard: true,
  };
}

// =====================
// Messages (todo desde Config)
// =====================
function buildWelcome(chat) {
  const brand = pickCfg("BRAND_NOMBRE", "Todo Queso");
  const emoji = pickCfg("BRAND_EMOJI", "🧀");
  const warm = pickCfg(
    "MSG_BIENVENIDA",
    `Hola 👋 Soy el asistente de ${brand} ${emoji}\n\nDesde acá podés:\n• Ver el catálogo\n• Armar tu pedido\n• Finalizar compra\n\n👇 Elegí una opción`
  );

  const logo = pickCfg("BRAND_LOGO_URL", "");
  return { text: warm, photo: logo };
}

function buildLocalInfo() {
  const brand = pickCfg("BRAND_NOMBRE", "Todo Queso");
  const dir = pickCfg("LOCAL_DIRECCION", "-");
  const horarios = pickCfg("LOCAL_HORARIOS", "-");
  const tel = pickCfg("LOCAL_TELEFONO", "-");
  const ig = pickCfg("LOCAL_INSTAGRAM", "");
  const fb = pickCfg("LOCAL_FACEBOOK", "");
  const extra = pickCfg("LOCAL_TEXTO", "");

  const logo = pickCfg("BRAND_LOGO_URL", "");

  let txt = `🏪 *${brand}*\n📍 ${dir}\n🕒 ${horarios}\n📞 ${tel}`;
  if (ig) txt += `\n📸 Instagram: ${ig}`;
  if (fb) txt += `\n📘 Facebook: ${fb}`;
  if (extra) txt += `\n\n${extra}`;

  return { text: txt, photo: logo };
}

function buildVendorWhatsAppLink() {
  // en Config guardá solo números con país, ejemplo: 5491133334444
  const wa = pickCfg("VENDEDOR_WHATSAPP", "");
  const msg = pickCfg("MSG_CONTACTO_VENDEDOR", "Hola, quiero hacer una consulta 🙂");
  if (!wa) return null;
  const url = `https://wa.me/${wa}?text=${encodeURIComponent(msg)}`;
  return url;
}

function buildShareText() {
  const brand = pickCfg("BRAND_NOMBRE", "Todo Queso");
  const share = pickCfg("MSG_COMPARTIR_BOT", `Compartí este bot de ${brand} con tus amigos 🙌`);
  return share;
}

// =====================
// Catalog render (por categoría)
// =====================
function productsByCategory(cat) {
  return state.products.filter(p => p.categoria === cat);
}

async function sendCategoryPage(chatId, cat, page = 1) {
  const chat = getChat(chatId);
  chat.lastCategory = cat;
  chat.lastPage = page;

  const items = productsByCategory(cat);
  if (!items.length) {
    await bot.sendMessage(chatId, `⚠️ No encontré productos en *${cat}*`, { parse_mode: "Markdown", reply_markup: categoriesKeyboard() });
    return;
  }

  const perPage = 1; // igual que tu captura (1 por página)
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const p = Math.min(Math.max(1, page), totalPages);
  const idx = (p - 1) * perPage;
  const prod = items[idx];

  const title = `📃 *${cat}* — Página *${p}/${totalPages}*`;
  const price = prod.precio > 0 ? moneyARS(prod.precio) : (prod.precioPorKilo > 0 ? `${moneyARS(prod.precioPorKilo)}/kg` : "Consultar");
  const idLine = `🆔 ${prod.codigo}`;
  const desc = prod.descripcion ? `\n\n_${prod.descripcion}_` : "";

  const caption = `${title}\n\n*${prod.nombre}*\n💰 ${price}\n${idLine}${desc}`;

  // botones inline (quiero este / compartir / nav)
  const inline = {
    inline_keyboard: [
      [
        { text: "✅ Quiero este", callback_data: `ADD:${prod.codigo}` },
        { text: "📣 Compartir", callback_data: `SHAREPROD:${prod.codigo}` },
      ],
      [{ text: "↩️ Volver a categoría", callback_data: `CATS` }],
      [
        { text: "⬅️ Anterior", callback_data: `PAGE:${cat}:${p - 1}` },
        { text: "📁 Categorías", callback_data: `CATS` },
        { text: "➡️ Siguiente", callback_data: `PAGE:${cat}:${p + 1}` },
      ],
    ],
  };

  // si hay imagen, la mostramos, si no, mandamos texto
  if (prod.imagen) {
    await bot.sendPhoto(chatId, prod.imagen, { caption, parse_mode: "Markdown", reply_markup: inline });
  } else {
    await bot.sendMessage(chatId, caption, { parse_mode: "Markdown", reply_markup: inline });
  }
}

// =====================
// Cart + Checkout (Módulo A)
// =====================
function addToCart(chatId, codigo) {
  const chat = getChat(chatId);
  const p = state.products.find(x => x.codigo === codigo);
  if (!p) return { ok: false, msg: "No encontré ese producto." };

  const found = chat.cart.find(i => i.codigo === codigo);
  if (found) {
    found.qty += 1;
  } else {
    chat.cart.push({
      codigo: p.codigo,
      nombre: p.nombre,
      precio: p.precio || p.precioPorKilo || 0,
      unidad: p.unidad || "unidad",
      qty: 1,
    });
  }
  return { ok: true, product: p };
}

function cartText(chatId) {
  const chat = getChat(chatId);
  if (!chat.cart.length) return "🛒 Tu carrito está vacío.";

  let total = 0;
  const lines = chat.cart.map((i, n) => {
    const sub = (i.precio || 0) * (i.qty || 0);
    total += sub;
    return `${n + 1}) ${i.nombre} (${i.codigo})\n   Cantidad: ${i.qty}\n   Subtotal: ${moneyARS(sub)}`;
  });

  return `🛒 *Tu carrito:*\n\n${lines.join("\n\n")}\n\n💰 *Total:* ${moneyARS(total)}`;
}

function clearCart(chatId) {
  const chat = getChat(chatId);
  chat.cart = [];
}

function nextTicket() {
  // ticket simple: TQ-###### (podés cambiar el prefijo desde Config)
  const pref = pickCfg("TICKET_PREFIJO", "TQ");
  const n = Math.floor(100000 + Math.random() * 900000);
  return `${pref}-${n}`;
}

function shippingOptionsText() {
  // textos desde Config
  const envioTxt = pickCfg("CHECKOUT_TEXTO_ENVIO", "🚚 Envío a domicilio");
  const retiroTxt = pickCfg("CHECKOUT_TEXTO_RETIRO", "🏪 Retiro en el local");
  return { envioTxt, retiroTxt };
}

async function sendCheckoutStep(chatId) {
  const chat = getChat(chatId);
  if (!chat.cart.length) {
    await bot.sendMessage(chatId, "🛒 Tu carrito está vacío.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  const resumen = cartText(chatId);
  const { envioTxt, retiroTxt } = shippingOptionsText();

  await bot.sendMessage(chatId, `🧾 *Finalizar compra*\n\n${resumen}\n\n¿Cómo querés recibir tu pedido?`, {
    parse_mode: "Markdown",
    reply_markup: {
      keyboard: [
        [{ text: envioTxt }],
        [{ text: retiroTxt }],
        [{ text: "⬅️ Menú" }],
      ],
      resize_keyboard: true,
    },
  });
}

async function finalizeTicket(chatId, mode) {
  const chat = getChat(chatId);
  if (!chat.cart.length) {
    await bot.sendMessage(chatId, "🛒 Tu carrito está vacío.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  const brand = pickCfg("BRAND_NOMBRE", "Todo Queso");
  const alias = pickCfg("PAGO_ALIAS", "");
  const cbu = pickCfg("PAGO_CBU", "");
  const envioCosto = safeNum(pickCfg("ENVIO_COSTO", "0"));
  const retiroCosto = 0;

  const now = new Date();
  const fecha = now.toLocaleDateString("es-AR");
  const hora = now.toLocaleTimeString("es-AR");

  let subtotal = 0;
  const lines = chat.cart.map(i => {
    const sub = (i.precio || 0) * (i.qty || 0);
    subtotal += sub;
    return `• ${i.nombre} (${i.qty})  ${moneyARS(sub)}`;
  });

  const extra = mode === "ENVIO" ? envioCosto : retiroCosto;
  const total = subtotal + extra;

  const ticket = nextTicket();

  // Texto cálido configurable
  const msgOk = pickCfg(
    "MSG_TICKET",
    `Gracias por tu compra 💛\n\nEnviá el comprobante para preparar tu pedido.`
  );

  let txt = `🧾 *${brand}*\nTicket N° *${ticket}*\n📅 ${fecha}, ${hora}\n\n${lines.join("\n")}\n\n`;
  if (mode === "ENVIO") txt += `🚚 Envío: ${moneyARS(envioCosto)}\n`;
  if (mode === "RETIRO") txt += `🏪 Retiro en el local: ${moneyARS(0)}\n`;
  txt += `💰 *TOTAL:* ${moneyARS(total)}\n\n`;

  if (alias) txt += `🏷️ Alias: \`${alias}\`\n`;
  if (cbu) txt += `🏦 CBU: \`${cbu}\`\n`;

  txt += `\n${msgOk}`;

  await bot.sendMessage(chatId, txt, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });

  // Limpio carrito al final del checkout (como caja)
  clearCart(chatId);
}

// =====================
// Telegram handlers
// =====================
async function ensureLoaded(force = false) {
  try {
    await refreshAll(force);
    state.lastError = null;
  } catch (e) {
    state.lastError = String(e?.message || e);
    console.log("❌ ensureLoaded:", state.lastError);
  }
}

async function sendWelcome(chatId) {
  await ensureLoaded(false);

  const w = buildWelcome(getChat(chatId));
  if (w.photo) {
    await bot.sendPhoto(chatId, w.photo, { caption: w.text, reply_markup: mainMenuKeyboard() });
  } else {
    await bot.sendMessage(chatId, w.text, { reply_markup: mainMenuKeyboard() });
  }
}

async function handleText(chatId, text) {
  await ensureLoaded(false);

  const t = norm(text);
  const low = t.toLowerCase();

  // ✅ /start y cualquier comando
  if (low === "/start" || low === "start" || low.startsWith("/")) {
    await sendWelcome(chatId);
    return;
  }

  // Menú
  if (t === "⬅️ Menú" || low === "menu" || low === "menú") {
    await sendWelcome(chatId);
    return;
  }

  // Recargar catálogo
  if (t === "🔄 Recargar catálogo" || low.includes("recargar")) {
    await ensureLoaded(true);
    const cats = state.categories?.length || 0;
    const prods = state.products?.length || 0;
    await bot.sendMessage(chatId, `✅ Listo. Recargué el catálogo.\n📁 Categorías: ${cats}\n🧾 Productos: ${prods}`, { reply_markup: mainMenuKeyboard() });
    return;
  }

  // Catálogo
  if (t === "🛍️ Catálogo" || low.includes("catálogo") || low.includes("catalogo")) {
    if (!state.categories.length) {
      await bot.sendMessage(
        chatId,
        "⚠️ No hay categorías cargadas todavía.\nRevisá que en `Catalogo` exista la columna `CATEGORIA` y que no esté vacía.",
        { reply_markup: mainMenuKeyboard() }
      );
      return;
    }
    await bot.sendMessage(chatId, "📁 Elegí una categoría:", { reply_markup: categoriesKeyboard() });
    return;
  }

  // Selección de categoría desde teclado (viene como "🎁 Promos")
  if (t.startsWith("🎁 ")) {
    const cat = normalizeCategory(t.replace("🎁 ", ""));
    if (!state.categories.includes(cat)) {
      await bot.sendMessage(chatId, "⚠️ Esa categoría no existe (todavía). Probá recargar el catálogo.", { reply_markup: categoriesKeyboard() });
      return;
    }
    await sendCategoryPage(chatId, cat, 1);
    return;
  }

  // Carrito
  if (t === "🛒 Mi carrito" || low.includes("carrito")) {
    const msg = cartText(chatId);
    await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", reply_markup: cartActionsKeyboard() });
    return;
  }

  if (t === "🧹 Vaciar carrito") {
    clearCart(chatId);
    await bot.sendMessage(chatId, "🧹 Listo, vacié tu carrito.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (t === "🛍️ Seguir comprando") {
    await bot.sendMessage(chatId, "📁 Elegí una categoría:", { reply_markup: categoriesKeyboard() });
    return;
  }

  if (t === "✅ Finalizar compra") {
    await sendCheckoutStep(chatId);
    return;
  }

  // Checkout: envío / retiro
  const { envioTxt, retiroTxt } = shippingOptionsText();
  if (t === envioTxt) {
    await bot.sendMessage(chatId, pickCfg("MSG_ENVIO", "🚚 Tu envío se realizará según horario del local."), { reply_markup: mainMenuKeyboard() });
    await finalizeTicket(chatId, "ENVIO");
    return;
  }
  if (t === retiroTxt) {
    await bot.sendMessage(chatId, pickCfg("MSG_RETIRO", "🏪 Tu pedido será preparado y podés pasar a retirarlo."), { reply_markup: mainMenuKeyboard() });
    await finalizeTicket(chatId, "RETIRO");
    return;
  }

  // Info local (con logo)
  if (t === "🏪 Información del local") {
    const info = buildLocalInfo();
    if (info.photo) {
      await bot.sendPhoto(chatId, info.photo, { caption: info.text, parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
    } else {
      await bot.sendMessage(chatId, info.text, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
    }
    return;
  }

  // Hablar con vendedor (WhatsApp)
  if (t === "💬 Hablar con el vendedor") {
    const url = buildVendorWhatsAppLink();
    if (!url) {
      await bot.sendMessage(chatId, "⚠️ Todavía no está configurado el WhatsApp del vendedor en Config.", { reply_markup: mainMenuKeyboard() });
      return;
    }
    await bot.sendMessage(chatId, "💬 Hablá con nosotros por WhatsApp 👇", {
      reply_markup: {
        inline_keyboard: [[{ text: "📱 Abrir WhatsApp", url }]],
      },
    });
    return;
  }

  // Compartir bot
  if (t === "📣 Compartir el bot") {
    await bot.sendMessage(chatId, buildShareText(), { reply_markup: mainMenuKeyboard() });
    return;
  }

  // Mis sellos (placeholder por ahora)
  if (t === "🎁 Mis sellos") {
    await bot.sendMessage(
      chatId,
      pickCfg("MSG_SELLOS", "Tu tarjeta de sellos todavía no está visible en este módulo. La activamos en el siguiente paso (sellos/niveles)."),
      { reply_markup: mainMenuKeyboard() }
    );
    return;
  }

  // ✅ Fallback cálido: si escribe “hola”, “que tal”, etc.
  const fallback = pickCfg(
    "MSG_FALLBACK",
    "Dale 😊 Elegí una opción del menú 👇\n\nSi querés ver productos, tocá *Catálogo*."
  );

  await bot.sendMessage(chatId, fallback, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
}

// =====================
// Callback queries (inline buttons)
// =====================
bot.on("callback_query", async (q) => {
  try {
    const chatId = q.message?.chat?.id;
    if (!chatId) return;

    const data = q.data || "";
    await ensureLoaded(false);

    if (data === "CATS") {
      await bot.sendMessage(chatId, "📁 Elegí una categoría:", { reply_markup: categoriesKeyboard() });
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data.startsWith("PAGE:")) {
      const [, catRaw, pageRaw] = data.split(":");
      const cat = normalizeCategory(catRaw);
      const page = Number(pageRaw);
      await sendCategoryPage(chatId, cat, page);
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data.startsWith("ADD:")) {
      const codigo = data.replace("ADD:", "");
      const r = addToCart(chatId, codigo);
      if (!r.ok) {
        await bot.answerCallbackQuery(q.id, { text: "No pude agregarlo 😕", show_alert: false });
        return;
      }
      await bot.answerCallbackQuery(q.id, { text: "✅ Agregado al carrito", show_alert: false });
      await bot.sendMessage(chatId, `✅ Agregado:\n${r.product.nombre}\nSubtotal: ${moneyARS((r.product.precio || r.product.precioPorKilo || 0))}`, {
        reply_markup: cartActionsKeyboard(),
      });
      return;
    }

    if (data.startsWith("SHAREPROD:")) {
      const codigo = data.replace("SHAREPROD:", "");
      const p = state.products.find(x => x.codigo === codigo);
      const brand = pickCfg("BRAND_NOMBRE", "Todo Queso");
      const txt = p
        ? `📣 ${brand}\n✅ ${p.nombre}\n🆔 ${p.codigo}\n💰 ${p.precio ? moneyARS(p.precio) : "Consultar"}`
        : `📣 ${brand}`;
      await bot.sendMessage(chatId, txt, { reply_markup: mainMenuKeyboard() });
      await bot.answerCallbackQuery(q.id);
      return;
    }

    await bot.answerCallbackQuery(q.id);
  } catch (e) {
    state.lastError = String(e?.message || e);
    console.log("❌ callback_query:", state.lastError);
  }
});

// =====================
// Text messages
// =====================
bot.on("message", async (msg) => {
  try {
    const chatId = msg.chat?.id;
    const text = msg.text;
    if (!chatId) return;

    state.lastUpdateAt = nowISO();
    state.lastUpdateChatId = chatId;
    state.lastText = text || null;

    // si no es texto, igual respondemos con menú
    if (!text) {
      await bot.sendMessage(chatId, pickCfg("MSG_NO_TEXTO", "Te leo 😊 Tocá una opción del menú 👇"), { reply_markup: mainMenuKeyboard() });
      return;
    }

    await handleText(chatId, text);
  } catch (e) {
    state.lastError = String(e?.message || e);
    console.log("❌ on message:", state.lastError);
    try {
      await bot.sendMessage(msg.chat.id, "Uy 😕 hubo un error interno. Probá de nuevo en 10 segundos.", { reply_markup: mainMenuKeyboard() });
    } catch {}
  }
});

// =====================
// Express Routes
// =====================

// health
app.get("/", (req, res) => {
  res.status(200).send("ok");
});

// debug
app.get("/debug", async (req, res) => {
  try {
    await ensureLoaded(false);
    res.status(200).json({
      ok: true,
      time: nowISO(),
      bot: { username: "unknown (webhook mode)" },
      cfgKeys: state.cfg ? Object.keys(state.cfg).slice(0, 40) : [],
      categoriesCount: state.categories?.length || 0,
      productsCount: state.products?.length || 0,
      sampleCategories: (state.categories || []).slice(0, 10),
      sampleProduct: state.products[0] || null,
      lastUpdateAt: state.lastUpdateAt,
      lastUpdateChatId: state.lastUpdateChatId,
      lastText: state.lastText,
      lastError: state.lastError,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e), lastError: state.lastError });
  }
});

// webhook endpoint
app.post("/webhook", async (req, res) => {
  try {
    await bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (e) {
    state.lastError = String(e?.message || e);
    console.log("❌ /webhook error:", state.lastError);
    res.sendStatus(200); // Telegram igual quiere 200
  }
});

// =====================
// Startup
// =====================
async function start() {
  try {
    // precarga para validar conexión
    await ensureLoaded(true);

    // set webhook
    const baseUrl = process.env.RENDER_EXTERNAL_URL
      ? process.env.RENDER_EXTERNAL_URL.trim()
      : ""; // Render suele proveerlo si lo agregás en env manual

    // Si no hay RENDER_EXTERNAL_URL, igual funciona si vos seteaste el webhook a mano.
    if (baseUrl) {
      const hook = `${baseUrl.replace(/\/$/, "")}/webhook`;
      await bot.setWebHook(hook);
      console.log("✅ Webhook seteado:", hook);
    } else {
      console.log("⚠️ No hay RENDER_EXTERNAL_URL. Si el bot no responde, configurá el webhook a /webhook.");
    }

    app.listen(PORT, () => {
      console.log("✅ Server up on", PORT);
      console.log("✅ Ready:", nowISO());
    });
  } catch (e) {
    state.lastError = String(e?.message || e);
    console.log("❌ Start error:", state.lastError);
    app.listen(PORT, () => console.log("⚠️ Server up (con error) on", PORT));
  }
}

start();

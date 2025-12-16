/**
 * EzerBot System - Telegram Seller Assistant (JSON-driven)
 * - Reads all business info and catalog from a public JSON (GitHub Pages)
 * - Works on Render using Webhook (recommended) or Polling fallback
 *
 * ENV required:
 * - TELEGRAM_BOT_TOKEN = your bot token
 * Optional:
 * - CONFIG_URL = public JSON url (default: your GitHub Pages config.json)
 * - PUBLIC_URL = your render public url, e.g. https://ezerbot-system.onrender.com (for webhook)
 * - PORT = Render port (provided by Render)
 */

import express from "express";
import TelegramBot from "node-telegram-bot-api";

const app = express();
app.use(express.json());

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
if (!TOKEN) {
  console.error("Falta TELEGRAM_BOT_TOKEN en variables de entorno.");
  process.exit(1);
}

// ✅ Default: tu GitHub Pages (cambialo solo si querés)
const DEFAULT_CONFIG_URL = "https://jemp9791.github.io/ezerbot-config/config.json";
const CONFIG_URL_RAW = process.env.CONFIG_URL || DEFAULT_CONFIG_URL;

// Render URL pública (para webhook). Ej: https://ezerbot-system.onrender.com
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const PORT = Number(process.env.PORT || 10000);

// --- Helpers ---
function normalizeUrl(u) {
  if (!u) return "";
  let s = String(u).trim();
  // Evita comillas coladas
  s = s.replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "");
  // Si alguien pegó "google.com/..." sin https
  if (s.startsWith("//")) s = "https:" + s;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  return s;
}

function safeText(s, fallback = "") {
  if (s === null || s === undefined) return fallback;
  return String(s).trim();
}

function money(n) {
  const num = Number(n);
  if (Number.isNaN(num)) return safeText(n);
  // Formato AR: 30.000
  return num.toLocaleString("es-AR");
}

// --- In-memory state ---
let CONFIG_CACHE = null;
let CONFIG_CACHE_AT = 0;
const CACHE_MS = 60_000; // 60s cache
const carts = new Map(); // chatId -> { items: [{codigo, nombre, precio, qty}], updatedAt }

async function loadConfig(force = false) {
  const now = Date.now();
  if (!force && CONFIG_CACHE && now - CONFIG_CACHE_AT < CACHE_MS) return CONFIG_CACHE;

  const url = normalizeUrl(CONFIG_URL_RAW);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "accept": "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} leyendo config`);
    const data = await res.json();

    // Soporta dos formatos:
    // A) { negocio: {...}, catalogo: [...], promos: [...], sellos: [...] }
    // B) { Config: [...], Catalogo: [...], Promos: [...], Sellos: [...] } (tu inicial)
    const normalized = normalizeConfig(data);

    CONFIG_CACHE = normalized;
    CONFIG_CACHE_AT = now;

    return normalized;
  } catch (e) {
    console.error("Error leyendo CONFIG:", e?.message || e);
    // Si hay cache viejo, lo devolvemos igual (para no “matar” el bot)
    if (CONFIG_CACHE) return CONFIG_CACHE;
    // Si no hay nada, devolvemos mínimo para responder
    return normalizeConfig({});
  }
}

function normalizeConfig(raw) {
  const r = raw || {};

  // Formato A (nuevo)
  if (r.negocio || r.catalogo) {
    return {
      negocio: r.negocio || {},
      catalogo: Array.isArray(r.catalogo) ? r.catalogo : [],
      promos: Array.isArray(r.promos) ? r.promos : [],
      sellos: Array.isArray(r.sellos) ? r.sellos : [],
      ajustes: r.ajustes || {},
    };
  }

  // Formato B (tu inicial por “arrays”)
  // { Config: [], Catalogo: [], Promos: [], Sellos: [] }
  const cfgArray = Array.isArray(r.Config) ? r.Config : [];
  const catalogoArray = Array.isArray(r.Catalogo) ? r.Catalogo : [];
  const promosArray = Array.isArray(r.Promos) ? r.Promos : [];
  const sellosArray = Array.isArray(r.Sellos) ? r.Sellos : [];

  // Si Config es array, tomamos el primer objeto
  const negocio = (cfgArray[0] && typeof cfgArray[0] === "object") ? cfgArray[0] : {};

  return {
    negocio,
    catalogo: catalogoArray,
    promos: promosArray,
    sellos: sellosArray,
    ajustes: {},
  };
}

function getCart(chatId) {
  if (!carts.has(chatId)) carts.set(chatId, { items: [], updatedAt: Date.now() });
  return carts.get(chatId);
}

function clearCart(chatId) {
  carts.set(chatId, { items: [], updatedAt: Date.now() });
}

function addToCart(chatId, product, qty = 1) {
  const cart = getCart(chatId);
  const q = Math.max(1, Number(qty) || 1);
  const existing = cart.items.find(i => i.codigo === product.codigo);
  if (existing) existing.qty += q;
  else cart.items.push({ codigo: product.codigo, nombre: product.nombre, precio: product.precio, qty: q });
  cart.updatedAt = Date.now();
  return cart;
}

function cartTotal(cart) {
  return cart.items.reduce((acc, it) => acc + (Number(it.precio) || 0) * (Number(it.qty) || 0), 0);
}

function mainMenuKeyboard() {
  return {
    keyboard: [
      [{ text: "🛍️ Catálogo" }, { text: "🔥 Promos" }],
      [{ text: "🛒 Mi carrito" }, { text: "✅ Finalizar compra" }],
      [{ text: "📍 Horarios y dirección" }, { text: "📣 Compartir el bot" }],
    ],
    resize_keyboard: true,
  };
}

function catalogInlineKeyboard(items, page = 1, pageSize = 6) {
  const p = Math.max(1, page);
  const start = (p - 1) * pageSize;
  const slice = items.slice(start, start + pageSize);

  const rows = slice.map(prod => ([
    { text: `➕ ${safeText(prod.nombre, "Producto")} (${money(prod.precio)})`, callback_data: `ADD:${safeText(prod.codigo)}` }
  ]));

  const nav = [];
  if (start > 0) nav.push({ text: "⬅️ Anterior", callback_data: `PAGE:${p - 1}` });
  if (start + pageSize < items.length) nav.push({ text: "Siguiente ➡️", callback_data: `PAGE:${p + 1}` });

  if (nav.length) rows.push(nav);
  rows.push([{ text: "🛒 Ver carrito", callback_data: "CART" }]);

  return { inline_keyboard: rows };
}

function promosInlineKeyboard(promos) {
  const rows = promos.slice(0, 10).map((p, idx) => ([
    { text: `ℹ️ ${safeText(p.titulo || p.nombre || `Promo ${idx + 1}`)}`, callback_data: `PROMO:${idx}` }
  ]));
  rows.push([{ text: "🛍️ Ir al catálogo", callback_data: "CATALOG" }]);
  return { inline_keyboard: rows };
}

function buildWelcome(cfg) {
  const n = safeText(cfg.negocio?.nombre, "¡Hola!");
  const dir = safeText(cfg.negocio?.direccion);
  const hor = safeText(cfg.negocio?.horarios);
  const tel = safeText(cfg.negocio?.telefono);

  const parts = [];
  parts.push(`👋 ¡Hola! Soy el asistente de *${n}*.`);
  parts.push(`Estoy para ayudarte a elegir y armar tu pedido.`);

  const info = [];
  if (dir) info.push(`📍 ${dir}`);
  if (hor) info.push(`🕒 ${hor}`);
  if (tel) info.push(`📞 ${tel}`);
  if (info.length) parts.push(`\n${info.join("\n")}`);

  parts.push(`\nElegí una opción del menú 👇`);
  return parts.join("\n");
}

function buildBusinessInfo(cfg) {
  const n = safeText(cfg.negocio?.nombre, "Negocio");
  const logo = safeText(cfg.negocio?.logo);
  const dir = safeText(cfg.negocio?.direccion);
  const hor = safeText(cfg.negocio?.horarios);
  const tel = safeText(cfg.negocio?.telefono);
  const ig = safeText(cfg.negocio?.instagram);

  const lines = [];
  lines.push(`🏪 *${n}*`);
  if (dir) lines.push(`📍 Dirección: ${dir}`);
  if (hor) lines.push(`🕒 Horarios: ${hor}`);
  if (tel) lines.push(`📞 Tel: ${tel}`);
  if (ig) lines.push(`📷 Instagram: ${ig}`);
  if (logo) lines.push(`🖼️ Logo: ${logo}`);

  return lines.join("\n");
}

function buildCartText(cfg, cart) {
  const n = safeText(cfg.negocio?.nombre, "el negocio");
  if (!cart.items.length) return `🛒 Tu carrito está vacío.\nQuerés que te muestre el catálogo de *${n}*?`;

  const lines = [];
  lines.push(`🛒 *Tu carrito*`);
  cart.items.forEach((it, idx) => {
    lines.push(`${idx + 1}) ${it.nombre} x${it.qty} — $${money((Number(it.precio) || 0) * it.qty)}`);
  });
  lines.push(`\n💰 Total: *$${money(cartTotal(cart))}*`);
  lines.push(`\nSi querés agregar más, tocá *Catálogo*.`);
  return lines.join("\n");
}

function findProductByCode(cfg, code) {
  const c = safeText(code);
  return cfg.catalogo.find(p => safeText(p.codigo) === c) || null;
}

function buildOrderSummary(cfg, cart, buyer) {
  const n = safeText(cfg.negocio?.nombre, "Negocio");
  const total = cartTotal(cart);

  const lines = [];
  lines.push(`🧾 *Nuevo pedido* — ${n}`);
  lines.push(`👤 Cliente: ${safeText(buyer?.name, "Sin nombre")} (${safeText(buyer?.username, "sin user")})`);
  lines.push(`🆔 ChatID: ${safeText(buyer?.chatId)}`);
  lines.push(`\n📦 Items:`);
  cart.items.forEach((it, idx) => {
    lines.push(`${idx + 1}) ${it.nombre} x${it.qty} — $${money((Number(it.precio) || 0) * it.qty)}`);
  });
  lines.push(`\n💰 Total: *$${money(total)}*`);
  lines.push(`\n✅ Responder al cliente desde Telegram para coordinar entrega/retiro.`);
  return lines.join("\n");
}

// --- Telegram Bot ---
const bot = new TelegramBot(TOKEN, { polling: false });

// Webhook endpoint
app.post("/webhook", async (req, res) => {
  try {
    await bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (e) {
    console.error("Error processUpdate:", e?.message || e);
    res.sendStatus(200);
  }
});

// Health
app.get("/", (req, res) => res.status(200).send("OK - EzerBot System"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// --- Bot logic ---
bot.onText(/\/start/, async (msg) => {
  const cfg = await loadConfig();
  await bot.sendMessage(msg.chat.id, buildWelcome(cfg), {
    parse_mode: "Markdown",
    reply_markup: mainMenuKeyboard(),
  });
});

bot.on("message", async (msg) => {
  // Ignorar comandos ya manejados
  if (msg.text && msg.text.startsWith("/")) return;

  const chatId = msg.chat.id;
  const text = safeText(msg.text).toLowerCase();
  const cfg = await loadConfig();

  // Menú principal
  if (text.includes("catálogo") || text === "🛍️ catálogo") {
    if (!cfg.catalogo.length) {
      await bot.sendMessage(chatId, "⏳ Todavía no cargó el catálogo. Probá de nuevo en unos segundos.", {
        reply_markup: mainMenuKeyboard(),
      });
      return;
    }
    await bot.sendMessage(chatId, "🛍️ *Catálogo*\nElegí un producto para agregar al carrito:", {
      parse_mode: "Markdown",
      reply_markup: catalogInlineKeyboard(cfg.catalogo, 1),
    });
    return;
  }

  if (text.includes("promos") || text === "🔥 promos") {
    if (!cfg.promos.length) {
      await bot.sendMessage(chatId, "🔥 Todavía no hay promos cargadas. Querés que te muestre el catálogo?", {
        reply_markup: mainMenuKeyboard(),
      });
      return;
    }
    await bot.sendMessage(chatId, "🔥 *Promos*\nTocá una promo para ver detalles:", {
      parse_mode: "Markdown",
      reply_markup: promosInlineKeyboard(cfg.promos),
    });
    return;
  }

  if (text.includes("carrito") || text === "🛒 mi carrito") {
    const cart = getCart(chatId);
    await bot.sendMessage(chatId, buildCartText(cfg, cart), {
      parse_mode: "Markdown",
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  if (text.includes("finalizar") || text === "✅ finalizar compra") {
    const cart = getCart(chatId);
    if (!cart.items.length) {
      await bot.sendMessage(chatId, "🛒 Tu carrito está vacío. Primero agregá algo del catálogo 😊", {
        reply_markup: mainMenuKeyboard(),
      });
      return;
    }

    // Enviar pedido al vendedor si existe vendedorChatId en config
    const vendedorChatId = cfg.negocio?.vendedorChatId || cfg.ajustes?.vendedorChatId;

    const buyer = {
      chatId,
      name: `${safeText(msg.from?.first_name)} ${safeText(msg.from?.last_name)}`.trim(),
      username: msg.from?.username ? `@${msg.from.username}` : "sin user",
    };

    const resumen = buildOrderSummary(cfg, cart, buyer);

    if (vendedorChatId) {
      try {
        await bot.sendMessage(Number(vendedorChatId), resumen, { parse_mode: "Markdown" });
      } catch (e) {
        console.error("No pude avisar al vendedor:", e?.message || e);
      }
    }

    await bot.sendMessage(chatId,
      `✅ *Pedido enviado*\nYa lo recibimos. En breve te respondemos para coordinar.\n\n💰 Total: *$${money(cartTotal(cart))}*`,
      { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() }
    );

    clearCart(chatId);
    return;
  }

  if (text.includes("horarios") || text.includes("dirección") || text === "📍 horarios y dirección") {
    await bot.sendMessage(chatId, buildBusinessInfo(cfg), {
      parse_mode: "Markdown",
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  if (text.includes("compartir") || text === "📣 compartir el bot") {
    const botUser = (await bot.getMe()).username;
    await bot.sendMessage(chatId, `📣 Compartí el bot con tus amigos:\nhttps://t.me/${botUser}`, {
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  // Respuesta “vendedora” inteligente simple: intenta buscar por palabra en catálogo
  if (text.length >= 3 && cfg.catalogo.length) {
    const found = cfg.catalogo.filter(p => safeText(p.nombre).toLowerCase().includes(text)).slice(0, 6);
    if (found.length) {
      await bot.sendMessage(chatId, `Encontré estos productos para *"${safeText(msg.text)}"* 👇`, {
        parse_mode: "Markdown",
        reply_markup: catalogInlineKeyboard(found, 1, 6),
      });
      return;
    }
  }

  // Fallback vendedor (no “frío”)
  const nombreNegocio = safeText(cfg.negocio?.nombre, "nuestro local");
  await bot.sendMessage(chatId,
    `😊 Decime qué estás buscando y te ayudo.\n\nPodés tocar *Catálogo* para ver todo lo disponible en *${nombreNegocio}*.`,
    { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() }
  );
});

// Inline actions
bot.on("callback_query", async (q) => {
  const chatId = q.message?.chat?.id;
  if (!chatId) return;

  const cfg = await loadConfig();
  const data = safeText(q.data);

  try {
    if (data === "CART") {
      const cart = getCart(chatId);
      await bot.sendMessage(chatId, buildCartText(cfg, cart), {
        parse_mode: "Markdown",
        reply_markup: mainMenuKeyboard(),
      });
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data === "CATALOG") {
      await bot.sendMessage(chatId, "🛍️ *Catálogo*\nElegí un producto para agregar al carrito:", {
        parse_mode: "Markdown",
        reply_markup: catalogInlineKeyboard(cfg.catalogo, 1),
      });
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data.startsWith("PAGE:")) {
      const page = Number(data.split(":")[1] || "1");
      await bot.editMessageReplyMarkup(
        catalogInlineKeyboard(cfg.catalogo, page),
        { chat_id: chatId, message_id: q.message.message_id }
      );
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data.startsWith("ADD:")) {
      const code = data.split(":")[1];
      const prod = findProductByCode(cfg, code);
      if (!prod) {
        await bot.answerCallbackQuery(q.id, { text: "No encontré ese producto 😕" });
        return;
      }
      addToCart(chatId, prod, 1);
      await bot.answerCallbackQuery(q.id, { text: `Agregado: ${safeText(prod.nombre)}` });
      return;
    }

    if (data.startsWith("PROMO:")) {
      const idx = Number(data.split(":")[1] || "0");
      const p = cfg.promos[idx];
      if (!p) {
        await bot.answerCallbackQuery(q.id, { text: "Promo no disponible" });
        return;
      }
      const titulo = safeText(p.titulo || p.nombre || `Promo ${idx + 1}`);
      const desc = safeText(p.descripcion || p.detalle || "");
      const precio = p.precio !== undefined ? `\n💰 Precio: *$${money(p.precio)}*` : "";
      await bot.sendMessage(chatId, `🔥 *${titulo}*\n${desc}${precio}`, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🛍️ Ver catálogo", callback_data: "CATALOG" }],
            [{ text: "🛒 Ver carrito", callback_data: "CART" }],
          ]
        }
      });
      await bot.answerCallbackQuery(q.id);
      return;
    }

    await bot.answerCallbackQuery(q.id);
  } catch (e) {
    console.error("callback error:", e?.message || e);
    try { await bot.answerCallbackQuery(q.id); } catch {}
  }
});

// --- Startup: webhook or polling ---
async function start() {
  // Warm config load (so we see errors early but don't crash)
  await loadConfig(true);

  app.listen(PORT, async () => {
    console.log("Bot activo");
    console.log(`Server up on ${PORT}`);

    // Prefer webhook if PUBLIC_URL provided
    if (PUBLIC_URL) {
      const hookUrl = normalizeUrl(PUBLIC_URL) + "/webhook";
      try {
        await bot.setWebHook(hookUrl);
        console.log("Webhook seteado:", hookUrl);
      } catch (e) {
        console.error("No pude setear webhook, paso a polling:", e?.message || e);
        bot.startPolling();
      }
    } else {
      // No public url: local dev
      bot.startPolling();
      console.log("Polling activo (sin PUBLIC_URL)");
    }
  });
}

start().catch((e) => {
  console.error("Startup error:", e?.message || e);
  process.exit(1);
});

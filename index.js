**
 * EzerBot System — index.js (UN SOLO ARCHIVO)
 * - Telegram Bot + Webhook (Render) o Polling (local)
 * - Lee TODO desde CONFIG_URL (config.json en GitHub Pages)
 * - Catálogo por categorías + paginado (3 por página)
 * - Cada producto se muestra con IMAGEN + botones: Quiero éste / Compartir / Volver / Menú / Anterior-Siguiente
 *
 * VARIABLES DE ENTORNO (Render > Environment):
 * - BOT_TOKEN
 * - CONFIG_URL
 * - PUBLIC_URL           (ej: https://ezerbot-system.onrender.com)  (para webhook)
 * - ADMIN_CHAT_ID        (opcional)
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
const money = (n) => Number(n || 0).toLocaleString("es-AR", { maximumFractionDigits: 0 });
function safeText(s, max = 3900) {
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

function buildBotShareLinks(botUsername, negocioNombre) {
  const text = encodeURIComponent(
    `Te comparto el bot de ${negocioNombre} 🤖✨\n\nAbrilo acá: https://t.me/${botUsername}\n`
  );
  return {
    wa: `https://wa.me/?text=${text}`,
    tg: `https://t.me/share/url?url=${encodeURIComponent(`https://t.me/${botUsername}`)}&text=${text}`,
    mail: `mailto:?subject=${encodeURIComponent(`Bot de ${negocioNombre}`)}&body=${text}`,
  };
}

function buildProductShareLinks(botUsername, negocioNombre, product) {
  const nombre = product?.nombre || "Producto";
  const precio = product?.precio ? `$${money(product.precio)}` : "";
  const unidad = product?.unidad ? `/${product.unidad}` : "";
  const cat = product?.categoria ? `(${product.categoria})` : "";
  const textoPlano =
    `🧀 ${negocioNombre}\n\n` +
    `${nombre} ${cat}\n` +
    `${precio}${unidad}\n\n` +
    `👉 Pedilo por el bot: https://t.me/${botUsername}\n`;

  const text = encodeURIComponent(textoPlano);
  return {
    wa: `https://wa.me/?text=${text}`,
    tg: `https://t.me/share/url?url=${encodeURIComponent(`https://t.me/${botUsername}`)}&text=${text}`,
    mail: `mailto:?subject=${encodeURIComponent(`${negocioNombre} - ${nombre}`)}&body=${text}`,
  };
}

// -------------------- CONFIG CACHE --------------------
let CONFIG_CACHE = null;
let CONFIG_CACHE_AT = 0;
const CONFIG_TTL_MS = 30_000;

async function fetchConfig() {
  const now = Date.now();
  if (CONFIG_CACHE && now - CONFIG_CACHE_AT < CONFIG_TTL_MS) return CONFIG_CACHE;

  const url = new URL(CONFIG_URL);
  const res = await fetch(url.toString(), { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`No pude leer config.json (HTTP ${res.status})`);
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
    arr.sort((a, b) => String(a.nombre || "").localeCompare(String(b.nombre || ""), "es"));
    map.set(k, arr);
  }
  return map;
}

function findProduct(config, codigo) {
  return (config.catalogo || []).find((p) => String(p.codigo) === String(codigo));
}

// -------------------- BOT SETUP --------------------
const bot = new TelegramBot(BOT_TOKEN, { polling: !PUBLIC_URL });

// cache de getMe para que no falle por rate o latencia
let BOT_ME = null;
async function getBotMeSafe() {
  if (BOT_ME) return BOT_ME;
  BOT_ME = await bot.getMe();
  return BOT_ME;
}

async function ensureWebhook() {
  if (!PUBLIC_URL) return;
  const hookPath = `/telegram/${BOT_TOKEN}`;
  const hookUrl = `${PUBLIC_URL.replace(/\/$/, "")}${hookPath}`;
  await bot.setWebHook(hookUrl);
  console.log("Webhook:", hookUrl);
}

// -------------------- UI (MENÚ) --------------------
function mainMenuKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🛍️ Catálogo" }, { text: "🔥 Promos" }],
        [{ text: "🛒 Mi carrito" }, { text: "✅ Finalizar compra" }],
        [{ text: "📍 Horarios y dirección" }],
        [{ text: "📣 Compartir" }],
      ],
      resize_keyboard: true,
    },
  };
}

function inlineCategoriesKeyboard(categories) {
  const rows = [];
  for (const cat of categories) rows.push([{ text: cat, callback_data: `cat:${cat}` }]);
  rows.push([{ text: "🏠 Menú", callback_data: "menu:main" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

// 🔥 Botones por producto (debajo de la imagen)
function inlineProductKeyboard(cat, page, totalPages, codigo) {
  const rows = [];

  rows.push([
    { text: "✅ Quiero éste", callback_data: `want:${codigo}` },
    { text: "📣 Compartir", callback_data: `share:${codigo}` },
  ]);

  const nav = [];
  if (page > 1) nav.push({ text: "⬅️ Anterior", callback_data: `page:${cat}:${page - 1}` });
  nav.push({ text: `📄 ${page}/${totalPages}`, callback_data: "noop" });
  if (page < totalPages) nav.push({ text: "➡️ Siguiente", callback_data: `page:${cat}:${page + 1}` });
  rows.push(nav);

  rows.push([{ text: "⬅️ Volver a categorías", callback_data: "cats:list" }]);
  rows.push([{ text: "🏠 Menú", callback_data: "menu:main" }]);

  return { reply_markup: { inline_keyboard: rows } };
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
async function sendWelcome(chatId, config, username) {
  const n = config.negocio || {};
  const negocioNombre = n.nombre || "Todo Queso";

  const saludo =
    config.textos?.bienvenida ||
    `👋 ¡Hola! Bienvenido/a a *${negocioNombre}* 🧀✨\n\n` +
      `📍 ${n.direccion ? n.direccion : "Garín"}\n` +
      `${n.horarios ? `🕒 ${n.horarios}\n` : ""}` +
      `\n👇 Elegí una opción para empezar:`;

  // 1) Logo arriba si existe
  const logo = (n.logo || "").trim();
  if (logo) {
    try {
      await bot.sendPhoto(chatId, logo, {
        caption: `*${negocioNombre}*`,
        parse_mode: "Markdown",
      });
    } catch {
      // si falla, seguimos igual
    }
  }

  // 2) Saludo + menú
  await bot.sendMessage(chatId, saludo, { parse_mode: "Markdown", ...mainMenuKeyboard() });
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
    await bot.sendMessage(chatId, "⏳ Todavía no hay productos cargados en el catálogo.", mainMenuKeyboard());
    return;
  }
  await bot.sendMessage(chatId, "🛍️ Elegí una categoría:", inlineCategoriesKeyboard(cats));
}

function buildProductCaption(p) {
  const nombre = p.nombre || "Producto";
  const precio = p.precio ? `$${money(p.precio)}` : "";
  const unidad = p.unidad ? `/${p.unidad}` : "";
  const desc = p.descripcion ? `\n\n${p.descripcion}` : "";
  const code = p.codigo ? `\n\nCódigo: ${p.codigo}` : "";
  return `*${safeText(nombre, 80)}*\n${precio}${unidad}${desc}${code}`.trim();
}

// ✅ Catálogo paginado: manda 3 PRODUCTOS (cada uno con foto+botones)
async function showCatalogPage(chatId, config, cat, page = 1) {
  const map = getCatalogByCategory(config);
  const items = map.get(cat) || [];
  if (!items.length) {
    await bot.sendMessage(chatId, `No hay productos en *${cat}* por ahora.`, { parse_mode: "Markdown" });
    return;
  }

  const perPage = Number(config.ui?.itemsPorPagina || 3); // <- 3 por defecto
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const p = Math.min(Math.max(1, Number(page || 1)), totalPages);

  const slice = items.slice((p - 1) * perPage, (p - 1) * perPage + perPage);

  // encabezado de página
  await bot.sendMessage(chatId, `📂 *${cat}* — Página *${p}/${totalPages}*\nElegí un producto:`, {
    parse_mode: "Markdown",
  });

  // enviar cada producto con su imagen y botones
  for (const prod of slice) {
    const caption = buildProductCaption(prod);
    const kb = inlineProductKeyboard(cat, p, totalPages, prod.codigo);

    const img = (prod.imagen || prod.image || prod.foto || "").trim(); // tolerante por si el nombre cambia
    if (img) {
      try {
        await bot.sendPhoto(chatId, img, { caption: safeText(caption, 900), parse_mode: "Markdown", ...kb });
      } catch {
        // si la imagen falla, enviamos texto igual
        await bot.sendMessage(chatId, caption, { parse_mode: "Markdown", ...kb });
      }
    } else {
      await bot.sendMessage(chatId, caption, { parse_mode: "Markdown", ...kb });
    }
  }
}

async function showPromos(chatId, config) {
  // promos por categoría Promos o lista config.promos (si existe)
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
    promoItems.push(...(map.get("Promos") || map.get("PROMOS") || []));
  }

  if (!promoItems.length) {
    await bot.sendMessage(chatId, "🔥 Todavía no hay promos cargadas. ¿Querés que te muestre el catálogo?", mainMenuKeyboard());
    return;
  }

  // Mostramos promos como “categoría virtual” con paginado también
  const tmpConfig = { ...config, catalogo: promoItems, ui: { ...(config.ui || {}), itemsPorPagina: 3 } };
  await showCatalogPage(chatId, tmpConfig, "Promos", 1);
}

async function showCart(chatId, config, user) {
  // simple
  if (!user.cart?.length) {
    await bot.sendMessage(chatId, "🛒 Tu carrito está vacío. ¿Querés que te muestre el catálogo?", mainMenuKeyboard());
    return;
  }

  let subtotal = 0;
  const lines = [];
  for (const it of user.cart) {
    const p = findProduct(config, it.codigo);
    if (!p) continue;
    const line = Number(p.precio || 0) * Number(it.qty || 1);
    subtotal += line;
    lines.push(`• ${it.qty} × ${p.nombre} — $${money(line)}`);
  }

  await bot.sendMessage(chatId, `🛒 *Tu carrito*\n\n${lines.join("\n")}\n\nSubtotal: *$${money(subtotal)}*`, {
    parse_mode: "Markdown",
    ...mainMenuKeyboard(),
  });
}

// -------------------- HANDLERS --------------------
bot.onText(/\/start/, async (msg) => {
  try {
    const config = await fetchConfig();
    await sendWelcome(msg.chat.id, config, msg.from?.username);
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

    if (text === "🛍️ Catálogo") return await showCategories(chatId, config);
    if (text === "🔥 Promos") return await showPromos(chatId, config);
    if (text === "🛒 Mi carrito") return await showCart(chatId, config, user);
    if (text === "✅ Finalizar compra") {
      return await bot.sendMessage(chatId, "✅ Para finalizar, primero agregá un producto desde el catálogo 🙂", mainMenuKeyboard());
    }
    if (text === "📍 Horarios y dirección") return await showBusinessInfo(chatId, config);

    if (text === "📣 Compartir") {
      const me = await getBotMeSafe();
      const links = buildBotShareLinks(me.username, config.negocio?.nombre || "el negocio");
      return await bot.sendMessage(chatId, "📣 Elegí cómo querés compartir el bot:", inlineShareKeyboard(links));
    }

    // fallback amable
    const fallback =
      config.textos?.fallback ||
      "🙂 Tocá *Catálogo* para ver productos por categoría.";
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

    if (data.startsWith("want:")) {
      await ack();
      const codigo = data.slice(5);
      const p = findProduct(config, codigo);
      if (!p) return await bot.sendMessage(chatId, "Ese producto no existe (revisá Catalogo / config).");
      addToCart(user, codigo, 1);
      saveData(DB);
      return await bot.sendMessage(chatId, `✅ Agregado al carrito: *${p.nombre}*`, { parse_mode: "Markdown" });
    }

    if (data.startsWith("share:")) {
      await ack();
      const codigo = data.slice(6);
      const p = findProduct(config, codigo);
      if (!p) return await bot.sendMessage(chatId, "No encontré ese producto para compartir.");
      const me = await getBotMeSafe();
      const links = buildProductShareLinks(me.username, config.negocio?.nombre || "Todo Queso", p);
      return await bot.sendMessage(chatId, "📣 Compartir este producto por:", inlineShareKeyboard(links));
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
    `Config cargado OK: negocio="${config.negocio?.nombre || "-"}", catalogo=${config.catalogo?.length || 0}`
  );

  // Cache bot.getMe
  try { await getBotMeSafe(); } catch {}

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

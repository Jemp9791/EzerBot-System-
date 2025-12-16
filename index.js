// index.js — EzerBot System (Render + Telegram + Config JSON)
// Requiere variables en Render:
// - TELEGRAM_BOT_TOKEN (o BOT_TOKEN)
// - CONFIG_URL (tu JSON en GitHub Pages)
// - PUBLIC_URL (ej: https://ezerbot-system.onrender.com)
// Opcional: PORT (Render lo da)

// -------------------- Imports --------------------
import express from "express";
import TelegramBot from "node-telegram-bot-api";

// -------------------- Env --------------------
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || "";
const CONFIG_URL = process.env.CONFIG_URL || "";
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.log("Falta TELEGRAM_BOT_TOKEN (o BOT_TOKEN) en variables de entorno.");
  process.exit(1);
}
if (!CONFIG_URL) {
  console.log("Falta CONFIG_URL en variables de entorno.");
  process.exit(1);
}
if (!PUBLIC_URL) {
  console.log("Falta PUBLIC_URL en variables de entorno (necesario para webhook).");
  process.exit(1);
}

// -------------------- App + Bot --------------------
const app = express();
app.use(express.json());

const bot = new TelegramBot(BOT_TOKEN, { webHook: true });

// -------------------- Estado en memoria --------------------
const STATE = {
  lastLoadAt: 0,
  loading: false,
  cfg: null,
  negocio: null,
  catalogo: [],
  promos: [],
  sellos: [],
  cartByChat: new Map(), // chatId -> [{codigo,nombre,precio,cantidad,subtotal}]
};

const LOAD_EVERY_MS = 30 * 1000; // refresca cada 30s (por si editás config.json)

// -------------------- Helpers --------------------
function now() { return Date.now(); }

function safeText(s) {
  return (s ?? "").toString().trim();
}

function money(n) {
  const x = Number(n || 0);
  return x.toLocaleString("es-AR");
}

function normalizeConfig(raw) {
  // Soporta 2 formatos:
  // A) { negocio:{}, catalogo:[], promos:[], sellos:[] }
  // B) { Config:[], Catalogo:[], Promos:[], Sellos:[] }  (o variantes de may/min)
  const obj = raw && typeof raw === "object" ? raw : {};

  const negocio =
    obj.negocio ||
    obj.Negocio ||
    (Array.isArray(obj.Config) ? null : null); // (por ahora no usamos Config[] para negocio)

  const catalogo =
    obj.catalogo ||
    obj.Catalogo ||
    obj.CATALOGO ||
    obj.Catalogue ||
    [];

  let promos =
    obj.promos ||
    obj.Promos ||
    obj.PROMOS ||
    [];

  const sellos =
    obj.sellos ||
    obj.Sellos ||
    obj.SELLOS ||
    [];

  // Si no hay promos como lista separada, las armamos desde el catálogo
  if (!Array.isArray(promos) || promos.length === 0) {
    if (Array.isArray(catalogo)) {
      promos = catalogo.filter(p => safeText(p.categoria).toLowerCase() === "promos");
    } else {
      promos = [];
    }
  }

  return {
    negocio: negocio || null,
    catalogo: Array.isArray(catalogo) ? catalogo : [],
    promos: Array.isArray(promos) ? promos : [],
    sellos: Array.isArray(sellos) ? sellos : [],
    raw: obj,
  };
}

async function loadConfig(force = false) {
  const fresh = (now() - STATE.lastLoadAt) < LOAD_EVERY_MS;
  if (!force && fresh && STATE.cfg) return true;
  if (STATE.loading) return false;

  STATE.loading = true;
  try {
    const res = await fetch(CONFIG_URL, { method: "GET" });
    if (!res.ok) throw new Error(`HTTP ${res.status} al leer CONFIG_URL`);
    const raw = await res.json();

    const norm = normalizeConfig(raw);
    STATE.cfg = norm.raw;
    STATE.negocio = norm.negocio;
    STATE.catalogo = norm.catalogo;
    STATE.promos = norm.promos;
    STATE.sellos = norm.sellos;
    STATE.lastLoadAt = now();

    console.log("Config cargada OK:", {
      negocio: STATE.negocio?.nombre || "(sin nombre)",
      catalogo: STATE.catalogo.length,
      promos: STATE.promos.length,
      sellos: STATE.sellos.length,
    });

    return true;
  } catch (e) {
    console.log("Error cargando config:", e?.message || e);
    return false;
  } finally {
    STATE.loading = false;
  }
}

function mainKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🛍️ Catálogo" }, { text: "🔥 Promos" }],
        [{ text: "🛒 Mi carrito" }, { text: "✅ Finalizar compra" }],
        [{ text: "📍 Horarios y dirección" }, { text: "📣 Compartir el bot" }],
      ],
      resize_keyboard: true,
    },
  };
}

function cartOf(chatId) {
  if (!STATE.cartByChat.has(chatId)) STATE.cartByChat.set(chatId, []);
  return STATE.cartByChat.get(chatId);
}

function cartTotal(cart) {
  return cart.reduce((acc, it) => acc + Number(it.subtotal || 0), 0);
}

function findProductByCode(code) {
  const c = safeText(code);
  return STATE.catalogo.find(p => safeText(p.codigo) === c) || null;
}

function listProductsText(list, title) {
  if (!Array.isArray(list) || list.length === 0) {
    return `⏳ Todavía no hay ${title.toLowerCase()} cargadas.`;
  }
  let msg = `*${title}*\n\n`;
  for (const p of list.slice(0, 30)) {
    const nombre = safeText(p.nombre);
    const codigo = safeText(p.codigo);
    const precio = money(p.precio);
    msg += `• *${nombre}* — $${precio}\n   Código: \`${codigo}\`\n`;
  }
  msg += `\n🧾 Para agregar al carrito, escribí: \`+ CODIGO\`\nEj: \`+ TQ01\``;
  return msg;
}

function negocioText() {
  const n = STATE.negocio;
  if (!n) return "📍 Negocio: (no configurado)";
  const nombre = safeText(n.nombre);
  const direccion = safeText(n.direccion);
  const horarios = safeText(n.horarios);
  const tel = safeText(n.telefono);
  const ig = safeText(n.instagram);

  let msg = `🏪 *${nombre}*\n`;
  if (direccion) msg += `📍 ${direccion}\n`;
  if (horarios) msg += `🕒 ${horarios}\n`;
  if (tel) msg += `📞 ${tel}\n`;
  if (ig) msg += `📲 ${ig}\n`;
  return msg;
}

function shareText() {
  return `📣 Compartí el bot con tus clientes:\nhttps://t.me/${process.env.BOT_USERNAME || "TU_BOT"}\n\n(Si no aparece el link bien, decime el @usuario del bot y lo dejo fijo.)`;
}

// -------------------- Handlers --------------------
async function ensureConfig(chatId) {
  const ok = await loadConfig(false);
  if (!ok) {
    await bot.sendMessage(
      chatId,
      "⏳ Todavía no cargó el catálogo. Probá de nuevo en unos segundos.",
      mainKeyboard()
    );
    return false;
  }
  // Si cargó pero está vacío, avisamos claro:
  if (STATE.catalogo.length === 0) {
    await bot.sendMessage(
      chatId,
      "⚠️ El bot pudo leer tu CONFIG_URL, pero el catálogo vino vacío. Revisá que tu config.json tenga `catalogo: [ ... ]` con productos.",
      mainKeyboard()
    );
    return false;
  }
  return true;
}

async function onText(chatId, text) {
  const t = safeText(text);

  // forzamos recarga si escriben /reload
  if (t === "/reload") {
    await loadConfig(true);
    await bot.sendMessage(chatId, "🔄 Recargué la config.", mainKeyboard());
    return;
  }

  if (t === "/start" || t.toLowerCase() === "hola") {
    await loadConfig(false);
    const saludo = `😊 Decime qué estás buscando y te ayudo.\n\nPodés tocar *Catálogo* para ver todo lo disponible en nuestro local.`;
    await bot.sendMessage(chatId, saludo, { parse_mode: "Markdown", ...mainKeyboard() });
    return;
  }

  // Menú
  if (t.includes("Catálogo")) {
    const ok = await ensureConfig(chatId);
    if (!ok) return;
    await bot.sendMessage(chatId, listProductsText(STATE.catalogo, "🛍️ Catálogo"), {
      parse_mode: "Markdown",
      ...mainKeyboard(),
    });
    return;
  }

  if (t.includes("Promos")) {
    const ok = await ensureConfig(chatId);
    if (!ok) return;

    if (!STATE.promos || STATE.promos.length === 0) {
      await bot.sendMessage(
        chatId,
        "🔥 Todavía no hay promos cargadas. Querés que te muestre el catálogo?",
        mainKeyboard()
      );
      return;
    }

    await bot.sendMessage(chatId, listProductsText(STATE.promos, "🔥 Promos"), {
      parse_mode: "Markdown",
      ...mainKeyboard(),
    });
    return;
  }

  if (t.includes("Horarios") || t.includes("dirección") || t.includes("direccion")) {
    await loadConfig(false);
    await bot.sendMessage(chatId, negocioText(), { parse_mode: "Markdown", ...mainKeyboard() });
    return;
  }

  if (t.includes("Compartir")) {
    await bot.sendMessage(chatId, "📣 Copiá y pegá este mensaje:\n\n" + shareText(), mainKeyboard());
    return;
  }

  if (t.includes("Mi carrito")) {
    const cart = cartOf(chatId);
    if (cart.length === 0) {
      await bot.sendMessage(chatId, "🛒 Tu carrito está vacío.\nQuerés que te muestre el catálogo del negocio?", mainKeyboard());
      return;
    }
    let msg = "🛒 *Tu carrito*\n\n";
    for (const it of cart) {
      msg += `• *${it.nombre}* x${it.cantidad} — $${money(it.subtotal)}\n`;
    }
    msg += `\n💰 *Total:* $${money(cartTotal(cart))}\n\n✅ Para finalizar: tocá *Finalizar compra*`;
    await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", ...mainKeyboard() });
    return;
  }

  if (t.includes("Finalizar")) {
    const cart = cartOf(chatId);
    if (cart.length === 0) {
      await bot.sendMessage(chatId, "🛒 Tu carrito está vacío. Primero agregá un producto con `+ CODIGO` (ej: + TQ01).", mainKeyboard());
      return;
    }
    const total = cartTotal(cart);
    let msg = "✅ *Pedido listo*\n\n";
    for (const it of cart) msg += `• ${it.nombre} x${it.cantidad} — $${money(it.subtotal)}\n`;
    msg += `\n💰 *Total:* $${money(total)}\n\n✍️ Escribime tu nombre y si es *retiro* o *envío* (y dirección si es envío).`;
    await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", ...mainKeyboard() });
    return;
  }

  // Agregar con "+ CODIGO" o "+ CODIGO x2"
  if (t.startsWith("+")) {
    const ok = await ensureConfig(chatId);
    if (!ok) return;

    const parts = t.replace("+", "").trim().split(/\s+/);
    const code = safeText(parts[0]);
    let qty = 1;

    // soporta "x2" o "2"
    const p2 = safeText(parts[1]).toLowerCase();
    if (p2.startsWith("x")) qty = Number(p2.replace("x", "")) || 1;
    else if (p2) qty = Number(p2) || 1;

    const prod = findProductByCode(code);
    if (!prod) {
      await bot.sendMessage(chatId, `❌ No encontré el código \`${code}\`.\nAbrí *Catálogo* y copiá el código que figura abajo de cada producto.`, { parse_mode: "Markdown", ...mainKeyboard() });
      return;
    }

    const cart = cartOf(chatId);
    const nombre = safeText(prod.nombre);
    const precio = Number(prod.precio || 0);

    const existing = cart.find(x => x.codigo === code);
    if (existing) {
      existing.cantidad += qty;
      existing.subtotal = existing.cantidad * existing.precio;
    } else {
      cart.push({ codigo: code, nombre, precio, cantidad: qty, subtotal: qty * precio });
    }

    await bot.sendMessage(chatId, `✅ Agregado: *${nombre}* x${qty}\n🛒 Total carrito: $${money(cartTotal(cart))}`, { parse_mode: "Markdown", ...mainKeyboard() });
    return;
  }

  // Si llega cualquier cosa:
  await bot.sendMessage(chatId, "🙂 Dale, elegí una opción del menú o escribí `+ CODIGO` para agregar al carrito.", mainKeyboard());
}

// -------------------- Telegram Webhook --------------------
app.get("/", (_req, res) => {
  res.status(200).send("EzerBot System OK");
});

app.post(`/telegram/${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || "";
  try {
    await onText(chatId, text);
  } catch (e) {
    console.log("Error handler:", e?.message || e);
    await bot.sendMessage(chatId, "⚠️ Hubo un error interno. Probá de nuevo en unos segundos.", mainKeyboard());
  }
});

// -------------------- Start --------------------
async function start() {
  // Set webhook
  const hookUrl = `${PUBLIC_URL}/telegram/${BOT_TOKEN}`;
  await bot.setWebHook(hookUrl);

  // Intento precargar config al arrancar
  await loadConfig(true);

  app.listen(PORT, () => {
    console.log("Bot activo");
    console.log("Webhook:", hookUrl);
    console.log("Escuchando en puerto:", PORT);
  });
}

start().catch((e) => {
  console.log("Fallo al iniciar:", e?.message || e);
  process.exit(1);
});

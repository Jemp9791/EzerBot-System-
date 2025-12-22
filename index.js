// index.js (ESM) — EzerBot (Webhook recomendado en Render) + Config/Catalogo desde Sheets + Catálogo tipo “libro” + Carrito + Checkout
import TelegramBot from "node-telegram-bot-api";
import http from "http";
import https from "https";
import { URL } from "url";

// =====================
// 1) ENV
// =====================
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const PORT = process.env.PORT || 10000;

// PEGÁ tu Apps Script /exec (NO googleusercontent)
const SHEETS_API_BASE = (process.env.SHEETS_API_BASE || "").trim();

// En Render: poné solo la base del servicio (sin /telegram)
const WEBHOOK_BASE_URL = (process.env.WEBHOOK_BASE_URL || "").trim(); // ej: https://ezerbot-system.onrender.com
const WEBHOOK_PATH = "/telegram";
const WEBHOOK_FULL_URL = WEBHOOK_BASE_URL ? `${WEBHOOK_BASE_URL}${WEBHOOK_PATH}` : "";

// Cache
const CACHE_TTL_MS = 30_000;

if (!BOT_TOKEN) console.log("❌ FALTA BOT_TOKEN en Render Environment");
if (!SHEETS_API_BASE) console.log("❌ FALTA SHEETS_API_BASE (Apps Script /exec) en Render Environment");
if (!WEBHOOK_BASE_URL) console.log("⚠️ FALTA WEBHOOK_BASE_URL. En Render DEBERÍAS usar webhook.");

// =====================
// 2) Helpers HTTP (fetch sin libs)
// =====================
function httpGetJson(urlStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "https:" ? https : http;

    const req = lib.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "GET",
        headers: { "User-Agent": "EzerBot/1.0" },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const json = JSON.parse(data || "null");
            resolve(json);
          } catch (e) {
            reject(new Error(`JSON inválido desde ${urlStr}: ${String(e?.message || e)}`));
          }
        });
      }
    );

    req.on("error", reject);
    req.end();
  });
}

// =====================
// 3) Cache de Config / Catalogo
// =====================
let cache = {
  config: { at: 0, data: null },
  catalog: { at: 0, data: null },
};

async function getConfig() {
  const now = Date.now();
  if (cache.config.data && now - cache.config.at < CACHE_TTL_MS) return cache.config.data;
  if (!SHEETS_API_BASE) return {};

  const url = `${SHEETS_API_BASE}?type=config&ts=${now}`;
  const data = await httpGetJson(url);
  cache.config = { at: now, data };
  return data || {};
}

async function getCatalog() {
  const now = Date.now();
  if (cache.catalog.data && now - cache.catalog.at < CACHE_TTL_MS) return cache.catalog.data;
  if (!SHEETS_API_BASE) return [];

  const url = `${SHEETS_API_BASE}?type=catalog&ts=${now}`;
  const data = await httpGetJson(url);
  const arr = Array.isArray(data) ? data : [];
  cache.catalog = { at: now, data: arr };
  return arr;
}

// =====================
// 4) Bot init (Webhook ONLY si hay base)
// =====================
const bot = new TelegramBot(BOT_TOKEN, WEBHOOK_FULL_URL ? { webHook: true } : { polling: true });

// Set webhook si corresponde
async function setupWebhook() {
  if (!WEBHOOK_FULL_URL) return;

  try {
    // IMPORTANTÍSIMO: esto borra conflictos previos
    await bot.deleteWebHook({ drop_pending_updates: true });
  } catch {}

  try {
    await bot.setWebHook(WEBHOOK_FULL_URL);
    console.log("✅ Webhook seteado:", WEBHOOK_FULL_URL);
  } catch (e) {
    console.log("❌ Error setWebHook:", e?.message || e);
  }
}

// =====================
// 5) Estado simple (carrito + “libro”)
// =====================
const state = new Map(); // chatId -> { idx, cart: [{id,nombre,precio,qty}], step: null, delivery: {} }

function getState(chatId) {
  if (!state.has(chatId)) state.set(chatId, { idx: 0, cart: [], step: null, delivery: {} });
  return state.get(chatId);
}

function money(n) {
  const x = Number(n || 0);
  return x.toLocaleString("es-AR");
}

function cartTotal(cart) {
  return cart.reduce((s, it) => s + Number(it.precio || 0) * Number(it.qty || 0), 0);
}

function upsertCartItem(cart, p, deltaQty) {
  const i = cart.findIndex((x) => x.id === p.id);
  if (i === -1) {
    cart.push({ id: p.id, nombre: p.nombre, precio: Number(p.precio || 0), unidad: p.unidad || "", qty: Math.max(1, deltaQty) });
  } else {
    cart[i].qty = Math.max(0, (cart[i].qty || 0) + deltaQty);
    if (cart[i].qty === 0) cart.splice(i, 1);
  }
}

function keyboardMain() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🛍️ Catálogo" }, { text: "🛒 Mi carrito" }],
        [{ text: "✅ Finalizar compra" }],
        [{ text: "🎟️ Tarjeta de sellos" }, { text: "📣 Compartir el bot" }],
      ],
      resize_keyboard: true,
    },
  };
}

// =====================
// 6) Mensajes UI
// =====================
async function sendWelcome(chatId) {
  const cfg = await getConfig();

  const nombre = cfg.NegocioNombre || "Tu negocio";
  const direccion = cfg.Direccion || "Dirección no configurada";
  const telefono = cfg.TelefonoNegocio || "Teléfono no configurado";
  const instagram = cfg.Instagram || "";
  const descripcion = cfg.Descripcion || "";

  let msg = `🧀 *${nombre}*\n`;
  msg += `📍 ${direccion}\n`;
  msg += `📞 ${telefono}\n`;
  if (instagram) msg += `📸 Instagram: ${instagram}\n`;
  if (descripcion) msg += `\n_${descripcion}_\n`;
  msg += `\nElegí una opción del menú para empezar 👇`;

  await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", ...keyboardMain() });
}

async function sendCatalogCard(chatId) {
  const st = getState(chatId);
  const catalog = await getCatalog();

  if (!catalog.length) {
    await bot.sendMessage(chatId, "Por ahora no hay productos cargados en el catálogo. Revisá la hoja de Sheets o intentá de nuevo en unos minutos.", keyboardMain());
    return;
  }

  // Ajuste idx
  if (st.idx < 0) st.idx = 0;
  if (st.idx > catalog.length - 1) st.idx = catalog.length - 1;

  const p = catalog[st.idx];

  const title = `📖 Producto ${st.idx + 1} / ${catalog.length}\n*${p.nombre || "Producto"}*`;
  const price = `💰 $${money(p.precio)} ${p.unidad ? `(${p.unidad})` : ""}`;
  const cat = p.categoria ? `🏷️ ${p.categoria}` : "";
  const desc = p.descripcion ? `\n_${String(p.descripcion).slice(0, 500)}_` : "";

  const caption = `${title}\n${price}\n${cat}${desc}`;

  const inline = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "⬅️ Anterior", callback_data: "CAT_PREV" },
          { text: "➡️ Siguiente", callback_data: "CAT_NEXT" },
        ],
        [
          { text: "➕ Agregar", callback_data: `ADD:${p.id}` },
          { text: "➖ Quitar", callback_data: `REM:${p.id}` },
        ],
        [{ text: "🛒 Ver carrito", callback_data: "VIEW_CART" }],
      ],
    },
    parse_mode: "Markdown",
  };

  // Si tiene imagen, mandamos foto; si no, texto
  const img = (p.imagenUrl || "").trim();
  if (img) {
    try {
      await bot.sendPhoto(chatId, img, { caption, ...inline });
      return;
    } catch {
      // si falla la foto, cae a texto
    }
  }
  await bot.sendMessage(chatId, caption, inline);
}

async function sendCart(chatId) {
  const st = getState(chatId);
  if (!st.cart.length) {
    await bot.sendMessage(chatId, "🛒 Tu carrito está vacío.", keyboardMain());
    return;
  }

  let msg = `🛒 *Mi carrito*\n\n`;
  st.cart.forEach((it, idx) => {
    msg += `${idx + 1}) ${it.nombre}\n   ${it.qty} x $${money(it.precio)} = $${money(it.qty * it.precio)}\n\n`;
  });
  msg += `*Total:* $${money(cartTotal(st.cart))}\n\n`;
  msg += `Cuando quieras: ✅ Finalizar compra`;

  await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", ...keyboardMain() });
}

async function sendShare(chatId) {
  // botones extra: WhatsApp, Email, Telegram
  const text = `📣 *Compartí el bot*\n\nReenviá o compartí este link:\nhttps://t.me/EzerBot\n\nElegí un canal 👇`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📲 WhatsApp", url: "https://wa.me/?text=" + encodeURIComponent("Pedí por el bot: https://t.me/EzerBot") },
          { text: "✉️ Email", url: "mailto:?subject=" + encodeURIComponent("Pedí por el bot") + "&body=" + encodeURIComponent("Link: https://t.me/EzerBot") },
        ],
        [{ text: "📨 Telegram", url: "https://t.me/share/url?url=" + encodeURIComponent("https://t.me/EzerBot") + "&text=" + encodeURIComponent("Pedí por el bot") }],
      ],
    },
  });
}

async function sendStamps(chatId) {
  // Base simple (luego lo conectamos a sellos reales)
  const cfg = await getConfig();
  const premio = cfg.BeneficioSellos || "Premio configurable";
  const max = Number(cfg.SellosObjetivo || 10) || 10;

  const msg =
    `🎟️ *Tarjeta de sellos*\n\n` +
    `Sellos: 0 / ${max}\n` +
    `Premio al completar: ${premio}\n\n` +
    `_Tip: cada compra confirmada suma 1 sello automático._`;

  await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", ...keyboardMain() });
}

// =====================
// 7) Checkout simple (flujo entrega/pago)
// =====================
function startCheckout(chatId) {
  const st = getState(chatId);
  if (!st.cart.length) {
    bot.sendMessage(chatId, "Tu carrito está vacío. Primero agregá productos 🛍️", keyboardMain());
    return;
  }

  st.step = "choose_delivery";
  st.delivery = {};

  bot.sendMessage(chatId, "Elegí cómo querés recibir tu pedido 👇", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🚚 Envío a domicilio", callback_data: "DELIVERY:ENVIO" }],
        [{ text: "🏪 Retiro por el local", callback_data: "DELIVERY:RETIRO" }],
      ],
    },
  });
}

// =====================
// 8) Handlers Telegram
// =====================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").toString().trim();

  const st = getState(chatId);

  // comandos básicos
  if (text === "/start" || /^hola$/i.test(text) || /^buenas/i.test(text)) {
    await sendWelcome(chatId);
    return;
  }

  // pasos checkout por texto
  if (st.step === "ask_address") {
    st.delivery.address = text;
    st.step = "ask_name";
    await bot.sendMessage(chatId, "🧾 Tu nombre:");
    return;
  }
  if (st.step === "ask_name") {
    st.delivery.name = text;
    st.step = "ask_phone";
    await bot.sendMessage(chatId, "📞 Tu teléfono:");
    return;
  }
  if (st.step === "ask_phone") {
    st.delivery.phone = text;
    st.step = "choose_payment";
    await bot.sendMessage(chatId, "Perfecto. Elegí método de pago:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💵 Efectivo", callback_data: "PAY:CASH" }],
          [{ text: "🏦 Transferencia", callback_data: "PAY:TRANSFER" }],
        ],
      },
    });
    return;
  }

  // menú
  if (text === "🛍️ Catálogo" || text === "Catálogo") {
    await sendCatalogCard(chatId);
    return;
  }
  if (text === "🛒 Mi carrito" || text === "Mi carrito") {
    await sendCart(chatId);
    return;
  }
  if (text === "✅ Finalizar compra" || text === "Finalizar compra") {
    startCheckout(chatId);
    return;
  }
  if (text === "📣 Compartir el bot" || text === "Compartir el bot") {
    await sendShare(chatId);
    return;
  }
  if (text === "🎟️ Tarjeta de sellos" || text === "Tarjeta de sellos") {
    await sendStamps(chatId);
    return;
  }
});

bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const data = q.data || "";
  const st = getState(chatId);

  try { await bot.answerCallbackQuery(q.id); } catch {}

  // catálogo tipo libro
  if (data === "CAT_PREV") {
    st.idx -= 1;
    await sendCatalogCard(chatId);
    return;
  }
  if (data === "CAT_NEXT") {
    st.idx += 1;
    await sendCatalogCard(chatId);
    return;
  }

  // add/rem
  if (data.startsWith("ADD:") || data.startsWith("REM:")) {
    const id = data.split(":")[1] || "";
    const catalog = await getCatalog();
    const p = catalog.find((x) => String(x.id) === String(id));
    if (!p) {
      await bot.sendMessage(chatId, "No encontré ese producto. Probá abrir el catálogo de nuevo.", keyboardMain());
      return;
    }
    const delta = data.startsWith("ADD:") ? +1 : -1;
    upsertCartItem(st.cart, p, delta);

    const total = cartTotal(st.cart);
    await bot.sendMessage(chatId, `✅ Carrito actualizado. Total: $${money(total)}`, keyboardMain());
    return;
  }

  if (data === "VIEW_CART") {
    await sendCart(chatId);
    return;
  }

  // checkout inline
  if (data === "DELIVERY:ENVIO") {
    st.delivery.type = "envio";
    st.step = "ask_address";
    await bot.sendMessage(chatId, "📍 Decime tu dirección completa:");
    return;
  }
  if (data === "DELIVERY:RETIRO") {
    st.delivery.type = "retiro";
    st.step = "ask_name";
    await bot.sendMessage(chatId, "🧾 Tu nombre:");
    return;
  }

  if (data === "PAY:CASH" || data === "PAY:TRANSFER") {
    if (st.step !== "choose_payment") return;

    const cfg = await getConfig();
    const alias = cfg.AliasTransferencia || cfg.ALIAS_TRANSFERENCIA || "jennyocampos.mp";

    const total = cartTotal(st.cart);
    const tipoEntrega = st.delivery.type === "envio" ? "Envío a domicilio 🚚" : "Retiro por el local 🏪";
    const metodo = data === "PAY:CASH" ? "Efectivo" : "Transferencia";

    let resumen = `✅ *Resumen del pedido*\n\n`;
    resumen += `Entrega: ${tipoEntrega}\n`;
    if (st.delivery.type === "envio") resumen += `Dirección: ${st.delivery.address || "-"}\n`;
    resumen += `Nombre: ${st.delivery.name || "-"}\n`;
    resumen += `Teléfono: ${st.delivery.phone || "-"}\n\n`;

    resumen += `🧾 *Detalle*\n`;
    st.cart.forEach((it) => {
      resumen += `• ${it.qty} x ${it.nombre} = $${money(it.qty * it.precio)}\n`;
    });
    resumen += `\n*Total:* $${money(total)}\n\n`;

    resumen += `Pago: *${metodo}*\n`;
    if (metodo === "Transferencia") {
      resumen += `Alias: \`${alias}\`\n`;
      resumen += `📌 Cuando transfieras, mandá el comprobante por acá.`;
    } else {
      resumen += `💵 Pagás al recibir o retirar.`;
    }

    st.step = null; // fin checkout
    await bot.sendMessage(chatId, resumen, { parse_mode: "Markdown", ...keyboardMain() });
    return;
  }
});

// =====================
// 9) HTTP Server (webhook receiver + health)
// =====================
const server = http.createServer((req, res) => {
  // Health
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("EzerBot está corriendo ✅");
    return;
  }

  // Webhook receiver
  if (req.method === "POST" && req.url === WEBHOOK_PATH) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const update = JSON.parse(body || "{}");
        bot.processUpdate(update);
      } catch (e) {
        console.log("❌ Webhook JSON inválido:", e?.message || e);
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK");
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

server.listen(PORT, async () => {
  console.log(`HTTP escuchando en puerto ${PORT}`);
  await setupWebhook();
  console.log("EzerBot iniciado ✅ (Config+Catalogo desde Sheets)");
}); 

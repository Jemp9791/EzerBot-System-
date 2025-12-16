/**
 * EzerBot System - index.js (ESM)
 * - Lee Config + Catálogo desde GAS_URL
 * - Menú humano + logo
 * - Info del negocio con botones (WhatsApp/Telegram/Mail)
 * - Checkout con envío calculado desde Config
 * - Comprobantes: comprador envía, vendedor aprueba/rechaza, comprador recibe estado
 * - Sellos: intenta leer por GAS si existe, si no no rompe
 */

import express from "express";
import TelegramBot from "node-telegram-bot-api";

const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const GAS_URL = process.env.GAS_URL; // https://script.google.com/macros/s/XXXX/exec
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || ""; // https://tu-app.onrender.com

if (!BOT_TOKEN) throw new Error("Falta BOT_TOKEN en variables de entorno");
if (!GAS_URL) throw new Error("Falta GAS_URL en variables de entorno");

const app = express();
app.use(express.json({ limit: "10mb" }));

const bot = new TelegramBot(BOT_TOKEN, { webHook: true });

// -------------------- Cache simple (rápido) --------------------
let CONFIG = {};
let CATALOGO = []; // array de productos
let CATS = [];     // categorías únicas
let cacheLoadedAt = null;

const TTL_MS = 60 * 1000; // 1 min (rápido, sin “recargar catálogo” manual)

function nowISO() { return new Date().toISOString(); }
function norm(s="") {
  return String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}
function money(n) {
  const x = Number(n || 0);
  return x.toLocaleString("es-AR");
}

// -------------------- Estado en memoria (sin romper) --------------------
// Nota: si Render reinicia, se pierde. Si querés persistencia total, lo pasamos a Sheets.
const USER = new Map(); // chatId -> state
function getUser(chatId) {
  if (!USER.has(chatId)) USER.set(chatId, {
    step: "IDLE",
    cart: [],
    delivery: null, // "ENVIO" o "RETIRO"
    address: "",
    shipping: 0,
    lastOrderId: null,
  });
  return USER.get(chatId);
}

// -------------------- GAS Helpers --------------------
async function gasFetch(params = {}) {
  const url = new URL(GAS_URL);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res = await fetch(url.toString(), { method: "GET" });
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return { ok: false, raw: txt }; }
}

async function loadAll(force=false) {
  const stale = !cacheLoadedAt || (Date.now() - cacheLoadedAt.getTime() > TTL_MS);
  if (!force && !stale) return;

  // Espera: tu GAS devuelve { ok:true, config:{...}, productos:[...]} o similar
  const data = await gasFetch({ action: "boot" });

  // Compatibilidad con lo que ya venías devolviendo:
  // - a veces Config viene como "config"
  // - a veces viene “configRawPreview” (debug)
  // - productos suele venir como "productos"
  const cfg = data.config || data.Config || {};
  const productos = data.productos || data.Productos || data.catalogo || [];

  CONFIG = cfg || {};
  CATALOGO = Array.isArray(productos) ? productos : [];
  CATS = [...new Set(CATALOGO.map(p => (p.categoria || "Sin categoría").trim()))].filter(Boolean);

  cacheLoadedAt = new Date();
  return { ok: true, at: cacheLoadedAt };
}

// -------------------- Config getters (no rompe si falta) --------------------
function cfg(key, def="") {
  return (CONFIG && Object.prototype.hasOwnProperty.call(CONFIG, key)) ? CONFIG[key] : def;
}

function getLogoUrl() {
  return cfg("LOGO_URL", cfg("logo", cfg("Logo", ""))) || "";
}

function getBusinessName() {
  return cfg("NOMBRE_NEGOCIO", cfg("NEGOCIO", cfg("nombre_negocio", "Todo Queso"))) || "Todo Queso";
}

function getSellerChatId() {
  // ID numérico del vendedor (chatId). Lo podés sacar hablando con tu bot y mirando /debug después.
  return Number(cfg("VENDEDOR_CHAT_ID", cfg("SELLER_CHAT_ID", 0)) || 0);
}

function getWhatsappSeller() {
  // Ej: 5491122538102 (sin +)
  return cfg("WHATSAPP_VENDEDOR", cfg("VENDEDOR_WHATSAPP", ""));
}

function getTelegramContact() {
  // Ej: https://t.me/todooqueso
  return cfg("TELEGRAM_CONTACTO", cfg("TELEGRAM", ""));
}

function getMailContact() {
  return cfg("EMAIL_CONTACTO", cfg("MAIL", ""));
}

function getAddress() {
  return cfg("DIRECCION", cfg("direccion", "")) || "";
}
function getPhone() {
  return cfg("TELEFONO", cfg("telefono", "")) || "";
}
function getHours() {
  return cfg("HORARIOS", cfg("horarios", "LUN a SAB\n08:30-14:00 / 16:30-21:00"));
}
function getInstagram() {
  return cfg("INSTAGRAM", cfg("ig", "@todoqueso.club"));
}
function getFacebook() {
  return cfg("FACEBOOK", cfg("fb", "NO"));
}

function getAliasPago() {
  return cfg("ALIAS_PAGO", cfg("alias_pago", "jennyocampos.mp"));
}
function getCbuPago() {
  return cfg("CBU_PAGO", cfg("cbu_pago", "-"));
}

// ENVÍO: opciones flexibles
function calcShipping(addressText) {
  // 1) Si hay ENVIO_COSTO_FIJO (número) lo usa
  const fijo = Number(cfg("ENVIO_COSTO_FIJO", cfg("ENVIO_COSTO", "")));
  if (!Number.isNaN(fijo) && fijo > 0) return fijo;

  // 2) Si hay ENVIO_ZONAS_JSON (json tipo {"garin":2000,"maschwitz":2500})
  const zonasRaw = cfg("ENVIO_ZONAS_JSON", "");
  if (zonasRaw) {
    try {
      const zonas = JSON.parse(zonasRaw);
      const a = norm(addressText);
      for (const [zona, precio] of Object.entries(zonas)) {
        if (a.includes(norm(zona))) return Number(precio) || 0;
      }
    } catch {}
  }

  // 3) Si hay ENVIO_GRATIS = "SI"
  const gratis = norm(cfg("ENVIO_GRATIS", ""));
  if (gratis === "si" || gratis === "true" || gratis === "1") return 0;

  // 4) default razonable
  return 2000;
}

// -------------------- UI Helpers --------------------
async function sendLogoHeader(chatId, caption) {
  const logo = getLogoUrl();
  if (logo) {
    try {
      await bot.sendPhoto(chatId, logo, { caption });
      return;
    } catch {
      // si falla la imagen, manda texto igual
    }
  }
  await bot.sendMessage(chatId, caption);
}

function mainMenuKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🛍️ Catálogo" }, { text: "🛒 Mi carrito" }],
        [{ text: "✅ Finalizar compra" }],
        [{ text: "ℹ️ Información del local" }, { text: "💬 Hablar con el vendedor" }],
        [{ text: "📣 Compartir el bot" }, { text: "🎁 Mis sellos" }],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    }
  };
}

function contactButtons() {
  const wa = getWhatsappSeller();
  const tg = getTelegramContact();
  const mail = getMailContact();

  const rows = [];
  const row1 = [];
  if (wa) row1.push({ text: "📲 WhatsApp", url: `https://wa.me/${wa}` });
  if (tg) row1.push({ text: "✈️ Telegram", url: tg.startsWith("http") ? tg : `https://t.me/${tg.replace("@","")}` });
  if (row1.length) rows.push(row1);

  if (mail) rows.push([{ text: "✉️ Email", url: `mailto:${mail}` }]);

  return rows.length
    ? { reply_markup: { inline_keyboard: rows } }
    : {};
}

// -------------------- Catálogo / Carrito --------------------
function findByCode(code) {
  const c = norm(code);
  return CATALOGO.find(p => norm(p.codigo) === c || norm(p.codigobarras) === c);
}

function cartTotal(u) {
  return u.cart.reduce((acc, it) => acc + Number(it.subtotal || 0), 0);
}

function formatCart(u) {
  if (!u.cart.length) return "🛒 Tu carrito está vacío.";
  const lines = u.cart.map((it, idx) => {
    const qtyTxt = it.unidad === "kg" ? `${it.qty}g` : `${it.qty}`;
    return `${idx+1}) ${it.nombre} (${it.codigo})\n   Cantidad: ${qtyTxt}\n   Subtotal: $${money(it.subtotal)} ARS`;
  });
  return `🛒 Tu carrito:\n\n${lines.join("\n\n")}\n\n💰 Total: $${money(cartTotal(u))} ARS`;
}

// -------------------- Flujos --------------------
async function greet(chatId, firstName="") {
  await loadAll(false);

  const business = getBusinessName();
  const msg =
`Hola ${firstName ? firstName : "😊"} 👋
Soy el asistente de *${business}*.

¿Querés ver productos, revisar tu carrito o finalizar una compra?
Elegí una opción del menú 👇`;

  await sendLogoHeader(chatId, msg);
  await bot.sendMessage(chatId, "✅ Menú listo.", { ...mainMenuKeyboard(), parse_mode: "Markdown" });
}

async function showInfo(chatId) {
  await loadAll(false);

  const business = getBusinessName();
  const address = getAddress();
  const phone = getPhone();

  const info =
`🏪 *${business}*
📍 ${address ? address : "Dirección no cargada"}
🕒 ${getHours()}
📞 ${phone ? phone : "Teléfono no cargado"}

📸 Instagram: ${getInstagram()}
📘 Facebook: ${getFacebook()}`;

  await sendLogoHeader(chatId, info);
  if (Object.keys(contactButtons()).length) {
    await bot.sendMessage(chatId, "Contactos rápidos:", { ...contactButtons() });
  }
}

async function talkToSeller(chatId) {
  await loadAll(false);
  const wa = getWhatsappSeller();

  if (wa) {
    await bot.sendMessage(
      chatId,
      "💬 Para hablar con el vendedor, tocá el botón 👇",
      { reply_markup: { inline_keyboard: [[{ text: "📲 Hablar por WhatsApp", url: `https://wa.me/${wa}` }]] } }
    );
  } else {
    await bot.sendMessage(chatId, "⚠️ Todavía no está configurado el WhatsApp del vendedor en Config.");
  }
}

async function shareBot(chatId) {
  const username = (await bot.getMe()).username;
  const link = `https://t.me/${username}?start=1`;

  await bot.sendMessage(
    chatId,
    `📣 Compartí este bot con tus amigos 🙌\n\n🔗 ${link}`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔗 Compartir link", url: link }],
          ...(contactButtons().reply_markup?.inline_keyboard || [])
        ],
      },
    }
  );
}

async function showSellos(chatId) {
  // Si tu GAS ya tiene “sellos”, lo lee. Si no existe, no rompe.
  try {
    const r = await gasFetch({ action: "getSellos", chatId });
    if (r && r.ok && typeof r.sellos !== "undefined") {
      await bot.sendMessage(chatId, `🎁 Tus sellos: *${r.sellos}*`, { parse_mode: "Markdown" });
      return;
    }
  } catch {}
  await bot.sendMessage(chatId, "🎁 Tus sellos: 0\n(En breve los activamos desde Config/Sistema.)");
}

// -------------------- Checkout --------------------
async function startCheckout(chatId) {
  const u = getUser(chatId);
  if (!u.cart.length) {
    await bot.sendMessage(chatId, "🛒 Tu carrito está vacío. Entrá a *Catálogo* para agregar productos.", { parse_mode: "Markdown" });
    return;
  }

  u.step = "CHOOSE_DELIVERY";
  await bot.sendMessage(
    chatId,
    `${formatCart(u)}\n\n🚚 ¿Cómo querés recibir tu pedido?`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🚚 Envío a domicilio", callback_data: "DELIVERY_ENVIO" }],
          [{ text: "🏪 Retiro en el local", callback_data: "DELIVERY_RETIRO" }],
        ],
      },
    }
  );
}

async function finalizeTicket(chatId) {
  const u = getUser(chatId);

  const total = cartTotal(u) + Number(u.shipping || 0);
  const ticket = `TQ-${Math.floor(Math.random() * 900000 + 100000)}`; // si querés, lo cambiamos por correlativo en GAS

  u.lastOrderId = ticket;

  const business = getBusinessName();

  const itemsLine = u.cart.map(it => {
    const qtyTxt = it.unidad === "kg" ? `${it.qty}g` : `${it.qty}`;
    return `• ${it.nombre} (${qtyTxt}) — $${money(it.subtotal)}`;
  }).join("\n");

  const deliveryLine =
    u.delivery === "ENVIO"
      ? `🚚 Envío: $${money(u.shipping)} ARS\n📍 Dirección: ${u.address}`
      : `🏪 Retiro en el local`;

  const text =
`🧾 *${business}*
Ticket N° *${ticket}*
📅 ${new Date().toLocaleString("es-AR")}

${itemsLine}

${deliveryLine}

💰 *TOTAL: $${money(total)} ARS*

🏦 Alias: *${getAliasPago()}*
🏛️ CBU: *${getCbuPago()}*

📩 *Enviá el comprobante por acá* y lo revisamos para preparar tu pedido 🙌`;

  // Guardar en GAS si existe (no rompe si no)
  try { await gasFetch({ action: "createOrder", chatId, orderId: ticket, total }); } catch {}

  u.step = "WAIT_PROOF";
  await bot.sendMessage(chatId, text, { parse_mode: "Markdown", ...mainMenuKeyboard() });
}

// -------------------- Webhook + handlers --------------------
app.get("/", async (_req, res) => {
  try {
    await loadAll(false);
    res.json({
      ok: true,
      bootedAt: nowISO(),
      publicUrl: PUBLIC_URL || null,
      gasUrlSet: !!GAS_URL,
      configKeysCount: Object.keys(CONFIG || {}).length,
      catalogoCount: (CATALOGO || []).length,
      sampleCats: CATS.slice(0, 10),
    });
  } catch (e) {
    res.json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/debug", async (_req, res) => {
  try {
    await loadAll(true);
    const me = await bot.getMe();
    res.json({
      ok: true,
      bootedAt: nowISO(),
      bot: me,
      gasUrlSet: !!GAS_URL,
      configLoadedAt: cacheLoadedAt,
      configKeysCount: Object.keys(CONFIG || {}).length,
      sampleKeys: Object.keys(CONFIG || {}).slice(0, 30),
      catalogoLoadedAt: cacheLoadedAt,
      catalogoCount: (CATALOGO || []).length,
      sampleCats: CATS.slice(0, 20),
    });
  } catch (e) {
    res.json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/webhook", async (req, res) => {
  try {
    await bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (e) {
    console.error("processUpdate error:", e);
    res.sendStatus(200);
  }
});

// -------------------- Telegram Events --------------------
bot.onText(/\/start/i, async (msg) => {
  await greet(msg.chat.id, msg.from?.first_name || "");
});

// Responder “con cualquier mensaje” con algo humano (no queda mudo)
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const u = getUser(chatId);

  // Evitar doble respuesta si era /start (ya lo maneja onText)
  if (msg.text && msg.text.startsWith("/start")) return;

  // Si manda comprobante (foto o documento)
  if (u.step === "WAIT_PROOF" && (msg.photo || msg.document)) {
    await bot.sendMessage(chatId, "✅ ¡Gracias! Estoy *revisando tu comprobante*… Apenas lo confirme el vendedor, te aviso 🙌", { parse_mode: "Markdown" });

    const sellerChat = getSellerChatId();
    if (sellerChat) {
      const caption =
`📩 *Comprobante recibido*
Pedido: *${u.lastOrderId || "-"}*
Cliente: ${msg.from?.first_name || ""} (@${msg.from?.username || "sin_user"})
Total (sin cambios): $${money(cartTotal(u) + Number(u.shipping||0))}

Acciones:`;

      const kb = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Aprobar", callback_data: `PROOF_OK:${chatId}:${u.lastOrderId || ""}` },
              { text: "❌ Rechazar", callback_data: `PROOF_NO:${chatId}:${u.lastOrderId || ""}` },
            ]
          ]
        }
      };

      // Reenviar foto/doc al vendedor
      try {
        if (msg.photo) {
          const fileId = msg.photo[msg.photo.length - 1].file_id;
          await bot.sendPhoto(sellerChat, fileId, { caption, parse_mode: "Markdown", ...kb });
        } else if (msg.document) {
          await bot.sendDocument(sellerChat, msg.document.file_id, { caption, parse_mode: "Markdown", ...kb });
        }
      } catch (e) {
        console.error("No pude enviar comprobante al vendedor:", e);
      }
    }

    return;
  }

  const text = (msg.text || "").trim();

  // Menú por texto (WhatsApp style)
  if (!text) return;

  const t = norm(text);

  // Accesos rápidos por texto
  if (t.includes("info") || t.includes("direccion") || t.includes("horario")) {
    await showInfo(chatId);
    return;
  }
  if (t.includes("vendedor") || t.includes("whatsapp")) {
    await talkToSeller(chatId);
    return;
  }
  if (t.includes("sello")) {
    await showSellos(chatId);
    return;
  }
  if (t.includes("carrito")) {
    await bot.sendMessage(chatId, formatCart(u), { ...mainMenuKeyboard() });
    return;
  }
  if (t.includes("finalizar") || t.includes("checkout") || t.includes("pagar")) {
    await startCheckout(chatId);
    return;
  }

  // Si está esperando dirección de envío
  if (u.step === "ASK_ADDRESS") {
    u.address = text;
    u.shipping = calcShipping(u.address);
    u.step = "WAIT_PROOF";

    await bot.sendMessage(chatId, `Perfecto 🚚\nCosto de envío: *$${money(u.shipping)} ARS*\n\nAhora te genero el ticket 👇`, { parse_mode: "Markdown" });
    await finalizeTicket(chatId);
    return;
  }

  // Default: responder con menú humano (no rompe)
  await bot.sendMessage(chatId, "👌 Dale. Elegí una opción del menú 👇\n\nSi querés ver productos, tocá *Catálogo*.", { parse_mode: "Markdown", ...mainMenuKeyboard() });
});

// Botones del teclado principal (Reply Keyboard)
bot.on("text", async (msg) => {
  const chatId = msg.chat.id;
  const u = getUser(chatId);
  const text = (msg.text || "").trim();

  // Evitar duplicar /start
  if (/^\/start/i.test(text)) return;

  await loadAll(false);

  if (text === "🛍️ Catálogo") {
    // Si querés, acá volvemos a tu paginación actual.
    // Para no romper: sólo listamos categorías como botones inline.
    if (!CATS.length) {
      await bot.sendMessage(chatId, "⚠️ No hay categorías cargadas.");
      return;
    }
    const buttons = CATS.map(c => [{ text: `📁 ${c}`, callback_data: `CAT:${c}` }]);
    await bot.sendMessage(chatId, "📁 Elegí una categoría:", { reply_markup: { inline_keyboard: buttons } });
    return;
  }

  if (text === "🛒 Mi carrito") {
    await bot.sendMessage(chatId, formatCart(u), { ...mainMenuKeyboard() });
    return;
  }

  if (text === "✅ Finalizar compra") {
    await startCheckout(chatId);
    return;
  }

  if (text === "ℹ️ Información del local") {
    await showInfo(chatId);
    return;
  }

  if (text === "💬 Hablar con el vendedor") {
    await talkToSeller(chatId);
    return;
  }

  if (text === "📣 Compartir el bot") {
    await shareBot(chatId);
    return;
  }

  if (text === "🎁 Mis sellos") {
    await showSellos(chatId);
    return;
  }
});

// Callbacks inline
bot.on("callback_query", async (q) => {
  const chatId = q.message?.chat?.id;
  const data = q.data || "";
  if (!chatId) return;

  const u = getUser(chatId);
  await loadAll(false);

  try { await bot.answerCallbackQuery(q.id); } catch {}

  // Elegir categoría
  if (data.startsWith("CAT:")) {
    const cat = data.slice(4);
    const items = CATALOGO.filter(p => (p.categoria || "").trim() === cat);

    if (!items.length) {
      await bot.sendMessage(chatId, "⚠️ No hay productos en esa categoría todavía.");
      return;
    }

    // Muestra hasta 8 productos con botones “Agregar”
    const show = items.slice(0, 8);
    for (const p of show) {
      const price = Number(p.precio || 0);
      const unit = norm(p.unidad || "unidad") === "kg" ? "kg" : "unidad";
      const caption =
`*${p.nombre}*
💵 $${money(price)} ARS
🆔 ${p.codigo}
📦 Unidad: ${unit}
${p.descripcion ? `\n_${p.descripcion}_` : ""}`;

      const kb = {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Quiero este", callback_data: `ADD:${p.codigo}` }],
          ]
        }
      };

      if (p.imagen) {
        try { await bot.sendPhoto(chatId, p.imagen, { caption, parse_mode: "Markdown", ...kb }); }
        catch { await bot.sendMessage(chatId, caption, { parse_mode: "Markdown", ...kb }); }
      } else {
        await bot.sendMessage(chatId, caption, { parse_mode: "Markdown", ...kb });
      }
    }

    return;
  }

  // Agregar producto
  if (data.startsWith("ADD:")) {
    const code = data.slice(4);
    const p = findByCode(code);
    if (!p) {
      await bot.sendMessage(chatId, "⚠️ No encontré ese producto.");
      return;
    }

    const unit = norm(p.unidad || "unidad") === "kg" ? "kg" : "unidad";

    // Si es kg, preguntamos gramos (sin romper)
    if (unit === "kg") {
      u.step = "ASK_GRAMS";
      u._pending = p;
      await bot.sendMessage(chatId, `¿Cuántos gramos de *${p.nombre}* querés?\nEj: 300`, { parse_mode: "Markdown" });
      return;
    }

    // unidad
    const qty = 1;
    const subtotal = Number(p.precio || 0) * qty;
    u.cart.push({ codigo: p.codigo, nombre: p.nombre, unidad: "unidad", qty, subtotal });

    await bot.sendMessage(chatId, `✅ Agregado: *${p.nombre}*\nSubtotal: $${money(subtotal)} ARS\n\n¿Sumamos algo más? 😋`, { parse_mode: "Markdown", ...mainMenuKeyboard() });
    return;
  }

  // Delivery choices
  if (data === "DELIVERY_ENVIO") {
    u.delivery = "ENVIO";
    u.step = "ASK_ADDRESS";
    await bot.sendMessage(chatId, "Perfecto 🚚\nPasame tu *dirección completa* (calle, número, barrio).", { parse_mode: "Markdown" });
    return;
  }
  if (data === "DELIVERY_RETIRO") {
    u.delivery = "RETIRO";
    u.shipping = 0;
    u.address = "";
    await finalizeTicket(chatId);
    return;
  }

  // Vendedor aprueba/rechaza comprobante
  if (data.startsWith("PROOF_OK:")) {
    const [, buyerChatId, orderId] = data.split(":");
    try {
      await bot.sendMessage(Number(buyerChatId), `✅ *Comprobante aprobado.*\nYa estamos preparando tu pedido 🙌\nPedido: *${orderId || "-"}*`, { parse_mode: "Markdown" });
      try { await gasFetch({ action: "updateOrderStatus", orderId, status: "APROBADO" }); } catch {}
    } catch {}
    await bot.sendMessage(chatId, "✅ Listo. Avisé al cliente que se está preparando.");
    return;
  }
  if (data.startsWith("PROOF_NO:")) {
    const [, buyerChatId, orderId] = data.split(":");
    try {
      await bot.sendMessage(Number(buyerChatId), `❌ *No pude validar el comprobante.*\n¿Podés reenviarlo más claro? 🙏\nPedido: *${orderId || "-"}*`, { parse_mode: "Markdown" });
      try { await gasFetch({ action: "updateOrderStatus", orderId, status: "RECHAZADO" }); } catch {}
    } catch {}
    await bot.sendMessage(chatId, "❌ Avisé al cliente que reenvíe el comprobante.");
    return;
  }
});

// Pregunta de gramos (kg)
bot.on("text", async (msg) => {
  const chatId = msg.chat.id;
  const u = getUser(chatId);
  if (u.step !== "ASK_GRAMS") return;

  const grams = Number(String(msg.text || "").replace(/[^\d]/g, ""));
  if (!grams || grams < 10) {
    await bot.sendMessage(chatId, "Decime un número de gramos válido 🙏 (Ej: 300)");
    return;
  }

  const p = u._pending;
  u._pending = null;
  u.step = "IDLE";

  const pricePerKg = Number(p.precioporkg || p.precio || 0);
  const subtotal = Math.round((pricePerKg / 1000) * grams);

  u.cart.push({ codigo: p.codigo, nombre: p.nombre, unidad: "kg", qty: grams, subtotal });

  await bot.sendMessage(chatId, `✅ Agregado: *${p.nombre}* (${grams}g)\nSubtotal: $${money(subtotal)} ARS\n\n¿Sumamos algo más? 😋`, { parse_mode: "Markdown", ...mainMenuKeyboard() });
});

// -------------------- Boot: set webhook --------------------
async function boot() {
  // set webhook
  if (!PUBLIC_URL) {
    console.log("⚠️ PUBLIC_URL no está seteada. Igual levanto el server, pero el webhook puede fallar.");
  } else {
    const hook = `${PUBLIC_URL.replace(/\/$/, "")}/webhook`;
    await bot.setWebHook(hook);
    console.log("✅ Webhook seteado:", hook);
  }

  // Preload
  try { await loadAll(true); } catch (e) { console.log("loadAll error:", e?.message || e); }

  app.listen(PORT, () => console.log(`✅ Server up on ${PORT}`));
}

boot().catch((e) => {
  console.error("BOOT ERROR:", e);
  process.exit(1);
});

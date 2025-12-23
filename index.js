// index.js (ESM) — EzerBot Render Webhook + Config/Catalogo desde Google Sheets (Apps Script)
// Render ENV: BOT_TOKEN, SHEETS_API_BASE, PUBLIC_URL
// PUBLIC_URL = https://ezerbot-system.onrender.com (SIN / al final)
// SHEETS_API_BASE = https://script.google.com/macros/s/XXXX/exec

import TelegramBot from "node-telegram-bot-api";
import http from "http";
import { URL } from "url";

// =====================
// 1) ENV
// =====================
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const SHEETS_API_BASE = process.env.SHEETS_API_BASE || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const PORT = Number(process.env.PORT || 10000);

const WEBHOOK_PATH = "/telegram";
const WEBHOOK_URL = PUBLIC_URL ? `${PUBLIC_URL}${WEBHOOK_PATH}` : "";

if (!BOT_TOKEN) console.log("❌ FALTA BOT_TOKEN en Render > Environment");
if (!SHEETS_API_BASE) console.log("❌ FALTA SHEETS_API_BASE en Render > Environment");
if (!PUBLIC_URL) console.log("❌ FALTA PUBLIC_URL en Render > Environment (ej: https://ezerbot-system.onrender.com)");

// =====================
// 2) BOT (WEBHOOK ONLY)
// =====================
const bot = new TelegramBot(BOT_TOKEN, { webHook: true });

// =====================
// 3) CACHE (Config + Catalogo)
// =====================
const CACHE_TTL_MS = 30 * 1000;
let cacheConfig = { at: 0, data: null };
let cacheCatalog = { at: 0, data: null };

async function fetchJSON(url) {
  const r = await fetch(url, { method: "GET" });
  const txt = await r.text();
  let j;
  try {
    j = JSON.parse(txt);
  } catch {
    throw new Error(`Respuesta no JSON desde ${url}: ${txt.slice(0, 200)}`);
  }
  return j;
}

async function getConfig() {
  const now = Date.now();
  if (cacheConfig.data && now - cacheConfig.at < CACHE_TTL_MS) return cacheConfig.data;
  if (!SHEETS_API_BASE) return {};
  const url = `${SHEETS_API_BASE}?type=config&_=${now}`;
  const data = await fetchJSON(url);
  cacheConfig = { at: now, data: data || {} };
  return cacheConfig.data;
}

async function getCatalog() {
  const now = Date.now();
  if (cacheCatalog.data && now - cacheCatalog.at < CACHE_TTL_MS) return cacheCatalog.data;
  if (!SHEETS_API_BASE) return [];
  const url = `${SHEETS_API_BASE}?type=catalog&_=${now}`;
  const data = await fetchJSON(url);
  cacheCatalog = { at: now, data: Array.isArray(data) ? data : [] };
  return cacheCatalog.data;
}

// =====================
// 4) STATE (RAM)
// =====================
const userState = new Map();

function getState(chatId) {
  if (!userState.has(chatId)) {
    userState.set(chatId, {
      // catálogo tipo libro
      catFilter: "ALL",
      catIndex: 0,
      catMsgId: null, // mensaje único que se edita (para no llenar el chat)
      catMode: "PRODUCT", // PRODUCT | QTY
      qtyForCode: null,

      // carrito
      cart: new Map(), // code -> {prod, qty}

      // input manual mínimo (solo si elige "Otro")
      awaitingQty: null, // { code, unit }

      // checkout
      flow: null,
    });
  }
  return userState.get(chatId);
}

// =====================
// 5) Helpers
// =====================
function safeStr(v) {
  return String(v ?? "").trim();
}

function moneyARS(n) {
  const v = Number(n || 0);
  try {
    return v.toLocaleString("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });
  } catch {
    return `$${Math.round(v)}`;
  }
}

function normalizeUnit(u) {
  const s = safeStr(u).toLowerCase();
  if (s.includes("kg")) return "kg";
  if (s.includes("kilo")) return "kg";
  if (s.includes("gram")) return "kg"; // si en catálogo escriben "gramos" lo tratamos como pesable
  return "unidad";
}

function productCode(p) {
  return safeStr(p.codigo || p.id || p.CODIGO || p.Codigo || p.code);
}

function productName(p) {
  return safeStr(p.nombre || p.NOMBRE || p.Nombre);
}

function productPrice(p) {
  return Number(p.precio || p.PRECIO || p.Precio || 0);
}

function productImage(p) {
  return safeStr(p.imagen || p.IMAGEN || p.Imagen || p.image || "");
}

function productCategory(p) {
  return safeStr(p.categoria || p.CATEGORIA || p.Categoria || "");
}

function productDesc(p) {
  return safeStr(p.descripcion || p.DESCRIPCION || p.Descripcion || "");
}

function productUnit(p) {
  return normalizeUnit(p.unidad || p.UNIDAD || p.Unidad);
}

function shippingCostFromConfig(cfg) {
  // soporta varias claves (porque en Config puede llamarse distinto)
  const keys = [
    "CostoEnvio",
    "EnvioCosto",
    "MontoEnvio",
    "CostoEnvioDomicilio",
    "PrecioEnvio",
    "CostoDelivery",
  ];
  for (const k of keys) {
    const v = Number(cfg?.[k]);
    if (isFinite(v) && v > 0) return v;
  }
  return 0;
}

function cfgVal(cfg, ...keys) {
  for (const k of keys) {
    const v = safeStr(cfg?.[k]);
    if (v && v.toUpperCase() !== "NO") return v;
  }
  return "";
}

function mainMenuKeyboard() {
  // Reply keyboard (siempre visible)
  return {
    keyboard: [
      [{ text: "🛍️ Catálogo" }, { text: "🛒 Mi carrito" }],
      [{ text: "✅ Finalizar compra" }],
      [{ text: "🎫 Tarjeta de sellos" }, { text: "📣 Compartir bot" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

// =====================
// 6) WELCOME (sin pisarse)
// =====================
async function sendWelcome(chatId) {
  const cfg = await getConfig();

  const negocio = cfgVal(cfg, "NegocioNombre", "NombreNegocio", "Nombre");
  const dir = cfgVal(cfg, "Direccion", "Dirección", "DireccionNegocio");
  const hor = cfgVal(cfg, "Horarios", "Horario", "HorarioNegocio");
  const tel = cfgVal(cfg, "TelefonoNegocio", "Telefono", "Tel", "WhatsApp", "Whatsapp");
  const ig = cfgVal(cfg, "Instagram");
  const logo = cfgVal(cfg, "LogoURL", "Logo", "LogoUrl");
  const textoBienvenida = cfgVal(cfg, "TextoBienvenida", "BienvenidaTexto", "MensajeBienvenida");
  const desc = cfgVal(cfg, "Descripcion", "Descripción", "TextoDescripcion", "TextoPresentacion");

  let text = "";
  if (textoBienvenida) {
    text += `${textoBienvenida}\n\n`;
  } else {
    text += `¡Hola! 👋 Bienvenid@ a *${negocio || "Todo Queso"}* 🧀✨\n\n`;
    text += `Elegí del Catálogo, armá tu carrito y confirmá en 1 minuto.\n`;
  }

  if (negocio) text += `\n🧀 *${negocio}*`;
  if (dir) text += `\n📍 ${dir}`;
  if (hor) text += `\n🕒 ${hor}`;
  if (tel) text += `\n📞 ${tel}`;
  if (ig) text += `\n📸 Instagram: ${ig.startsWith("@") ? ig : "@" + ig}`;
  if (desc) text += `\n\n${desc}`;

  text += `\n\nElegí una opción del menú para empezar 👇`;

  // Botón inline extra para compartir (por si el reply keyboard no “toma” en algunos clientes)
  const inline = {
    inline_keyboard: [
      [{ text: "🛍️ Abrir catálogo", callback_data: "OPEN:CAT" }],
      [{ text: "📣 Compartir bot", callback_data: "OPEN:SHARE" }],
    ],
  };

  if (logo) {
    try {
      await bot.sendPhoto(chatId, logo, {
        caption: text,
        parse_mode: "Markdown",
        reply_markup: inline,
      });
      await bot.sendMessage(chatId, "Menú listo ✅", { reply_markup: mainMenuKeyboard() });
      return;
    } catch {
      // fallback a texto
    }
  }

  await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: inline });
  await bot.sendMessage(chatId, "Menú listo ✅", { reply_markup: mainMenuKeyboard() });
}

// =====================
// 7) SHARE BOT (SIEMPRE FUNCIONA)
// =====================
function shareInlineButtons() {
  // Si querés compartir el bot real, lo ideal es tu link de bot (t.me/...)
  // Si todavía no lo tenés fijo, podés guardarlo en Config como BotLink.
  const fallback = "https://t.me/EzerBot";
  return async () => {
    const cfg = await getConfig();
    const botLink = cfgVal(cfg, "BotLink") || fallback;

    const waText = encodeURIComponent(`Pedí por el bot 🧀👇\n${botLink}`);
    const tgText = encodeURIComponent("Pedí por el bot:");
    const mailSubj = encodeURIComponent("Te comparto el bot");
    const mailBody = encodeURIComponent(`Hola! Te comparto el bot para pedir:\n${botLink}`);

    return {
      inline_keyboard: [
        [{ text: "💬 WhatsApp", url: `https://wa.me/?text=${waText}` }],
        [{ text: "✈️ Telegram", url: `https://t.me/share/url?url=${encodeURIComponent(botLink)}&text=${tgText}` }],
        [{ text: "📧 Email", url: `mailto:?subject=${mailSubj}&body=${mailBody}` }],
      ],
    };
  };
}
const getShareKeyboard = shareInlineButtons();

async function showShare(chatId) {
  const kb = await getShareKeyboard();
  await bot.sendMessage(chatId, "📣 Compartí el bot con tus contactos 👇", {
    reply_markup: kb,
  });
}

// =====================
// 8) STAMPS CARD
// =====================
async function sendStampsCard(chatId) {
  const cfg = await getConfig();
  const usa = (safeStr(cfg.UsaSellos || cfg.UsaTarjetaSellos || "NO").toUpperCase() === "SI");
  if (!usa) {
    await bot.sendMessage(chatId, "Por ahora la tarjeta de sellos está desactivada.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  const cardUrl = cfgVal(cfg, "TarjetaURL", "SelloURL", "TarjetaSellosURL");
  const premio = cfgVal(cfg, "BeneficioPorSellos", "PremioSellos", "BeneficioCumple") || "Beneficio sorpresa";
  const meta = Number(cfg.SellosPorNivel || cfg.MetaSellos || 10);
  const sellos = 0; // (si después conectás sellos por cliente, acá se reemplaza)

  const bar = "🟩".repeat(Math.min(sellos, meta)) + "⬜".repeat(Math.max(0, meta - sellos));
  const text =
    `🎫 *Tarjeta de sellos*\n\n${bar}\n\n` +
    `Sellos: *${sellos} / ${meta}*\n` +
    `Premio al completar: *${premio}*\n\n` +
    `Tip: cada compra confirmada suma 1 sello automático.`;

  if (cardUrl) {
    try {
      await bot.sendPhoto(chatId, cardUrl, { caption: text, parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
      return;
    } catch {}
  }
  await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
}

// =====================
// 9) CATÁLOGO “LIBRO” (1 mensaje que se edita)
// =====================
function uniqueCategories(list) {
  const set = new Set();
  for (const p of list) {
    const c = productCategory(p);
    if (c) set.add(c);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, "es"));
}

function filteredList(list, filter) {
  if (!filter || filter === "ALL") return list;
  return list.filter((p) => productCategory(p) === filter);
}

function productCaption(p, idx, total, filter) {
  const nombre = productName(p);
  const precio = productPrice(p);
  const unit = productUnit(p);

  const header = filter && filter !== "ALL" ? `🛍️ *Catálogo — ${filter}*\n📖 Producto *${idx + 1}* de *${total}*\n\n` : `🛍️ *Catálogo*\n📖 Producto *${idx + 1}* de *${total}*\n\n`;
  const priceLine = unit === "kg" ? `💰 ${moneyARS(precio)} *(x kg)*` : `💰 ${moneyARS(precio)} *(por unidad)*`;
  const desc = productDesc(p);
  const descLine = desc ? `\n\n📝 ${desc}` : "";

  return `${header}🧀 *${nombre}*\n${priceLine}${descLine}`;
}

function catalogButtonsForState(st, list, p) {
  const left = { text: "⬅️", callback_data: "CAT:PREV" };
  const right = { text: "➡️", callback_data: "CAT:NEXT" };

  const rowNav = [
    ...(list.length > 1 ? [left] : []),
    { text: "➕ Quiero este", callback_data: `CAT:ADD:${productCode(p)}` },
    ...(list.length > 1 ? [right] : []),
  ];

  return {
    inline_keyboard: [
      rowNav,
      [
        { text: "📚 Categorías", callback_data: "CAT:SHOW_CATS" },
        { text: "🛒 Ver carrito", callback_data: "OPEN:CART" },
      ],
      [{ text: "📣 Compartir bot", callback_data: "OPEN:SHARE" }],
    ],
  };
}

async function upsertCatalogMessage(chatId) {
  const st = getState(chatId);
  const full = await getCatalog();
  const list = filteredList(full, st.catFilter);

  if (!list.length) {
    await bot.sendMessage(chatId, "Todavía no hay productos cargados en el catálogo.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (st.catIndex < 0) st.catIndex = 0;
  if (st.catIndex >= list.length) st.catIndex = list.length - 1;

  const p = list[st.catIndex];
  const img = productImage(p);
  const caption = productCaption(p, st.catIndex, list.length, st.catFilter);

  const kb = catalogButtonsForState(st, list, p);

  // Si ya existe el mensaje “libro”, lo editamos (cero spam)
  if (st.catMsgId) {
    try {
      if (img) {
        await bot.editMessageMedia(
          {
            type: "photo",
            media: img,
            caption,
            parse_mode: "Markdown",
          },
          { chat_id: chatId, message_id: st.catMsgId }
        );
        await bot.editMessageReplyMarkup(kb, { chat_id: chatId, message_id: st.catMsgId });
        st.catMode = "PRODUCT";
        return;
      } else {
        // si no hay imagen, editamos texto
        await bot.editMessageText(caption, {
          chat_id: chatId,
          message_id: st.catMsgId,
          parse_mode: "Markdown",
          reply_markup: kb,
        });
        st.catMode = "PRODUCT";
        return;
      }
    } catch {
      // si falla (por ejemplo message muy viejo), lo mandamos de nuevo
      st.catMsgId = null;
    }
  }

  // Crear mensaje nuevo (1 sola vez)
  if (img) {
    const sent = await bot.sendPhoto(chatId, img, { caption, parse_mode: "Markdown", reply_markup: kb });
    st.catMsgId = sent.message_id;
    st.catMode = "PRODUCT";
    return;
  } else {
    const sent = await bot.sendMessage(chatId, caption, { parse_mode: "Markdown", reply_markup: kb });
    st.catMsgId = sent.message_id;
    st.catMode = "PRODUCT";
    return;
  }
}

async function showCategories(chatId) {
  const st = getState(chatId);
  const full = await getCatalog();
  const cats = uniqueCategories(full);

  const rows = [];
  const firstRow = [{ text: "📚 Todas", callback_data: "CATF:ALL" }];
  rows.push(firstRow);

  // Botones por filas (2 por fila para que quede prolijo)
  let r = [];
  for (const c of cats) {
    r.push({ text: c, callback_data: `CATF:${c}` });
    if (r.length === 2) {
      rows.push(r);
      r = [];
    }
  }
  if (r.length) rows.push(r);

  rows.push([{ text: "🛒 Ver carrito", callback_data: "OPEN:CART" }]);

  // mensaje chico y útil (sin ejemplos)
  await bot.sendMessage(chatId, "📚 *Categorías*\nElegí una categoría para ver productos 👇", {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: rows },
  });
}

function qtyKeyboardForProduct(p) {
  const code = productCode(p);
  const unit = productUnit(p);

  if (unit === "kg") {
    // botones “limpios” (no llenan el chat con ejemplos)
    return {
      inline_keyboard: [
        [
          { text: "100g", callback_data: `QTYG:${code}:100` },
          { text: "200g", callback_data: `QTYG:${code}:200` },
          { text: "300g", callback_data: `QTYG:${code}:300` },
        ],
        [
          { text: "400g", callback_data: `QTYG:${code}:400` },
          { text: "500g", callback_data: `QTYG:${code}:500` },
          { text: "✍️ Otro", callback_data: `QTY:OTHER:${code}` },
        ],
        [
          { text: "📚 Categorías", callback_data: "CAT:SHOW_CATS" },
          { text: "🛒 Ver carrito", callback_data: "OPEN:CART" },
        ],
      ],
    };
  }

  // unidad
  return {
    inline_keyboard: [
      [
        { text: "1", callback_data: `QTYU:${code}:1` },
        { text: "2", callback_data: `QTYU:${code}:2` },
        { text: "3", callback_data: `QTYU:${code}:3` },
      ],
      [
        { text: "4", callback_data: `QTYU:${code}:4` },
        { text: "5", callback_data: `QTYU:${code}:5` },
        { text: "✍️ Otro", callback_data: `QTY:OTHER:${code}` },
      ],
      [
        { text: "📚 Categorías", callback_data: "CAT:SHOW_CATS" },
        { text: "🛒 Ver carrito", callback_data: "OPEN:CART" },
      ],
    ],
  };
}

async function askQtyOnSameCatalogMessage(chatId, p) {
  const st = getState(chatId);
  const unit = productUnit(p);

  const title = unit === "kg"
    ? `¿Cuántos *gramos* querés de *${productName(p)}*?`
    : `¿Cuántas *unidades* querés de *${productName(p)}*?`;

  const img = productImage(p);
  const kb = qtyKeyboardForProduct(p);

  // Edita el mismo mensaje del “libro” para no llenar el chat
  if (st.catMsgId) {
    try {
      if (img) {
        await bot.editMessageMedia(
          {
            type: "photo",
            media: img,
            caption: `➕ *Agregar al carrito*\n\n${title}`,
            parse_mode: "Markdown",
          },
          { chat_id: chatId, message_id: st.catMsgId }
        );
        await bot.editMessageReplyMarkup(kb, { chat_id: chatId, message_id: st.catMsgId });
        st.catMode = "QTY";
        st.qtyForCode = productCode(p);
        return;
      } else {
        await bot.editMessageText(`➕ *Agregar al carrito*\n\n${title}`, {
          chat_id: chatId,
          message_id: st.catMsgId,
          parse_mode: "Markdown",
          reply_markup: kb,
        });
        st.catMode = "QTY";
        st.qtyForCode = productCode(p);
        return;
      }
    } catch {
      // fallback: manda un mensaje mínimo
    }
  }

  await bot.sendMessage(chatId, title, { parse_mode: "Markdown", reply_markup: kb });
  st.catMode = "QTY";
  st.qtyForCode = productCode(p);
}

// =====================
// 10) CARRITO (resumen corto)
// =====================
function cartTotalProducts(st) {
  let total = 0;
  for (const { prod, qty } of st.cart.values()) {
    total += productPrice(prod) * Number(qty || 0);
  }
  return total;
}

async function showCart(chatId) {
  const st = getState(chatId);
  if (!st.cart.size) {
    await bot.sendMessage(chatId, "🛒 Tu carrito está vacío.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  let text = "🛒 *Tu carrito*\n\n";
  for (const { prod, qty } of st.cart.values()) {
    const unit = productUnit(prod);
    const lineTotal = productPrice(prod) * Number(qty || 0);
    text += `• *${productName(prod)}* — *${qty}* ${unit === "kg" ? "kg" : "u"} | ${moneyARS(lineTotal)}\n`;
  }

  text += `\nTotal productos: *${moneyARS(cartTotalProducts(st))}*`;

  const inline = {
    inline_keyboard: [
      [{ text: "✅ Finalizar compra", callback_data: "OPEN:CHECKOUT" }],
      [{ text: "📚 Categorías", callback_data: "CAT:SHOW_CATS" }],
      [{ text: "📣 Compartir bot", callback_data: "OPEN:SHARE" }],
    ],
  };

  await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: inline });
}

// =====================
// 11) CHECKOUT
// =====================
function startCheckout(chatId) {
  const st = getState(chatId);
  if (!st.cart.size) {
    bot.sendMessage(chatId, "Tu carrito está vacío.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  st.flow = {
    step: "choose_delivery",
    deliveryType: null,
    address: null,
    name: null,
    phone: null,
    payment: null,
  };

  bot.sendMessage(chatId, "Elegí cómo querés recibir tu pedido 👇", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🚚 Envío a domicilio", callback_data: "CHK:DELIVERY" }],
        [{ text: "🏪 Retiro por el local", callback_data: "CHK:PICKUP" }],
      ],
    },
  });
}

async function finalizeOrder(chatId) {
  const st = getState(chatId);
  const cfg = await getConfig();
  const flow = st.flow;

  const negocio = cfgVal(cfg, "NegocioNombre", "NombreNegocio", "Nombre") || "Todo Queso";
  const alias = cfgVal(cfg, "AliasPago", "Alias", "MercadoPagoAlias") || "jennyocampos.mp";
  const waNegocio = cfgVal(cfg, "WhatsAppLink", "WhatsappLink", "LinkWhatsApp");
  const chatVendedor = Number(cfg.ChatIdVendedor || cfg.ChatVendedor || 0);

  // detalle
  let detalle = "";
  for (const { prod, qty } of st.cart.values()) {
    const unit = productUnit(prod);
    const lt = productPrice(prod) * Number(qty || 0);
    detalle += `- ${productName(prod)} | ${qty} ${unit === "kg" ? "kg" : "u"} | ${moneyARS(lt)}\n`;
  }

  const totalProd = cartTotalProducts(st);
  const envio = flow.deliveryType === "envio" ? shippingCostFromConfig(cfg) : 0;
  const totalFinal = totalProd + envio;

  const entregaTxt = flow.deliveryType === "envio" ? "🚚 Envío a domicilio" : "🏪 Retiro por el local";

  let resumen =
    `✅ *Pedido confirmado (pendiente de pago/validación)*\n\n` +
    `*${negocio}*\n` +
    `Entrega: *${entregaTxt}*\n` +
    (flow.deliveryType === "envio" ? `Dirección: *${safeStr(flow.address)}*\n` : "") +
    `Nombre: *${safeStr(flow.name)}*\n` +
    `Teléfono: *${safeStr(flow.phone)}*\n` +
    `Pago: *${safeStr(flow.payment)}*\n\n` +
    `🧾 *Detalle:*\n${detalle}\n` +
    `🧀 Total productos: *${moneyARS(totalProd)}*\n` +
    `🚚 Envío: *${moneyARS(envio)}*\n` +
    `💰 *Total final: ${moneyARS(totalFinal)}*\n`;

  if (flow.payment === "Transferencia") {
    resumen += `\n🏦 Alias para transferir: \`${alias}\`\n📌 Cuando transfieras, mandá el comprobante por acá.`;
  } else {
    resumen += `\n💵 Pagás en efectivo al retirar o al recibir el pedido.`;
  }

  await bot.sendMessage(chatId, resumen, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });

  // aviso al vendedor
  if (chatVendedor) {
    const vendedorMsg =
      `🛎️ *Nuevo pedido*\n\n` +
      `Cliente: *${safeStr(flow.name)}*\n` +
      `Tel: *${safeStr(flow.phone)}*\n` +
      `Entrega: *${entregaTxt}*\n` +
      (flow.deliveryType === "envio" ? `Dirección: *${safeStr(flow.address)}*\n` : "") +
      `Pago: *${safeStr(flow.payment)}*\n\n` +
      `🧾 *Detalle:*\n${detalle}\n` +
      `🧀 Total productos: *${moneyARS(totalProd)}*\n` +
      `🚚 Envío: *${moneyARS(envio)}*\n` +
      `💰 *Total final: ${moneyARS(totalFinal)}*\n`;

    try {
      await bot.sendMessage(chatVendedor, vendedorMsg, { parse_mode: "Markdown" });
    } catch (e) {
      console.log("No pude avisar al vendedor:", e?.message || e);
    }
  }

  if (waNegocio) {
    await bot.sendMessage(chatId, `📲 WhatsApp del local: ${waNegocio}`, { reply_markup: mainMenuKeyboard() });
  }

  st.flow = null;
}

// =====================
// 12) ADD TO CART (desde qty buttons)
// =====================
function setCartQty(st, prod, qtyKgOrUnits) {
  const code = productCode(prod);
  st.cart.set(code, { prod, qty: qtyKgOrUnits });
}

function addOrReplaceCart(st, prod, qty) {
  const code = productCode(prod);
  st.cart.set(code, { prod, qty });
}

async function confirmAddedMinimal(chatId, prod, qty) {
  // mensaje corto para no llenar
  const unit = productUnit(prod);
  const txt = unit === "kg"
    ? `✅ Agregado: *${productName(prod)}* — *${qty} kg*`
    : `✅ Agregado: *${productName(prod)}* — *${qty} u*`;

  await bot.sendMessage(chatId, txt, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
}

// =====================
// 13) HANDLERS (text)
// =====================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const textRaw = safeStr(msg.text);
  const text = textRaw.toLowerCase();
  const st = getState(chatId);

  // input manual SOLO si eligió "Otro" (mínimo, sin ejemplos)
  if (st.awaitingQty) {
    const { code, unit } = st.awaitingQty;
    st.awaitingQty = null;

    const catalog = await getCatalog();
    const prod = catalog.find((p) => productCode(p) === code);
    if (!prod) {
      await bot.sendMessage(chatId, "No encontré ese producto.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    const raw = String(textRaw).replace(",", ".").trim();
    const n = Number(raw);

    if (!isFinite(n) || n <= 0) {
      await bot.sendMessage(chatId, "Cantidad inválida. Probá de nuevo.", { reply_markup: mainMenuKeyboard() });
      return;
    }

    if (unit === "kg") {
      // si escribe 250 => gramos, si escribe 0.25 => kg
      const qtyKg = n >= 5 ? Math.round((n / 1000) * 100) / 100 : Math.round(n * 100) / 100;
      addOrReplaceCart(st, prod, qtyKg);
      await confirmAddedMinimal(chatId, prod, qtyKg);
      await upsertCatalogMessage(chatId);
      return;
    } else {
      const qtyU = Math.round(n);
      addOrReplaceCart(st, prod, qtyU);
      await confirmAddedMinimal(chatId, prod, qtyU);
      await upsertCatalogMessage(chatId);
      return;
    }
  }

  // checkout data capture
  if (st.flow && st.flow.step) {
    const flow = st.flow;
    if (flow.step === "ask_address") {
      flow.address = textRaw;
      flow.step = "ask_name";
      await bot.sendMessage(chatId, "🧾 Tu nombre:");
      return;
    }
    if (flow.step === "ask_name") {
      flow.name = textRaw;
      flow.step = "ask_phone";
      await bot.sendMessage(chatId, "📞 Tu teléfono:");
      return;
    }
    if (flow.step === "ask_phone") {
      flow.phone = textRaw;
      flow.step = "choose_payment";
      await bot.sendMessage(chatId, "Elegí el método de pago:", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "💵 Efectivo", callback_data: "CHK:PAY:CASH" }],
            [{ text: "🏦 Transferencia", callback_data: "CHK:PAY:TRANSFER" }],
          ],
        },
      });
      return;
    }
  }

  // comandos útiles
  if (text === "/start" || text === "hola" || text === "buen día" || text === "buen dia" || text === "buenas" || text === "menu" || text === "menú") {
    await sendWelcome(chatId);
    return;
  }
  if (text === "/share" || text === "compartir" || text === "compartir bot") {
    await showShare(chatId);
    return;
  }

  // Reply keyboard
  if (textRaw === "🛍️ Catálogo") {
    const st = getState(chatId);
    st.catFilter = st.catFilter || "ALL";
    st.catIndex = 0;
    await showCategories(chatId);
    await upsertCatalogMessage(chatId);
    return;
  }
  if (textRaw === "🛒 Mi carrito") {
    await showCart(chatId);
    return;
  }
  if (textRaw === "✅ Finalizar compra") {
    startCheckout(chatId);
    return;
  }
  if (textRaw === "🎫 Tarjeta de sellos") {
    await sendStampsCard(chatId);
    return;
  }
  if (textRaw === "📣 Compartir bot") {
    await showShare(chatId);
    return;
  }

  // Default minimal
  await bot.sendMessage(chatId, "Elegí una opción del menú 👇", { reply_markup: mainMenuKeyboard() });
});

// =====================
// 14) HANDLERS (callbacks)
// =====================
bot.on("callback_query", async (q) => {
  const chatId = q.message?.chat?.id;
  const data = safeStr(q.data);
  if (!chatId) return;

  const st = getState(chatId);

  try { await bot.answerCallbackQuery(q.id); } catch {}

  // Share
  if (data === "OPEN:SHARE") {
    await showShare(chatId);
    return;
  }

  // Catalog open
  if (data === "OPEN:CAT") {
    await showCategories(chatId);
    await upsertCatalogMessage(chatId);
    return;
  }

  // Categories menu
  if (data === "CAT:SHOW_CATS") {
    await showCategories(chatId);
    return;
  }
  if (data.startsWith("CATF:")) {
    const f = data.slice("CATF:".length);
    st.catFilter = f === "ALL" ? "ALL" : f;
    st.catIndex = 0;
    await upsertCatalogMessage(chatId);
    return;
  }

  // Prev / Next
  if (data === "CAT:PREV") {
    st.catIndex = Math.max(0, st.catIndex - 1);
    await upsertCatalogMessage(chatId);
    return;
  }
  if (data === "CAT:NEXT") {
    st.catIndex = st.catIndex + 1;
    await upsertCatalogMessage(chatId);
    return;
  }

  // Add -> ask qty (no spam)
  if (data.startsWith("CAT:ADD:")) {
    const code = data.slice("CAT:ADD:".length);
    const catalog = await getCatalog();
    const prod = catalog.find((p) => productCode(p) === code);
    if (!prod) return;

    await askQtyOnSameCatalogMessage(chatId, prod);
    return;
  }

  // Qty buttons grams
  if (data.startsWith("QTYG:")) {
    const [, code, gramsStr] = data.split(":");
    const grams = Number(gramsStr || 0);
    const catalog = await getCatalog();
    const prod = catalog.find((p) => productCode(p) === code);
    if (!prod) return;

    const qtyKg = Math.round((grams / 1000) * 100) / 100;
    addOrReplaceCart(st, prod, qtyKg);

    await confirmAddedMinimal(chatId, prod, qtyKg);
    await upsertCatalogMessage(chatId);
    return;
  }

  // Qty buttons units
  if (data.startsWith("QTYU:")) {
    const [, code, uStr] = data.split(":");
    const u = Number(uStr || 0);
    const catalog = await getCatalog();
    const prod = catalog.find((p) => productCode(p) === code);
    if (!prod) return;

    const qtyU = Math.round(u);
    addOrReplaceCart(st, prod, qtyU);

    await confirmAddedMinimal(chatId, prod, qtyU);
    await upsertCatalogMessage(chatId);
    return;
  }

  // Qty other -> minimal input
  if (data.startsWith("QTY:OTHER:")) {
    const code = data.slice("QTY:OTHER:".length);
    const catalog = await getCatalog();
    const prod = catalog.find((p) => productCode(p) === code);
    if (!prod) return;

    const unit = productUnit(prod);
    st.awaitingQty = { code, unit };

    if (unit === "kg") {
      await bot.sendMessage(chatId, `Escribí la cantidad en *gramos* para *${productName(prod)}* 👇`, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
    } else {
      await bot.sendMessage(chatId, `Escribí cuántas *unidades* querés de *${productName(prod)}* 👇`, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
    }
    return;
  }

  // Cart / Checkout shortcuts
  if (data === "OPEN:CART") {
    await showCart(chatId);
    return;
  }
  if (data === "OPEN:CHECKOUT") {
    startCheckout(chatId);
    return;
  }

  // Checkout
  if (data === "CHK:DELIVERY") {
    st.flow = st.flow || {};
    st.flow.deliveryType = "envio";
    st.flow.step = "ask_address";
    await bot.sendMessage(chatId, "📍 Decime tu dirección completa:");
    return;
  }
  if (data === "CHK:PICKUP") {
    st.flow = st.flow || {};
    st.flow.deliveryType = "retiro";
    st.flow.step = "ask_name";
    await bot.sendMessage(chatId, "🧾 Tu nombre:");
    return;
  }
  if (data === "CHK:PAY:CASH" || data === "CHK:PAY:TRANSFER") {
    if (!st.flow || st.flow.step !== "choose_payment") return;
    st.flow.payment = data.endsWith("CASH") ? "Efectivo" : "Transferencia";
    await finalizeOrder(chatId);
    return;
  }
});

// =====================
// 15) HTTP SERVER (Render)
// =====================
const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);

    if (u.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("EzerBot está corriendo ✅");
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
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
        }
      });
      return;
    }

    if (u.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, webhook: WEBHOOK_URL, sheets: !!SHEETS_API_BASE }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error_code: 404, description: "Not Found" }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Server error");
  }
});

server.listen(PORT, async () => {
  console.log(`HTTP escuchando en puerto ${PORT}`);

  if (WEBHOOK_URL) {
    try {
      await bot.setWebHook(WEBHOOK_URL);
      console.log("✅ Webhook seteado:", WEBHOOK_URL);
    } catch (e) {
      console.log("❌ Error setWebHook:", e?.message || e);
    }
  } else {
    console.log("❌ No hay PUBLIC_URL, no se puede setear webhook.");
  }

  try {
    const cfg = await getConfig();
    const cat = await getCatalog();
    console.log("✅ Warmup ok. Config keys:", Object.keys(cfg || {}).length, "Catalog items:", Array.isArray(cat) ? cat.length : 0);
  } catch (e) {
    console.log("❌ Warmup fetch error:", e?.message || e);
  }

  console.log("✅ EzerBot iniciado (WEBHOOK + Config/Catalogo desde Sheets)");
});

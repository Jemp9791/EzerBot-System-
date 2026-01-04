/**
 * EzerBot - index.js (único script)
 * Requisitos ENV:
 * - BOT_TOKEN
 * - DATA_API_URL   (tu API que lee Google Sheets y devuelve JSON)
 * - PUBLIC_URL     (base url del bot/web si ya lo usás para links)
 *
 * Endpoints esperados:
 * - GET  {DATA_API_URL}/config           -> { ok:true, config:{...} }
 * - GET  {DATA_API_URL}/catalogo         -> { ok:true, items:[...] }
 * - GET  {DATA_API_URL}/catalogo?cat=... -> filtra por categoría (opcional)
 *
 * Items de catálogo esperados (flexible):
 * { codigo, nombre, precio, unidad, precio_por_kg, descripcion, imagen, categoria }
 */

const TelegramBot = require("node-telegram-bot-api");

// Node 18+ tiene fetch global. Si no, descomentá:
// const fetch = (...args) => import("node-fetch").then(({default: fetch}) => fetch(...args));

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATA_API_URL = (process.env.DATA_API_URL || "").replace(/\/+$/, "");
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");

if (!BOT_TOKEN) throw new Error("Falta ENV BOT_TOKEN");
if (!DATA_API_URL) throw new Error("Falta ENV DATA_API_URL");

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

/** =========================
 *  Estado en memoria (simple)
 *  ========================= */
const SESS = new Map(); // key = `${chatId}:${userId}`
const CART_TTL_MS = 60 * 60 * 1000;   // 1 hora (carrito)
const ORDER_TTL_MS = 60 * 60 * 1000;  // 1 hora (pedido esperando confirmación)

function sessKey(chatId, userId) {
  return `${chatId}:${userId}`;
}
function getSess(chatId, userId) {
  const k = sessKey(chatId, userId);
  const now = Date.now();
  let s = SESS.get(k);
  if (!s) {
    s = {
      cart: [],
      cartUpdatedAt: 0,
      lastCatalogMsgId: null,
      catalogPage: 0,
      category: null,
      awaiting: null,   // { type, payload }
      orderDraft: null, // { ... } esperando confirmación
      orderUpdatedAt: 0,
      lastProductShown: null,
    };
    SESS.set(k, s);
  }

  // Expira carrito
  if (s.cartUpdatedAt && now - s.cartUpdatedAt > CART_TTL_MS) {
    s.cart = [];
    s.cartUpdatedAt = 0;
  }
  // Expira borrador de pedido
  if (s.orderUpdatedAt && now - s.orderUpdatedAt > ORDER_TTL_MS) {
    s.orderDraft = null;
    s.orderUpdatedAt = 0;
  }
  return s;
}

function money(n, currency="$") {
  const num = Number(n || 0);
  return `${currency}${num.toLocaleString("es-AR")}`;
}

/** =========================
 *  Cargar Config + Catálogo
 *  ========================= */
let CACHE = { config: null, items: null, at: 0 };
const CACHE_MS = 30 * 1000;

async function apiGet(path) {
  const url = `${DATA_API_URL}${path.startsWith("/") ? "" : "/"}${path}`;
  const res = await fetch(url, { headers: { "accept": "application/json" } });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) {
    throw new Error(`API no devolvió JSON en ${url}. Respuesta: ${text.slice(0, 200)}`);
  }
  if (!res.ok || json.ok === false) {
    throw new Error(`API error ${res.status} en ${url}: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json;
}

async function loadData(force=false) {
  const now = Date.now();
  if (!force && CACHE.config && CACHE.items && now - CACHE.at < CACHE_MS) return CACHE;

  const [cfg, cat] = await Promise.all([
    apiGet("/config"),
    apiGet("/catalogo"),
  ]);

  CACHE = {
    config: cfg.config || cfg.data || cfg || {},
    items: cat.items || cat.catalogo || cat.data || [],
    at: now,
  };
  return CACHE;
}

/** =========================
 *  UI Helpers
 *  ========================= */
function ik(rows) {
  return { reply_markup: { inline_keyboard: rows } };
}

function safeText(s, max=3900) {
  const t = (s ?? "").toString();
  return t.length > max ? t.slice(0, max-3) + "..." : t;
}

function buildMainMenu(config) {
  return ik([
    [
      { text: "🛍️ Catálogo", callback_data: "m:catalogo" },
      { text: "⭐ Sellos", callback_data: "m:sellos" },
    ],
    [
      { text: "❓ Ayuda", callback_data: "m:ayuda" },
      { text: "📣 Compartir bot", callback_data: "m:sharebot" },
    ],
  ]);
}

function buildHelpMenu(config) {
  const rows = [
    [{ text: "🛍️ Ver catálogo", callback_data: "m:catalogo" }],
    [{ text: "💬 Contactar vendedor", callback_data: "m:contact" }],
    [{ text: "⬅️ Menú", callback_data: "m:menu" }],
  ];
  return ik(rows);
}

function buildCategories(items) {
  const set = new Set();
  for (const it of items) {
    const c = (it.categoria || it.category || "").toString().trim();
    if (c) set.add(c);
  }
  return Array.from(set).sort((a,b)=>a.localeCompare(b, "es"));
}

function normalizeUnit(item) {
  // Detecta si es pesable o por unidad:
  const u = (item.unidad || item.unit || "").toString().toLowerCase().trim();
  // Si viene “kg”, “kilo”, “gr”, “g”, “pesable”
  if (["kg","kilo","kilos","gr","g","gramo","gramos","pesable"].includes(u)) return "PESABLE";
  // Si trae precio_por_kg o similar -> pesable
  if (item.precio_por_kg || item.price_per_kg) return "PESABLE";
  return "UNIDAD";
}

function itemPrice(item, gramsOrUnits) {
  const unitType = normalizeUnit(item);
  if (unitType === "PESABLE") {
    const pricePerKg = Number(item.precio_por_kg || item.price_per_kg || item.precio || item.price || 0);
    const grams = Number(gramsOrUnits || 0);
    const kg = grams / 1000;
    return Math.round(pricePerKg * kg);
  } else {
    const price = Number(item.precio || item.price || 0);
    const units = Number(gramsOrUnits || 0);
    return Math.round(price * units);
  }
}

/** =========================
 *  Render de Catálogo (ojeada)
 *  ========================= */
function pageSlice(items, page, perPage) {
  const p = Math.max(0, Number(page||0));
  const pp = Math.max(1, Number(perPage||6));
  const start = p * pp;
  return { slice: items.slice(start, start+pp), start, end: start+pp, total: items.length };
}

async function showWelcome(chatId, userId) {
  const { config } = await loadData();
  const brand = config.brand_name || "Todo Queso";
  const welcome = config.welcome_message || `¡Hola! Soy el asistente de ${brand} 😊`;
  const status = config.open_status || config.opening_status || ""; // opcional
  const schedule = config.open_hours || config.schedule || ""; // opcional

  let msg = `👋 *${brand}*\n\n${welcome}`;
  if (status) msg += `\n\n🟢 Estado: *${status}*`;
  if (schedule) msg += `\n🕒 Horarios: ${schedule}`;

  msg += `\n\n¿En qué te ayudo hoy?`;

  await bot.sendMessage(chatId, msg, {
    parse_mode: "Markdown",
    ...buildMainMenu(config),
  });
}

async function showCategories(chatId, userId) {
  const { config, items } = await loadData();
  const cats = buildCategories(items);
  if (!cats.length) {
    await bot.sendMessage(chatId, "No hay categorías cargadas todavía.", buildMainMenu(config));
    return;
  }
  const rows = [];
  for (let i=0; i<cats.length; i+=2) {
    const r = [];
    r.push({ text: `📁 ${cats[i]}`, callback_data: `c:${encodeURIComponent(cats[i])}` });
    if (cats[i+1]) r.push({ text: `📁 ${cats[i+1]}`, callback_data: `c:${encodeURIComponent(cats[i+1])}` });
    rows.push(r);
  }
  rows.push([{ text: "⬅️ Menú", callback_data: "m:menu" }]);

  await bot.sendMessage(chatId, "Elegí una categoría:", ik(rows));
}

async function showCatalogPage(chatId, userId, page=0) {
  const s = getSess(chatId, userId);
  const { config, items } = await loadData();
  const perPage = Number(config.catalog_per_page || 5);

  let list = items;
  if (s.category) {
    list = items.filter(it => ((it.categoria||it.category||"").toString().trim() === s.category));
  }

  if (!list.length) {
    await bot.sendMessage(chatId, "No hay productos para mostrar en esta categoría.", buildMainMenu(config));
    return;
  }

  const { slice, total } = pageSlice(list, page, perPage);
  s.catalogPage = page;

  const lines = slice.map((it, idx) => {
    const name = it.nombre || it.name || "Producto";
    const code = it.codigo || it.code || "";
    const unitType = normalizeUnit(it) === "PESABLE" ? "⚖️ Pesable" : "📦 Unidad";
    const price = normalizeUnit(it) === "PESABLE"
      ? money(it.precio_por_kg || it.price_per_kg || it.precio, config.currency || "$") + " /kg"
      : money(it.precio || it.price, config.currency || "$");
    return `*${name}* ${code ? `(_${code}_)` : ""}\n${unitType} · ${price}`;
  });

  const header = s.category ? `🛍️ *Catálogo* — _${s.category}_` : `🛍️ *Catálogo*`;
  const body = `${header}\n\n${lines.join("\n\n")}\n\n_Seleccioná un producto para ver y comprar._`;

  const productButtons = slice.map(it => {
    const name = (it.nombre || it.name || "Producto").toString();
    const code = (it.codigo || it.code || name).toString();
    return [{ text: `👉 ${name}`, callback_data: `p:${encodeURIComponent(code)}` }];
  });

  const totalPages = Math.ceil(total / perPage);
  const nav = [];
  if (page > 0) nav.push({ text: "⬅️ Anterior", callback_data: `cat:page:${page-1}` });
  if (page < totalPages - 1) nav.push({ text: "Siguiente ➡️", callback_data: `cat:page:${page+1}` });

  const rows = [
    ...productButtons,
    ...(nav.length ? [nav] : []),
    [
      { text: "📁 Cambiar categoría", callback_data: "m:cats" },
      { text: "🧺 Ver carrito", callback_data: "m:carrito" },
    ],
    [{ text: "⬅️ Menú", callback_data: "m:menu" }],
  ];

  await bot.sendMessage(chatId, safeText(body), { parse_mode: "Markdown", ...ik(rows) });
}

function findItemByCode(items, code) {
  const c = decodeURIComponent(code || "").trim();
  if (!c) return null;
  return items.find(it => {
    const codeIt = (it.codigo || it.code || "").toString().trim();
    const nameIt = (it.nombre || it.name || "").toString().trim();
    return codeIt === c || nameIt === c;
  }) || null;
}

async function showProduct(chatId, userId, code) {
  const s = getSess(chatId, userId);
  const { config, items } = await loadData();

  const item = findItemByCode(items, code);
  if (!item) {
    await bot.sendMessage(chatId, "No encontré ese producto. Volvé al catálogo.", buildMainMenu(config));
    return;
  }

  s.lastProductShown = (item.codigo || item.code || item.nombre || item.name || "").toString();

  const name = item.nombre || item.name || "Producto";
  const desc = item.descripcion || item.description || "";
  const unitType = normalizeUnit(item);
  const currency = config.currency || "$";
  const priceLine = unitType === "PESABLE"
    ? `💰 ${money(item.precio_por_kg || item.price_per_kg || item.precio, currency)} /kg`
    : `💰 ${money(item.precio || item.price, currency)} c/u`;

  const text = `🧾 *${name}*\n${priceLine}\n${desc ? `\n_${desc}_\n` : ""}\n¿Cómo querés comprarlo?`;

  const rows = [
    [{ text: "✅ Quiero este", callback_data: `buy:${encodeURIComponent(s.lastProductShown)}` }],
    [{ text: "📣 Compartir producto", callback_data: `sharep:${encodeURIComponent(s.lastProductShown)}` }],
    [{ text: "⬅️ Volver al catálogo", callback_data: "m:catalogo" }],
  ];

  // Foto si hay imagen
  const img = item.imagen || item.image || "";
  if (img) {
    try {
      await bot.sendPhoto(chatId, img, { caption: safeText(text), parse_mode: "Markdown", ...ik(rows) });
      return;
    } catch (e) {
      // si falla la imagen, sigue con texto
    }
  }

  await bot.sendMessage(chatId, safeText(text), { parse_mode: "Markdown", ...ik(rows) });
}

/** =========================
 *  Compra: cantidad (gramos / unidades)
 *  ========================= */
async function askQuantity(chatId, userId, code) {
  const s = getSess(chatId, userId);
  const { config, items } = await loadData();
  const item = findItemByCode(items, code);
  if (!item) {
    await bot.sendMessage(chatId, "No encontré el producto.", buildMainMenu(config));
    return;
  }

  const unitType = normalizeUnit(item);
  s.awaiting = { type: "QTY", payload: { code: (item.codigo || item.code || item.nombre || item.name || code).toString(), unitType } };

  if (unitType === "PESABLE") {
    const rows = [
      [
        { text: "100g", callback_data: "qtyg:100" },
        { text: "200g", callback_data: "qtyg:200" },
        { text: "250g", callback_data: "qtyg:250" },
      ],
      [
        { text: "500g", callback_data: "qtyg:500" },
        { text: "750g", callback_data: "qtyg:750" },
        { text: "1kg", callback_data: "qtyg:1000" },
      ],
      [{ text: "✍️ Otra cantidad (escribí gramos)", callback_data: "qtyg:custom" }],
      [{ text: "⬅️ Volver", callback_data: `p:${encodeURIComponent(code)}` }],
    ];
    await bot.sendMessage(chatId, "⚖️ ¿Cuántos *gramos* querés?", { parse_mode: "Markdown", ...ik(rows) });
  } else {
    const rows = [
      [
        { text: "1", callback_data: "qtyu:1" },
        { text: "2", callback_data: "qtyu:2" },
        { text: "3", callback_data: "qtyu:3" },
        { text: "4", callback_data: "qtyu:4" },
        { text: "5", callback_data: "qtyu:5" },
      ],
      [
        { text: "6", callback_data: "qtyu:6" },
        { text: "7", callback_data: "qtyu:7" },
        { text: "8", callback_data: "qtyu:8" },
        { text: "9", callback_data: "qtyu:9" },
        { text: "10", callback_data: "qtyu:10" },
      ],
      [{ text: "✍️ Otra cantidad (escribí número)", callback_data: "qtyu:custom" }],
      [{ text: "⬅️ Volver", callback_data: `p:${encodeURIComponent(code)}` }],
    ];
    await bot.sendMessage(chatId, "📦 ¿Cuántas *unidades* querés?", { parse_mode: "Markdown", ...ik(rows) });
  }
}

function addToCart(chatId, userId, code, qty) {
  const s = getSess(chatId, userId);
  s.cart.push({ code, qty });
  s.cartUpdatedAt = Date.now();
}

/** =========================
 *  Carrito + Checkout
 *  ========================= */
async function showCart(chatId, userId) {
  const s = getSess(chatId, userId);
  const { config, items } = await loadData();
  const currency = config.currency || "$";

  if (!s.cart.length) {
    await bot.sendMessage(chatId, "🧺 Tu carrito está vacío.", buildMainMenu(config));
    return;
  }

  let total = 0;
  const lines = s.cart.map((c, idx) => {
    const it = findItemByCode(items, c.code) || { nombre: c.code };
    const name = it.nombre || it.name || c.code;
    const unitType = normalizeUnit(it);
    const qtyLabel = unitType === "PESABLE" ? `${c.qty}g` : `${c.qty}u`;
    const sub = itemPrice(it, c.qty);
    total += sub;
    return `• *${name}* — ${qtyLabel} — ${money(sub, currency)}`;
  });

  const msg = `🧺 *Tu carrito*\n\n${lines.join("\n")}\n\n*Total:* ${money(total, currency)}`;

  const rows = [
    [
      { text: "✅ Finalizar compra", callback_data: "ck:start" },
      { text: "🛍️ Seguir comprando", callback_data: "m:catalogo" },
    ],
    [
      { text: "🗑️ Vaciar carrito", callback_data: "ck:clear" },
      { text: "⬅️ Menú", callback_data: "m:menu" },
    ],
  ];

  await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", ...ik(rows) });
}

async function startCheckout(chatId, userId) {
  const s = getSess(chatId, userId);
  const { config } = await loadData();

  if (!s.cart.length) {
    await bot.sendMessage(chatId, "Tu carrito está vacío.", buildMainMenu(config));
    return;
  }

  // Paso 1: envío o retiro
  const envioCosto = Number(config.shipping_cost || config.envio_costo || 0);
  const rows = [
    [{ text: `🚚 Envío express (${money(envioCosto, config.currency || "$")})`, callback_data: "ck:ship" }],
    [{ text: "🏪 Retiro en el local", callback_data: "ck:pickup" }],
    [{ text: "⬅️ Volver al carrito", callback_data: "m:carrito" }],
  ];
  await bot.sendMessage(chatId, "📦 ¿Cómo querés recibir tu pedido?", ik(rows));
}

async function askPayment(chatId, userId, mode) {
  const s = getSess(chatId, userId);
  const { config } = await loadData();

  s.orderDraft = s.orderDraft || {};
  s.orderDraft.delivery = mode; // ship|pickup
  s.orderUpdatedAt = Date.now();

  // Métodos simples (podés cargar en Config si ya lo tenés)
  const rows = [
    [{ text: "🏦 Transferencia", callback_data: "pay:transfer" }],
    [{ text: "💵 Efectivo", callback_data: "pay:cash" }],
    [{ text: "⬅️ Volver", callback_data: "ck:start" }],
  ];
  await bot.sendMessage(chatId, "💳 ¿Cómo vas a pagar?", ik(rows));
}

async function showFinalTicket(chatId, userId, payMethod) {
  const s = getSess(chatId, userId);
  const { config, items } = await loadData();
  const currency = config.currency || "$";

  s.orderDraft = s.orderDraft || {};
  s.orderDraft.payment = payMethod;
  s.orderUpdatedAt = Date.now();

  // Arma ticket
  let total = 0;
  const detail = s.cart.map(c => {
    const it = findItemByCode(items, c.code) || { nombre: c.code };
    const name = it.nombre || it.name || c.code;
    const unitType = normalizeUnit(it);
    const qtyLabel = unitType === "PESABLE" ? `${c.qty}g` : `${c.qty}u`;
    const sub = itemPrice(it, c.qty);
    total += sub;
    return { name, qtyLabel, sub };
  });

  const envioCosto = Number(config.shipping_cost || config.envio_costo || 0);
  const delivery = s.orderDraft.delivery || "pickup";
  const deliveryLine = delivery === "ship" ? `🚚 Envío express: ${money(envioCosto, currency)}` : `🏪 Retiro en local: ${money(0, currency)}`;
  const grand = total + (delivery === "ship" ? envioCosto : 0);

  const brand = config.brand_name || "Todo Queso";

  // Mensaje persuasivo (suave)
  const ahorro = config.savings_message || "Estás por aprovechar precios de almacén, sin pagar de más 🙂";
  const compare = config.compare_message || ""; // lo vas a cargar después desde Config

  const lines = detail.map(d => `• ${d.name} — ${d.qtyLabel} — ${money(d.sub, currency)}`).join("\n");
  const payLabel = payMethod === "transfer" ? "🏦 Transferencia" : "💵 Efectivo";

  const msg =
`🧾 *Resumen final — ${brand}*

${lines}

${deliveryLine}
${payLabel}

*Total:* ${money(grand, currency)}

_${ahorro}${compare ? `\n${compare}` : ""}_

¿Confirmás el pedido?`;

  // 3 botones: confirmar, cancelar, menú (como pediste)
  const rows = [
    [{ text: "✅ Confirmar pedido", callback_data: "ord:confirm" }],
    [{ text: "❌ Cancelar compra", callback_data: "ord:cancel" }],
    [{ text: "⬅️ Menú", callback_data: "m:menu" }],
  ];

  await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", ...ik(rows) });
}

async function cancelOrder(chatId, userId, final=false) {
  const s = getSess(chatId, userId);
  const { config } = await loadData();

  // Confirmar cancelación
  if (!final) {
    const msg = `¿Querés *confirmar la cancelación*?\n\n_Es una pena perder esta compra justo ahora 🙂_`;
    const rows = [
      [{ text: "✅ Confirmar cancelación", callback_data: "ord:cancel:yes" }],
      [{ text: "⬅️ Volver", callback_data: "m:carrito" }],
      [{ text: "⬅️ Menú", callback_data: "m:menu" }],
    ];
    await bot.sendMessage(chatId, msg, { parse_mode: "Markdown", ...ik(rows) });
    return;
  }

  s.cart = [];
  s.cartUpdatedAt = 0;
  s.orderDraft = null;
  s.orderUpdatedAt = 0;

  await bot.sendMessage(chatId, "Listo, cancelé la compra y vacié el carrito.", buildMainMenu(config));
}

function buildVendorWhatsAppLink(config, ticketText) {
  const phone = (config.contact_whatsapp || config.vendor_whatsapp || "").toString().replace(/[^\d]/g, "");
  if (!phone) return null;
  const msg = encodeURIComponent(ticketText);
  return `https://wa.me/${phone}?text=${msg}`;
}

async function sendOrderToVendor(chatId, userId) {
  const s = getSess(chatId, userId);
  const { config, items } = await loadData();
  const currency = config.currency || "$";

  // arma ticket plano para vendedor
  let total = 0;
  const detail = s.cart.map(c => {
    const it = findItemByCode(items, c.code) || { nombre: c.code };
    const name = it.nombre || it.name || c.code;
    const unitType = normalizeUnit(it);
    const qtyLabel = unitType === "PESABLE" ? `${c.qty}g` : `${c.qty}u`;
    const sub = itemPrice(it, c.qty);
    total += sub;
    return `- ${name} (${qtyLabel}) = ${money(sub, currency)}`;
  });

  const envioCosto = Number(config.shipping_cost || config.envio_costo || 0);
  const delivery = (s.orderDraft && s.orderDraft.delivery) || "pickup";
  const grand = total + (delivery === "ship" ? envioCosto : 0);

  const payMethod = (s.orderDraft && s.orderDraft.payment) || "transfer";
  const payLabel = payMethod === "transfer" ? "Transferencia" : "Efectivo";

  const brand = config.brand_name || "Todo Queso";

  const ticket =
`🧾 PEDIDO - ${brand}
Cliente: @${(await bot.getChatMember(chatId, userId)).user.username || "sin_username"}
ChatID: ${chatId}

Items:
${detail.join("\n")}

Entrega: ${delivery === "ship" ? "Envío express" : "Retiro en local"}
Pago: ${payLabel}
TOTAL: ${money(grand, currency)}

(Esperar confirmación de pago si es transferencia)`;

  // Si hay chat id de vendedor, lo manda por Telegram
  const vendorChatId = config.vendor_chat_id || config.telegram_vendor_chat_id;
  if (vendorChatId) {
    try {
      await bot.sendMessage(Number(vendorChatId), ticket);
    } catch (e) {
      // si falla, no corta
    }
  }

  // Al cliente: botón para WhatsApp directo al vendedor si hay número
  const wa = buildVendorWhatsAppLink(config, ticket);
  const rows = [];
  if (wa) rows.push([{ text: "📲 Enviar pedido por WhatsApp", url: wa }]);
  rows.push([{ text: "⬅️ Menú", callback_data: "m:menu" }]);

  await bot.sendMessage(chatId, "✅ Pedido confirmado. Ahora el vendedor lo va a preparar.\n\nSi pagás por transferencia, esperá la confirmación del vendedor.", ik(rows));

  // Limpia carrito (pedido ya emitido)
  s.cart = [];
  s.cartUpdatedAt = 0;
  s.orderDraft = null;
  s.orderUpdatedAt = 0;
}

/** =========================
 *  Sellos (visual + niveles)
 *  ========================= */
async function showSellos(chatId, userId) {
  const { config } = await loadData();
  const brand = config.brand_name || "Todo Queso";

  const card = config.card_url || config.sellos_card_url || config.sellos_foto || "";
  const step = Number(config.sellos_step_amount || 10000); // $10.000 = 1 sello
  const lvl10 = config.sellos_level_10 || "Beneficio por 10 sellos";
  const lvl30 = config.sellos_level_30 || "Beneficio por 30 sellos";
  const lvl50 = config.sellos_level_50 || "Beneficio por 50 sellos";

  const txt =
`⭐ *Sellos de ${brand}*

📌 *Cómo funciona:*
• Cada ${money(step, config.currency || "$")} de compra = *1 sello*
• Además: si compartís un producto/promo y tu referido compra → *ganás 1 sello* (sin importar el monto)

🎁 *Niveles:*
• 10 sellos: ${lvl10}
• 30 sellos: ${lvl30}
• 50 sellos: ${lvl50}

¿Querés que te muestre tus sellos actuales? (se activa cuando el flujo de compra ya registra pedidos).`;

  const rows = [
    [{ text: "🛍️ Ver catálogo", callback_data: "m:catalogo" }],
    [{ text: "⬅️ Menú", callback_data: "m:menu" }],
  ];

  if (card) {
    try {
      await bot.sendPhoto(chatId, card, { caption: safeText(txt), parse_mode: "Markdown", ...ik(rows) });
      return;
    } catch (e) {}
  }
  await bot.sendMessage(chatId, txt, { parse_mode: "Markdown", ...ik(rows) });
}

/** =========================
 *  Ayuda + Contacto vendedor
 *  ========================= */
async function showAyuda(chatId, userId) {
  const { config } = await loadData();
  const brand = config.brand_name || "Todo Queso";

  const help =
config.help_message ||
`❓ *Ayuda - ${brand}*

Decime qué necesitás y te lo resuelvo rápido:

• ¿No encontraste un producto en el catálogo?
• ¿Querés hacer una sugerencia o comentario?
• ¿Te falta agregar algo al pedido?

Si preferís, podés hablar directo con un vendedor.`;

  await bot.sendMessage(chatId, help, { parse_mode: "Markdown", ...buildHelpMenu(config) });
}

async function contactVendor(chatId, userId) {
  const { config } = await loadData();

  const phone = (config.contact_whatsapp || config.vendor_whatsapp || "").toString().replace(/[^\d]/g, "");
  const telegram = (config.contact_telegram || config.vendor_telegram || "").toString().trim();
  const email = (config.contact_email || "").toString().trim();

  const rows = [];
  if (phone) rows.push([{ text: "📲 WhatsApp vendedor", url: `https://wa.me/${phone}` }]);
  if (telegram) {
    const url = telegram.startsWith("http") ? telegram : `https://t.me/${telegram.replace("@","")}`;
    rows.push([{ text: "✈️ Telegram vendedor", url }]);
  }
  if (email) rows.push([{ text: "📧 Email", url: `mailto:${email}` }]);
  rows.push([{ text: "⬅️ Menú", callback_data: "m:menu" }]);

  await bot.sendMessage(chatId, "Elegí cómo querés contactar al vendedor:", ik(rows));
}

/** =========================
 *  Handlers
 *  ========================= */
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  try {
    const s = getSess(chatId, userId);
    s.category = null;
    s.catalogPage = 0;
    await showWelcome(chatId, userId);
  } catch (e) {
    await bot.sendMessage(chatId, `Error: ${e.message}`);
  }
});

bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const userId = q.from.id;
  const data = q.data || "";
  const s = getSess(chatId, userId);

  try {
    await bot.answerCallbackQuery(q.id).catch(()=>{});

    // Menú
    if (data === "m:menu") return showWelcome(chatId, userId);
    if (data === "m:catalogo") { s.category = null; s.catalogPage = 0; return showCategories(chatId, userId); }
    if (data === "m:cats") return showCategories(chatId, userId);
    if (data === "m:carrito") return showCart(chatId, userId);
    if (data === "m:sellos") return showSellos(chatId, userId);
    if (data === "m:ayuda") return showAyuda(chatId, userId);
    if (data === "m:contact") return contactVendor(chatId, userId);

    // Share (no lo toco: dejo el hook para tu lógica actual si ya lo tenías)
    if (data === "m:sharebot") {
      const { config } = await loadData();
      const shareMsg = config.share_message || "¿Querés un bot como este para tu negocio? Escribinos al email de Config.";
      await bot.sendMessage(chatId, shareMsg, buildMainMenu(config));
      return;
    }

    // Categoría
    if (data.startsWith("c:")) {
      const cat = decodeURIComponent(data.slice(2));
      s.category = cat;
      s.catalogPage = 0;
      return showCatalogPage(chatId, userId, 0);
    }

    // Paginación catálogo
    if (data.startsWith("cat:page:")) {
      const page = Number(data.split(":").pop());
      return showCatalogPage(chatId, userId, page);
    }

    // Producto
    if (data.startsWith("p:")) {
      const code = decodeURIComponent(data.slice(2));
      return showProduct(chatId, userId, code);
    }

    // Comprar -> pregunta cantidad
    if (data.startsWith("buy:")) {
      const code = decodeURIComponent(data.slice(4));
      return askQuantity(chatId, userId, code);
    }

    // Compartir producto (hook simple)
    if (data.startsWith("sharep:")) {
      const code = decodeURIComponent(data.slice(7));
      // Si ya tenías lógica real, acá la llamás.
      await bot.sendMessage(chatId, `📣 Compartí este producto: *${code}*\n\n(Se enviará por WhatsApp/Telegram como ya tenías).`, { parse_mode: "Markdown" });
      return;
    }

    // Cantidad pesable
    if (data.startsWith("qtyg:")) {
      const v = data.split(":")[1];
      if (v === "custom") {
        s.awaiting = { type: "QTY_CUSTOM_G", payload: s.awaiting?.payload || {} };
        return bot.sendMessage(chatId, "Escribí la cantidad en *gramos* (ej: 350):", { parse_mode: "Markdown" });
      }
      const grams = Number(v);
      const code = s.awaiting?.payload?.code;
      if (!code || !grams) return;
      addToCart(chatId, userId, code, grams);
      const { config } = await loadData();
      return bot.sendMessage(chatId, "✅ Agregado al carrito.", { ...ik([
        [{ text: "🧺 Ver carrito", callback_data: "m:carrito" }],
        [{ text: "🛍️ Seguir comprando", callback_data: "m:catalogo" }],
        [{ text: "⬅️ Menú", callback_data: "m:menu" }],
      ])});
    }

    // Cantidad unidades
    if (data.startsWith("qtyu:")) {
      const v = data.split(":")[1];
      if (v === "custom") {
        s.awaiting = { type: "QTY_CUSTOM_U", payload: s.awaiting?.payload || {} };
        return bot.sendMessage(chatId, "Escribí la cantidad en *unidades* (ej: 3):", { parse_mode: "Markdown" });
      }
      const units = Number(v);
      const code = s.awaiting?.payload?.code;
      if (!code || !units) return;
      addToCart(chatId, userId, code, units);
      const { config } = await loadData();
      return bot.sendMessage(chatId, "✅ Agregado al carrito.", { ...ik([
        [{ text: "🧺 Ver carrito", callback_data: "m:carrito" }],
        [{ text: "🛍️ Seguir comprando", callback_data: "m:catalogo" }],
        [{ text: "⬅️ Menú", callback_data: "m:menu" }],
      ])});
    }

    // Checkout
    if (data === "ck:clear") {
      s.cart = []; s.cartUpdatedAt = 0;
      const { config } = await loadData();
      return bot.sendMessage(chatId, "Listo, vacié el carrito.", buildMainMenu(config));
    }
    if (data === "ck:start") return startCheckout(chatId, userId);
    if (data === "ck:ship") return askPayment(chatId, userId, "ship");
    if (data === "ck:pickup") return askPayment(chatId, userId, "pickup");

    if (data.startsWith("pay:")) {
      const m = data.split(":")[1];
      return showFinalTicket(chatId, userId, m);
    }

    // Confirmar/cancelar pedido
    if (data === "ord:confirm") return sendOrderToVendor(chatId, userId);
    if (data === "ord:cancel") return cancelOrder(chatId, userId, false);
    if (data === "ord:cancel:yes") return cancelOrder(chatId, userId, true);

  } catch (e) {
    await bot.sendMessage(chatId, `Error: ${e.message}`);
  }
});

bot.on("message", async (msg) => {
  // Manejo de inputs custom de cantidad
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const s = getSess(chatId, userId);

  // Ignora comandos
  if ((msg.text || "").startsWith("/")) return;

  try {
    const text = (msg.text || "").trim();

    if (s.awaiting?.type === "QTY_CUSTOM_G") {
      const grams = Number(text.replace(/[^\d]/g, ""));
      const code = s.awaiting?.payload?.code;
      if (!grams || grams < 10) return bot.sendMessage(chatId, "Poné un número válido de gramos (ej: 350).");
      addToCart(chatId, userId, code, grams);
      s.awaiting = null;
      return bot.sendMessage(chatId, "✅ Agregado al carrito.", ik([
        [{ text: "🧺 Ver carrito", callback_data: "m:carrito" }],
        [{ text: "🛍️ Seguir comprando", callback_data: "m:catalogo" }],
        [{ text: "⬅️ Menú", callback_data: "m:menu" }],
      ]));
    }

    if (s.awaiting?.type === "QTY_CUSTOM_U") {
      const units = Number(text.replace(/[^\d]/g, ""));
      const code = s.awaiting?.payload?.code;
      if (!units || units < 1) return bot.sendMessage(chatId, "Poné un número válido de unidades (ej: 3).");
      addToCart(chatId, userId, code, units);
      s.awaiting = null;
      return bot.sendMessage(chatId, "✅ Agregado al carrito.", ik([
        [{ text: "🧺 Ver carrito", callback_data: "m:carrito" }],
        [{ text: "🛍️ Seguir comprando", callback_data: "m:catalogo" }],
        [{ text: "⬅️ Menú", callback_data: "m:menu" }],
      ]));
    }

    // Mensaje libre: lo tratamos como "ayuda conversacional"
    // Sin ensuciar: responde corto + opciones
    const { config } = await loadData();
    const reply =
`Entendido 😊
¿Querés que:
• Busque un producto por vos
• Tomemos una sugerencia/comentario
• O hablemos con un vendedor?`;

    return bot.sendMessage(chatId, reply, buildHelpMenu(config));

  } catch (e) {
    await bot.sendMessage(chatId, `Error: ${e.message}`);
  }
});

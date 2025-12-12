/**
 * EzerBot System - index.js (ESM)
 * Node 18+ (Render usa Node 22) -> fetch nativo OK
 * Requiere: npm i node-telegram-bot-api
 */

import TelegramBot from "node-telegram-bot-api";
import http from "http";

const BOT_TOKEN = process.env.BOT_TOKEN || "PEGAR_TOKEN_ACA";
const BACKEND_URL =
  process.env.BACKEND_URL ||
  "https://script.google.com/macros/s/AKfycbxznmXVhDFd45kwrtsO0lORoGDn7AcHVdQIYQkgYy_63jaJCrjumzphVK_N39T_zjK_/exec";

const PORT = Number(process.env.PORT || 10000);

// ============================
// Utils
// ============================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toNumber(v, fallback = 0) {
  const n = Number(String(v ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : fallback;
}

function asBool(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "sí" || s === "si" || s === "1" || s === "yes";
}

function money(n, moneda = "ARS") {
  const val = Math.round(Number(n) || 0);
  return `${val.toLocaleString("es-AR")} ${moneda}`;
}

function safeText(s) {
  // Evita problemas de parse entities. No usamos Markdown.
  return String(s ?? "").replace(/\u0000/g, "");
}

function chunk3(arr, page) {
  const start = page * 3;
  return arr.slice(start, start + 3);
}

function upperFirst(s) {
  s = String(s || "");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}


/***********************
 * 1) Pegar este bloque (helpers) cerca de tus helpers/funciones
 ***********************/

// Normaliza texto
function norm(s = "") {
  return String(s).toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Detecta categorías sugeridas por palabras clave (venta humana)
function inferSuggestionTargetsByKeywords(productName = "") {
  const n = norm(productName);

  // Importante: devolvemos "categorías objetivo" (NO productos)
  // para que el bot solo diga "si querés, mirá esta categoría".
  const rules = [
    { keys: ["prepizza", "pizza", "pizz"], cats: ["Quesos", "Fiambres", "Panificados", "Promos"] },
    { keys: ["fiambre", "jamon", "salame", "mortad", "bondiola", "lomito", "longan"], cats: ["Panificados", "Quesos", "Aderezos", "Promos"] },
    { keys: ["queso", "muzz", "cremoso", "provol", "sardo", "gruy"], cats: ["Panificados", "Dulces", "Fiambres", "Promos"] },
    { keys: ["leche", "yogur", "crema"], cats: ["Panificados", "Dulces", "Promos"] },
    { keys: ["dulce", "mermel", "membr"], cats: ["Panificados", "Quesos", "Promos"] },
    { keys: ["pan"], cats: ["Quesos", "Fiambres", "Dulces", "Promos"] },
  ];

  for (const r of rules) {
    if (r.keys.some(k => n.includes(k))) return r.cats;
  }
  // fallback general
  return ["Promos", "Panificados"];
}

// Devuelve categorías existentes en catálogo (para no sugerir categorías que no existen)
function getExistingCategories(productos = []) {
  const set = new Set();
  for (const p of (productos || [])) {
    const c = (p.categoria || p.category || "General");
    set.add(String(c));
  }
  return [...set];
}

// Filtra sugerencias a categorías reales
function getSuggestedCategories(productoElegido, productos) {
  const existing = new Set(getExistingCategories(productos).map(norm));
  const targets = inferSuggestionTargetsByKeywords(productoElegido?.nombre || productoElegido?.name || "");
  const out = [];
  for (const t of targets) {
    if (existing.has(norm(t))) out.push(t);
  }
  // Si ninguna coincide, sugerimos General/Promos si existen
  if (out.length === 0) {
    const ex = getExistingCategories(productos);
    if (ex.some(x => norm(x) === "promos")) out.push("Promos");
    else out.push(ex[0] || "General");
  }
  // Máximo 2-3 categorías para que quede vendedor, sin spamear
  return out.slice(0, 3);
}

/**
 * ✅ Sugerencia SOLO VENDEDORA: no agrega nada al carrito.
 * Te manda botones para ir a esas categorías.
 *
 * Requiere que tengas una función para mostrar categoría por callback:
 * - Si ya tenés callback "CAT|<cat>|<page>" o parecido, ajustá el callback_data acá.
 */
async function sendUpsellOnly(bot, chatId, productoElegido, productos, config) {
  try {
    const negocio = config?.NegocioNombre || config?.NegocioNombre?.value || "Tu tienda";
    const cats = getSuggestedCategories(productoElegido, productos);

    // Mensaje vendedor, humano y cercano
    const frases = [
      `💛 ¿Querés que te sugiera algo para acompañar?`,
      `🤝 Para que quede redondo, te recomiendo mirar esto:`,
      `✨ Si querés completar la compra, fijate estas opciones:`
    ];
    const intro = frases[Math.floor(Math.random() * frases.length)];

    const lines = cats.map(c => `• ${c}`);
    const text = `${intro}\n\n${lines.join("\n")}\n\n👉 Tocá una opción y te llevo directo.`;

    // Botones: llevan al catálogo por categoría (NO compra automática)
    // AJUSTÁ callback_data si tu handler usa otro formato
    const buttons = cats.map(c => ([{
      text: `🛒 Ver ${c}`,
      callback_data: `CAT|${c}|0`  // <-- si tu handler es distinto, cambiá esto
    }]));

    await bot.sendMessage(chatId, `🏪 ${negocio}\n\n${text}`, {
      reply_markup: { inline_keyboard: buttons }
    });

  } catch (e) {
    // Silencioso: si falla no rompe el flujo de compra
    console.log("sendUpsellOnly error:", e?.message || e);
  }
}

/***********************
 * 2) Reemplazar donde HOY sugerís y se agrega solo
 ***********************/

/*
BUSCÁ en tu index.js la parte que corre DESPUÉS de agregar al carrito.
Suele estar cerca de algo como:
- addToCart(...)
- "Se agregó al carrito"
- "¿Querés algo más?"
y probablemente tenés algo tipo:
  autoSuggestAndAdd(...)
  crossSellAdd(...)
  addSuggestedItemToCart(...)
o similar.

👉 ELIMINÁ la parte que agrega el sugerido al carrito.
👉 Y poné esto:
*/

// EJEMPLO DE REEMPLAZO (adaptalo a tu bloque real):
// Después de agregar el producto elegido al carrito, hacé:
/// await sendUpsellOnly(bot, chatId, productoElegido, productos, config);

// O si no tenés async en esa función, hacelo con .then:
/// sendUpsellOnly(bot, chatId, productoElegido, productos, config);


// ============================
// In-memory store (simple)
// ============================
const store = {
  cache: { ts: 0, productos: [], config: {} },
  carts: new Map(), // chatId -> [{codigo,nombre,precio,qty,unidad,subtotal}]
  browse: new Map(), // chatId -> {categoria, page}
  pendingQty: new Map(), // chatId -> {codigo, categoria}
  delivery: new Map(), // chatId -> {tipo:"envio"|"retiro"}
};

// ============================
// Backend load (Apps Script)
// ============================
async function loadBackend(force = false) {
  const now = Date.now();
  if (!force && store.cache.ts && now - store.cache.ts < 25_000) return store.cache;

  const url = `${BACKEND_URL}?accion=catalogo&t=${now}`;
  const res = await fetch(url, { method: "GET" });
  const data = await res.json().catch(() => ({}));

  // Esperamos algo tipo: { ok:true, productos:[...], config:{...} }
  const productos = Array.isArray(data.productos) ? data.productos : [];
  const config = data.config && typeof data.config === "object" ? data.config : {};

  store.cache = { ts: now, productos, config };

  return store.cache;
}

// ============================
// Config getters
// ============================
function getCfg(cfg, key, fallback = "") {
  const v = cfg?.[key];
  return v === undefined || v === null || v === "" ? fallback : v;
}

function getBrand(cfg) {
  const nombre = getCfg(cfg, "NegocioNombre", "Tu tienda");
  const desc = getCfg(cfg, "Descripcion", "Productos frescos, promos y beneficios exclusivos.");
  const moneda = getCfg(cfg, "Moneda", "ARS");
  const logo = getCfg(cfg, "LogoURL", "");
  return { nombre, desc, moneda, logo };
}

// ============================
// Category emojis (lindos y grandes)
// ============================
const CAT_EMOJI = [
  ["promos", "🔥"],
  ["combo", "🔥"],
  ["queso", "🧀"],
  ["fiambre", "🥓"],
  ["lacte", "🥛"],
  ["pan", "🥖"],
  ["bebida", "🥤"],
  ["dulce", "🍯"],
  ["pizza", "🍕"],
  ["empan", "🥟"],
  ["congel", "🧊"],
  ["snack", "🍪"],
  ["verd", "🥬"],
  ["fruta", "🍎"],
  ["general", "📦"],
];

function emojiForCategory(cat) {
  const c = normalize(cat);
  for (const [k, e] of CAT_EMOJI) if (c.includes(k)) return e;
  return "🛍️";
}

// ============================
// Suggestive selling (vendedora)
// ============================
function suggestionsFor(productos, chosen) {
  const name = normalize(chosen?.nombre);
  const cat = normalize(chosen?.categoria || "");

  const wants = [];

  // Heurísticas por palabra
  if (name.includes("prepizza") || name.includes("pizza")) wants.push("queso", "muzza", "jamon", "oregano");
  if (name.includes("fiambre") || name.includes("jamon") || name.includes("salame") || name.includes("lomito")) wants.push("pan", "mayonesa", "queso", "pepino");
  if (name.includes("leche")) wants.push("azucar", "mermelada", "pan", "cafe");
  if (name.includes("queso")) wants.push("dulce", "membrillo", "pan");
  if (name.includes("dulce") || name.includes("mermelada")) wants.push("pan", "queso", "gallet");
  if (name.includes("cafe")) wants.push("azucar", "leche", "medial");

  // Fallback por categoría
  if (wants.length === 0) {
    if (cat.includes("queso")) wants.push("dulce", "pan");
    else if (cat.includes("fiambre")) wants.push("pan", "queso");
    else if (cat.includes("lact")) wants.push("azucar", "pan");
    else wants.push("promo", "combo");
  }

  const picked = [];
  for (const w of wants) {
    const found = productos.find((p) => {
      const n = normalize(p.nombre);
      const c = normalize(p.categoria || "");
      return n.includes(w) || c.includes(w);
    });
    if (found && !picked.some((x) => x.codigo === found.codigo) && found.codigo !== chosen.codigo) {
      picked.push(found);
    }
    if (picked.length >= 3) break;
  }

  return picked;
}

// ============================
// Telegram Bot
// ============================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Evita conflicto webhook/polling (si quedó webhook activo)
(async () => {
  try {
    await bot.deleteWebHook();
  } catch (_) {}
})();

// ============================
// Menús
// ============================
function mainMenu(cfg) {
  return {
    reply_markup: {
      keyboard: [
        ["🛍️ Catálogo", "🛒 Mi carrito"],
        ["🏆 Mis sellos"],
        ["💬 Hablar con el vendedor"],
        ["🏬 Información del local"],
        ["📣 Compartir el bot"],
      ],
      resize_keyboard: true,
    },
  };
}

function cartActions() {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: "✅ Confirmar pedido", callback_data: "CART_CONFIRM" }], [{ text: "🗑️ Vaciar carrito", callback_data: "CART_CLEAR" }]],
    },
  };
}

// ============================
// Helpers: cart
// ============================
function getCart(chatId) {
  if (!store.carts.has(chatId)) store.carts.set(chatId, []);
  return store.carts.get(chatId);
}

function cartTotals(cart) {
  const subtotal = cart.reduce((a, i) => a + (Number(i.subtotal) || 0), 0);
  return { subtotal };
}

function addToCart(chatId, producto, qty) {
  const cart = getCart(chatId);
  const precio = toNumber(producto.precio, 0);
  const unidad = producto.unidad || "unidad";
  const subtotal = Math.round(precio * qty);

  // si ya existe, acumula
  const idx = cart.findIndex((x) => x.codigo === producto.codigo);
  if (idx >= 0) {
    cart[idx].qty += qty;
    cart[idx].subtotal = Math.round(cart[idx].qty * precio);
  } else {
    cart.push({
      codigo: producto.codigo,
      nombre: producto.nombre,
      precio,
      qty,
      unidad,
      categoria: producto.categoria || "General",
      subtotal,
    });
  }
}

// ============================
// Catalog flow
// ============================
async function showCategories(chatId) {
  const { productos, config } = await loadBackend();
  const { nombre } = getBrand(config);

  const cats = [...new Set(productos.map((p) => (p.categoria && String(p.categoria).trim()) || "General"))]
    .map((c) => c.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "es"));

  if (cats.length === 0) {
    await bot.sendMessage(chatId, "Todavía no hay productos cargados en el catálogo.");
    return;
  }

  const rows = cats.map((c) => [
    {
      text: `${emojiForCategory(c)}  ${upperFirst(c)}`,
      callback_data: `CAT|${c}`,
    },
  ]);

  await bot.sendMessage(chatId, safeText(`🛍️ ${nombre}\nElegí una categoría:`), {
    reply_markup: { inline_keyboard: rows },
  });
}

async function showCategoryPage(chatId, categoria, page = 0) {
  const { productos, config } = await loadBackend();
  const moneda = getBrand(config).moneda;

  const list = productos.filter((p) => ((p.categoria && String(p.categoria).trim()) || "General") === categoria);

  if (!list.length) {
    await bot.sendMessage(chatId, "No encontré productos en esa categoría todavía.");
    return;
  }

  const maxPage = Math.max(0, Math.ceil(list.length / 3) - 1);
  const safePage = Math.min(Math.max(page, 0), maxPage);

  store.browse.set(chatId, { categoria, page: safePage });

  const items = chunk3(list, safePage);

  // Enviamos 1 a 1 con foto si hay
  for (const p of items) {
    const precio = toNumber(p.precio, 0);
    const title = safeText(`${p.nombre}`);
    const desc = safeText(p.descripcion || "");
    const codigo = safeText(p.codigo || "");
    const priceLine = precio ? `Precio: ${money(precio, moneda)}\n` : "";

    const text = `${title}\n${priceLine}${codigo ? `Código: ${codigo}\n` : ""}${desc ? `\n${desc}` : ""}`;

    const kb = {
      inline_keyboard: [
        [{ text: "🛒 Agregar al carrito", callback_data: `ADD|${p.codigo}|${categoria}` }],
        [{ text: "📣 Compartir este producto", callback_data: `SHARE_PROD|${p.codigo}` }],
      ],
    };

    const img = (p.imagen || "").trim();
    if (img) {
      try {
        await bot.sendPhoto(chatId, img, { caption: text, reply_markup: kb });
      } catch {
        await bot.sendMessage(chatId, text, { reply_markup: kb });
      }
    } else {
      await bot.sendMessage(chatId, text, { reply_markup: kb });
    }

    await sleep(150);
  }

  // Navegación
  const nav = [];
  if (safePage > 0) nav.push({ text: "⬅️ Anterior", callback_data: "PAGE_PREV" });
  if (safePage < maxPage) nav.push({ text: "Siguiente ➡️", callback_data: "PAGE_NEXT" });

  const navRow = nav.length ? [nav] : [];
  const extra = [
    [
      { text: "🛒 Ver mi carrito", callback_data: "GO_CART" },
      { text: "🏠 Menú", callback_data: "GO_MENU" },
    ],
  ];

  await bot.sendMessage(
    chatId,
    `${emojiForCategory(categoria)} ${upperFirst(categoria)}\nMostrando ${safePage + 1}/${maxPage + 1}`,
    { reply_markup: { inline_keyboard: [...navRow, ...extra] } }
  );
}

// ============================
// Ticket (POS-like) + pago + envío
// ============================
function buildTicket(cfg, cart, deliveryType) {
  const { nombre, moneda } = getBrand(cfg);

  const alias = getCfg(cfg, "AliasPago", "jennyocampos.mp");
  const cbu = getCfg(cfg, "CBUPago", "0000003100014980639781");

  const usaEnvio = asBool(getCfg(cfg, "UsaEnvíoDomicilio", false));
  const costoEnvio = toNumber(getCfg(cfg, "CostoEnvíoBase", 0), 0);

  const lines = [];
  lines.push(`🧾 ${nombre}`);
  lines.push(`────────────────────`);

  for (const it of cart) {
    const unit = money(it.precio, moneda);
    const sub = money(it.subtotal, moneda);
    lines.push(`${it.qty} x ${it.nombre}`);
    lines.push(`   ${unit}  →  ${sub}`);
  }

  const { subtotal } = cartTotals(cart);
  lines.push(`────────────────────`);
  lines.push(`Subtotal: ${money(subtotal, moneda)}`);

  let envio = 0;
  if (deliveryType === "envio" && usaEnvio) {
    envio = costoEnvio;
    lines.push(`Envío: ${money(envio, moneda)}`);
  }

  const total = subtotal + envio;
  lines.push(`TOTAL: ${money(total, moneda)}`);
  lines.push(`────────────────────`);
  lines.push(`💳 Para pagar:`);
  lines.push(`Alias: ${alias}`);
  lines.push(`CBU: ${cbu}`);
  lines.push(``);
  lines.push(`📸 Enviame el comprobante por este chat para confirmar y preparar tu pedido.`);

  return lines.join("\n");
}

// ============================
// Handlers: commands / messages
// ============================
bot.onText(/\/start/i, async (msg) => {
  const chatId = msg.chat.id;
  const first = msg.from?.first_name || "¡Hola!";
  const { config } = await loadBackend(true);
  const { nombre, desc } = getBrand(config);

  await bot.sendMessage(
    chatId,
    safeText(`${nombre}\n${desc}\n\nHola ${first} 👋\nSoy el asistente de ${nombre}.\nElegí una opción del menú de abajo para empezar 👇`),
    mainMenu(config)
  );
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  // Si estaba esperando cantidad
  if (store.pendingQty.has(chatId) && text && /^\d+(\.\d+)?$/.test(text)) {
    const qty = toNumber(text, 1);
    const pending = store.pendingQty.get(chatId);
    store.pendingQty.delete(chatId);

    const { productos, config } = await loadBackend();
    const prod = productos.find((p) => String(p.codigo) === String(pending.codigo));
    if (!prod) {
      await bot.sendMessage(chatId, "No encontré ese producto. Probá de nuevo desde Catálogo.");
      return;
    }

    addToCart(chatId, prod, qty);

    await bot.sendMessage(chatId, `✅ Listo. Agregué *${qty}* de *${prod.nombre}* a tu carrito.`, {
      // sin parse_mode, texto seguro
    });

    // Sugerencias vendedoras
    const sug = suggestionsFor(productos, prod);
    if (sug.length) {
      const kb = {
        inline_keyboard: sug.map((p) => [
          { text: `➕ ${p.nombre}`, callback_data: `ADD_FAST|${p.codigo}|${(p.categoria || "General").trim()}` },
        ]),
      };
      await bot.sendMessage(chatId, `💡 Ya que estás… ¿te agrego algo para acompañar?`, { reply_markup: kb });
    } else {
      await bot.sendMessage(chatId, `🛍️ Si querés, seguí mirando el catálogo para sumar algo más.`);
    }

    return;
  }

  // Menú principal por texto
  if (text === "🛍️ Catálogo") return showCategories(chatId);
  if (text === "🛒 Mi carrito") return showCart(chatId);
  if (text === "🏬 Información del local") return showInfo(chatId);
  if (text === "📣 Compartir el bot") return shareBot(chatId);
  if (text === "💬 Hablar con el vendedor") return talkSeller(chatId);

  // Ignorar otros textos
});

// ============================
// Buttons / callbacks
// ============================
bot.on("callback_query", async (q) => {
  const chatId = q.message?.chat?.id;
  const data = q.data || "";

  try {
    await bot.answerCallbackQuery(q.id);
  } catch (_) {}

  if (!chatId) return;

  if (data === "GO_MENU") {
    const { config } = await loadBackend();
    await bot.sendMessage(chatId, "🏠 Menú principal", mainMenu(config));
    return;
  }

  if (data === "GO_CART") {
    await showCart(chatId);
    return;
  }

  if (data.startsWith("CAT|")) {
    const categoria = data.split("|")[1];
    await showCategoryPage(chatId, categoria, 0);
    return;
  }

  if (data === "PAGE_PREV" || data === "PAGE_NEXT") {
    const b = store.browse.get(chatId);
    if (!b) return showCategories(chatId);
    const nextPage = data === "PAGE_NEXT" ? b.page + 1 : b.page - 1;
    await showCategoryPage(chatId, b.categoria, nextPage);
    return;
  }

  if (data.startsWith("ADD|")) {
    const [, codigo, categoria] = data.split("|");
    const { productos } = await loadBackend();
    const prod = productos.find((p) => String(p.codigo) === String(codigo));
    if (!prod) {
      await bot.sendMessage(chatId, "No encontré el producto. Volvé al catálogo.");
      return;
    }

    // Pregunta cantidad según unidad
    store.pendingQty.set(chatId, { codigo, categoria });
    const unidad = normalize(prod.unidad || "unidad");
    const prompt = unidad.includes("kg") || unidad.includes("gr") ? "¿Cuántos gramos?" : "¿Cuántas unidades?";
    await bot.sendMessage(chatId, `🛒 ${prod.nombre}\n${prompt} (solo número)`);
    return;
  }

  if (data.startsWith("ADD_FAST|")) {
    const [, codigo] = data.split("|");
    const { productos } = await loadBackend();
    const prod = productos.find((p) => String(p.codigo) === String(codigo));
    if (!prod) return;

    addToCart(chatId, prod, 1);
    await bot.sendMessage(chatId, `✅ Agregué *1* de *${prod.nombre}* al carrito.`, {});
    return;
  }

  if (data.startsWith("SHARE_PROD|")) {
    const codigo = data.split("|")[1];
    const { productos, config } = await loadBackend();
    const p = productos.find((x) => String(x.codigo) === String(codigo));
    const botUser = (await bot.getMe()).username;
    const linkBot = `https://t.me/${botUser}`;
    if (!p) {
      await bot.sendMessage(chatId, `📣 Compartí el bot:\n${linkBot}`);
      return;
    }
    const { nombre } = getBrand(config);
    await bot.sendMessage(
      chatId,
      `📣 ${nombre}\nMirá este producto: ${p.nombre}\n\nEntrá al bot: ${linkBot}\n(pegalo en WhatsApp/Instagram/email para compartir)`,
      {}
    );
    return;
  }

  if (data === "CART_CLEAR") {
    store.carts.set(chatId, []);
    await bot.sendMessage(chatId, "🗑️ Listo, vacié tu carrito.");
    return;
  }

  if (data === "CART_CONFIRM") {
    const cart = getCart(chatId);
    if (!cart.length) {
      await bot.sendMessage(chatId, "Tu carrito está vacío.");
      return;
    }

    const { config } = await loadBackend();
    const usaEnvio = asBool(getCfg(config, "UsaEnvíoDomicilio", false));
    const usaRetiro = asBool(getCfg(config, "UsaRetiroLocal", false));

    // Si no está configurado, avisar claro
    if (!usaEnvio && !usaRetiro) {
      await bot.sendMessage(chatId, "Todavía no está configurado el tipo de entrega. Consultá con el vendedor.");
      return;
    }

    const kb = { inline_keyboard: [] };
    if (usaRetiro) kb.inline_keyboard.push([{ text: "🏬 Retiro en el local", callback_data: "DELIVERY|retiro" }]);
    if (usaEnvio) kb.inline_keyboard.push([{ text: "🚚 Envío a domicilio", callback_data: "DELIVERY|envio" }]);

    await bot.sendMessage(chatId, "📦 ¿Cómo querés recibir tu pedido?", { reply_markup: kb });
    return;
  }

  if (data.startsWith("DELIVERY|")) {
    const tipo = data.split("|")[1]; // envio / retiro
    store.delivery.set(chatId, { tipo });

    const { config } = await loadBackend();
    const cart = getCart(chatId);

    const ticket = buildTicket(config, cart, tipo);

    // Enviar ticket al cliente
    await bot.sendMessage(chatId, ticket);

    // Enviar ticket al vendedor (si está configurado)
    const chatVendedor = getCfg(config, "ChatIdVendedor", "");
    if (chatVendedor) {
      try {
        await bot.sendMessage(Number(chatVendedor), `🆕 Pedido nuevo\nCliente: ${chatId}\n\n${ticket}`);
      } catch (_) {}
    }

    await bot.sendMessage(chatId, "✅ Cuando me mandes el comprobante, lo revisamos y te confirmo la preparación.");
    return;
  }
});

// ============================
// Screens: info / share / cart / seller
// ============================
async function showInfo(chatId) {
  const { config } = await loadBackend();
  const { nombre } = getBrand(config);

  const direccion = getCfg(config, "Dirección", "Dirección no configurada");
  const horarios = getCfg(config, "Horarios", "");
  const tel = getCfg(config, "TeléfonoNegocio", "");
  const ig = getCfg(config, "Instagram", "");

  const parts = [];
  parts.push(`🏬 ${nombre}`);
  parts.push(`📍 Dirección: ${direccion}`);
  if (horarios) parts.push(`🕒 Horarios: ${horarios}`);
  if (tel) parts.push(`📞 Tel: ${tel}`);
  if (ig) parts.push(`📸 Instagram: ${ig}`);
  parts.push(`\nGracias por elegir productos frescos y de calidad 💛`);

  await bot.sendMessage(chatId, parts.join("\n"));
}

async function shareBot(chatId) {
  const { config } = await loadBackend();
  const active = asBool(getCfg(config, "CompartirBotActivo", true));
  if (!active) {
    await bot.sendMessage(chatId, "La opción de compartir está desactivada por el comercio.");
    return;
  }

  const botUser = (await bot.getMe()).username;
  const linkBot = `https://t.me/${botUser}`;
  const texto = getCfg(
    config,
    "TextoCompartirBot",
    "📣 Compartí este bot con tus contactos para que también aprovechen promos y sumen sellos."
  );

  await bot.sendMessage(
    chatId,
    `${texto}\n\n👉 Entrá al bot: ${linkBot}\n\nPodés copiar este mensaje y pegarlo en WhatsApp, Instagram, email o donde quieras.`,
    {}
  );
}

async function talkSeller(chatId) {
  const { config } = await loadBackend();
  const nombre = getCfg(config, "NegocioNombre", "Tu tienda");
  const msg = getCfg(
    config,
    "TextoAvisoVendedor",
    `Hola 👋 Soy ${nombre}.\nEscribí tu consulta por este chat y te respondo a la brevedad.`
  );

  await bot.sendMessage(chatId, msg);
}

async function showCart(chatId) {
  const { config } = await loadBackend();
  const { moneda } = getBrand(config);

  const cart = getCart(chatId);
  if (!cart.length) {
    await bot.sendMessage(chatId, "🧺 Tu carrito está vacío por ahora.");
    return;
  }

  const lines = [];
  lines.push(`🛒 Tu carrito:`);
  cart.forEach((it, idx) => {
    lines.push(`${idx + 1}) ${it.nombre} — ${it.qty} — ${money(it.subtotal, moneda)}`);
  });

  const { subtotal } = cartTotals(cart);
  lines.push(`\nSubtotal (sin envío): ${money(subtotal, moneda)}`);

  await bot.sendMessage(chatId, lines.join("\n"), cartActions());
}

// ============================
// Minimal HTTP server for Render health/ping
// ============================
const server = http.createServer(async (req, res) => {
  if (req.url?.startsWith("/ping")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, accion: "ping", mensaje: "EzerBot backend activo" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("EzerBot System OK");
});

// ✅ UN SOLO LISTEN (soluciona EADDRINUSE)
server.listen(PORT, "0.0.0.0", () => {
  console.log("Servidor activo en puerto", PORT);
});

// Warm cache
(async () => {
  try {
    const { productos } = await loadBackend(true);
    console.log("Catálogo cargado:", productos.length, "productos.");
  } catch (e) {
    console.log("No pude precargar catálogo:", e?.message || e);
  }
})();

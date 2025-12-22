// index.js (ESM) — EzerBot (Config+Catalogo desde Sheets) + Catálogo tipo "libro" + Carrito + Checkout
import TelegramBot from "node-telegram-bot-api";
import http from "http";

// =====================
// 1) ENV
// =====================
const BOT_TOKEN = process.env.BOT_TOKEN || "";
if (!BOT_TOKEN) {
  console.log("FALTA BOT_TOKEN en Render Environment");
}

const PORT = process.env.PORT || 10000;

// ⚠️ PEGÁ ACÁ tu /exec de Apps Script (NO el googleusercontent, el que termina en /exec)
const SHEETS_API_BASE =
  process.env.SHEETS_API_BASE ||
  "PEGAR_AQUI_TU_URL_DE_APPS_SCRIPT_EXEC"; // ej: https://script.google.com/macros/s/XXXX/exec

// Anti-409: si existe WEBHOOK_URL, usa webhook (RECOMENDADO EN RENDER).
// Si no existe, usa polling (pero SOLO si no hay otra instancia corriendo).
const WEBHOOK_URL = process.env.WEBHOOK_URL || ""; // ej: https://tuservicio.onrender.com/telegram

// Cache
const CACHE_TTL_MS = 30 * 1000;

// =====================
// 2) BOT
// =====================
const bot = new TelegramBot(BOT_TOKEN, WEBHOOK_URL ? { webHook: true } : { polling: true });

// Si webhook, setWebhook
async function setupWebhookIfNeeded() {
  if (!WEBHOOK_URL) return;
  try {
    await bot.setWebHook(WEBHOOK_URL);
    console.log("Webhook seteado:", WEBHOOK_URL);
  } catch (e) {
    console.log("Error setWebhook:", e?.message || e);
  }
}

// =====================
// 3) HTTP server (Render needs a port open)
// =====================
const server = http.createServer(async (req, res) => {
  try {
    if (WEBHOOK_URL && req.url?.startsWith("/telegram")) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const update = JSON.parse(body);
          bot.processUpdate(update);
        } catch (e) {}
        res.writeHead(200);
        res.end("ok");
      });
      return;
    }

    // health
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("EzerBot está corriendo ✅");
  } catch (e) {
    res.writeHead(500);
    res.end("error");
  }
});

server.listen(PORT, async () => {
  console.log("HTTP escuchando en puerto", PORT);
  await setupWebhookIfNeeded();
});

// =====================
// 4) Fetch helpers
// =====================
let cache = { config: null, catalog: null, ts: 0 };

async function fetchJSON(url) {
  const r = await fetch(url, { method: "GET" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

async function loadData(force = false) {
  const now = Date.now();
  if (!force && cache.ts && now - cache.ts < CACHE_TTL_MS && cache.config && cache.catalog) {
    return cache;
  }

  const configUrl = `${SHEETS_API_BASE}?type=config`;
  const catalogUrl = `${SHEETS_API_BASE}?type=catalog`;

  const [config, catalog] = await Promise.all([fetchJSON(configUrl), fetchJSON(catalogUrl)]);

  cache = { config, catalog, ts: now };
  return cache;
}

// =====================
// 5) Normalizadores de Config (porque tus keys son las de tu foto)
// =====================
function cfgGet(cfg, key, fallback = "") {
  // key exacto
  if (cfg && cfg[key] != null && cfg[key] !== "") return cfg[key];
  // algunas alternativas típicas
  const alt = {
    NegocioNombre: ["NEGOCIONOMBRE", "NombreNegocio", "NEGOCIO"],
    LogoURL: ["LOGOURL", "Logo", "LOGO"],
    Direccion: ["DIRECCION", "Dirección"],
    Horarios: ["HORARIOS", "Horario"],
    TelefonoNegocio: ["TELEFONONEGOCIO", "Telefono", "TEL"],
    Instagram: ["INSTAGRAM", "IG"],
    WhatsAppLink: ["WHATSAPPLINK", "WALINK"],
    Descripcion: ["DESCRIPCION", "Descripción"],
    CatalogoActivo: ["CATALOGOACTIVO", "CatalogoActivo"],
    UsaSellos: ["USASELLOS", "UsaSellos"],
    TarjetaURL: ["TARJETAURL", "TarjetaURL"],
    SelloURL: ["SELLOURl", "SELLOURL", "SelloURL"],
    MontoPorSello: ["MONTOPORSELLO", "MontoPorSello"],
    AliasTransferencia: ["ALIAS_TRANSFERENCIA", "Aliastranferencia", "ALIAS", "AliasTransferencia"],
    Moneda: ["MONEDA", "Moneda"],
  }[key];

  if (alt && cfg) {
    for (const k of alt) if (cfg[k] != null && cfg[k] !== "") return cfg[k];
  }
  return fallback;
}

function isCatalogActive(cfg) {
  const v = String(cfgGet(cfg, "CatalogoActivo", "SI")).trim().toUpperCase();
  return v === "SI" || v === "TRUE" || v === "1";
}

// =====================
// 6) Estado por usuario
// =====================
const S = new Map(); // chatId -> state

function getState(chatId) {
  if (!S.has(chatId)) {
    S.set(chatId, {
      cart: [], // {id,nombre,unidad,precio,precioPorKilo,cantidad,gramos,subtotal}
      view: { category: null, page: 0, perPage: 4 },
      step: null,
      pendingProductId: null,
      checkout: {
        delivery: null, // envio|retiro
        address: null,
        name: null,
        phone: null,
        payment: null, // efectivo|transferencia
      },
    });
  }
  return S.get(chatId);
}

// =====================
// 7) UI helpers
// =====================
function money(n, currency = "$") {
  const x = Number(n || 0);
  return `${currency}${x.toLocaleString("es-AR")}`;
}

function mainMenuKeyboard() {
  return {
    keyboard: [
      [{ text: "🛍️ Catálogo" }, { text: "🛒 Mi carrito" }],
      [{ text: "✅ Finalizar compra" }],
      [{ text: "🎟️ Tarjeta de sellos" }, { text: "📣 Compartir el bot" }],
    ],
    resize_keyboard: true,
  };
}

function shareButtons(botUsername, negocioNombre) {
  const tme = `https://t.me/${botUsername || "EzerBot"}`;
  const text = encodeURIComponent(`Pedí por el bot de ${negocioNombre}: ${tme}`);

  const wa = `https://wa.me/?text=${text}`;
  const mail = `mailto:?subject=${encodeURIComponent("Pedido por bot")}&body=${text}`;
  const tg = `https://t.me/share/url?url=${encodeURIComponent(tme)}&text=${encodeURIComponent(`Pedí por ${negocioNombre}`)}`;

  return {
    inline_keyboard: [
      [
        { text: "📲 WhatsApp", url: wa },
        { text: "✉️ Email", url: mail },
      ],
      [{ text: "📣 Telegram", url: tg }],
      [{ text: "🔗 Abrir bot", url: tme }],
    ],
  };
}

// =====================
// 8) Saludo inicial (TODO en el saludo, sin botón de horarios)
// =====================
async function sendWelcome(chatId) {
  const { config } = await loadData(false);

  const nombre = String(cfgGet(config, "NegocioNombre", "Todo Queso Club"));
  const direccion = String(cfgGet(config, "Direccion", "Dirección no configurada"));
  const horarios = String(cfgGet(config, "Horarios", "Horarios no configurados"));
  const tel = String(cfgGet(config, "TelefonoNegocio", "Teléfono no configurado"));
  const ig = String(cfgGet(config, "Instagram", "@todoqueso.club"));
  const desc = String(cfgGet(config, "Descripcion", "")).trim();
  const logo = String(cfgGet(config, "LogoURL", "")).trim();

  const txt =
`🧀 *${nombre}*
📍 ${direccion}
🕒 ${horarios}
📞 ${tel}
📸 Instagram: ${ig}
${desc ? `\n_${desc}_` : ""}

Elegí una opción del menú para empezar 👇`;

  if (logo) {
    // envío el logo y luego el texto
    try {
      await bot.sendPhoto(chatId, logo, {
        caption: txt,
        parse_mode: "Markdown",
        reply_markup: mainMenuKeyboard(),
      });
      return;
    } catch (e) {}
  }

  await bot.sendMessage(chatId, txt, {
    parse_mode: "Markdown",
    reply_markup: mainMenuKeyboard(),
  });
}

// =====================
// 9) Catálogo "tipo libro" (páginas con botones Prev/Next)
// =====================
function groupByCategory(catalog) {
  const map = new Map();
  for (const p of catalog || []) {
    const cat = (p.categoria || "Otros").toString().trim() || "Otros";
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat).push(p);
  }
  // orden básico
  for (const [k, arr] of map.entries()) {
    arr.sort((a, b) => (a.nombre || "").localeCompare(b.nombre || ""));
  }
  return map;
}

async function showCategories(chatId) {
  const { config, catalog } = await loadData(false);

  if (!isCatalogActive(config)) {
    await bot.sendMessage(chatId, "📦 El catálogo está desactivado en Config (CatalogoActivo != SI).", {
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  if (!Array.isArray(catalog) || catalog.length === 0) {
    await bot.sendMessage(
      chatId,
      "Por ahora no hay productos cargados en el catálogo. Revisá la hoja de Sheets o intentá de nuevo en unos minutos.",
      { reply_markup: mainMenuKeyboard() }
    );
    return;
  }

  const byCat = groupByCategory(catalog);
  const cats = Array.from(byCat.keys());

  const inline = cats.map((c) => [{ text: c, callback_data: `cat:${c}` }]);
  await bot.sendMessage(chatId, "🛍️ Elegí una categoría:", {
    reply_markup: { inline_keyboard: inline },
  });
}

async function showCatalogPage(chatId, category, page) {
  const { config, catalog } = await loadData(false);
  const currency = String(cfgGet(config, "Moneda", "$")) === "ARS" ? "$" : "$";

  const byCat = groupByCategory(catalog);
  const items = byCat.get(category) || [];
  if (items.length === 0) {
    await bot.sendMessage(chatId, "No hay productos en esa categoría.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  const st = getState(chatId);
  st.view.category = category;
  st.view.page = Math.max(0, page);

  const perPage = st.view.perPage;
  const totalPages = Math.ceil(items.length / perPage);
  const safePage = Math.min(st.view.page, totalPages - 1);

  const slice = items.slice(safePage * perPage, safePage * perPage + perPage);

  // “Libro”: mandamos 1 producto por mensaje con foto + botones
  await bot.sendMessage(chatId, `📚 *${category}* — Página ${safePage + 1}/${totalPages}`, { parse_mode: "Markdown" });

  for (const p of slice) {
    const unidad = (p.unidad || "").toLowerCase();
    const isKg = unidad === "kg";
    const precioBase = isKg ? (Number(p.precioPorKilo || p.precio || 0)) : Number(p.precio || 0);

    const caption =
`*${p.nombre}*
${p.descripcion ? `_${p.descripcion}_\n` : ""}💵 ${money(precioBase, currency)} ${isKg ? "x kg" : ""}`;

    const kb = {
      inline_keyboard: [
        [
          { text: "➕ Agregar", callback_data: `add:${p.id}` },
          { text: "🛒 Ver carrito", callback_data: "cart" },
        ],
      ],
    };

    if (p.imagenUrl) {
      try {
        await bot.sendPhoto(chatId, p.imagenUrl, { caption, parse_mode: "Markdown", reply_markup: kb });
      } catch (e) {
        await bot.sendMessage(chatId, caption, { parse_mode: "Markdown", reply_markup: kb });
      }
    } else {
      await bot.sendMessage(chatId, caption, { parse_mode: "Markdown", reply_markup: kb });
    }
  }

  const nav = [];
  if (safePage > 0) nav.push({ text: "⬅️ Anterior", callback_data: `page:${safePage - 1}` });
  if (safePage < totalPages - 1) nav.push({ text: "Siguiente ➡️", callback_data: `page:${safePage + 1}` });

  const footKb = {
    inline_keyboard: [
      nav.length ? nav : [{ text: "✅ OK", callback_data: "noop" }],
      [{ text: "🏷️ Cambiar categoría", callback_data: "cats" }],
      [{ text: "🏠 Menú", callback_data: "home" }],
    ],
  };

  await bot.sendMessage(chatId, "Navegá el catálogo 👇", { reply_markup: footKb });
}

// =====================
// 10) Carrito + gramos/unidad
// =====================
async function askQuantity(chatId, productId) {
  const { catalog } = await loadData(false);
  const p = (catalog || []).find(x => String(x.id) === String(productId) || String(x.codigo) === String(productId));
  if (!p) {
    await bot.sendMessage(chatId, "No encontré ese producto. Probá de nuevo.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  const st = getState(chatId);
  st.pendingProductId = p.id;

  const unidad = (p.unidad || "").toLowerCase();
  const isKg = unidad === "kg";

  st.step = isKg ? "ask_grams" : "ask_units";

  if (isKg) {
    await bot.sendMessage(
      chatId,
      `🧮 *${p.nombre}*\nDecime cuántos *gramos* querés (ej: 250, 500, 1000):`,
      { parse_mode: "Markdown" }
    );
  } else {
    await bot.sendMessage(
      chatId,
      `🧮 *${p.nombre}*\nDecime cuántas *unidades* querés (ej: 1, 2, 3):`,
      { parse_mode: "Markdown" }
    );
  }
}

function addToCart(chatId, product, qtyOrGrams) {
  const st = getState(chatId);
  const unidad = (product.unidad || "").toLowerCase();
  const isKg = unidad === "kg";

  const precioKg = Number(product.precioPorKilo || product.precio || 0);
  const precioUnidad = Number(product.precio || 0);

  let item;
  if (isKg) {
    const gramos = Math.max(1, Number(qtyOrGrams || 0));
    const subtotal = (gramos / 1000) * precioKg;

    item = {
      id: product.id,
      nombre: product.nombre,
      unidad: "kg",
      precio: precioKg,
      precioPorKilo: precioKg,
      gramos,
      cantidad: null,
      subtotal,
    };
  } else {
    const cantidad = Math.max(1, Number(qtyOrGrams || 0));
    const subtotal = cantidad * precioUnidad;

    item = {
      id: product.id,
      nombre: product.nombre,
      unidad: "unidad",
      precio: precioUnidad,
      precioPorKilo: 0,
      gramos: null,
      cantidad,
      subtotal,
    };
  }

  st.cart.push(item);
}

async function showCart(chatId) {
  const { config } = await loadData(false);
  const currency = String(cfgGet(config, "Moneda", "$")) === "ARS" ? "$" : "$";
  const st = getState(chatId);

  if (!st.cart.length) {
    await bot.sendMessage(chatId, "🛒 Tu carrito está vacío. Agregá algo del catálogo 🙂", {
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  let total = 0;
  let lines = st.cart.map((it, idx) => {
    total += Number(it.subtotal || 0);
    const qty = it.unidad === "kg" ? `${it.gramos}g` : `${it.cantidad}u`;
    return `• ${idx + 1}) ${it.nombre} — ${qty} — ${money(it.subtotal, currency)}`;
  });

  const txt = `🛒 *Tu carrito*\n\n${lines.join("\n")}\n\n*TOTAL:* ${money(total, currency)}`;

  await bot.sendMessage(chatId, txt, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🧹 Vaciar carrito", callback_data: "clear_cart" }],
        [{ text: "✅ Finalizar compra", callback_data: "checkout" }],
        [{ text: "🏠 Menú", callback_data: "home" }],
      ],
    },
  });
}

// =====================
// 11) Checkout (envío/retiro + pago efectivo/transferencia)
// =====================
async function startCheckout(chatId) {
  const st = getState(chatId);
  if (!st.cart.length) {
    await bot.sendMessage(chatId, "Tu carrito está vacío. Primero agregá productos 🙂", { reply_markup: mainMenuKeyboard() });
    return;
  }

  st.checkout = { delivery: null, address: null, name: null, phone: null, payment: null };
  st.step = "choose_delivery";

  await bot.sendMessage(chatId, "Elegí cómo querés recibir tu pedido 👇", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🚚 Envío a domicilio", callback_data: "del:envio" }],
        [{ text: "🏪 Retiro en el local", callback_data: "del:retiro" }],
        [{ text: "❌ Cancelar", callback_data: "home" }],
      ],
    },
  });
}

async function sendOrderSummary(chatId) {
  const { config } = await loadData(false);
  const st = getState(chatId);

  const currency = String(cfgGet(config, "Moneda", "$")) === "ARS" ? "$" : "$";
  const alias = String(cfgGet(config, "AliasTransferencia", process.env.ALIAS_TRANSFERENCIA || "jennyocampos.mp"));

  let total = 0;
  const lines = st.cart.map((it) => {
    total += Number(it.subtotal || 0);
    const qty = it.unidad === "kg" ? `${it.gramos}g` : `${it.cantidad}u`;
    return `• ${qty} x ${it.nombre} — ${money(it.subtotal, currency)}`;
  });

  const entrega = st.checkout.delivery === "envio" ? "Envío a domicilio 🚚" : "Retiro en el local 🏪";
  const pago = st.checkout.payment === "transferencia" ? "Transferencia 🏦" : "Efectivo 💵";

  let txt =
`🧾 *Ticket de compra*
——————————————
*Detalle:*
${lines.join("\n")}
——————————————
*TOTAL:* ${money(total, currency)}
——————————————
🚚 *Entrega:* ${entrega}
${st.checkout.delivery === "envio" ? `📍 *Dirección:* ${st.checkout.address || "-"}` : ""}
👤 *Nombre:* ${st.checkout.name || "-"}
📞 *Tel:* ${st.checkout.phone || "-"}
💳 *Pago:* ${pago}
`;

  if (st.checkout.payment === "transferencia") {
    txt += `\n🏦 *Alias:* \`${alias}\`\n📌 Cuando transfieras, mandá el comprobante por acá.`;
  } else {
    txt += `\n💵 Pagás en efectivo al retirar o al recibir.`;
  }

  await bot.sendMessage(chatId, txt, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
}

// =====================
// 12) Sellos (muestra imagen de tarjeta si está en Config)
// =====================
async function showStamps(chatId) {
  const { config } = await loadData(false);

  const usa = String(cfgGet(config, "UsaSellos", "SI")).trim().toUpperCase() === "SI";
  if (!usa) {
    await bot.sendMessage(chatId, "🎟️ Sellos desactivados en Config.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  const tarjetaUrl = String(cfgGet(config, "TarjetaURL", "")).trim();
  const premio = String(cfgGet(config, "BeneficiosPorNivel", "Premio configurable")).trim();

  // acá podrías leer sellos reales desde otra hoja, por ahora mostramos 0/10 si no hay sistema de clientes
  const sellos = 0;
  const meta = 10;

  const caption =
`🎟️ *Tarjeta de sellos*
Sellos: *${sellos} / ${meta}*
Premio al completar: ${premio}

Tip: cada compra confirmada suma 1 sello automático (configurable).`;

  if (tarjetaUrl) {
    try {
      await bot.sendPhoto(chatId, tarjetaUrl, { caption, parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
      return;
    } catch (e) {}
  }

  await bot.sendMessage(chatId, caption, { parse_mode: "Markdown", reply_markup: mainMenuKeyboard() });
}

// =====================
// 13) Handlers
// =====================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  // /start o saludo
  if (text === "/start" || /^hola|buenas|buen\s?día|buenos\s?días|buenas\s?tardes|buenas\s?noches/i.test(text)) {
    await sendWelcome(chatId);
    return;
  }

  // menú
  if (text === "🛍️ Catálogo") return await showCategories(chatId);
  if (text === "🛒 Mi carrito") return await showCart(chatId);
  if (text === "✅ Finalizar compra") return await startCheckout(chatId);
  if (text === "🎟️ Tarjeta de sellos") return await showStamps(chatId);
  if (text === "📣 Compartir el bot") {
    const { config } = await loadData(false);
    const negocio = String(cfgGet(config, "NegocioNombre", "Todo Queso Club"));
    // poné tu username real si querés
    const botUsername = process.env.BOT_USERNAME || "EzerBot";
    await bot.sendMessage(chatId, `📣 Compartí ${negocio}`, {
      reply_markup: shareButtons(botUsername, negocio),
    });
    return;
  }

  // pasos de cantidad (gramos/unidades) y checkout texto
  const st = getState(chatId);

  if (st.step === "ask_grams") {
    const grams = Number(text.replace(/[^\d]/g, ""));
    if (!grams || grams <= 0) {
      await bot.sendMessage(chatId, "Decime gramos válidos (ej: 250, 500, 1000).");
      return;
    }
    const { catalog } = await loadData(false);
    const p = (catalog || []).find(x => String(x.id) === String(st.pendingProductId));
    if (!p) return await bot.sendMessage(chatId, "No encontré el producto. Volvé al catálogo.");

    addToCart(chatId, p, grams);
    st.step = null;
    st.pendingProductId = null;

    await bot.sendMessage(chatId, "✅ Agregado al carrito.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (st.step === "ask_units") {
    const qty = Number(text.replace(/[^\d]/g, ""));
    if (!qty || qty <= 0) {
      await bot.sendMessage(chatId, "Decime una cantidad válida (ej: 1, 2, 3).");
      return;
    }
    const { catalog } = await loadData(false);
    const p = (catalog || []).find(x => String(x.id) === String(st.pendingProductId));
    if (!p) return await bot.sendMessage(chatId, "No encontré el producto. Volvé al catálogo.");

    addToCart(chatId, p, qty);
    st.step = null;
    st.pendingProductId = null;

    await bot.sendMessage(chatId, "✅ Agregado al carrito.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (st.step === "ask_address") {
    st.checkout.address = text;
    st.step = "ask_name";
    await bot.sendMessage(chatId, "🧾 Decime tu nombre para el pedido:");
    return;
  }

  if (st.step === "ask_name") {
    st.checkout.name = text;
    st.step = "ask_phone";
    await bot.sendMessage(chatId, "📞 Pasame tu teléfono (así coordinamos si hace falta):");
    return;
  }

  if (st.step === "ask_phone") {
    st.checkout.phone = text;
    st.step = "choose_payment";
    await bot.sendMessage(chatId, "Elegí método de pago 👇", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💵 Efectivo", callback_data: "pay:efectivo" }],
          [{ text: "🏦 Transferencia", callback_data: "pay:transferencia" }],
          [{ text: "❌ Cancelar", callback_data: "home" }],
        ],
      },
    });
    return;
  }
});

bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const data = q.data || "";
  const st = getState(chatId);

  try { await bot.answerCallbackQuery(q.id); } catch (e) {}

  if (data === "home") {
    await sendWelcome(chatId);
    return;
  }

  if (data === "cats") {
    await showCategories(chatId);
    return;
  }

  if (data === "cart") {
    await showCart(chatId);
    return;
  }

  if (data === "checkout") {
    await startCheckout(chatId);
    return;
  }

  if (data === "clear_cart") {
    st.cart = [];
    await bot.sendMessage(chatId, "🧹 Carrito vaciado.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  if (data.startsWith("cat:")) {
    const cat = data.slice(4);
    await showCatalogPage(chatId, cat, 0);
    return;
  }

  if (data.startsWith("page:")) {
    const page = Number(data.slice(5));
    await showCatalogPage(chatId, st.view.category, page);
    return;
  }

  if (data.startsWith("add:")) {
    const id = data.slice(4);
    await askQuantity(chatId, id);
    return;
  }

  if (data.startsWith("del:")) {
    const v = data.slice(4); // envio | retiro
    st.checkout.delivery = v;
    if (v === "envio") {
      st.step = "ask_address";
      await bot.sendMessage(chatId, "📍 Pasame tu dirección completa (calle + número + entre calles / referencia):");
    } else {
      st.step = "ask_name";
      await bot.sendMessage(chatId, "🧾 Decime tu nombre para el pedido:");
    }
    return;
  }

  if (data.startsWith("pay:")) {
    const v = data.slice(4); // efectivo | transferencia
    st.checkout.payment = v;
    st.step = null;
    await sendOrderSummary(chatId);
    return;
  }
});

console.log("EzerBot iniciado ✅ (Config+Catalogo desde Sheets)");

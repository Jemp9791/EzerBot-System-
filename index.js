// =======================
// EzerBot System - index.js (CommonJS)
// =======================

const TelegramBot = require("node-telegram-bot-api");
const http = require("http");
const fs = require("fs");
const path = require("path");

// ---------- ENV ----------
const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const CONFIG_URL = (process.env.CONFIG_URL || "").trim(); // JSON generado desde Sheets
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim(); // URL de Render
const ADMIN_CHAT_ID = (process.env.ADMIN_CHAT_ID || "").trim();
const PORT = Number(process.env.PORT || 10000);

if (!BOT_TOKEN) {
  console.error("Falta BOT_TOKEN");
  process.exit(1);
}
if (!CONFIG_URL) {
  console.error("Falta CONFIG_URL");
  process.exit(1);
}

// ---------- PERSISTENCIA SIMPLE (archivo local) ----------
const DATA_PATH = path.join(__dirname, "data.json");

function loadData() {
  try {
    if (!fs.existsSync(DATA_PATH)) return { users: {} };
    const raw = fs.readFileSync(DATA_PATH, "utf8");
    const json = JSON.parse(raw);
    if (!json.users) json.users = {};
    return json;
  } catch (e) {
    console.error("Error leyendo data.json:", e);
    return { users: {} };
  }
}

function saveData(data) {
  try {
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error("Error guardando data.json:", e);
  }
}

const DB = loadData();

function getUser(userId) {
  const key = String(userId);
  if (!DB.users[key]) {
    DB.users[key] = {
      cart: [], // [{codigo, qty, unitType:'u'|'g'}]
      profile: { nombre: "", telefono: "" },
      checkout: {
        paso: "",
        envioTipo: "",
        direccion: "",
        horario: "",
        pago: "",
        pagoId: ""
      },
      pendingQty: null
    };
    saveData(DB);
  }
  return DB.users[key];
}

function money(n) {
  const num = Number(n || 0);
  return num.toLocaleString("es-AR", { maximumFractionDigits: 0 });
}

function safeText(s, max) {
  max = max || 4000;
  const t = String(s || "");
  return t.length > max ? t.slice(0, max - 3) + "..." : t;
}

// ---------- CONFIG CACHE ----------
let CONFIG_CACHE = null;
let CONFIG_CACHE_AT = 0;
const CONFIG_TTL_MS = 30000;

async function fetchConfig() {
  const now = Date.now();
  if (CONFIG_CACHE && now - CONFIG_CACHE_AT < CONFIG_TTL_MS) return CONFIG_CACHE;

  const res = await fetch(CONFIG_URL);
  if (!res.ok) throw new Error("No pude leer config.json: HTTP " + res.status);
  const cfg = await res.json();

  // Normalizar usando tu hoja Config
  if (!cfg.negocio) cfg.negocio = {};
  if (cfg.NegocioNombre && !cfg.negocio.nombre)
    cfg.negocio.nombre = cfg.NegocioNombre;
  if (cfg.Dirección && !cfg.negocio.direccion)
    cfg.negocio.direccion = cfg.Dirección;
  if (cfg.Horarios && !cfg.negocio.horarios)
    cfg.negocio.horarios = cfg.Horarios;
  if (cfg.TeléfonoNegocio && !cfg.negocio.telefono)
    cfg.negocio.telefono = cfg.TeléfonoNegocio;
  if (cfg.Instagram && !cfg.negocio.instagram)
    cfg.negocio.instagram = cfg.Instagram;
  if (cfg.LogoURL && !cfg.negocio.logoUrl)
    cfg.negocio.logoUrl = cfg.LogoURL;

  if (!Array.isArray(cfg.catalogo)) cfg.catalogo = cfg.catalogo || [];
  if (!Array.isArray(cfg.promos)) cfg.promos = cfg.promos || [];

  if (!cfg.textos) cfg.textos = {};

  if (!cfg.textos.bienvenida) {
    const desc =
      cfg.Descripcion ||
      "Aquí encontrás los mejores precios, picadas ricas y beneficios por ser parte del club.";
    const nom = cfg.negocio.nombre || "nuestro local";
    cfg.textos.bienvenida =
      "👋 ¡Hola!\n" +
      "Soy el bot de *" + nom + "*.\n\n" +
      desc + "\n\n" +
      "✅ Podés ver el catálogo por categorías, armar tu carrito y finalizar tu pedido.\n" +
      "👇 Elegí una opción del menú para empezar:";
  }

  if (!cfg.textos.pedidoConfirmado && cfg.TextoConfirmacionPedido)
    cfg.textos.pedidoConfirmado = cfg.TextoConfirmacionPedido;

  // Envios
  if (!cfg.envios) cfg.envios = {};
  const usaEnvio =
    cfg.UsaEnvíoDomicilio === "SI" || cfg.UsaEnvioDomicilio === "SI";
  if (usaEnvio) cfg.envios.activo = true;
  if (!cfg.envios.costo && cfg.CostoEnvíoBase)
    cfg.envios.costo = Number(cfg.CostoEnvíoBase || 0);
  if (!cfg.envios.texto && cfg.TextoEnvíoDomicilio)
    cfg.envios.texto = cfg.TextoEnvíoDomicilio;

  // Pagos
  if (!cfg.pagos) cfg.pagos = {};
  if (!Array.isArray(cfg.pagos.metodos) || cfg.pagos.metodos.length === 0) {
    cfg.pagos.metodos = [{ id: "efectivo", label: "Efectivo" }];
    const permiteOnline = cfg.PermitirPagoOnline === "SI";
    const tipo = String(cfg.TipoPagoOnline || "").toUpperCase();
    if (permiteOnline && tipo.indexOf("TRANSFER") !== -1) {
      cfg.pagos.metodos.push({
        id: "transferencia",
        label: "Transferencia",
        alias: cfg.AliasPago || "",
        cbu: cfg.CBUPago || ""
      });
    }
  } else {
    cfg.pagos.metodos = cfg.pagos.metodos.map(function (m) {
      return {
        ...m,
        id:
          m.id ||
          String(m.label || m.nombre || "")
            .toLowerCase()
            .replace(/\s+/g, "_")
      };
    });
  }

  CONFIG_CACHE = cfg;
  CONFIG_CACHE_AT = now;
  return cfg;
}

// ---------- CATALOGO HELPERS ----------
function getCatalogByCategory(config) {
  const map = {};
  (config.catalogo || []).forEach(function (p) {
    const cat = (p.categoria || "Otros").trim() || "Otros";
    if (!map[cat]) map[cat] = [];
    map[cat].push(p);
  });
  Object.keys(map).forEach(function (cat) {
    map[cat].sort(function (a, b) {
      return String(a.nombre).localeCompare(String(b.nombre), "es");
    });
  });
  return map;
}

function findProduct(config, codigo) {
  return (config.catalogo || []).find(function (p) {
    return String(p.codigo) === String(codigo);
  });
}

function addToCartUnits(user, codigo, units) {
  const q = Math.max(1, Number(units || 1));
  const existing = user.cart.find(function (x) {
    return x.codigo === codigo && x.unitType === "u";
  });
  if (existing) existing.qty += q;
  else user.cart.push({ codigo: codigo, qty: q, unitType: "u" });
}

function addToCartGrams(user, codigo, grams) {
  const g = Math.max(1, Number(grams || 1));
  const existing = user.cart.find(function (x) {
    return x.codigo === codigo && x.unitType === "g";
  });
  if (existing) existing.qty += g;
  else user.cart.push({ codigo: codigo, qty: g, unitType: "g" });
}

function removeFromCart(user, codigo) {
  user.cart = user.cart.filter(function (x) {
    return x.codigo !== codigo;
  });
}

function clearCart(user) {
  user.cart = [];
}

function calcCartTotals(config, user) {
  let subtotal = 0;
  const lines = [];
  user.cart.forEach(function (it) {
    const p = findProduct(config, it.codigo);
    if (!p) return;
    const precio = Number(p.precio || p.precioPorKg || 0);
    let line = 0;
    let labelQty = "";
    if (it.unitType === "g") {
      const kg = it.qty / 1000;
      line = precio * kg;
      labelQty = it.qty + "g ×";
    } else {
      line = precio * it.qty;
      labelQty = it.qty + " ×";
    }
    subtotal += line;
    lines.push({
      p: p,
      qty: it.qty,
      unitType: it.unitType,
      line: line,
      labelQty: labelQty
    });
  });
  return { subtotal: subtotal, lines: lines };
}

function calcShipping(config, subtotal, checkout) {
  const env = config.envios || {};
  const activo =
    env.activo ||
    config.UsaEnvíoDomicilio === "SI" ||
    config.UsaEnvioDomicilio === "SI";
  if (!activo) return { costo: 0, label: "Retiro en el local" };
  if (checkout.envioTipo === "retiro")
    return { costo: 0, label: "Retiro en el local" };
  const base =
    Number(env.costo || 0) || Number(config.CostoEnvíoBase || 0) || 0;
  return { costo: base, label: "Envío a domicilio" };
}

// ---------- BOT ----------
const bot = new TelegramBot(BOT_TOKEN, { polling: !PUBLIC_URL });
let BOT_USERNAME = "";

// ---------- TECLADOS ----------
function mainMenuKeyboard(config) {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🛍️ Catálogo" }, { text: "🔥 Promos" }],
        [{ text: "🛒 Mi carrito" }, { text: "✅ Finalizar compra" }],
        [{ text: "📍 Horarios y dirección" }, { text: "📣 Compartir bot" }]
      ],
      resize_keyboard: true
    }
  };
}

function inlineCategoriesKeyboard(categories) {
  const rows = categories.map(function (cat) {
    return [{ text: cat, callback_data: "cat:" + cat }];
  });
  rows.push([{ text: "⬅️ Menú", callback_data: "menu:main" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function productCardKeyboard(cat, index, total) {
  const rows = [];
  rows.push([
    { text: "🟢 Quiero éste", callback_data: "padd:" + cat + ":" + index },
    { text: "📣 Compartir", callback_data: "pshare:" + cat + ":" + index }
  ]);

  rows.push([
    {
      text: "⬅️ Anterior",
      callback_data: "pnav:" + cat + ":" + Math.max(index - 1, 0)
    },
    {
      text: "📄 " + (index + 1) + "/" + total,
      callback_data: "noop"
    },
    {
      text: "➡️ Siguiente",
      callback_data:
        "pnav:" + cat + ":" + Math.min(index + 1, Math.max(total - 1, 0))
    }
  ]);

  rows.push([{ text: "🛍️ Categorías", callback_data: "cats:list" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function inlineCartKeyboard(user) {
  const rows = [];
  if (user.cart.length) {
    rows.push([{ text: "🧹 Vaciar carrito", callback_data: "cart:clear" }]);
    rows.push([
      { text: "✅ Finalizar compra", callback_data: "checkout:start" }
    ]);
  }
  rows.push([{ text: "⬅️ Menú", callback_data: "menu:main" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function inlineCheckoutDeliveryKeyboard(config) {
  const env = config.envios || {};
  const rows = [];
  rows.push([
    { text: "🏬 Retiro en el local", callback_data: "ship:retiro" }
  ]);
  const envioActivo =
    env.activo ||
    config.UsaEnvíoDomicilio === "SI" ||
    config.UsaEnvioDomicilio === "SI";
  if (envioActivo) {
    const base =
      Number(env.costo || 0) || Number(config.CostoEnvíoBase || 0) || 0;
    const label =
      base > 0
        ? "🚚 Envío a domicilio (+$" + money(base) + ")"
        : "🚚 Envío a domicilio";
    rows.push([{ text: label, callback_data: "ship:envio" }]);
  }
  rows.push([{ text: "❌ Cancelar", callback_data: "checkout:cancel" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function inlinePaymentKeyboard(config) {
  const methods = Array.isArray(config.pagos && config.pagos.metodos)
    ? config.pagos.metodos
    : [];
  const rows = methods.map(function (m) {
    return [
      {
        text: m.label || m.nombre || "Pago",
        callback_data: "pay:" + (m.id || m.label)
      }
    ];
  });
  rows.push([{ text: "❌ Cancelar", callback_data: "checkout:cancel" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

// ---------- MENSAJES ----------
async function sendWelcome(chatId, config) {
  const negocio = config.negocio || {};
  const bienvenida = config.textos && config.textos.bienvenida;
  const opts = { parse_mode: "Markdown", ...mainMenuKeyboard(config) };

  if (negocio.logoUrl) {
    await bot.sendPhoto(chatId, negocio.logoUrl, {
      caption: bienvenida,
      parse_mode: "Markdown",
      ...mainMenuKeyboard(config)
    });
  } else {
    await bot.sendMessage(chatId, bienvenida, opts);
  }
}

async function showBusinessInfo(chatId, config) {
  const n = config.negocio || {};
  const lines = [];
  lines.push("🏪 *" + (n.nombre || "Negocio") + "*");
  if (n.direccion) lines.push("📍 " + n.direccion);
  if (n.horarios) lines.push("🕒 " + n.horarios);
  if (n.telefono) lines.push("📞 " + n.telefono);
  if (n.instagram) lines.push("📸 " + n.instagram);

  await bot.sendMessage(chatId, lines.join("\n"), {
    parse_mode: "Markdown",
    ...mainMenuKeyboard(config)
  });
}

async function showCategories(chatId, config) {
  const map = getCatalogByCategory(config);
  const cats = Object.keys(map);
  if (!cats.length) {
    await bot.sendMessage(
      chatId,
      "⏳ Todavía no hay productos cargados en el catálogo.",
      mainMenuKeyboard(config)
    );
    return;
  }
  await bot.sendMessage(
    chatId,
    "🛍️ Elegí una categoría:",
    inlineCategoriesKeyboard(cats)
  );
}

async function showProductCard(chatId, config, cat, index) {
  const map = getCatalogByCategory(config);
  const items = map[cat] || [];
  if (!items.length) {
    await bot.sendMessage(
      chatId,
      "No hay productos en *" + cat + "* por ahora.",
      { parse_mode: "Markdown" }
    );
    return;
  }
  let i = Number(index || 0);
  if (i < 0) i = 0;
  if (i >= items.length) i = items.length - 1;
  const p = items[i];

  const unidad = String(p.unidad || "").toLowerCase();
  let precioLine = "$" + money(p.precio);
  if (unidad === "kg") precioLine = "$" + money(p.precio) + " / kg";
  else if (unidad) precioLine = "$" + money(p.precio) + " " + unidad;

  const caption =
    "*" +
    p.nombre +
    "*\n" +
    "💰 " +
    precioLine +
    "\n" +
    (p.descripcion ? "📝 " + p.descripcion : "");

  if (p.imagen) {
    await bot.sendPhoto(chatId, p.imagen, {
      caption: caption,
      parse_mode: "Markdown",
      ...productCardKeyboard(cat, i, items.length)
    });
  } else {
    await bot.sendMessage(chatId, caption, {
      parse_mode: "Markdown",
      ...productCardKeyboard(cat, i, items.length)
    });
  }
}

async function showPromos(chatId, config) {
  const promosArray = Array.isArray(config.promos) ? config.promos : [];
  const promoItems = [];

  if (promosArray.length) {
    promosArray.forEach(function (pr) {
      const code = pr.codigo || pr;
      const p = findProduct(config, code);
      if (p) promoItems.push(p);
    });
  } else {
    const map = getCatalogByCategory(config);
    (map["Promos"] || map["PROMOS"] || []).forEach(function (p) {
      promoItems.push(p);
    });
  }

  if (!promoItems.length) {
    await bot.sendMessage(
      chatId,
      "🔥 Todavía no hay promos cargadas. ¿Querés que te muestre el catálogo?",
      mainMenuKeyboard(config)
    );
    return;
  }

  const tmpConfig = {
    ...config,
    catalogo: promoItems.map(function (p) {
      return { ...p, categoria: "Promos" };
    })
  };
  await showProductCard(chatId, tmpConfig, "Promos", 0);
}

async function showCart(chatId, config, user) {
  const result = calcCartTotals(config, user);
  const subtotal = result.subtotal;
  const lines = result.lines;
  if (!lines.length) {
    await bot.sendMessage(
      chatId,
      "🛒 Tu carrito está vacío. ¿Querés que te muestre el catálogo?",
      mainMenuKeyboard(config)
    );
    return;
  }

  const msgLines = [];
  msgLines.push("🛒 *Tu carrito*");
  msgLines.push("");
  lines.forEach(function (it) {
    msgLines.push(
      "• " +
        it.labelQty +
        " " +
        it.p.nombre +
        " — $" +
        money(it.line)
    );
  });
  msgLines.push("");
  msgLines.push("Subtotal: *$" + money(subtotal) + "*");

  await bot.sendMessage(chatId, msgLines.join("\n"), {
    parse_mode: "Markdown",
    ...inlineCartKeyboard(user)
  });
}

// ---------- CHECKOUT ----------
async function startCheckout(chatId, config, user) {
  const result = calcCartTotals(config, user);
  if (!result.lines.length) {
    await bot.sendMessage(
      chatId,
      "Tu carrito está vacío. Primero agregá algo del catálogo 🙂",
      mainMenuKeyboard(config)
    );
    return;
  }

  user.checkout = {
    paso: "envio_tipo",
    envioTipo: "",
    direccion: "",
    horario: "",
    pago: "",
    pagoId: ""
  };
  saveData(DB);

  await bot.sendMessage(
    chatId,
    "✅ *Finalizar compra*\nElegí cómo querés recibir tu pedido:",
    {
      parse_mode: "Markdown",
      ...inlineCheckoutDeliveryKeyboard(config)
    }
  );
}

async function askName(chatId) {
  await bot.sendMessage(chatId, "🧾 Decime tu *nombre* para el pedido.", {
    parse_mode: "Markdown"
  });
}

async function askPhone(chatId) {
  await bot.sendMessage(
    chatId,
    "📞 Pasame tu *teléfono* (así coordinamos si hace falta).",
    { parse_mode: "Markdown" }
  );
}

async function askAddress(chatId) {
  await bot.sendMessage(
    chatId,
    "📍 Pasame tu *dirección completa* (calle + número + referencia).",
    { parse_mode: "Markdown" }
  );
}

async function askHorario(chatId) {
  await bot.sendMessage(
    chatId,
    "⏰ ¿En qué horario te queda mejor pasar o recibir el pedido?",
    { parse_mode: "Markdown" }
  );
}

async function askPayment(chatId, config) {
  const methods = Array.isArray(config.pagos && config.pagos.metodos)
    ? config.pagos.metodos
    : [];
  if (!methods.length) {
    await bot.sendMessage(
      chatId,
      "💳 No hay métodos de pago configurados todavía.",
      mainMenuKeyboard(config)
    );
    return;
  }
  await bot.sendMessage(chatId, "💳 Elegí método de pago:", {
    ...inlinePaymentKeyboard(config)
  });
}

function buildOrderSummary(config, user, chatId, username) {
  const negocio = config.negocio || {};
  const result = calcCartTotals(config, user);
  const subtotal = result.subtotal;
  const lines = result.lines;
  const ship = calcShipping(config, subtotal, user.checkout);
  const total = subtotal + Number(ship.costo || 0);

  const profileName = user.profile.nombre || "";
  const profilePhone = user.profile.telefono || "";

  const txt = [];
  txt.push("🧾 *Pedido — " + (negocio.nombre || "Negocio") + "*");
  txt.push(
    "👤 Cliente: " +
      (profileName || (username ? "@" + username : ""))
  );
  if (profilePhone) txt.push("📞 Tel: " + profilePhone);
  txt.push("");
  txt.push("*Detalle:*");
  lines.forEach(function (it) {
    txt.push(
      "• " +
        it.labelQty +
        " " +
        it.p.nombre +
        " — $" +
        money(it.line)
    );
  });
  txt.push("");
  txt.push("Subtotal: *$" + money(subtotal) + "*");
  txt.push(ship.label + ": *$" + money(ship.costo) + "*");
  txt.push("TOTAL: *$" + money(total) + "*");
  txt.push("");

  if (user.checkout.envioTipo === "envio") {
    txt.push("🏠 Entrega: Envío a domicilio");
    if (user.checkout.direccion)
      txt.push("📍 Dirección: " + user.checkout.direccion);
  } else {
    txt.push("🏬 Entrega: Retiro en el local");
  }
  if (user.checkout.horario)
    txt.push("⏰ Horario preferido: " + user.checkout.horario);

  if (user.checkout.pago)
    txt.push("💳 Pago: " + user.checkout.pago);

  const metodoTransfer =
    user.checkout.pagoId === "transferencia" ||
    /transfer/i.test(user.checkout.pago || "");

  if (metodoTransfer && (config.AliasPago || config.CBUPago)) {
    txt.push("");
    txt.push("📄 *Datos para transferencia:*");
    if (config.AliasPago)
      txt.push("• Alias: `" + config.AliasPago + "`");
    if (config.CBUPago)
      txt.push("• CBU: `" + config.CBUPago + "`");
  }

  txt.push("");
  txt.push("🆔 ChatID cliente: " + chatId);

  return txt.join("\n");
}

async function finalizeOrder(chatId, config, user, username) {
  const resumen = buildOrderSummary(config, user, chatId, username);

  if (ADMIN_CHAT_ID) {
    try {
      await bot.sendMessage(ADMIN_CHAT_ID, resumen, {
        parse_mode: "Markdown"
      });
    } catch (e) {
      console.error("No pude enviar a ADMIN_CHAT_ID:", e);
    }
  }

  const confirmText =
    (config.textos && config.textos.pedidoConfirmado) ||
    "✅ ¡Listo! Ya tomé tu pedido.\n\nTu compra fue confirmada y está en preparación. ✅";

  await bot.sendMessage(chatId, safeText(confirmText), {
    ...mainMenuKeyboard(config)
  });

  clearCart(user);
  user.checkout = {
    paso: "",
    envioTipo: "",
    direccion: "",
    horario: "",
    pago: "",
    pagoId: ""
  };
  saveData(DB);
}

// ---------- HANDLERS ----------
bot.onText(/\/start/, async function (msg) {
  const chatId = msg.chat.id;
  try {
    const config = await fetchConfig();
    await sendWelcome(chatId, config);
  } catch (e) {
    console.error(e);
    bot.sendMessage(
      chatId,
      "Hubo un problema cargando la configuración. Probá de nuevo en unos segundos."
    );
  }
});

bot.on("message", async function (msg) {
  const chatId = msg.chat.id;
  const userId = msg.from && msg.from.id;
  if (!userId) return;

  if (msg.text && msg.text.startsWith("/start")) return;

  try {
    const config = await fetchConfig();
    const user = getUser(userId);
    const text = String(msg.text || "").trim();

    // saludo
    if (/^hola\b/i.test(text)) {
      await sendWelcome(chatId, config);
      return;
    }

    // pendiente de cantidad
    if (user.pendingQty && text) {
      const num = parseInt(text.replace(/[^\d]/g, ""), 10);
      if (!isFinite(num) || num <= 0) {
        await bot.sendMessage(
          chatId,
          "Necesito un número válido. Ej: 250 o 1."
        );
        return;
      }
      if (user.pendingQty.unitType === "g") {
        addToCartGrams(user, user.pendingQty.codigo, num);
        await bot.sendMessage(
          chatId,
          "✅ Agregué " +
            num +
            "g de *" +
            user.pendingQty.nombre +
            "* al carrito.",
          { parse_mode: "Markdown" }
        );
      } else {
        addToCartUnits(user, user.pendingQty.codigo, num);
        await bot.sendMessage(
          chatId,
          "✅ Agregué " +
            num +
            " unidad(es) de *" +
            user.pendingQty.nombre +
            "* al carrito.",
          { parse_mode: "Markdown" }
        );
      }
      user.pendingQty = null;
      saveData(DB);
      return;
    }

    // flujo de checkout por texto
    if (user.checkout && user.checkout.paso) {
      if (user.checkout.paso === "esperando_direccion") {
        user.checkout.direccion = text;
        user.checkout.paso = "esperando_nombre";
        saveData(DB);
        await askName(chatId);
        return;
      }
      if (user.checkout.paso === "esperando_nombre") {
        user.profile.nombre = text;
        user.checkout.paso = "esperando_telefono";
        saveData(DB);
        await askPhone(chatId);
        return;
      }
      if (user.checkout.paso === "esperando_telefono") {
        user.profile.telefono = text;
        user.checkout.paso = "esperando_horario";
        saveData(DB);
        await askHorario(chatId);
        return;
      }
      if (user.checkout.paso === "esperando_horario") {
        user.checkout.horario = text;
        user.checkout.paso = "pago";
        saveData(DB);
        await askPayment(chatId, config);
        return;
      }
    }

    // botones del teclado principal
    if (text === "🛍️ Catálogo") {
      await showCategories(chatId, config);
      return;
    }
    if (text === "🔥 Promos") {
      await showPromos(chatId, config);
      return;
    }
    if (text === "🛒 Mi carrito") {
      await showCart(chatId, config, user);
      return;
    }
    if (text === "✅ Finalizar compra") {
      await startCheckout(chatId, config, user);
      return;
    }
    if (text === "📍 Horarios y dirección") {
      await showBusinessInfo(chatId, config);
      return;
    }
    if (text === "📣 Compartir bot") {
      const url = BOT_USERNAME ? "https://t.me/" + BOT_USERNAME : "";
      const msgShare = url
        ? "📣 Podés compartir este bot reenviando este mensaje o pasando este enlace:\n" +
          url
        : "📣 Podés compartir este bot reenviando este mensaje a tus contactos.";
      await bot.sendMessage(chatId, msgShare);
      return;
    }

    // texto libre
    if (text) {
      await bot.sendMessage(
        chatId,
        "🙂 Decime qué estás buscando (por ejemplo: *picada*, *queso*, *promo*) o tocá una opción del menú.",
        { parse_mode: "Markdown", ...mainMenuKeyboard(config) }
      );
    }
  } catch (e) {
    console.error(e);
    bot.sendMessage(
      chatId,
      "Hubo un error. Probá de nuevo en unos segundos."
    );
  }
});

bot.on("callback_query", async function (q) {
  const data = q.data || "";
  const msg = q.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const userId = q.from && q.from.id;
  if (!userId) return;

  try {
    const config = await fetchConfig();
    const user = getUser(userId);

    const ack = async function () {
      try {
        await bot.answerCallbackQuery(q.id);
      } catch (e) {}
    };

    if (data === "noop") {
      await ack();
      return;
    }

    if (data === "menu:main") {
      await ack();
      await sendWelcome(chatId, config);
      return;
    }

    if (data === "cats:list") {
      await ack();
      await showCategories(chatId, config);
      return;
    }

    if (data.indexOf("cat:") === 0) {
      await ack();
      const cat = data.slice(4);
      await showProductCard(chatId, config, cat, 0);
      return;
    }

    if (data.indexOf("pnav:") === 0) {
      await ack();
      const parts = data.split(":"); // [pnav, cat, index]
      const cat = parts[1];
      const idx = Number(parts[2] || 0);
      await showProductCard(chatId, config, cat, idx);
      return;
    }

    if (data.indexOf("padd:") === 0) {
      await ack();
      const parts = data.split(":");
      const cat = parts[1];
      const idx = Number(parts[2] || 0);
      const map = getCatalogByCategory(config);
      const items = map[cat] || [];
      const p = items[idx];
      if (!p) {
        await bot.sendMessage(
          chatId,
          "Ese producto no existe. Probá de nuevo desde el catálogo."
        );
        return;
      }

      const unidad = String(p.unidad || "").toLowerCase();
      if (unidad === "kg") {
        user.pendingQty = {
          codigo: p.codigo,
          unitType: "g",
          nombre: p.nombre
        };
        saveData(DB);
        await bot.sendMessage(
          chatId,
          "⚖️ ¿Cuántos *gramos* querés de *" +
            p.nombre +
            "*?\n\nEscribí solo el número (ej: 250, 500, 1000).",
          { parse_mode: "Markdown" }
        );
      } else {
        user.pendingQty = {
          codigo: p.codigo,
          unitType: "u",
          nombre: p.nombre
        };
        saveData(DB);
        await bot.sendMessage(
          chatId,
          "🔢 ¿Cuántas *unidades* querés de *" +
            p.nombre +
            "*?\n\nEscribí solo el número (ej: 1, 2, 3).",
          { parse_mode: "Markdown" }
        );
      }
      return;
    }

    if (data.indexOf("pshare:") === 0) {
      await ack();
      const parts = data.split(":");
      const cat = parts[1];
      const idx = Number(parts[2] || 0);
      const map = getCatalogByCategory(config);
      const items = map[cat] || [];
      const p = items[idx];
      const url = BOT_USERNAME ? "https://t.me/" + BOT_USERNAME : "";
      const txt =
        "📣 Compartí este producto de *" +
        (config.negocio && config.negocio.nombre
          ? config.negocio.nombre
          : "Todo Queso") +
        "*:\n\n" +
        "• " +
        (p ? p.nombre : "Producto") +
        (url ? "\nAbrí el bot acá: " + url : "");
      await bot.sendMessage(chatId, txt, { parse_mode: "Markdown" });
      return;
    }

    if (data === "cart:clear") {
      await ack();
      clearCart(user);
      saveData(DB);
      await bot.sendMessage(
        chatId,
        "🧹 Listo, vacié el carrito.",
        mainMenuKeyboard(config)
      );
      return;
    }

    if (data === "checkout:start") {
      await ack();
      await startCheckout(chatId, config, user);
      return;
    }

    if (data === "checkout:cancel") {
      await ack();
      user.checkout = {
        paso: "",
        envioTipo: "",
        direccion: "",
        horario: "",
        pago: "",
        pagoId: ""
      };
      saveData(DB);
      await bot.sendMessage(
        chatId,
        "Listo, cancelé el checkout.",
        mainMenuKeyboard(config)
      );
      return;
    }

    if (data.indexOf("ship:") === 0) {
      await ack();
      const tipo = data.split(":")[1]; // retiro | envio
      user.checkout.envioTipo = tipo;
      if (tipo === "envio") {
        user.checkout.paso = "esperando_direccion";
        saveData(DB);
        await askAddress(chatId);
      } else {
        user.checkout.paso = "esperando_nombre";
        saveData(DB);
        await askName(chatId);
      }
      return;
    }

    if (data.indexOf("pay:") === 0) {
      await ack();
      const payId = data.slice(4);
      const methods = Array.isArray(config.pagos && config.pagos.metodos)
        ? config.pagos.metodos
        : [];
      const method =
        methods.find(function (m) {
          return String(m.id || m.label) === String(payId);
        }) || null;

      user.checkout.pagoId = method ? method.id : String(payId);
      user.checkout.pago = method
        ? method.label || method.nombre || String(payId)
        : String(payId);
      saveData(DB);

      const resumen = buildOrderSummary(
        config,
        user,
        chatId,
        q.from && q.from.username
      );
      await bot.sendMessage(chatId, resumen, { parse_mode: "Markdown" });

      await bot.sendMessage(chatId, "¿Confirmás el pedido?", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ Confirmar pedido", callback_data: "order:confirm" }],
            [{ text: "❌ Cancelar", callback_data: "checkout:cancel" }]
          ]
        }
      });
      return;
    }

    if (data === "order:confirm") {
      await ack();
      await finalizeOrder(
        chatId,
        config,
        user,
        q.from && q.from.username
      );
      return;
    }

    await ack();
  } catch (e) {
    console.error(e);
    try {
      await bot.answerCallbackQuery(q.id, {
        text: "Hubo un error. Probá de nuevo."
      });
    } catch (err) {}
  }
});

// ---------- WEBHOOK (Render) ----------
async function setup() {
  try {
    const config = await fetchConfig();
    console.log(
      'Config ok — negocio:',
      (config.negocio && config.negocio.nombre) || "-"
    );
  } catch (e) {
    console.error("Error cargando config al inicio:", e);
  }

  try {
    const me = await bot.getMe();
    BOT_USERNAME = me.username || "";
    console.log("Bot username:", BOT_USERNAME);
  } catch (e) {
    console.error("No pude obtener username:", e);
  }

  if (PUBLIC_URL) {
    const hookPath = "/telegram/" + BOT_TOKEN;
    const hookUrl = PUBLIC_URL.replace(/\/$/, "") + hookPath;
    await bot.setWebHook(hookUrl);
    console.log("Webhook:", hookUrl);

    const server = http.createServer(function (req, res) {
      if (req.method === "POST" && req.url === hookPath) {
        let body = "";
        req.on("data", function (chunk) {
          body += chunk;
        });
        req.on("end", function () {
          try {
            const update = JSON.parse(body);
            bot.processUpdate(update);
          } catch (e) {
            console.error("Error procesando update:", e);
          }
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

    server.listen(PORT, function () {
      console.log("Escuchando en puerto", PORT);
    });
  } else {
    console.log("Bot en modo polling");
  }
}

setup().catch(function (e) {
  console.error("Error al iniciar:", e);
  process.exit(1);
});

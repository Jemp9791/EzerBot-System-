/**
 * EzerBot System — index.js (UN SOLO ARCHIVO)
 * - Telegram Bot + Webhook (Render) o Polling (local)
 * - Lee TODO desde CONFIG_URL (config.json generado desde tu hoja Config)
 * - Catálogo por categorías con fotos + navegación tipo carrusel
 * - Unidades o gramos según "UNIDAD" del producto
 * - Carrito + checkout + envío domicilio / retiro local
 * - Métodos de pago: efectivo + transferencia (lee AliasPago / CBUPago)
 * - Ticket tipo POS + aviso al vendedor (ADMIN_CHAT_ID)
 * - Estilo de conversación tipo WhatsApp
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
const money = (n) => {
  const num = Number(n || 0);
  return num.toLocaleString("es-AR", { maximumFractionDigits: 0 });
};

function safeText(s, max = 4000) {
  const t = String(s ?? "");
  return t.length > max ? t.slice(0, max - 3) + "..." : t;
}

function getUser(db, userId) {
  const key = String(userId);
  if (!db.users[key]) {
    db.users[key] = {
      cart: [],
      stamps: 0,
      profile: { nombre: "", telefono: "" },
      checkout: { paso: "", envioTipo: "", direccion: "", horario: "", pago: "" },
      temp: { cat: "", index: 0 },
      pendingQty: null,
      lastSeen: Date.now(),
    };
    saveData(db);
  }
  db.users[key].lastSeen = Date.now();
  return db.users[key];
}

function addToCart(user, codigo, qty) {
  const q = Math.max(1, Number(qty || 1));
  const item = user.cart.find((x) => x.codigo === codigo);
  if (item) item.qty += q;
  else user.cart.push({ codigo, qty: q });
}

function clearCart(user) {
  user.cart = [];
}

function buildShareLinks(botUsername, negocioNombre, publicUrl) {
  const text = encodeURIComponent(
    `Te comparto el bot de ${negocioNombre} 🧀🤖\n\nAbrilo acá: https://t.me/${botUsername}\n`
  );
  const wa = `https://wa.me/?text=${text}`;
  const tg = `https://t.me/share/url?url=${encodeURIComponent(
    `https://t.me/${botUsername}`
  )}&text=${text}`;
  const mail = `mailto:?subject=${encodeURIComponent(
    `Bot de ${negocioNombre}`
  )}&body=${text}`;
  const web = publicUrl ? publicUrl : "";
  return { wa, tg, mail, web };
}

// -------------------- CONFIG CACHE --------------------
let CONFIG_CACHE = null;
let CONFIG_CACHE_AT = 0;
const CONFIG_TTL_MS = 30_000;

async function fetchConfig() {
  const now = Date.now();
  if (CONFIG_CACHE && now - CONFIG_CACHE_AT < CONFIG_TTL_MS) return CONFIG_CACHE;

  const res = await fetch(CONFIG_URL, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`No pude leer config.json (HTTP ${res.status})`);
  const json = await res.json();

  // ---- Normalización para tu hoja Config ----
  if (!json.negocio) json.negocio = {};
  const nombreNegocio =
    json.negocio.nombre ||
    json.NegocioNombre ||
    json.negocio.NegocioNombre ||
    "Todo Queso";
  json.negocio.nombre = nombreNegocio;

  json.negocio.direccion =
    json.negocio.direccion || json.Dirección || json.Direccion || "";
  json.negocio.horarios = json.negocio.horarios || json.Horarios || "";
  json.negocio.telefono =
    json.negocio.telefono || json.TeléfonoNegocio || json.TelefonoNegocio || "";
  json.negocio.instagram = json.negocio.instagram || json.Instagram || "";

  const logoField =
    json.negocio.logo ||
    json.LogoURL ||
    json.logoUrl ||
    json.logo_url ||
    (json.negocio && (json.negocio.LogoURL || json.negocio.logoUrl));
  json.negocio.logo = logoField || "";

  // catálogo
  if (!Array.isArray(json.catalogo)) json.catalogo = [];

  // -------- ENVÍOS --------
  if (!json.envios) json.envios = {};

  const rawEnvio =
    json.envios.activo ??
    json.UsaEnvíoDomicilio ??
    json.UsaEnvioDomicilio ??
    json.UsaEnvio ??
    json.UsaEnvios;

  json.envios.activo =
    String(rawEnvio || "").toUpperCase() === "SI" || rawEnvio === true;

  const rawRetiro =
    json.envios.usaRetiro ?? json.UsaRetiroLocal ?? json.UsaRetiro ?? "";

  // Por defecto SI (para que salga el botón aunque no esté configurado)
  json.envios.usaRetiro =
    rawRetiro === "" ? true : String(rawRetiro).toUpperCase() === "SI";

  json.envios.costo =
    json.envios.costo ||
    Number(json.CostoEnvíoBase || json.CostoEnvioBase || 0);
  json.envios.textoEnvio =
    json.envios.textoEnvio ||
    json.TextoEnvíoDomicilio ||
    json.TextoEnvioDomicilio ||
    "";
  json.envios.textoRetiro =
    json.envios.textoRetiro || json.TextoRetiroLocal || "";

  // -------- PAGOS --------
  if (!json.pagos) json.pagos = {};
  json.pagos.alias = json.AliasPago || "";
  json.pagos.cbu = json.CBUPago || "";

  if (!Array.isArray(json.pagos.metodos) || !json.pagos.metodos.length) {
    const metodos = [];
    metodos.push({ id: "EFECTIVO", label: "Efectivo" });

    const permitirOnline =
      String(json.PermitirPagoOnline || "").toUpperCase() === "SI";
    if (permitirOnline && json.TipoPagoOnline) {
      const id = String(json.TipoPagoOnline).toUpperCase();
      const label = id === "TRANSFERENCIA" ? "Transferencia" : json.TipoPagoOnline;
      metodos.push({ id, label });
    }
    json.pagos.metodos = metodos;
  }

  // -------- TEXTOS --------
  if (!json.textos) json.textos = {};
  json.textos.bienvenida =
    json.textos.bienvenida ||
    `👋 Hola, soy el bot de *${json.negocio.nombre}*.\n\nTe ayudo a armar tu pedido rápido:\n- Mirás el catálogo 🛍️\n- Elegís lo que querés\n- Cerramos el pedido y te paso cómo pagar\n\nCuando quieras, tocá *Catálogo* o escribime qué estás buscando.`;
  json.textos.pedidoConfirmado =
    json.textos.pedidoConfirmado ||
    json.TextoConfirmacionPedido ||
    "Gracias 🧀 Tu compra fue confirmada y ya la estamos preparando. ✅";
  json.textos.avisoVendedor =
    json.textos.avisoVendedor ||
    json.TextoAvisoVendedor ||
    "Nuevo pedido para revisar 👀";
  json.textos.compartirBot =
    json.textos.compartirBot ||
    json.TextoCompartirBot ||
    "Compartí este Ezerbot con tus amigos y ganá sellos extras. 🧀";

  // -------- SELLOS --------
  json.sellos = json.sellos || {};
  json.sellos.activo =
    json.sellos.activo ||
    String(json.UsaSellos || "").toUpperCase() === "SI";

  CONFIG_CACHE = json;
  CONFIG_CACHE_AT = now;
  return json;
}

// -------------------- CATALOGO / PRODUCTOS --------------------
function getCatalogByCategory(config) {
  const map = new Map();
  for (const p of config.catalogo || []) {
    const cat = (p.categoria || "Otros").trim() || "Otros";
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat).push(p);
  }
  for (const [k, arr] of map.entries()) {
    arr.sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), "es"));
    map.set(k, arr);
  }
  return map;
}

function getCategoryList(config) {
  const map = getCatalogByCategory(config);
  return Array.from(map.keys());
}

function findProduct(config, codigo) {
  return (config.catalogo || []).find(
    (p) => String(p.codigo) === String(codigo)
  );
}

function calcCartTotals(config, user) {
  let subtotal = 0;
  const lines = [];
  for (const it of user.cart) {
    const p = findProduct(config, it.codigo);
    if (!p) continue;
    const precio = Number(p.precio || 0);
    const unidad = String(p.unidad || "").toLowerCase();
    const qty = Number(it.qty || 0);
    let line = 0;
    let labelQty = "";
    if (unidad.includes("kg")) {
      const kg = qty / 1000;
      line = precio * kg;
      labelQty = `${qty} g`;
    } else {
      line = precio * qty;
      labelQty = `${qty} u.`;
    }
    subtotal += line;
    lines.push({ p, qty, labelQty, line });
  }
  return { subtotal, lines };
}

// -------------------- ENVÍO / PAGO --------------------
function calcShipping(config, subtotal, checkout) {
  const env = config.envios || {};
  const usaEnvio = !!env.activo;
  if (checkout.envioTipo === "retiro" || !usaEnvio) {
    return { costo: 0, label: "Retiro en el local" };
  }
  if (checkout.envioTipo === "envio") {
    let costo = Number(env.costo || 0);
    const gratisDesde = Number(config.EnvioGratisDesde || 0);
    if (gratisDesde > 0 && subtotal >= gratisDesde) costo = 0;
    return { costo, label: "Envío a domicilio" };
  }
  return { costo: 0, label: "Retiro/Envío" };
}

// -------------------- BOT SETUP --------------------
const bot = new TelegramBot(BOT_TOKEN, { polling: !PUBLIC_URL });

async function ensureWebhook() {
  if (!PUBLIC_URL) return;
  const hookPath = `/telegram/${BOT_TOKEN}`;
  const hookUrl = `${PUBLIC_URL.replace(/\/$/, "")}${hookPath}`;
  await bot.setWebHook(hookUrl);
  console.log("Webhook:", hookUrl);
}

// -------------------- UI (BOTONES) --------------------
function mainMenuKeyboard(config) {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🛍️ Catálogo" }, { text: "🔥 Promos" }],
        [{ text: "🛒 Ver carrito" }, { text: "✅ Finalizar compra" }],
        [{ text: "📍 Horarios y dirección" }, { text: "📣 Compartir bot" }],
      ],
      resize_keyboard: true,
    },
  };
}

function inlineCategoriesKeyboard(categories) {
  const rows = categories.map((cat) => [
    { text: cat, callback_data: `cat:${cat}` },
  ]);
  return { reply_markup: { inline_keyboard: rows } };
}

function inlineProductKeyboard(cat, index, total) {
  const rows = [
    [
      { text: "🟢 Quiero éste", callback_data: `prod:add:${cat}:${index}` },
      { text: "📣 Compartir", callback_data: `prod:share:${cat}:${index}` },
    ],
    [
      { text: "⬅️ Anterior", callback_data: `prod:prev:${cat}:${index}` },
      { text: `${index + 1}/${total}`, callback_data: "noop" },
      { text: "➡️ Siguiente", callback_data: `prod:next:${cat}:${index}` },
    ],
  ];
  return { reply_markup: { inline_keyboard: rows } };
}

function inlineCheckoutDeliveryKeyboard(config) {
  const env = config.envios || {};
  const rows = [];
  if (env.usaRetiro !== false) {
    rows.push([{ text: "🏬 Retiro en el local", callback_data: "ship:retiro" }]);
  }
  if (env.activo) {
    const labelEnvio =
      env.costo && Number(env.costo) > 0
        ? `🚚 Envío a domicilio (+$${money(env.costo)})`
        : "🚚 Envío a domicilio";
    rows.push([{ text: labelEnvio, callback_data: "ship:envio" }]);
  }
  rows.push([{ text: "❌ Cancelar", callback_data: "checkout:cancel" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function inlinePaymentKeyboard(config) {
  const methods = Array.isArray(config.pagos?.metodos)
    ? config.pagos.metodos
    : [];
  const rows = [];
  for (const m of methods) {
    rows.push([
      {
        text: m.label || m.nombre || m.id || "Pago",
        callback_data: `pay:${m.id || m.label}`,
      },
    ]);
  }
  rows.push([{ text: "❌ Cancelar", callback_data: "checkout:cancel" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

// -------------------- MENSAJES PRINCIPALES --------------------
async function sendWelcome(chatId, config) {
  const negocio = config.negocio || {};
  const bienvenida = config.textos?.bienvenida;
  const logo = negocio.logo;
  if (logo) {
    await bot.sendPhoto(chatId, logo, {
      caption: bienvenida,
      parse_mode: "Markdown",
      ...mainMenuKeyboard(config),
    });
  } else {
    await bot.sendMessage(chatId, bienvenida, {
      parse_mode: "Markdown",
      ...mainMenuKeyboard(config),
    });
  }
}

async function showBusinessInfo(chatId, config) {
  const n = config.negocio || {};
  const lines = [];
  lines.push(`🏪 *${n.nombre || "Negocio"}*`);
  if (n.direccion) lines.push(`📍 ${n.direccion}`);
  if (n.horarios) lines.push(`🕒 ${n.horarios}`);
  if (n.telefono) lines.push(`📞 ${n.telefono}`);
  if (n.instagram) lines.push(`📸 ${n.instagram}`);
  await bot.sendMessage(chatId, lines.join("\n"), {
    parse_mode: "Markdown",
    ...mainMenuKeyboard(config),
  });
}

async function showCategories(chatId, config) {
  const cats = getCategoryList(config);
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
    "🛍️ Elegí una categoría para empezar:",
    inlineCategoriesKeyboard(cats)
  );
}

function getProductsForCategory(config, cat) {
  const map = getCatalogByCategory(config);
  return map.get(cat) || [];
}

// showProductCard: si viene msg, intenta EDITAR; si no, ENVÍA NUEVA
async function showProductCard(chatId, config, user, cat, index, opts = {}) {
  const items = getProductsForCategory(config, cat);
  if (!items.length) {
    await bot.sendMessage(
      chatId,
      `No hay productos en *${cat}* por ahora.`,
      { parse_mode: "Markdown" }
    );
    return;
  }
  const total = items.length;
  const idx = ((index % total) + total) % total;
  const p = items[idx];

  user.temp.cat = cat;
  user.temp.index = idx;
  saveData(DB);

  const unidad = String(p.unidad || "").toLowerCase();
  const precio = Number(p.precio || 0);
  const precioLabel = unidad.includes("kg")
    ? `$${money(precio)} / kg`
    : `$${money(precio)} / unidad`;

  const lines = [];
  lines.push(`*${p.nombre || "Producto"}*`);
  lines.push(`💰 ${precioLabel}`);
  if (p.descripcion) lines.push(`📝 ${p.descripcion}`);
  const caption = lines.join("\n");

  const kb = inlineProductKeyboard(cat, idx, total).reply_markup;

  const msg = opts.msg;
  if (msg) {
    try {
      if (p.imagen && msg.photo) {
        await bot.editMessageMedia(
          {
            type: "photo",
            media: p.imagen,
            caption,
            parse_mode: "Markdown",
          },
          {
            chat_id: msg.chat.id,
            message_id: msg.message_id,
            reply_markup: kb,
          }
        );
        return;
      } else {
        await bot.editMessageText(caption, {
          chat_id: msg.chat.id,
          message_id: msg.message_id,
          parse_mode: "Markdown",
          reply_markup: kb,
        });
        return;
      }
    } catch (e) {
      console.error("No pude editar mensaje, envío uno nuevo:", e?.message || e);
    }
  }

  if (p.imagen) {
    await bot.sendPhoto(chatId, p.imagen, {
      caption,
      parse_mode: "Markdown",
      reply_markup: kb,
    });
  } else {
    await bot.sendMessage(chatId, caption, {
      parse_mode: "Markdown",
      reply_markup: kb,
    });
  }
}

async function showPromos(chatId, config, user) {
  const items = getProductsForCategory(config, "Promos");
  if (!items.length) {
    await bot.sendMessage(
      chatId,
      "🔥 Por ahora no hay promos cargadas.\nSi querés, tocá *Catálogo* y vemos todo lo demás.",
      { parse_mode: "Markdown", ...mainMenuKeyboard(config) }
    );
    return;
  }
  await showProductCard(chatId, config, user, "Promos", 0);
}

async function showCart(chatId, config, user) {
  const { subtotal, lines } = calcCartTotals(config, user);
  if (!lines.length) {
    await bot.sendMessage(
      chatId,
      "🛒 Todavía no agregaste nada.\nTocá *Catálogo* para empezar a armar tu pedido 🙂",
      mainMenuKeyboard(config)
    );
    return;
  }

  const msg = [];
  msg.push("🛒 *Tu carrito hasta ahora*");
  msg.push("");
  for (const it of lines) {
    msg.push(`• ${it.labelQty} × ${it.p.nombre} — $${money(it.line)}`);
  }
  msg.push("");
  msg.push(`Subtotal: *$${money(subtotal)}*`);
  msg.push("");
  msg.push("Si querés, podés seguir sumando cosas o tocar *Finalizar compra*.");

  await bot.sendMessage(chatId, msg.join("\n"), {
    parse_mode: "Markdown",
    ...mainMenuKeyboard(config),
  });
}

async function sendPostAddSuggestion(chatId, config, user) {
  const { subtotal, lines } = calcCartTotals(config, user);
  const cant = lines.length;
  const txt =
    `🧺 Listo, lo sumé a tu carrito.\n\n` +
    `Ahora tenés *${cant}* producto(s) y un subtotal de *$${money(
      subtotal
    )}*.\n\n` +
    `👉 Si querés seguir mirando, tocá *🛍️ Catálogo*.\n` +
    `👉 Si ya está, tocá *✅ Finalizar compra* y cerramos el pedido.`;
  await bot.sendMessage(chatId, txt, {
    parse_mode: "Markdown",
    ...mainMenuKeyboard(config),
  });
}

// -------------------- CHECKOUT --------------------
async function startCheckout(chatId, config, user) {
  const { subtotal, lines } = calcCartTotals(config, user);
  if (!lines.length) {
    await bot.sendMessage(
      chatId,
      "Por ahora tu carrito está vacío.\nPrimero elegí algo del *Catálogo* 🙂",
      { parse_mode: "Markdown", ...mainMenuKeyboard(config) }
    );
    return;
  }
  user.checkout = {
    paso: "envio_tipo",
    envioTipo: "",
    direccion: "",
    horario: "",
    pago: "",
  };
  saveData(DB);

  await bot.sendMessage(
    chatId,
    "Perfecto, cerremos tu pedido 🙌\n\nPrimero decime cómo querés recibirlo:",
    {
      parse_mode: "Markdown",
      ...inlineCheckoutDeliveryKeyboard(config),
    }
  );
}

async function askAddress(chatId) {
  await bot.sendMessage(
    chatId,
    "📍 Escribime tu *dirección completa* (calle, número y alguna referencia).",
    { parse_mode: "Markdown" }
  );
}

async function askName(chatId) {
  await bot.sendMessage(
    chatId,
    "🧾 ¿A nombre de quién dejo el pedido? Escribí tu *nombre* 🙂",
    { parse_mode: "Markdown" }
  );
}

async function askPhone(chatId) {
  await bot.sendMessage(
    chatId,
    "📞 Pasame un *celu de contacto* (por si necesitamos escribirte).",
    { parse_mode: "Markdown" }
  );
}

async function askHorario(chatId) {
  await bot.sendMessage(
    chatId,
    "⏰ ¿En qué horario te viene mejor pasar o recibir el pedido?",
    { parse_mode: "Markdown" }
  );
}

async function askPayment(chatId, config) {
  const methods = Array.isArray(config.pagos?.metodos)
    ? config.pagos.metodos
    : [];
  if (!methods.length) {
    await bot.sendMessage(
      chatId,
      "💳 Todavía no hay métodos de pago configurados.",
      mainMenuKeyboard(config)
    );
    return;
  }
  await bot.sendMessage(
    chatId,
    "💳 Elegí cómo lo vas a pagar:",
    inlinePaymentKeyboard(config)
  );
}

function buildOrderSummary(config, user, chatId, username) {
  const negocio = config.negocio || {};
  const { subtotal, lines } = calcCartTotals(config, user);
  const ship = calcShipping(config, subtotal, user.checkout);
  const total = subtotal + Number(ship.costo || 0);

  const profileName = user.profile?.nombre || "";
  const profilePhone = user.profile?.telefono || "";

  const parts = [];
  parts.push(`🧾 *Pedido — ${negocio.nombre || "Negocio"}*`);
  parts.push(
    `👤 Cliente: ${profileName || (username ? `@${username}` : "—")}`
  );
  if (profilePhone) parts.push(`📞 Tel: ${profilePhone}`);
  parts.push("");
  parts.push("*Detalle:*");
  for (const it of lines) {
    parts.push(`• ${it.labelQty} × ${it.p.nombre} — $${money(it.line)}`);
  }
  parts.push("");
  parts.push(`Subtotal: *$${money(subtotal)}*`);
  parts.push(`${ship.label}: *$${money(ship.costo)}*`);
  parts.push(`TOTAL: *$${money(total)}*`);
  parts.push("");
  if (user.checkout.envioTipo === "envio") {
    parts.push("🚚 Entrega: Envío a domicilio");
    if (user.checkout.direccion)
      parts.push(`📍 Dirección: ${user.checkout.direccion}`);
  } else {
    parts.push("🏬 Entrega: Retiro en el local");
  }
  if (user.checkout.horario)
    parts.push(`⏰ Horario: ${user.checkout.horario}`);
  if (user.checkout.pago)
    parts.push(`💳 Pago: ${user.checkout.pago}`);
  parts.push("");
  parts.push(`🆔 ChatID cliente: ${chatId}`);
  return parts.join("\n");
}

async function finalizeOrder(chatId, config, user, username) {
  if (config.sellos?.activo) {
    user.stamps = Number(user.stamps || 0) + 1;
  }

  const summary = buildOrderSummary(config, user, chatId, username);

  if (ADMIN_CHAT_ID) {
    try {
      const aviso = config.textos?.avisoVendedor || "Nuevo pedido recibido 👀";
      await bot.sendMessage(
        ADMIN_CHAT_ID,
        `${aviso}\n\n${summary}`,
        { parse_mode: "Markdown" }
      );
    } catch (e) {
      console.error("No pude avisar al vendedor:", e?.message || e);
    }
  }

  const confirmText =
    config.textos?.pedidoConfirmado ||
    "Gracias 🧀 Tu compra fue confirmada y ya la estamos preparando. ✅";

  await bot.sendMessage(chatId, safeText(confirmText), {
    ...mainMenuKeyboard(config),
  });

  clearCart(user);
  user.checkout = {
    paso: "",
    envioTipo: "",
    direccion: "",
    horario: "",
    pago: "",
  };
  saveData(DB);
}

// -------------------- HANDLERS --------------------
bot.onText(/\/start/, async (msg) => {
  try {
    const config = await fetchConfig();
    const chatId = msg.chat.id;
    await sendWelcome(chatId, config);
  } catch (e) {
    console.error(e);
    bot.sendMessage(
      msg.chat.id,
      "Se me trabó la configuración 😅 Probá de nuevo en unos segundos."
    );
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

    // Flujo de cantidad pendiente (gramos / unidades)
    if (user.pendingQty) {
      const num = Number(text.replace(",", "."));
      if (!Number.isFinite(num) || num <= 0) {
        await bot.sendMessage(
          chatId,
          "Escribime un número válido, por ejemplo 2 o 250 🙂"
        );
        return;
      }
      const { codigo, modo } = user.pendingQty;
      let qty = Math.round(num);
      addToCart(user, codigo, qty);
      user.pendingQty = null;
      saveData(DB);

      const p = findProduct(config, codigo);
      const unidad = modo === "gramos" ? "g" : "u.";
      await bot.sendMessage(
        chatId,
        `✅ Agregué ${qty}${unidad} de *${p?.nombre || "producto"}* al carrito.`,
        { parse_mode: "Markdown" }
      );
      await sendPostAddSuggestion(chatId, config, user);
      return;
    }

    // Flujo de checkout (texto libre)
    if (user.checkout?.paso) {
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

    // Botones del teclado principal
    if (text === "🛍️ Catálogo") return await showCategories(chatId, config);
    if (text === "🔥 Promos") return await showPromos(chatId, config, user);
    if (text === "🛒 Ver carrito") return await showCart(chatId, config, user);
    if (text === "✅ Finalizar compra")
      return await startCheckout(chatId, config, user);
    if (text === "📍 Horarios y dirección")
      return await showBusinessInfo(chatId, config);

    if (text === "📣 Compartir bot") {
      try {
        const me = await bot.getMe();
        const links = buildShareLinks(
          me.username,
          config.negocio?.nombre || "el negocio",
          PUBLIC_URL
        );
        const mensaje =
          config.textos?.compartirBot +
          `\n\nLink directo del bot:\nhttps://t.me/${me.username}`;
        await bot.sendMessage(chatId, mensaje, {
          reply_markup: {
            inline_keyboard: [
              [{ text: "📲 Compartir por WhatsApp", url: links.wa }],
            ],
          },
        });
      } catch (e) {
        console.error("Error en Compartir bot:", e?.message || e);
        await bot.sendMessage(
          chatId,
          "Podés compartir este link con tus contactos:\nhttps://t.me/" +
            (await bot.getMe()).username
        );
      }
      return;
    }

    // Texto libre: estilo WhatsApp
    if (text) {
      await bot.sendMessage(
        chatId,
        "Te leo 🙂\nPodés decirme algo como *picada*, *queso*, *pan* o tocar directamente *Catálogo*.",
        { parse_mode: "Markdown", ...mainMenuKeyboard(config) }
      );
    }
  } catch (e) {
    console.error(e);
    try {
      await bot.sendMessage(
        msg.chat.id,
        "Se me mezclaron los quesos un segundo 😅 Probá de nuevo."
      );
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
      try {
        await bot.answerCallbackQuery(q.id);
      } catch {}
    };

    if (data === "noop") return await ack();

    if (data === "menu:main") {
      await ack();
      return await sendWelcome(chatId, config);
    }

    // categorías
    if (data.startsWith("cat:")) {
      await ack();
      const cat = data.slice(4);
      return await showProductCard(chatId, config, user, cat, 0);
    }

    // navegación de productos
    if (data.startsWith("prod:")) {
      await ack();
      const parts = data.split(":"); // prod:accion:cat:index
      const accion = parts[1];
      const cat = parts[2];
      const index = Number(parts[3] || 0);
      const items = getProductsForCategory(config, cat);
      if (!items.length) return;

      if (accion === "next")
        return await showProductCard(chatId, config, user, cat, index + 1, {
          msg,
        });
      if (accion === "prev")
        return await showProductCard(chatId, config, user, cat, index - 1, {
          msg,
        });

      const p = items[((index % items.length) + items.length) % items.length];

      if (accion === "add") {
        const unidad = String(p.unidad || "").toLowerCase();
        if (unidad.includes("kg")) {
          user.pendingQty = { codigo: p.codigo, modo: "gramos" };
          saveData(DB);
          await bot.sendMessage(
            chatId,
            `⚖️ ¿Cuántos *gramos* querés de *${p.nombre}*?\nEjemplo: 250`,
            { parse_mode: "Markdown" }
          );
          return;
        } else {
          user.pendingQty = { codigo: p.codigo, modo: "unidades" };
          saveData(DB);
          await bot.sendMessage(
            chatId,
            `🔢 ¿Cuántas *unidades* querés de *${p.nombre}*?\nEjemplo: 2`,
            { parse_mode: "Markdown" }
          );
          return;
        }
      }

      if (accion === "share") {
        const me = await bot.getMe();
        const linkProducto = `https://t.me/${me.username}`;
        const txt = encodeURIComponent(
          `Mirá este producto de ${config.negocio?.nombre}:\n${p.nombre} - $${money(
            p.precio
          )}\n${linkProducto}`
        );
        const wa = `https://wa.me/?text=${txt}`;
        const tg = `https://t.me/share/url?url=${encodeURIComponent(
          linkProducto
        )}&text=${txt}`;
        const mail = `mailto:?subject=${encodeURIComponent(
          p.nombre
        )}&body=${txt}`;
        const rows = [
          [{ text: "📲 WhatsApp", url: wa }],
          [{ text: "📨 Telegram", url: tg }],
          [{ text: "✉️ Email", url: mail }],
        ];
        await bot.sendMessage(chatId, "¿Por dónde lo querés compartir?", {
          reply_markup: { inline_keyboard: rows },
        });
        return;
      }
    }

    // checkout
    if (data === "checkout:start") {
      await ack();
      return await startCheckout(chatId, config, user);
    }

    if (data === "checkout:cancel") {
      await ack();
      user.checkout = {
        paso: "",
        envioTipo: "",
        direccion: "",
        horario: "",
        pago: "",
      };
      saveData(DB);
      await bot.sendMessage(
        chatId,
        "Listo, cancelé el cierre del pedido. Cuando quieras retomamos 🙂",
        mainMenuKeyboard(config)
      );
      return;
    }

    if (data.startsWith("ship:")) {
      await ack();
      const tipo = data.split(":")[1]; // retiro / envio
      user.checkout.envioTipo = tipo === "envio" ? "envio" : "retiro";
      if (tipo === "retiro") {
        user.checkout.paso = "esperando_nombre";
        saveData(DB);
        await askName(chatId);
        return;
      } else {
        user.checkout.paso = "esperando_direccion";
        saveData(DB);
        await askAddress(chatId);
        return;
      }
    }

    if (data.startsWith("pay:")) {
      await ack();
      const payId = data.slice(4);
      const methods = Array.isArray(config.pagos?.metodos)
        ? config.pagos.metodos
        : [];
      const method =
        methods.find(
          (m) => String(m.id || m.label) === String(payId)
        ) || null;
      user.checkout.pago = method?.label || method?.nombre || String(payId);
      saveData(DB);

      const idUpper = String(payId).toUpperCase();
      if (idUpper === "TRANSFERENCIA") {
        const pieces = [];
        pieces.push("💳 Datos para transferencia:");
        if (config.pagos.alias)
          pieces.push(`• Alias: *${config.pagos.alias}*`);
        if (config.pagos.cbu) pieces.push(`• CBU: *${config.pagos.cbu}*`);
        pieces.push("");
        pieces.push(
          "Cuando tengas el comprobante, guardalo. El local va a revisarlo y preparar tu pedido ✅"
        );
        await bot.sendMessage(chatId, pieces.join("\n"), {
          parse_mode: "Markdown",
        });
      }

      const summary = buildOrderSummary(
        config,
        user,
        chatId,
        q.from?.username
      );
      await bot.sendMessage(chatId, summary, {
        parse_mode: "Markdown",
      });

      const rows = [
        [{ text: "✅ Confirmar pedido", callback_data: "order:confirm" }],
        [{ text: "❌ Cancelar", callback_data: "checkout:cancel" }],
      ];
      await bot.sendMessage(
        chatId,
        "¿Confirmamos este pedido así como está?",
        {
          reply_markup: { inline_keyboard: rows },
        }
      );
      return;
    }

    if (data === "order:confirm") {
      await ack();
      return await finalizeOrder(chatId, config, user, q.from?.username);
    }

    await ack();
  } catch (e) {
    console.error(e);
    try {
      await bot.answerCallbackQuery(q.id, {
        text: "Se me trabó un botón 😅 Probá de nuevo.",
      });
    } catch {}
  }
});

// -------------------- WEBHOOK SERVER (Render) --------------------
async function start() {
  const config = await fetchConfig();
  console.log(
    `Config cargado OK: negocio="${config.negocio?.nombre || "-"}", catalogo=${
      config.catalogo?.length || 0
    }`
  );

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
            res.writeHead(200);
            res.end("OK");
          } catch (e) {
            console.error("Error procesando update:", e?.message || e);
            res.writeHead(200);
            res.end("OK");
          }
        });
        return;
      }

      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
        });
        res.end("EzerBot System OK");
        return;
      }

      res.writeHead(404);
      res.end("Not Found");
    });

    server.listen(PORT, () =>
      console.log(`Escuchando en puerto ${PORT} (webhook)`)
    );
  } else {
    console.log("Bot activo (polling).");
  }
}

start().catch((e) => {
  console.error("Error iniciando:", e?.message || e);
  process.exit(1);
});

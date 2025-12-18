/**
 * EzerBot System — index.js
 * Render: Node 22, single file
 *
 * ENV (Render):
 * - BOT_TOKEN
 * - CONFIG_URL    (URL al JSON generado desde la hoja EZERBOT-SYSTEM)
 * - PUBLIC_URL    (https://tu-servicio.onrender.com)  opcional para webhook
 * - ADMIN_CHAT_ID (chatId del vendedor)
 * - PORT          (Render lo setea)
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
  console.error("Falta BOT_TOKEN");
  process.exit(1);
}
if (!CONFIG_URL) {
  console.error("Falta CONFIG_URL");
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
      cart: [], // [{codigo, qty}]
      stamps: 0,
      profile: { nombre: "", telefono: "" },
      checkout: {
        paso: "",
        envioTipo: "",
        zona: "",
        direccion: "",
        pago: "",
        horario: "",
      },
      pendingQtyCode: "", // cuando está esperando que escriba gramos/unidades
      lastSeen: Date.now(),
    };
    saveData(db);
  }
  db.users[key].lastSeen = Date.now();
  return db.users[key];
}

function addToCart(user, codigo, qty = 1) {
  const q = Math.max(0, Number(qty || 0));
  if (!q) return;
  const item = user.cart.find((x) => x.codigo === codigo);
  if (item) item.qty += q;
  else user.cart.push({ codigo, qty: q });
}

function removeFromCart(user, codigo, qty = 1) {
  const q = Math.max(1, Number(qty || 1));
  const idx = user.cart.findIndex((x) => x.codigo === codigo);
  if (idx === -1) return;
  user.cart[idx].qty -= q;
  if (user.cart[idx].qty <= 0) user.cart.splice(idx, 1);
}

function clearCart(user) {
  user.cart = [];
}

function buildShareLinksForBot(botUsername, negocioNombre) {
  const baseText = `Te comparto el bot de ${negocioNombre} 🤖🧀\nAbrilo acá: https://t.me/${botUsername}`;
  const text = encodeURIComponent(baseText);
  const wa = `https://wa.me/?text=${text}`;
  const tg = `https://t.me/share/url?url=${encodeURIComponent(
    `https://t.me/${botUsername}`
  )}&text=${text}`;
  const mail = `mailto:?subject=${encodeURIComponent(
    `Bot de ${negocioNombre}`
  )}&body=${text}`;
  return { wa, tg, mail };
}

function qtyLabel(qty, unidad) {
  const u = String(unidad || "").toLowerCase();
  if (u.includes("kg")) {
    const g = Math.round(qty * 1000);
    return `${g}g`;
  }
  return `${qty} u`;
}

function parseQtyFromText(text, unidad) {
  const t = String(text || "").toLowerCase().replace(",", ".").trim();
  if (!t) return 0;
  const u = String(unidad || "").toLowerCase();

  // sacar letras para el número
  const numPart = t.replace(/[^\d.]/g, "");
  if (!numPart) return 0;
  let n = Number(numPart);
  if (!Number.isFinite(n) || n <= 0) return 0;

  if (u.includes("kg")) {
    // si escribió menos de 10 y con "kg" en el texto, lo tomo como kilos
    if (t.includes("kg") || t.includes("kilo")) {
      return n; // kg directos
    }
    // si no puso "kg", lo tomo como gramos
    return n / 1000; // ejemplo 250 => 0.25 kg
  }

  // por unidad
  return Math.round(n);
}

// -------------------- CONFIG CACHE --------------------
let CONFIG_CACHE = null;
let CONFIG_CACHE_AT = 0;
const CONFIG_TTL_MS = 30_000;

async function fetchConfig() {
  const now = Date.now();
  if (CONFIG_CACHE && now - CONFIG_CACHE_AT < CONFIG_TTL_MS) return CONFIG_CACHE;

  const res = await fetch(CONFIG_URL, {
    headers: { "cache-control": "no-cache" },
  });
  if (!res.ok) throw new Error(`No pude leer CONFIG_URL (HTTP ${res.status})`);
  const json = await res.json();

  // -------- BRIDGE desde hoja "Config" cruda (en español) --------
  // negocio
  if (!json.negocio) {
    json.negocio = {
      nombre: json.NegocioNombre || "Mi negocio",
      logoUrl: json.LogoURL || "",
      descripcion: json.Descripcion || "",
      direccion: json.Dirección || json.Direccion || "",
      horarios: json.Horarios || "",
      telefono: json.TeléfonoNegocio || json.TelefonoNegocio || "",
      instagram: json.Instagram || "",
      whatsappLink: json.WhatsAppLink || "",
    };
  }

  // envíos
  if (!json.envios) {
    const usaEnvio =
      String(
        json["UsaEnvíoDomicilio"] ||
          json["UsaEnvioDomicilio"] ||
          ""
      )
        .toUpperCase()
        .startsWith("SI");
    if (usaEnvio) {
      json.envios = {
        activo: true,
        costo: Number(json["CostoEnvíoBase"] || json["CostoEnvioBase"] || 0),
        texto: json["TextoEnvíoDomicilio"] || json["TextoEnvioDomicilio"] || "",
        gratisDesde: 0,
        zonas: [],
      };
    } else {
      json.envios = { activo: false, zonas: [] };
    }
  }

  // pagos
  if (!json.pagos || !Array.isArray(json.pagos.metodos)) {
    const metodos = [{ id: "efectivo", label: "Efectivo" }];
    const tipo = String(json.TipoPagoOnline || "").toUpperCase();
    const alias = json.AliasPago || "";
    const cbu = json.CBUPago || "";
    if (tipo === "TRANSFERENCIA" && (alias || cbu)) {
      metodos.push({
        id: "transferencia",
        label: "Transferencia",
        alias,
        cbu,
      });
    }
    json.pagos = { metodos };
  }

  // sellos
  if (!json.sellos) {
    json.sellos = {
      activo: String(json.UsaSellos || "").toUpperCase().startsWith("SI"),
      meta: Number((json.SellosPorNivel || "").split("|")[0] || 10),
      premio: (json.BeneficiosPorNivel || "").split("|")[0] || "",
      sumaPorCompra: 1,
      resetAlCompletar: String(json.ResetSellosAlCanjear || "")
        .toUpperCase()
        .startsWith("SI"),
      nombre: "Tarjeta de Sellos",
    };
  }

  if (!Array.isArray(json.catalogo)) json.catalogo = [];
  if (!Array.isArray(json.promos)) json.promos = [];

  CONFIG_CACHE = json;
  CONFIG_CACHE_AT = now;
  return json;
}

// -------------------- CATALOGO --------------------
function getCatalogByCategory(config) {
  const map = new Map();
  for (const p of config.catalogo || []) {
    const cat = (p.categoria || "Otros").trim() || "Otros";
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat).push(p);
  }
  for (const [k, arr] of map.entries()) {
    arr.sort((a, b) =>
      String(a.nombre || "").localeCompare(String(b.nombre || ""), "es")
    );
    map.set(k, arr);
  }
  return map;
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
    const qty = Number(it.qty || 0);
    const line = precio * qty;
    subtotal += line;
    lines.push({ p, qty, line });
  }
  return { subtotal, lines };
}

function calcShipping(config, subtotal, checkout) {
  const env = config.envios || { activo: false };
  if (!env.activo) return { costo: 0, label: "Entrega en el local" };

  if (checkout.envioTipo !== "envio") {
    return { costo: 0, label: "Retiro en el local" };
  }

  const gratisDesde = Number(env.gratisDesde || 0);
  if (gratisDesde > 0 && subtotal >= gratisDesde) {
    return { costo: 0, label: `Envío gratis (desde $${money(gratisDesde)})` };
  }

  const zonas = Array.isArray(env.zonas) ? env.zonas : [];
  if (checkout.zona && zonas.length) {
    const z = zonas.find((x) => String(x.nombre) === String(checkout.zona));
    if (z) return { costo: Number(z.costo || 0), label: `Envío (${z.nombre})` };
  }

  const costoFijo = Number(env.costo || 0);
  return { costo: costoFijo, label: "Envío" };
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

// -------------------- TECLADOS --------------------
function mainMenuKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🛍️ Catálogo" }, { text: "🔥 Promos" }],
        [{ text: "🛒 Mi carrito" }, { text: "✅ Finalizar compra" }],
        [{ text: "📍 Horarios y dirección" }, { text: "📣 Compartir bot" }],
      ],
      resize_keyboard: true,
    },
  };
}

function inlineCategoriesKeyboard(categories) {
  const rows = [];
  for (const cat of categories) {
    rows.push([
      {
        text: cat,
        callback_data: `list:cat:${encodeURIComponent(cat)}:1`,
      },
    ]);
  }
  return { reply_markup: { inline_keyboard: rows } };
}

function navKeyboard(mode, id, page, totalPages) {
  const rows = [];
  const navRow = [];
  if (page > 1) {
    navRow.push({
      text: "⬅️ Anterior",
      callback_data: `nav:${mode}:${encodeURIComponent(id)}:${page - 1}`,
    });
  }
  navRow.push({
    text: `${page}/${totalPages}`,
    callback_data: "noop",
  });
  if (page < totalPages) {
    navRow.push({
      text: "➡️ Siguiente",
      callback_data: `nav:${mode}:${encodeURIComponent(id)}:${page + 1}`,
    });
  }
  rows.push(navRow);
  return { reply_markup: { inline_keyboard: rows } };
}

function productKeyboard(codigo) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "🟢 Quiero éste",
            callback_data: `prod:${codigo}`,
          },
        ],
        [
          {
            text: "📣 Compartir",
            callback_data: `share:${codigo}`,
          },
        ],
      ],
    },
  };
}

function inlineShareBotKeyboard(links) {
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

function inlineCheckoutDeliveryKeyboard(config) {
  const env = config.envios || { activo: false };
  const rows = [];
  if (env.activo) {
    rows.push([
      { text: "🏪 Retiro en el local", callback_data: "ship:retiro" },
    ]);
    rows.push([
      { text: "🚚 Envío a domicilio", callback_data: "ship:envio" },
    ]);
  } else {
    rows.push([
      { text: "🏪 Retiro en el local", callback_data: "ship:retiro" },
    ]);
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
        text: m.label || m.nombre || "Pago",
        callback_data: `pay:${m.id || m.label}`,
      },
    ]);
  }
  rows.push([{ text: "❌ Cancelar", callback_data: "checkout:cancel" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

// -------------------- MENSAJES --------------------
async function sendWelcome(chatId, config) {
  const n = config.negocio || {};
  const texto =
    `👋 ¡Hola!\nSoy el bot de *${n.nombre || "tu negocio"}*.\n\n` +
    `✅ Podés ver el catálogo por categorías, armar tu carrito y finalizar tu pedido.\n` +
    `👇 Elegí una opción del menú para empezar:`;

  if (n.logoUrl) {
    await bot.sendPhoto(chatId, n.logoUrl, {
      caption: texto,
      parse_mode: "Markdown",
      ...mainMenuKeyboard(),
    });
  } else {
    await bot.sendMessage(chatId, texto, {
      parse_mode: "Markdown",
      ...mainMenuKeyboard(),
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
    ...mainMenuKeyboard(),
  });
}

async function showCategories(chatId, config) {
  const map = getCatalogByCategory(config);
  const cats = Array.from(map.keys());
  if (!cats.length) {
    await bot.sendMessage(
      chatId,
      "⏳ Todavía no hay productos cargados en el catálogo.",
      mainMenuKeyboard()
    );
    return;
  }
  await bot.sendMessage(chatId, "🛍️ Elegí una categoría:", inlineCategoriesKeyboard(cats));
}

async function showProductsPage(chatId, config, mode, id, page = 1) {
  let items = [];
  if (mode === "cat") {
    const map = getCatalogByCategory(config);
    const catName = decodeURIComponent(id || "");
    items = map.get(catName) || [];
  } else if (mode === "promos") {
    const promos = Array.isArray(config.promos) ? config.promos : [];
    const promoItems = [];
    for (const pr of promos) {
      const code = pr.codigo || pr;
      const p = findProduct(config, code);
      if (p) promoItems.push(p);
    }
    items = promoItems;
  }

  if (!items.length) {
    await bot.sendMessage(
      chatId,
      mode === "promos"
        ? "🔥 Todavía no hay promos cargadas."
        : "Por ahora no hay productos en esa categoría.",
      mainMenuKeyboard()
    );
    return;
  }

  const perPage = 3;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const p = Math.min(Math.max(1, Number(page || 1)), totalPages);
  const slice = items.slice((p - 1) * perPage, (p - 1) * perPage + perPage);

  // Enviamos cada producto como foto con sus botones
  for (const prod of slice) {
    const photo = prod.imagen || prod.imagenUrl || prod.image || config.negocio?.logoUrl;
    const unidad = prod.unidad ? ` / ${prod.unidad}` : "";
    const desc = prod.descripcion || "";
    const caption =
      `*${prod.nombre}*\n` +
      `💰 $${money(prod.precio)}${unidad}\n` +
      (desc ? `📝 ${desc}` : "");

    if (photo) {
      await bot.sendPhoto(chatId, photo, {
        caption,
        parse_mode: "Markdown",
        ...productKeyboard(prod.codigo),
      });
    } else {
      await bot.sendMessage(chatId, caption, {
        parse_mode: "Markdown",
        ...productKeyboard(prod.codigo),
      });
    }
  }

  // Navegación
  await bot.sendMessage(
    chatId,
    "Navegación:",
    navKeyboard(mode, id || "", p, totalPages)
  );
}

async function showCart(chatId, config, user) {
  const { subtotal, lines } = calcCartTotals(config, user);
  if (!lines.length) {
    await bot.sendMessage(
      chatId,
      "🛒 Tu carrito está vacío. ¿Querés que te muestre el catálogo?",
      mainMenuKeyboard()
    );
    return;
  }

  const msg = [];
  msg.push("🛒 *Tu carrito*");
  msg.push("");
  for (const it of lines) {
    const label = qtyLabel(it.qty, it.p.unidad);
    msg.push(`• ${label} × ${it.p.nombre} — $${money(it.line)}`);
  }
  msg.push("");
  msg.push(`Subtotal: *$${money(subtotal)}*`);

  const rows = [];
  for (const it of user.cart) {
    rows.push([
      { text: "❌ Quitar", callback_data: `rm:${it.codigo}` },
      { text: "➕ Agregar", callback_data: `inc:${it.codigo}` },
    ]);
  }
  rows.push([{ text: "🧹 Vaciar carrito", callback_data: "cart:clear" }]);
  rows.push([{ text: "✅ Finalizar compra", callback_data: "checkout:start" }]);

  await bot.sendMessage(chatId, msg.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: rows },
  });
}

async function showStamps(chatId, config, user) {
  const sellos = config.sellos || { activo: false };
  if (!sellos.activo) {
    await bot.sendMessage(
      chatId,
      "🎫 La tarjeta de sellos todavía no está activa en este negocio.",
      mainMenuKeyboard()
    );
    return;
  }
  const meta = Number(sellos.meta || 10);
  const premio = sellos.premio || "un beneficio especial";
  const actuales = Number(user.stamps || 0);

  const filled = Math.min(meta, actuales);
  const bar =
    "🟩".repeat(filled) + "⬜️".repeat(Math.max(0, meta - filled));

  const txt =
    `🎫 *${sellos.nombre || "Tarjeta de Sellos"}*\n` +
    `${bar}\n\n` +
    `Sellos: *${actuales} / ${meta}*\n` +
    `Premio al completar: *${premio}*`;

  await bot.sendMessage(chatId, txt, {
    parse_mode: "Markdown",
    ...mainMenuKeyboard(),
  });
}

// -------------------- CHECKOUT --------------------
async function startCheckout(chatId, config, user) {
  const { subtotal, lines } = calcCartTotals(config, user);
  if (!lines.length) {
    await bot.sendMessage(
      chatId,
      "Tu carrito está vacío. Primero agregá algo del catálogo 🙂",
      mainMenuKeyboard()
    );
    return;
  }
  user.checkout = {
    paso: "envio_tipo",
    envioTipo: "",
    zona: "",
    direccion: "",
    pago: "",
    horario: "",
  };
  saveData(DB);

  await bot.sendMessage(
    chatId,
    "✅ *Finalizar compra*\nElegí cómo querés recibir tu pedido:",
    {
      parse_mode: "Markdown",
      ...inlineCheckoutDeliveryKeyboard(config),
    }
  );
}

async function askAddress(chatId) {
  await bot.sendMessage(
    chatId,
    "📍 Pasame tu *dirección completa* (calle, número y referencia).",
    { parse_mode: "Markdown" }
  );
}

async function askName(chatId) {
  await bot.sendMessage(chatId, "🧾 Decime tu *nombre* para el pedido.", {
    parse_mode: "Markdown",
  });
}

async function askPhone(chatId) {
  await bot.sendMessage(chatId, "📞 Pasame tu *teléfono*.", {
    parse_mode: "Markdown",
  });
}

async function askHorario(chatId, tipo) {
  const texto =
    tipo === "envio"
      ? "⏰ ¿En qué horario te queda mejor recibir el *envío*?"
      : "⏰ ¿En qué horario te queda mejor *pasar a retirar*?";
  await bot.sendMessage(chatId, texto, { parse_mode: "Markdown" });
}

async function askPayment(chatId, config) {
  const methods = Array.isArray(config.pagos?.metodos)
    ? config.pagos.metodos
    : [];
  if (!methods.length) {
    await bot.sendMessage(
      chatId,
      "💳 No hay métodos de pago configurados todavía.",
      mainMenuKeyboard()
    );
    return;
  }
  await bot.sendMessage(chatId, "💳 Elegí método de pago:", inlinePaymentKeyboard(config));
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
    `👤 Cliente: ${profileName || (username ? `@${username}` : "")}`.trim()
  );
  if (profilePhone) parts.push(`📞 Tel: ${profilePhone}`);
  parts.push("");

  parts.push("*Detalle:*");
  for (const it of lines) {
    parts.push(
      `• ${qtyLabel(it.qty, it.p.unidad)} × ${it.p.nombre} — $${money(
        it.line
      )}`
    );
  }
  parts.push("");
  parts.push(`Subtotal: *$${money(subtotal)}*`);
  parts.push(`${ship.label}: *$${money(ship.costo)}*`);
  parts.push(`TOTAL: *$${money(total)}*`);
  parts.push("");

  if (user.checkout.envioTipo === "envio") {
    if (user.checkout.zona) parts.push(`🗺️ Zona: ${user.checkout.zona}`);
    parts.push(`📍 Dirección: ${user.checkout.direccion || "-"}`);
  } else {
    parts.push("🏪 Entrega: Retiro en el local");
  }

  if (user.checkout.horario) {
    parts.push(`⏰ Horario preferido: ${user.checkout.horario}`);
  }

  if (user.checkout.pago) {
    parts.push(`💳 Pago: ${user.checkout.pago}`);
  }

  parts.push("");
  parts.push(`🆔 ChatID cliente: ${chatId}`);

  return parts.join("\n");
}

async function finalizeOrder(chatId, config, user, username) {
  // sellos
  if (config.sellos?.activo) {
    const suma = Number(config.sellos?.sumaPorCompra || 1);
    user.stamps = Number(user.stamps || 0) + (Number.isFinite(suma) ? suma : 1);

    const meta = Number(config.sellos?.meta || 10);
    if (meta > 0 && user.stamps >= meta) {
      const premio = config.sellos?.premio || "un beneficio";
      const reset = config.sellos?.resetAlCompletar ?? true;
      await bot.sendMessage(
        chatId,
        `🎉 ¡Felicitaciones! Completaste tu tarjeta de sellos y ganaste: *${premio}*`,
        { parse_mode: "Markdown" }
      );
      if (reset) user.stamps = 0;
    }
  }

  const summary = buildOrderSummary(config, user, chatId, username);

  // aviso vendedor
  if (ADMIN_CHAT_ID) {
    try {
      await bot.sendMessage(ADMIN_CHAT_ID, summary, { parse_mode: "Markdown" });
    } catch (e) {
      console.error("No pude enviar al ADMIN_CHAT_ID:", e?.message || e);
    }
  }

  const confirmText =
    config.textos?.pedidoConfirmado ||
    (config.TextoConfirmacionPedido ||
      "Gracias. Tu compra fue confirmada y está en preparación. ✅");

  await bot.sendMessage(chatId, safeText(confirmText), mainMenuKeyboard());

  clearCart(user);
  user.checkout = {
    paso: "",
    envioTipo: "",
    zona: "",
    direccion: "",
    pago: "",
    horario: "",
  };
  saveData(DB);
}

// -------------------- HANDLERS --------------------

// /start
bot.onText(/\/start/, async (msg) => {
  try {
    const config = await fetchConfig();
    await sendWelcome(msg.chat.id, config);
  } catch (e) {
    console.error(e);
    bot.sendMessage(
      msg.chat.id,
      "Hubo un problema cargando la configuración. Probá de nuevo en unos segundos."
    );
  }
});

// mensajes de texto
bot.on("message", async (msg) => {
  try {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    if (!userId) return;

    const text = (msg.text || "").trim();
    if (!text) return;
    if (text.startsWith("/start")) return; // ya manejado

    const config = await fetchConfig();
    const user = getUser(DB, userId);

    // 1) ¿Está escribiendo cantidad para un producto?
    if (user.pendingQtyCode) {
      const prod = findProduct(config, user.pendingQtyCode);
      if (!prod) {
        user.pendingQtyCode = "";
        saveData(DB);
        await bot.sendMessage(
          chatId,
          "No encontré ese producto. Probá de nuevo desde el catálogo."
        );
        return;
      }
      const qty = parseQtyFromText(text, prod.unidad);
      if (!qty || qty <= 0) {
        const u = String(prod.unidad || "").toLowerCase();
        const ejemplo = u.includes("kg")
          ? "Por ejemplo: 250, 250g o 0.25kg"
          : "Por ejemplo: 1, 2, 3";
        await bot.sendMessage(
          chatId,
          `No entendí la cantidad 🤔. ${ejemplo}.`,
          mainMenuKeyboard()
        );
        return;
      }

      addToCart(user, prod.codigo, qty);
      user.pendingQtyCode = "";
      saveData(DB);

      await bot.sendMessage(
        chatId,
        `✅ Agregué ${qtyLabel(qty, prod.unidad)} de *${prod.nombre}* al carrito.`,
        { parse_mode: "Markdown", ...mainMenuKeyboard() }
      );
      return;
    }

    // 2) ¿Está en flujo de checkout?
    if (user.checkout?.paso) {
      const paso = user.checkout.paso;

      if (paso === "esperando_direccion") {
        user.checkout.direccion = text;
        user.checkout.paso = "esperando_nombre";
        saveData(DB);
        await askName(chatId);
        return;
      }

      if (paso === "esperando_nombre") {
        user.profile.nombre = text;
        user.checkout.paso = "esperando_telefono";
        saveData(DB);
        await askPhone(chatId);
        return;
      }

      if (paso === "esperando_telefono") {
        user.profile.telefono = text;
        user.checkout.paso = "esperando_horario";
        saveData(DB);
        await askHorario(chatId, user.checkout.envioTipo || "retiro");
        return;
      }

      if (paso === "esperando_horario") {
        user.checkout.horario = text;
        user.checkout.paso = "pago";
        saveData(DB);
        await askPayment(chatId, config);
        return;
      }

      // si está en "pago", se maneja por botones pay:
    }

    // 3) Teclado principal
    if (text === "🛍️ Catálogo") {
      return await showCategories(chatId, config);
    }
    if (text === "🔥 Promos") {
      return await showProductsPage(chatId, config, "promos", "", 1);
    }
    if (text === "🛒 Mi carrito") {
      return await showCart(chatId, config, user);
    }
    if (text === "✅ Finalizar compra") {
      return await startCheckout(chatId, config, user);
    }
    if (text === "📍 Horarios y dirección") {
      return await showBusinessInfo(chatId, config);
    }
    if (text === "📣 Compartir bot") {
      const me = await bot.getMe();
      const links = buildShareLinksForBot(
        me.username,
        config.negocio?.nombre || "el negocio"
      );
      return await bot.sendMessage(
        chatId,
        config.TextoCompartirBot ||
          "Compartí este bot con tus contactos:",
        inlineShareBotKeyboard(links)
      );
    }

    // 4) Fallback amable
    await sendWelcome(chatId, config);
  } catch (e) {
    console.error(e);
    try {
      await bot.sendMessage(
        msg.chat.id,
        "Hubo un error. Probá de nuevo en unos segundos."
      );
    } catch {}
  }
});

// callback queries
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

    if (data.startsWith("list:")) {
      await ack();
      const [, mode, encId, page] = data.split(":");
      return await showProductsPage(chatId, config, mode, encId, Number(page || 1));
    }

    if (data.startsWith("nav:")) {
      await ack();
      const [, mode, encId, page] = data.split(":");
      return await showProductsPage(chatId, config, mode, encId, Number(page || 1));
    }

    if (data.startsWith("prod:")) {
      await ack();
      const codigo = data.slice(5);
      const prod = findProduct(config, codigo);
      if (!prod) {
        return await bot.sendMessage(
          chatId,
          "Ese producto no existe. Revisá el catálogo."
        );
      }
      user.pendingQtyCode = codigo;
      saveData(DB);

      const u = String(prod.unidad || "").toLowerCase();
      const ejemplo = u.includes("kg")
        ? "Por ejemplo: 250, 250g o 0.25kg."
        : "Por ejemplo: 1, 2, 3.";
      await bot.sendMessage(
        chatId,
        `¿Cuánta cantidad querés de *${prod.nombre}*?\n${ejemplo}`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (data.startsWith("share:")) {
      await ack();
      const codigo = data.slice(6);
      const prod = findProduct(config, codigo);
      if (!prod) {
        return await bot.sendMessage(
          chatId,
          "No encontré ese producto para compartir."
        );
      }
      const n = config.negocio || {};
      const texto =
        `🧀 *${n.nombre || "Todo Queso"}*\n` +
        `Te comparto este producto:\n\n` +
        `*${prod.nombre}* — $${money(prod.precio)}${
          prod.unidad ? " / " + prod.unidad : ""
        }\n` +
        (prod.descripcion ? `_${prod.descripcion}_\n` : "") +
        (n.whatsappLink
          ? `\nPodés escribirnos acá para pedirlo:\n${n.whatsappLink}`
          : "");
      await bot.sendMessage(chatId, texto, { parse_mode: "Markdown" });
      return;
    }

    if (data === "cart:view") {
      await ack();
      return await showCart(chatId, config, user);
    }

    if (data === "cart:clear") {
      await ack();
      clearCart(user);
      saveData(DB);
      return await bot.sendMessage(
        chatId,
        "🧹 Listo, vacié el carrito.",
        mainMenuKeyboard()
      );
    }

    if (data.startsWith("inc:")) {
      await ack();
      const codigo = data.slice(4);
      addToCart(user, codigo, 1);
      saveData(DB);
      return await showCart(chatId, config, user);
    }

    if (data.startsWith("rm:")) {
      await ack();
      const codigo = data.slice(3);
      user.cart = user.cart.filter((x) => x.codigo !== codigo);
      saveData(DB);
      return await showCart(chatId, config, user);
    }

    if (data === "checkout:start") {
      await ack();
      return await startCheckout(chatId, config, user);
    }

    if (data === "checkout:cancel") {
      await ack();
      user.checkout = {
        paso: "",
        envioTipo: "",
        zona: "",
        direccion: "",
        pago: "",
        horario: "",
      };
      saveData(DB);
      return await bot.sendMessage(
        chatId,
        "Listo, cancelé el checkout.",
        mainMenuKeyboard()
      );
    }

    if (data.startsWith("ship:")) {
      await ack();
      const tipo = data.split(":")[1]; // retiro / envio
      user.checkout.envioTipo = tipo;

      const zonas = Array.isArray(config.envios?.zonas)
        ? config.envios.zonas
        : [];
      if (tipo === "envio" && zonas.length) {
        user.checkout.paso = "zona";
        saveData(DB);
        const rows = [];
        for (const z of zonas) {
          rows.push([
            {
              text: `${z.nombre} ($${money(z.costo)})`,
              callback_data: `zone:${z.nombre}`,
            },
          ]);
        }
        rows.push([
          { text: "⬅️ Volver", callback_data: "checkout:start" },
        ]);
        await bot.sendMessage(chatId, "🗺️ Elegí tu zona de envío:", {
          reply_markup: { inline_keyboard: rows },
        });
        return;
      }

      if (tipo === "envio") {
        user.checkout.paso = "esperando_direccion";
        saveData(DB);
        await askAddress(chatId);
        return;
      }

      // retiro
      user.checkout.paso = "esperando_nombre";
      saveData(DB);
      await askName(chatId);
      return;
    }

    if (data.startsWith("zone:")) {
      await ack();
      const zona = data.slice(5);
      user.checkout.zona = zona;
      user.checkout.paso = "esperando_direccion";
      saveData(DB);
      await askAddress(chatId);
      return;
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

      if (method && method.id === "transferencia") {
        const alias = method.alias || "";
        const cbu = method.cbu || "";
        let t = "💸 Datos para transferencia:\n";
        if (alias) t += `• Alias: \`${alias}\`\n`;
        if (cbu) t += `• CBU: \`${cbu}\`\n`;
        await bot.sendMessage(chatId, t, { parse_mode: "Markdown" });
      }

      const summary = buildOrderSummary(
        config,
        user,
        chatId,
        q.from?.username
      );
      await bot.sendMessage(chatId, summary, { parse_mode: "Markdown" });

      const rows = [
        [{ text: "✅ Confirmar pedido", callback_data: "order:confirm" }],
        [{ text: "❌ Cancelar", callback_data: "checkout:cancel" }],
      ];
      await bot.sendMessage(chatId, "¿Confirmás el pedido?", {
        reply_markup: { inline_keyboard: rows },
      });
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
        text: "Hubo un error. Probá de nuevo.",
        show_alert: false,
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
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
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
    console.log("Bot activo con polling.");
  }
}

start().catch((e) => {
  console.error("Error iniciando:", e?.message || e);
  process.exit(1);
});

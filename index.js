/**
 * EzerBot - Telegram Bot (Render webhook) - UI con 1 solo mensaje "vivo" + carrusel con imágenes
 * Funciones: Catálogo/Combos/Categorías/Buscar, Carrito, Checkout, Transferencia, Compartir bot/producto,
 * Referidos (/start ref_), Sellos, Panel vendedor (admin pin) con pedidos.
 *
 * ENV requeridas en Render:
 * - TELEGRAM_BOT_TOKEN
 * - GOOGLE_SHEET_ID
 * - GOOGLE_SERVICE_ACCOUNT_B64   (base64 del JSON COMPLETO, sin saltos)
 * - PUBLIC_URL                  (ej: https://ezerbot-system.onrender.com)
 * - PORT                        (Render lo define)
 *
 * Google Sheet:
 * - Hoja "Config": dos columnas: key | value  (sin encabezado o con encabezado, el código lo tolera)
 * - Hoja "Catalogo": encabezados (recomendado):
 *   codigo, nombre, precio, unidad, precio_por_kg, codigo_barras, descripcion, imagen, categoria, es_combo
 *   (imagen = URL http/https)
 *
 * Se crean si no existen:
 * - "Clientes": telegram_id, nombre, username, first_seen, referido_por
 * - "Pedidos": id, telegram_id, nombre, username, fecha, estado, envio_tipo, direccion, pago_tipo, total, items_json
 * - "Sellos": telegram_id, sellos, updated_at
 */

const express = require("express");
const crypto = require("crypto");
const TelegramBot = require("node-telegram-bot-api");
const { google } = require("googleapis");

// -------------------- Utils --------------------
const nowISO = () => new Date().toISOString();
const safeNum = (v, def = 0) => {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : def;
};
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};
const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 10);
const b64ToJson = (b64) => {
  const raw = Buffer.from(b64, "base64").toString("utf8");
  return JSON.parse(raw);
};
const escape = (s) => String(s ?? "").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// -------------------- ENV --------------------
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SA_B64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
const PUBLIC_URL = process.env.PUBLIC_URL;
const PORT = process.env.PORT || 10000;

if (!TOKEN || !SHEET_ID || !SA_B64 || !PUBLIC_URL) {
  console.error("FALTAN ENV: TELEGRAM_BOT_TOKEN, GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_B64, PUBLIC_URL");
  process.exit(1);
}

// -------------------- Google Auth --------------------
const serviceAccount = b64ToJson(SA_B64);
const jwt = new google.auth.JWT({
  email: serviceAccount.client_email,
  key: serviceAccount.private_key,
  scopes: [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.readonly",
  ],
});
const sheets = google.sheets({ version: "v4", auth: jwt });

// -------------------- Ensure sheets/tabs --------------------
async function getSpreadsheet() {
  const res = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  return res.data;
}
async function ensureTab(title, headers) {
  const ss = await getSpreadsheet();
  const exists = (ss.sheets || []).some((s) => s.properties?.title === title);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title } } }],
      },
    });
    if (headers && headers.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${title}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [headers] },
      });
    }
  }
}

// -------------------- Config loader --------------------
let CONFIG_CACHE = { at: 0, data: {} };
async function loadConfig(force = false) {
  const ttlMs = 20_000;
  if (!force && Date.now() - CONFIG_CACHE.at < ttlMs) return CONFIG_CACHE.data;

  await ensureTab("Config", ["key", "value"]);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Config!A:B",
  });

  const rows = res.data.values || [];
  const out = {};
  for (const r of rows) {
    const k = String(r[0] ?? "").trim();
    const v = String(r[1] ?? "").trim();
    if (!k || k.toLowerCase() === "key") continue;
    out[k] = v;
  }

  // defaults
  out.BRAND_NAME = out.BRAND_NAME || "EzerBot";
  out.BRAND_TAGLINE = out.BRAND_TAGLINE || "Tu asistente de compras";
  out.DEFAULT_BANNER_URL = out.DEFAULT_BANNER_URL || "https://i.imgur.com/2yaf2wb.jpeg";
  out.SUPPORT_WHATSAPP = out.SUPPORT_WHATSAPP || "";
  out.CURRENCY = out.CURRENCY || "$";
  out.ADMIN_PIN = out.ADMIN_PIN || "1234";
  out.STAMPS_PER_REWARD = out.STAMPS_PER_REWARD || "10";
  out.REWARD_TEXT = out.REWARD_TEXT || "¡Premio por sellos!";
  out.TRANSFER_ALIAS = out.TRANSFER_ALIAS || "";
  out.TRANSFER_CBU = out.TRANSFER_CBU || "";
  out.TRANSFER_HOLDER = out.TRANSFER_HOLDER || "";
  out.SHIPPING_TEXT = out.SHIPPING_TEXT || "Envío a coordinar";
  out.PICKUP_TEXT = out.PICKUP_TEXT || "Retiro por el local";

  CONFIG_CACHE = { at: Date.now(), data: out };
  return out;
}

// -------------------- Catalog loader --------------------
let CATALOG_CACHE = { at: 0, items: [] };

function normalizeHeader(h) {
  return String(h || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^\w_]/g, "");
}

async function loadCatalog(force = false) {
  const ttlMs = 20_000;
  if (!force && Date.now() - CATALOG_CACHE.at < ttlMs) return CATALOG_CACHE.items;

  await ensureTab("Catalogo", [
    "codigo",
    "nombre",
    "precio",
    "unidad",
    "precio_por_kg",
    "codigo_barras",
    "descripcion",
    "imagen",
    "categoria",
    "es_combo",
  ]);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Catalogo!A:Z",
  });
  const rows = res.data.values || [];
  if (!rows.length) {
    CATALOG_CACHE = { at: Date.now(), items: [] };
    return [];
  }

  const header = rows[0].map(normalizeHeader);
  const dataRows = rows.slice(1);

  const idx = (key) => header.indexOf(key);

  const items = [];
  for (const r of dataRows) {
    const codigo = String(r[idx("codigo")] ?? "").trim();
    if (!codigo) continue;

    const nombre = String(r[idx("nombre")] ?? "").trim();
    const precio = safeNum(r[idx("precio")], 0);
    const unidad = String(r[idx("unidad")] ?? "").trim(); // "unidad" | "kg" | etc
    const precioKg = safeNum(r[idx("precio_por_kg")], 0);
    const descripcion = String(r[idx("descripcion")] ?? "").trim();
    const imagen = String(r[idx("imagen")] ?? "").trim();
    const categoria = String(r[idx("categoria")] ?? "").trim() || "General";
    const esComboRaw = String(r[idx("es_combo")] ?? "").trim().toLowerCase();
    const esCombo = ["si", "sí", "true", "1", "combo"].includes(esComboRaw);

    items.push({
      codigo,
      nombre,
      precio,
      unidad,
      precioKg,
      descripcion,
      imagen,
      categoria,
      esCombo,
    });
  }

  CATALOG_CACHE = { at: Date.now(), items };
  return items;
}

// -------------------- Storage tabs: Clientes / Pedidos / Sellos --------------------
async function ensureStorageTabs() {
  await ensureTab("Clientes", ["telegram_id", "nombre", "username", "first_seen", "referido_por"]);
  await ensureTab("Pedidos", [
    "id",
    "telegram_id",
    "nombre",
    "username",
    "fecha",
    "estado",
    "envio_tipo",
    "direccion",
    "pago_tipo",
    "total",
    "items_json",
  ]);
  await ensureTab("Sellos", ["telegram_id", "sellos", "updated_at"]);
}

async function upsertCliente(user, referidoPor = "") {
  await ensureStorageTabs();
  const tid = String(user.id);
  const nombre = `${user.first_name || ""} ${user.last_name || ""}`.trim();
  const username = user.username ? `@${user.username}` : "";

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Clientes!A:E",
  });
  const rows = res.data.values || [];
  const headerMaybe = rows[0] || [];
  const startIdx = headerMaybe[0] === "telegram_id" ? 1 : 0;

  let foundRow = -1;
  for (let i = startIdx; i < rows.length; i++) {
    if (String(rows[i][0] ?? "") === tid) {
      foundRow = i + 1; // 1-based
      break;
    }
  }

  if (foundRow === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Clientes!A:E",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[tid, nombre, username, nowISO(), referidoPor || ""]],
      },
    });
  }
}

async function getSellos(telegramId) {
  await ensureStorageTabs();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Sellos!A:C",
  });
  const rows = res.data.values || [];
  const headerMaybe = rows[0] || [];
  const startIdx = headerMaybe[0] === "telegram_id" ? 1 : 0;

  for (let i = startIdx; i < rows.length; i++) {
    if (String(rows[i][0] ?? "") === String(telegramId)) {
      return safeNum(rows[i][1], 0);
    }
  }
  // create
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "Sellos!A:C",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[String(telegramId), "0", nowISO()]] },
  });
  return 0;
}

async function setSellos(telegramId, val) {
  await ensureStorageTabs();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Sellos!A:C",
  });
  const rows = res.data.values || [];
  const headerMaybe = rows[0] || [];
  const startIdx = headerMaybe[0] === "telegram_id" ? 1 : 0;

  for (let i = startIdx; i < rows.length; i++) {
    if (String(rows[i][0] ?? "") === String(telegramId)) {
      const rowNum = i + 1;
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `Sellos!B${rowNum}:C${rowNum}`,
        valueInputOption: "RAW",
        requestBody: { values: [[String(val), nowISO()]] },
      });
      return;
    }
  }
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "Sellos!A:C",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[String(telegramId), String(val), nowISO()]] },
  });
}

async function createPedido({ telegramId, nombre, username, envioTipo, direccion, pagoTipo, total, items }) {
  await ensureStorageTabs();
  const id = `PED-${Date.now()}-${sha1(`${telegramId}-${Math.random()}`)}`;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "Pedidos!A:K",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[
        id,
        String(telegramId),
        nombre,
        username,
        nowISO(),
        "pendiente",
        envioTipo,
        direccion,
        pagoTipo,
        String(total),
        JSON.stringify(items),
      ]],
    },
  });
  return id;
}

async function listPedidos({ estado = "pendiente", limit = 50 } = {}) {
  await ensureStorageTabs();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Pedidos!A:K",
  });
  const rows = res.data.values || [];
  const headerMaybe = rows[0] || [];
  const startIdx = headerMaybe[0] === "id" ? 1 : 0;

  const pedidos = [];
  for (let i = startIdx; i < rows.length; i++) {
    const r = rows[i];
    const p = {
      id: r[0],
      telegram_id: r[1],
      nombre: r[2],
      username: r[3],
      fecha: r[4],
      estado: r[5],
      envio_tipo: r[6],
      direccion: r[7],
      pago_tipo: r[8],
      total: safeNum(r[9], 0),
      items_json: r[10] || "[]",
      rowNum: i + 1,
    };
    if (!estado || p.estado === estado) pedidos.push(p);
  }
  return pedidos.slice(-limit).reverse();
}

async function updatePedidoEstado(rowNum, estado) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `Pedidos!F${rowNum}`,
    valueInputOption: "RAW",
    requestBody: { values: [[estado]] },
  });
}

// -------------------- Bot state (memory) --------------------
/**
 * stateByChat:
 *  mainMsgId: number
 *  screen: string
 *  cat: { mode:'all'|'combo'|'cat', category?:string, index:number }
 *  cart: { [codigo]: qty }
 *  checkout: { step, envioTipo, direccion, pagoTipo }
 *  admin: boolean
 *  adminScreen: { listIndex }
 */
const stateByChat = new Map();

function getState(chatId) {
  if (!stateByChat.has(chatId)) {
    stateByChat.set(chatId, {
      mainMsgId: null,
      screen: "HOME",
      cat: { mode: "all", index: 0, category: null },
      cart: {},
      checkout: { step: 0, envioTipo: "", direccion: "", pagoTipo: "" },
      admin: false,
      adminScreen: { listIndex: 0 },
    });
  }
  return stateByChat.get(chatId);
}

// -------------------- Telegram webhook bot --------------------
const bot = new TelegramBot(TOKEN, { webHook: { port: PORT } });

const app = express();
app.use(express.json());

app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (req, res) => res.send("OK"));

(async () => {
  await jwt.authorize();
  await ensureStorageTabs();
  await loadConfig(true);
  await loadCatalog(true);

  const hookUrl = `${PUBLIC_URL}/bot${TOKEN}`;
  await bot.setWebHook(hookUrl);
  console.log("Webhook set:", hookUrl);

  app.listen(PORT, () => console.log("Server running on", PORT));
})().catch((e) => {
  console.error("BOOT ERROR:", e);
  process.exit(1);
});

// -------------------- UI Rendering --------------------
function kb(rows) {
  return { inline_keyboard: rows };
}

function btn(text, data) {
  return { text, callback_data: data };
}
function urlBtn(text, url) {
  return { text, url };
}

function formatPrice(cfg, item) {
  const cur = cfg.CURRENCY || "$";
  if (item.unidad && item.unidad.toLowerCase() === "kg" && item.precioKg > 0) {
    return `${cur}${item.precioKg.toFixed(0)}/kg`;
  }
  return `${cur}${item.precio.toFixed(0)}`;
}

function cartTotal(itemsMap, catalog) {
  let total = 0;
  for (const [codigo, qty] of Object.entries(itemsMap)) {
    const it = catalog.find((x) => x.codigo === codigo);
    if (!it) continue;
    const price = (it.unidad && it.unidad.toLowerCase() === "kg" && it.precioKg > 0) ? it.precioKg : it.precio;
    total += price * safeNum(qty, 0);
  }
  return total;
}

function cartItemsArray(itemsMap, catalog) {
  const out = [];
  for (const [codigo, qty] of Object.entries(itemsMap)) {
    const it = catalog.find((x) => x.codigo === codigo);
    if (!it) continue;
    out.push({
      codigo,
      nombre: it.nombre,
      qty: safeNum(qty, 0),
      precio: (it.unidad && it.unidad.toLowerCase() === "kg" && it.precioKg > 0) ? it.precioKg : it.precio,
      unidad: it.unidad || "u",
      imagen: it.imagen || "",
    });
  }
  return out;
}

async function ensureMainMessage(chatId, cfg) {
  const st = getState(chatId);
  if (st.mainMsgId) return st.mainMsgId;

  // 1ra vez: mandamos FOTO + caption (para que luego podamos editar media/caption)
  const sent = await bot.sendPhoto(chatId, cfg.DEFAULT_BANNER_URL, {
    caption: `👋 Hola! Soy *${escape(cfg.BRAND_NAME)}* ✅\n${escape(cfg.BRAND_TAGLINE)}\n\nElegí una opción:`,
    parse_mode: "Markdown",
    reply_markup: kb([
      [btn("🛍️ Catálogo", "GO:CAT"), btn("🎁 Combos", "GO:COMB")],
      [btn("🧺 Carrito", "GO:CART"), btn("🚚 Envío / Retiro", "GO:SHIP")],
      [btn("💳 Transferencia", "GO:PAY"), btn("🆘 Ayuda", "GO:HELP")],
      [btn("⭐ Sellos", "GO:STAMPS"), btn("📣 Compartir bot", "SHARE:BOT")],
    ]),
  });

  st.mainMsgId = sent.message_id;
  return st.mainMsgId;
}

async function editMain(chatId, cfg, mediaUrl, caption, replyMarkup) {
  const st = getState(chatId);
  const msgId = await ensureMainMessage(chatId, cfg);

  // Si hay mediaUrl => editMessageMedia (foto)
  if (mediaUrl) {
    try {
      await bot.editMessageMedia(
        {
          type: "photo",
          media: mediaUrl,
          caption,
          parse_mode: "Markdown",
        },
        { chat_id: chatId, message_id: msgId, reply_markup: replyMarkup }
      );
      return;
    } catch (e) {
      // fallback: si falla edit media (url inválida), edit caption manteniendo imagen actual
      await bot.editMessageCaption(caption, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: replyMarkup,
      });
      return;
    }
  }

  // Solo caption
  await bot.editMessageCaption(caption, {
    chat_id: chatId,
    message_id: msgId,
    parse_mode: "Markdown",
    reply_markup: replyMarkup,
  });
}

// -------------------- Screens --------------------
async function renderHome(chatId) {
  const cfg = await loadConfig();
  const st = getState(chatId);

  st.screen = "HOME";

  const caption =
    `👋 *${escape(cfg.BRAND_NAME)}* ✅\n` +
    `${escape(cfg.BRAND_TAGLINE)}\n\n` +
    `Elegí una opción:`;

  const markup = kb([
    [btn("🛍️ Catálogo", "GO:CAT"), btn("🎁 Combos", "GO:COMB")],
    [btn("🧺 Carrito", "GO:CART"), btn("🚚 Envío / Retiro", "GO:SHIP")],
    [btn("💳 Transferencia", "GO:PAY"), btn("🆘 Ayuda", "GO:HELP")],
    [btn("⭐ Sellos", "GO:STAMPS"), btn("📣 Compartir bot", "SHARE:BOT")],
    [btn("🔐 Panel vendedor", "ADMIN:OPEN")],
  ]);

  await editMain(chatId, cfg, cfg.DEFAULT_BANNER_URL, caption, markup);
}

function buildShareBotUrl(botUsername, refTag) {
  // link deep start: https://t.me/<bot>?start=ref_<id>
  if (!botUsername) return null;
  return `https://t.me/${botUsername}?start=${encodeURIComponent(refTag)}`;
}

function buildShareProductDeeplink(botUsername, code) {
  if (!botUsername) return null;
  return `https://t.me/${botUsername}?start=${encodeURIComponent("prod_" + code)}`;
}

function buildTelegramShareLink(url, text) {
  return `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
}

async function renderHelp(chatId) {
  const cfg = await loadConfig();
  const st = getState(chatId);
  st.screen = "HELP";

  const support = cfg.SUPPORT_WHATSAPP
    ? `\n📲 Soporte WhatsApp: ${escape(cfg.SUPPORT_WHATSAPP)}`
    : "";

  const caption =
    `🆘 *Ayuda*\n\n` +
    `• Tocá *Catálogo* para ver productos con fotos.\n` +
    `• Agregá al *Carrito* y finalizá.\n` +
    `• Elegí *Envío/Retiro* y luego *Pago*.\n` +
    `• Podés *Compartir* el bot o un producto.\n\n` +
    `Comandos rápidos:\n` +
    `• /start\n` +
    `• escribí *catalogo* / *combos* / *carrito*\n` +
    support;

  const markup = kb([
    [btn("🏠 Menú", "GO:HOME")],
    [btn("🛍️ Catálogo", "GO:CAT"), btn("🧺 Carrito", "GO:CART")],
  ]);

  await editMain(chatId, cfg, cfg.DEFAULT_BANNER_URL, caption, markup);
}

async function renderStamps(chatId) {
  const cfg = await loadConfig();
  const st = getState(chatId);
  st.screen = "STAMPS";

  const sellos = await getSellos(chatId);
  const goal = safeNum(cfg.STAMPS_PER_REWARD, 10);
  const faltan = Math.max(0, goal - sellos);

  const caption =
    `⭐ *Sellos*\n\n` +
    `Tus sellos: *${sellos}*\n` +
    `Meta para premio: *${goal}*\n` +
    (faltan === 0
      ? `\n🎉 *¡Ya alcanzaste la meta!* ${escape(cfg.REWARD_TEXT)}\n`
      : `\nTe faltan *${faltan}* para el premio.\n`);

  const markup = kb([
    [btn("🏠 Menú", "GO:HOME"), btn("🛍️ Catálogo", "GO:CAT")],
  ]);

  await editMain(chatId, cfg, cfg.DEFAULT_BANNER_URL, caption, markup);
}

async function renderShipping(chatId) {
  const cfg = await loadConfig();
  const st = getState(chatId);
  st.screen = "SHIP";

  const caption =
    `🚚 *Envío / Retiro*\n\n` +
    `Elegí cómo querés recibir tu pedido:\n\n` +
    `• *Envío*: ${escape(cfg.SHIPPING_TEXT)}\n` +
    `• *Retiro*: ${escape(cfg.PICKUP_TEXT)}\n`;

  const markup = kb([
    [btn("🚚 Envío", "CHK:SHIP"), btn("🏪 Retiro", "CHK:PICKUP")],
    [btn("🏠 Menú", "GO:HOME"), btn("🧺 Carrito", "GO:CART")],
  ]);

  await editMain(chatId, cfg, cfg.DEFAULT_BANNER_URL, caption, markup);
}

async function renderPayment(chatId) {
  const cfg = await loadConfig();
  const st = getState(chatId);
  st.screen = "PAY";

  const caption =
    `💳 *Transferencia*\n\n` +
    (cfg.TRANSFER_ALIAS ? `Alias: *${escape(cfg.TRANSFER_ALIAS)}*\n` : "") +
    (cfg.TRANSFER_CBU ? `CBU: *${escape(cfg.TRANSFER_CBU)}*\n` : "") +
    (cfg.TRANSFER_HOLDER ? `Titular: *${escape(cfg.TRANSFER_HOLDER)}*\n` : "") +
    `\nCuando transfieras, en el checkout tocá *Ya transferí* para avisar.\n`;

  const markup = kb([
    [btn("🧺 Ir al carrito", "GO:CART")],
    [btn("🏠 Menú", "GO:HOME")],
  ]);

  await editMain(chatId, cfg, cfg.DEFAULT_BANNER_URL, caption, markup);
}

async function renderCatalog(chatId, mode = "all", category = null) {
  const cfg = await loadConfig();
  const st = getState(chatId);
  const catalog = await loadCatalog();

  st.screen = "CAT";
  st.cat.mode = mode;
  st.cat.category = category;

  let list = catalog;
  if (mode === "combo") list = catalog.filter((x) => x.esCombo);
  if (mode === "cat" && category) list = catalog.filter((x) => (x.categoria || "General") === category);

  if (!list.length) {
    const caption = `🛍️ *Catálogo*\n\nNo hay productos cargados todavía.`;
    const markup = kb([[btn("🏠 Menú", "GO:HOME")]]);
    await editMain(chatId, cfg, cfg.DEFAULT_BANNER_URL, caption, markup);
    return;
  }

  st.cat.index = clamp(st.cat.index, 0, list.length - 1);
  const it = list[st.cat.index];

  const qty = safeNum(st.cart[it.codigo], 0);

  const caption =
    `🛍️ *${escape(mode === "combo" ? "Combos" : "Catálogo")}*\n` +
    (mode === "cat" && category ? `📌 *${escape(category)}*\n` : "") +
    `\n*${escape(it.nombre)}*\n` +
    `💰 ${formatPrice(cfg, it)}\n` +
    (it.descripcion ? `\n${escape(it.descripcion)}\n` : "\n") +
    `🧾 Código: \`${escape(it.codigo)}\`\n` +
    `🧺 En carrito: *${qty}*\n` +
    `\n${st.cat.index + 1}/${list.length}`;

  // Botones compartir
  const botInfo = await bot.getMe().catch(() => null);
  const botUsername = botInfo?.username ? botInfo.username : "";

  const productDeeplink = buildShareProductDeeplink(botUsername, it.codigo);
  const shareUrl = productDeeplink
    ? buildTelegramShareLink(productDeeplink, `${cfg.BRAND_NAME} • ${it.nombre} • ${formatPrice(cfg, it)}`)
    : null;

  const rows = [
    [
      btn("⬅️", "CAT:PREV"),
      btn("➕ Agregar", `CART:ADD:${it.codigo}`),
      btn("➡️", "CAT:NEXT"),
    ],
    [
      btn("🧺 Carrito", "GO:CART"),
      btn("🗂️ Categorías", mode === "combo" ? "CAT:CATS:COMBO" : "CAT:CATS:ALL"),
    ],
  ];

  if (shareUrl) {
    rows.push([urlBtn("📤 Compartir este producto", shareUrl)]);
  }

  rows.push([btn("🏠 Menú", "GO:HOME")]);

  const markup = kb(rows);

  const mediaUrl = it.imagen || cfg.DEFAULT_BANNER_URL;
  await editMain(chatId, cfg, mediaUrl, caption, markup);
}

async function renderCategories(chatId, forMode = "all") {
  const cfg = await loadConfig();
  const st = getState(chatId);
  st.screen = "CATS";

  const catalog = await loadCatalog();
  let list = catalog;
  if (forMode === "combo") list = catalog.filter((x) => x.esCombo);

  const cats = Array.from(new Set(list.map((x) => x.categoria || "General"))).sort();

  const caption =
    `🗂️ *Categorías*\n\nElegí una categoría para ojeo:\n` +
    (forMode === "combo" ? "\n(Combos)\n" : "");

  // 2 botones por fila
  const rows = chunk(
    cats.map((c) => btn(`📌 ${c}`, `CAT:CAT:${forMode}:${c}`)),
    2
  );

  rows.push([btn("⬅️ Volver", forMode === "combo" ? "GO:COMB" : "GO:CAT"), btn("🏠 Menú", "GO:HOME")]);

  await editMain(chatId, cfg, cfg.DEFAULT_BANNER_URL, caption, kb(rows));
}

async function renderCart(chatId) {
  const cfg = await loadConfig();
  const st = getState(chatId);
  st.screen = "CART";

  const catalog = await loadCatalog();
  const itemsArr = cartItemsArray(st.cart, catalog);

  if (!itemsArr.length) {
    const caption = `🧺 *Carrito*\n\nTu carrito está vacío.\n\nTocá *Catálogo* para agregar productos.`;
    const markup = kb([[btn("🛍️ Catálogo", "GO:CAT"), btn("🎁 Combos", "GO:COMB")], [btn("🏠 Menú", "GO:HOME")]]);
    await editMain(chatId, cfg, cfg.DEFAULT_BANNER_URL, caption, markup);
    return;
  }

  // carrusel del carrito: guardamos un índice adentro de st.cat.index? mejor separado:
  if (typeof st.cartIndex !== "number") st.cartIndex = 0;
  st.cartIndex = clamp(st.cartIndex, 0, itemsArr.length - 1);

  const it = itemsArr[st.cartIndex];
  const total = cartTotal(st.cart, catalog);

  const caption =
    `🧺 *Carrito*\n\n` +
    `*${escape(it.nombre)}*\n` +
    `Cantidad: *${it.qty}*\n` +
    `Precio: ${cfg.CURRENCY}${it.precio.toFixed(0)}\n\n` +
    `Total carrito: *${cfg.CURRENCY}${total.toFixed(0)}*\n` +
    `\n${st.cartIndex + 1}/${itemsArr.length}`;

  const markup = kb([
    [btn("⬅️", "CART:PREV"), btn("➖", `CART:DEC:${it.codigo}`), btn("➕", `CART:INC:${it.codigo}`), btn("➡️", "CART:NEXT")],
    [btn("🗑️ Quitar", `CART:DEL:${it.codigo}`), btn("🧹 Vaciar", "CART:CLEAR")],
    [btn("✅ Finalizar compra", "CHK:START")],
    [btn("🛍️ Seguir comprando", "GO:CAT"), btn("🏠 Menú", "GO:HOME")],
  ]);

  const mediaUrl = it.imagen || cfg.DEFAULT_BANNER_URL;
  await editMain(chatId, cfg, mediaUrl, caption, markup);
}

async function renderCheckout(chatId) {
  const cfg = await loadConfig();
  const st = getState(chatId);
  st.screen = "CHK";

  const catalog = await loadCatalog();
  const total = cartTotal(st.cart, catalog);

  // Paso 0: elegir envío/retiro
  if (st.checkout.step === 0) {
    const caption =
      `✅ *Finalizar compra*\n\n` +
      `Total: *${cfg.CURRENCY}${total.toFixed(0)}*\n\n` +
      `Paso 1/3 — ¿Envío o retiro?`;

    const markup = kb([
      [btn("🚚 Envío", "CHK:SHIP"), btn("🏪 Retiro", "CHK:PICKUP")],
      [btn("⬅️ Volver al carrito", "GO:CART"), btn("🏠 Menú", "GO:HOME")],
    ]);
    await editMain(chatId, cfg, cfg.DEFAULT_BANNER_URL, caption, markup);
    return;
  }

  // Paso 1: dirección si envío
  if (st.checkout.step === 1 && st.checkout.envioTipo === "envio") {
    const caption =
      `✅ *Finalizar compra*\n\n` +
      `Total: *${cfg.CURRENCY}${total.toFixed(0)}*\n\n` +
      `Paso 2/3 — Envío\n` +
      `📍 Tocá el botón para *enviar ubicación* (recomendado) o escribí la dirección.`;

    const markup = kb([
      [btn("📍 Ya envié ubicación", "CHK:ADDR:OK")],
      [btn("⬅️ Atrás", "CHK:BACK"), btn("🏠 Menú", "GO:HOME")],
    ]);

    await editMain(chatId, cfg, cfg.DEFAULT_BANNER_URL, caption, markup);
    return;
  }

  // Paso 1: retiro no requiere dirección
  if (st.checkout.step === 1 && st.checkout.envioTipo === "retiro") {
    st.checkout.direccion = "Retiro en local";
    st.checkout.step = 2;
  }

  // Paso 2: pago
  if (st.checkout.step === 2) {
    const caption =
      `✅ *Finalizar compra*\n\n` +
      `Total: *${cfg.CURRENCY}${total.toFixed(0)}*\n\n` +
      `Paso 3/3 — Elegí forma de pago:`;

    const markup = kb([
      [btn("💵 Efectivo", "CHK:PAY:CASH"), btn("💳 Transferencia", "CHK:PAY:TRF")],
      [btn("⬅️ Atrás", "CHK:BACK"), btn("🏠 Menú", "GO:HOME")],
    ]);

    await editMain(chatId, cfg, cfg.DEFAULT_BANNER_URL, caption, markup);
    return;
  }

  // Paso 3: confirmación
  const itemsArr = cartItemsArray(st.cart, catalog);
  const itemsText = itemsArr
    .map((x) => `• ${x.nombre} x${x.qty} (${cfg.CURRENCY}${x.precio.toFixed(0)})`)
    .slice(0, 12)
    .join("\n");

  const caption =
    `🧾 *Confirmación*\n\n` +
    `Envío: *${escape(st.checkout.envioTipo)}*\n` +
    `Dirección: *${escape(st.checkout.direccion)}*\n` +
    `Pago: *${escape(st.checkout.pagoTipo)}*\n\n` +
    `🛒 Items:\n${escape(itemsText)}\n\n` +
    `Total: *${cfg.CURRENCY}${total.toFixed(0)}*`;

  const markupRows = [
    [btn("✅ Confirmar pedido", "CHK:CONFIRM")],
    [btn("⬅️ Atrás", "CHK:BACK"), btn("🏠 Menú", "GO:HOME")],
  ];

  // Si es transferencia, agregamos botón "Ver datos" y "Ya transferí"
  if (st.checkout.pagoTipo === "transferencia") {
    markupRows.unshift([btn("💳 Ver datos transferencia", "GO:PAY"), btn("📎 Ya transferí", "CHK:PAID")]);
  }

  await editMain(chatId, cfg, cfg.DEFAULT_BANNER_URL, caption, kb(markupRows));
}

async function renderAdmin(chatId) {
  const cfg = await loadConfig();
  const st = getState(chatId);
  st.screen = "ADMIN";

  const caption =
    `🔐 *Panel vendedor*\n\n` +
    `Opciones:\n` +
    `• Ver pedidos pendientes\n` +
    `• Marcar pedido como listo / entregado\n` +
    `• Sumar sellos a cliente\n`;

  const markup = kb([
    [btn("📦 Pedidos pendientes", "ADM:LIST:PEND")],
    [btn("⭐ Sumador de sellos", "ADM:STAMPS")],
    [btn("🏠 Menú", "GO:HOME")],
  ]);

  await editMain(chatId, cfg, cfg.DEFAULT_BANNER_URL, caption, markup);
}

async function renderAdminPedidos(chatId, estado = "pendiente") {
  const cfg = await loadConfig();
  const st = getState(chatId);
  st.screen = "ADM_LIST";

  const pedidos = await listPedidos({ estado, limit: 50 });
  if (!pedidos.length) {
    const caption = `📦 *Pedidos (${escape(estado)})*\n\nNo hay pedidos en este estado.`;
    const markup = kb([[btn("⬅️ Volver", "ADMIN:OPEN"), btn("🏠 Menú", "GO:HOME")]]);
    await editMain(chatId, cfg, cfg.DEFAULT_BANNER_URL, caption, markup);
    return;
  }

  st.adminScreen.listIndex = clamp(st.adminScreen.listIndex, 0, pedidos.length - 1);
  const p = pedidos[st.adminScreen.listIndex];

  let items = [];
  try { items = JSON.parse(p.items_json || "[]"); } catch {}
  const itemsTxt = (items || []).slice(0, 10).map((x) => `• ${x.nombre} x${x.qty}`).join("\n");

  const caption =
    `📦 *Pedido*\n\n` +
    `ID: \`${escape(p.id)}\`\n` +
    `Cliente: *${escape(p.nombre)}* ${escape(p.username)}\n` +
    `Estado: *${escape(p.estado)}*\n` +
    `Envío: *${escape(p.envio_tipo)}*\n` +
    `Dirección: *${escape(p.direccion)}*\n` +
    `Pago: *${escape(p.pago_tipo)}*\n` +
    `Total: *${cfg.CURRENCY}${p.total.toFixed(0)}*\n\n` +
    `Items:\n${escape(itemsTxt)}\n\n` +
    `${st.adminScreen.listIndex + 1}/${pedidos.length}`;

  const markup = kb([
    [btn("⬅️", "ADM:PREV"), btn("➡️", "ADM:NEXT")],
    [btn("✅ Marcar 'listo'", `ADM:STATUS:${p.rowNum}:listo`), btn("🚚 Marcar 'entregado'", `ADM:STATUS:${p.rowNum}:entregado`)],
    [btn("⭐ +1 sello al cliente", `ADM:STAMP:${p.telegram_id}:1`), btn("⭐ +3 sellos", `ADM:STAMP:${p.telegram_id}:3`)],
    [btn("⬅️ Volver", "ADMIN:OPEN"), btn("🏠 Menú", "GO:HOME")],
  ]);

  await editMain(chatId, cfg, cfg.DEFAULT_BANNER_URL, caption, markup);
}

async function renderAdminStamps(chatId) {
  const cfg = await loadConfig();
  const st = getState(chatId);
  st.screen = "ADM_STAMPS";

  const caption =
    `⭐ *Sellos (vendedor)*\n\n` +
    `Usá esto desde un pedido pendiente para sumar sellos.\n` +
    `O mandá: /sellos <telegram_id> <cantidad>\n\n` +
    `Ej: /sellos 123456789 2`;

  const markup = kb([[btn("📦 Pedidos pendientes", "ADM:LIST:PEND")], [btn("⬅️ Volver", "ADMIN:OPEN"), btn("🏠 Menú", "GO:HOME")]]);
  await editMain(chatId, cfg, cfg.DEFAULT_BANNER_URL, caption, markup);
}

// -------------------- Share actions --------------------
async function renderShareBot(chatId) {
  const cfg = await loadConfig();
  const st = getState(chatId);

  const me = await bot.getMe().catch(() => null);
  const botUsername = me?.username ? me.username : "";

  const refTag = `ref_${chatId}`;
  const deeplink = buildShareBotUrl(botUsername, refTag);

  const caption =
    `📣 *Compartir*\n\n` +
    `Compartí el bot con tus contactos.\n` +
    `Si alguien entra por tu link, queda registrado como *referido*.\n`;

  const rows = [];
  if (deeplink) {
    const shareLink = buildTelegramShareLink(deeplink, `${cfg.BRAND_NAME} • Comprá fácil desde Telegram ✅`);
    rows.push([urlBtn("📤 Compartir el bot", shareLink)]);
  }
  rows.push([btn("🏠 Menú", "GO:HOME")]);

  await editMain(chatId, cfg, cfg.DEFAULT_BANNER_URL, caption, kb(rows));
}

// -------------------- Handlers --------------------
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const user = msg.from || {};
  const cfg = await loadConfig();

  // referral / product deep links
  const payload = (match && match[1]) ? String(match[1]).trim() : "";
  let referidoPor = "";

  if (payload.startsWith("ref_")) {
    referidoPor = payload.replace("ref_", "").trim();
  }

  await upsertCliente(user, referidoPor);

  // si start=prod_CODE => abrir producto directo
  if (payload.startsWith("prod_")) {
    const code = payload.replace("prod_", "").trim();
    const st = getState(chatId);
    // buscar en catálogo
    const catalog = await loadCatalog();
    const idx = catalog.findIndex((x) => x.codigo === code);
    if (idx >= 0) {
      st.cat.mode = "all";
      st.cat.category = null;
      st.cat.index = idx;
      await ensureMainMessage(chatId, cfg);
      await renderCatalog(chatId, "all", null);
      return;
    }
  }

  await ensureMainMessage(chatId, cfg);
  await renderHome(chatId);
});

bot.onText(/\/admin\s+(\S+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const pin = String(match[1] || "");
  const cfg = await loadConfig();
  const st = getState(chatId);

  if (pin === cfg.ADMIN_PIN) {
    st.admin = true;
    await bot.deleteMessage(chatId, String(msg.message_id)).catch(() => {});
    await renderAdmin(chatId);
  } else {
    await bot.deleteMessage(chatId, String(msg.message_id)).catch(() => {});
    await bot.answerCallbackQuery({ callback_query_id: "0", text: "PIN incorrecto" }).catch(() => {});
    await renderHome(chatId);
  }
});

bot.onText(/\/sellos\s+(\d+)\s+(\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const cfg = await loadConfig();
  const st = getState(chatId);

  if (!st.admin) {
    await bot.deleteMessage(chatId, String(msg.message_id)).catch(() => {});
    return;
  }
  const tid = match[1];
  const qty = safeNum(match[2], 0);

  const current = await getSellos(tid);
  await setSellos(tid, current + qty);

  await bot.deleteMessage(chatId, String(msg.message_id)).catch(() => {});
  await renderAdmin(chatId);
});

bot.on("message", async (msg) => {
  // Para mantener el chat limpio: ignoramos texto normal y no respondemos con mensajes nuevos.
  // Solo tomamos texto si el checkout necesita dirección o búsqueda.
  const chatId = msg.chat.id;
  const st = getState(chatId);

  if (!msg.text) return;

  const t = msg.text.trim().toLowerCase();
  if (t === "catalogo" || t === "catálogo") {
    await renderCatalog(chatId, "all", null);
    return;
  }
  if (t === "combos") {
    await renderCatalog(chatId, "combo", null);
    return;
  }
  if (t === "carrito") {
    await renderCart(chatId);
    return;
  }
  if (t === "ayuda") {
    await renderHelp(chatId);
    return;
  }

  // Dirección: si estamos en checkout esperando dirección
  if (st.screen === "CHK" && st.checkout.step === 1 && st.checkout.envioTipo === "envio" && !st.checkout.direccion) {
    st.checkout.direccion = msg.text.trim();
    st.checkout.step = 2;
    // intentamos borrar el mensaje del usuario para “limpiar” (no siempre permite)
    await bot.deleteMessage(chatId, String(msg.message_id)).catch(() => {});
    await renderCheckout(chatId);
  }
});

bot.on("location", async (msg) => {
  const chatId = msg.chat.id;
  const st = getState(chatId);

  if (st.screen === "CHK" && st.checkout.step === 1 && st.checkout.envioTipo === "envio") {
    const loc = msg.location;
    if (loc) {
      st.checkout.direccion = `Ubicación: https://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
      st.checkout.step = 2;
      await bot.deleteMessage(chatId, String(msg.message_id)).catch(() => {});
      await renderCheckout(chatId);
    }
  }
});

bot.on("callback_query", async (q) => {
  const chatId = q.message?.chat?.id;
  if (!chatId) return;
  const data = q.data || "";
  const st = getState(chatId);

  const cfg = await loadConfig();
  const catalog = await loadCatalog();

  // popup silencioso
  const toast = async (text) => {
    await bot.answerCallbackQuery(q.id, { text, show_alert: false }).catch(() => {});
  };

  // Navegación general
  if (data === "GO:HOME") return renderHome(chatId);
  if (data === "GO:HELP") return renderHelp(chatId);
  if (data === "GO:SHIP") return renderShipping(chatId);
  if (data === "GO:PAY") return renderPayment(chatId);
  if (data === "GO:CART") return renderCart(chatId);
  if (data === "GO:STAMPS") return renderStamps(chatId);
  if (data === "GO:CAT") {
    st.cat.mode = "all";
    st.cat.category = null;
    st.cat.index = 0;
    return renderCatalog(chatId, "all", null);
  }
  if (data === "GO:COMB") {
    st.cat.mode = "combo";
    st.cat.category = null;
    st.cat.index = 0;
    return renderCatalog(chatId, "combo", null);
  }
  if (data === "SHARE:BOT") return renderShareBot(chatId);

  // Admin
  if (data === "ADMIN:OPEN") {
    // entra si ya está admin, sino muestra instrucción
    if (st.admin) return renderAdmin(chatId);

    const caption =
      `🔐 *Panel vendedor*\n\n` +
      `Para entrar:\n` +
      `Mandá: /admin PIN\n\n` +
      `Ejemplo: /admin ${escape(cfg.ADMIN_PIN)}\n\n` +
      `(Después podés borrar el mensaje, el bot intenta limpiarlo.)`;
    const markup = kb([[btn("🏠 Menú", "GO:HOME")]]);
    await editMain(chatId, cfg, cfg.DEFAULT_BANNER_URL, caption, markup);
    return;
  }

  if (data === "ADM:LIST:PEND") {
    if (!st.admin) return renderHome(chatId);
    st.adminScreen.listIndex = 0;
    return renderAdminPedidos(chatId, "pendiente");
  }
  if (data === "ADM:PREV") {
    if (!st.admin) return renderHome(chatId);
    st.adminScreen.listIndex = Math.max(0, (st.adminScreen.listIndex || 0) - 1);
    return renderAdminPedidos(chatId, "pendiente");
  }
  if (data === "ADM:NEXT") {
    if (!st.admin) return renderHome(chatId);
    st.adminScreen.listIndex = (st.adminScreen.listIndex || 0) + 1;
    return renderAdminPedidos(chatId, "pendiente");
  }
  if (data.startsWith("ADM:STATUS:")) {
    if (!st.admin) return renderHome(chatId);
    const [, , rowNum, estado] = data.split(":");
    await updatePedidoEstado(Number(rowNum), estado);
    await toast(`Estado: ${estado}`);
    return renderAdminPedidos(chatId, "pendiente");
  }
  if (data === "ADM:STAMPS") {
    if (!st.admin) return renderHome(chatId);
    return renderAdminStamps(chatId);
  }
  if (data.startsWith("ADM:STAMP:")) {
    if (!st.admin) return renderHome(chatId);
    const [, , tid, qtyStr] = data.split(":");
    const qty = safeNum(qtyStr, 1);
    const current = await getSellos(tid);
    await setSellos(tid, current + qty);
    await toast(`⭐ Sellos +${qty}`);
    return renderAdminPedidos(chatId, "pendiente");
  }

  // Categorías
  if (data === "CAT:CATS:ALL") return renderCategories(chatId, "all");
  if (data === "CAT:CATS:COMBO") return renderCategories(chatId, "combo");
  if (data.startsWith("CAT:CAT:")) {
    const [, , forMode, catName] = data.split(":");
    st.cat.mode = "cat";
    st.cat.category = catName;
    st.cat.index = 0;
    return renderCatalog(chatId, "cat", catName);
  }

  // Carrusel catálogo
  if (data === "CAT:PREV" || data === "CAT:NEXT") {
    const mode = st.cat.mode || "all";
    const category = st.cat.category || null;

    let list = catalog;
    if (mode === "combo") list = catalog.filter((x) => x.esCombo);
    if (mode === "cat" && category) list = catalog.filter((x) => (x.categoria || "General") === category);

    if (!list.length) return renderCatalog(chatId, mode, category);

    if (data === "CAT:PREV") st.cat.index = (st.cat.index - 1 + list.length) % list.length;
    if (data === "CAT:NEXT") st.cat.index = (st.cat.index + 1) % list.length;

    return renderCatalog(chatId, mode === "cat" ? "cat" : mode, category);
  }

  // Carrito - agregar desde catálogo
  if (data.startsWith("CART:ADD:")) {
    const code = data.split(":")[2];
    st.cart[code] = safeNum(st.cart[code], 0) + 1;
    await toast("✅ Agregado");
    // mantener en la misma pantalla
    const mode = st.cat.mode || "all";
    const category = st.cat.category || null;
    return renderCatalog(chatId, mode === "cat" ? "cat" : mode, category);
  }

  // Carrito carrusel
  if (data === "CART:PREV" || data === "CART:NEXT") {
    const itemsArr = cartItemsArray(st.cart, catalog);
    if (!itemsArr.length) return renderCart(chatId);
    if (typeof st.cartIndex !== "number") st.cartIndex = 0;

    if (data === "CART:PREV") st.cartIndex = (st.cartIndex - 1 + itemsArr.length) % itemsArr.length;
    if (data === "CART:NEXT") st.cartIndex = (st.cartIndex + 1) % itemsArr.length;

    return renderCart(chatId);
  }
  if (data.startsWith("CART:INC:")) {
    const code = data.split(":")[2];
    st.cart[code] = safeNum(st.cart[code], 0) + 1;
    await toast("➕");
    return renderCart(chatId);
  }
  if (data.startsWith("CART:DEC:")) {
    const code = data.split(":")[2];
    st.cart[code] = Math.max(0, safeNum(st.cart[code], 0) - 1);
    if (st.cart[code] === 0) delete st.cart[code];
    await toast("➖");
    return renderCart(chatId);
  }
  if (data.startsWith("CART:DEL:")) {
    const code = data.split(":")[2];
    delete st.cart[code];
    await toast("🗑️ Quitado");
    return renderCart(chatId);
  }
  if (data === "CART:CLEAR") {
    st.cart = {};
    st.cartIndex = 0;
    await toast("🧹 Vacío");
    return renderCart(chatId);
  }

  // Checkout
  if (data === "CHK:START") {
    st.checkout = { step: 0, envioTipo: "", direccion: "", pagoTipo: "" };
    return renderCheckout(chatId);
  }
  if (data === "CHK:SHIP") {
    st.checkout.envioTipo = "envio";
    st.checkout.step = 1;
    st.checkout.direccion = "";
    return renderCheckout(chatId);
  }
  if (data === "CHK:PICKUP") {
    st.checkout.envioTipo = "retiro";
    st.checkout.step = 2; // salta a pago
    st.checkout.direccion = "Retiro en local";
    return renderCheckout(chatId);
  }
  if (data === "CHK:ADDR:OK") {
    // El usuario puede mandar ubicación; si no la mandó, deja placeholder
    if (!st.checkout.direccion) st.checkout.direccion = "Dirección a confirmar";
    st.checkout.step = 2;
    return renderCheckout(chatId);
  }
  if (data === "CHK:PAY:CASH") {
    st.checkout.pagoTipo = "efectivo";
    st.checkout.step = 3;
    return renderCheckout(chatId);
  }
  if (data === "CHK:PAY:TRF") {
    st.checkout.pagoTipo = "transferencia";
    st.checkout.step = 3;
    return renderCheckout(chatId);
  }
  if (data === "CHK:BACK") {
    st.checkout.step = Math.max(0, st.checkout.step - 1);
    if (st.checkout.step < 2) st.checkout.pagoTipo = "";
    if (st.checkout.step === 0) {
      st.checkout.envioTipo = "";
      st.checkout.direccion = "";
    }
    return renderCheckout(chatId);
  }
  if (data === "CHK:PAID") {
    await toast("📎 Aviso enviado al vendedor");
    // no ensuciamos el chat; el pedido lo verá el vendedor
    return renderCheckout(chatId);
  }
  if (data === "CHK:CONFIRM") {
    // Crear pedido y limpiar carrito
    const user = q.from || {};
    const nombre = `${user.first_name || ""} ${user.last_name || ""}`.trim();
    const username = user.username ? `@${user.username}` : "";
    const total = cartTotal(st.cart, catalog);
    const items = cartItemsArray(st.cart, catalog);

    if (!items.length) {
      await toast("Carrito vacío");
      return renderCart(chatId);
    }

    const pedidoId = await createPedido({
      telegramId: chatId,
      nombre,
      username,
      envioTipo: st.checkout.envioTipo || "envio",
      direccion: st.checkout.direccion || "A confirmar",
      pagoTipo: st.checkout.pagoTipo || "efectivo",
      total,
      items,
    });

    // Sumatoria de sellos automática por compra (1 sello por pedido confirmado, ajustable)
    const currentSellos = await getSellos(chatId);
    await setSellos(chatId, currentSellos + 1);

    st.cart = {};
    st.cartIndex = 0;
    st.checkout = { step: 0, envioTipo: "", direccion: "", pagoTipo: "" };

    await toast("✅ Pedido confirmado");

    const caption =
      `✅ *Pedido confirmado*\n\n` +
      `ID: \`${escape(pedidoId)}\`\n` +
      `En breve te respondemos.\n\n` +
      `⭐ Sumaste *1* sello.\n` +
      `Tocá *Catálogo* para seguir comprando.`;

    const markup = kb([
      [btn("🛍️ Catálogo", "GO:CAT"), btn("🎁 Combos", "GO:COMB")],
      [btn("⭐ Ver sellos", "GO:STAMPS"), btn("🏠 Menú", "GO:HOME")],
    ]);

    await editMain(chatId, cfg, cfg.DEFAULT_BANNER_URL, caption, markup);
    return;
  }
});

// -------------------- Boot: primera pantalla al primer ping --------------------
bot.on("polling_error", (e) => console.error("polling_error", e));

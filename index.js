// index.js
import express from "express";
import TelegramBot from "node-telegram-bot-api";
import { google } from "googleapis";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const SHEET_ID = (process.env.SHEET_ID || "").trim();
const GOOGLE_SERVICE_ACCOUNT_JSON = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "").trim();
const GOOGLE_SERVICE_ACCOUNT_B64 = (process.env.GOOGLE_SERVICE_ACCOUNT_B64 || "").trim();

if (!SHEET_ID) throw new Error("Falta SHEET_ID");
if (!TELEGRAM_BOT_TOKEN) throw new Error("Falta TELEGRAM_BOT_TOKEN");
if (!GOOGLE_SERVICE_ACCOUNT_JSON && !GOOGLE_SERVICE_ACCOUNT_B64) {
  throw new Error("Falta GOOGLE_SERVICE_ACCOUNT_JSON o GOOGLE_SERVICE_ACCOUNT_B64");
}

const svcJson = GOOGLE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON)
  : JSON.parse(Buffer.from(GOOGLE_SERVICE_ACCOUNT_B64, "base64").toString("utf8"));

const auth = new google.auth.JWT({
  email: svcJson.client_email,
  key: svcJson.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});

const sheets = google.sheets({ version: "v4", auth });

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

const state = {
  config: {},
  catalog: [],
  catalogByCat: new Map(),
  lastLoadAt: 0,
  loading: false,
};

const sessions = new Map(); // chatId -> { step, cart: [{code,name,price,qty}], current: {code,...}, cat, page }

function norm(s) {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function num(v) {
  const s = String(v ?? "").replace(/\./g, "").replace(/,/g, ".").trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function money(n) {
  const currency = state.config.currency || "$";
  const decimals = Number(state.config.money_decimals ?? 0);
  const fixed = Number.isFinite(decimals) ? decimals : 0;
  const val = Number(n || 0).toFixed(fixed);
  return `${currency}${val}`;
}

async function sheetValues(rangeA1) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: rangeA1,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  return res.data.values || [];
}

async function loadConfig() {
  const values = await sheetValues("Config!A:B");
  const cfg = {};
  for (let i = 0; i < values.length; i++) {
    const k = String(values[i][0] ?? "").trim();
    const v = values[i][1];
    if (!k) continue;
    cfg[k] = v;
  }
  state.config = cfg;
}

function rowToObj(headers, row) {
  const o = {};
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    o[h] = row[i] ?? "";
  }
  return o;
}

async function loadCatalog() {
  const values = await sheetValues("Catalogo!A:Z");
  if (!values.length) {
    state.catalog = [];
    state.catalogByCat = new Map();
    return;
  }
  const headersRaw = values[0].map((h) => String(h ?? "").trim());
  const headers = headersRaw.map((h) => norm(h));

  const idx = {
    codigo: headers.indexOf("codigo"),
    nombre: headers.indexOf("nombre"),
    precio: headers.indexOf("precio"),
    categoria: headers.indexOf("categoria"),
    unidad: headers.indexOf("unidad"),
    precioporkg: headers.indexOf("precio por kg"),
    codigobarras: headers.indexOf("codigo de barras"),
    descripcion: headers.indexOf("descripcion"),
    imagen: headers.indexOf("imagen"),
    activo: headers.indexOf("activo"),
  };

  const out = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (!row || row.every((c) => String(c ?? "").trim() === "")) continue;

    const codigo = idx.codigo >= 0 ? String(row[idx.codigo] ?? "").trim() : "";
    const nombre = idx.nombre >= 0 ? String(row[idx.nombre] ?? "").trim() : "";
    const categoria = idx.categoria >= 0 ? String(row[idx.categoria] ?? "").trim() : "Sin categoría";
    const unidad = idx.unidad >= 0 ? String(row[idx.unidad] ?? "").trim() : "";
    const precio = idx.precio >= 0 ? num(row[idx.precio]) : 0;
    const precioPorKg = idx.precioporkg >= 0 ? num(row[idx.precioporkg]) : 0;

    const activoRaw = idx.activo >= 0 ? String(row[idx.activo] ?? "").trim() : "";
    const activo = activoRaw ? !["0", "no", "false", "inactivo"].includes(norm(activoRaw)) : true;

    if (!activo) continue;
    if (!codigo && !nombre) continue;

    out.push({
      codigo,
      nombre,
      categoria,
      unidad,
      precio,
      precioPorKg,
      descripcion: idx.descripcion >= 0 ? String(row[idx.descripcion] ?? "").trim() : "",
      imagen: idx.imagen >= 0 ? String(row[idx.imagen] ?? "").trim() : "",
      codigoBarras: idx.codigobarras >= 0 ? String(row[idx.codigobarras] ?? "").trim() : "",
    });
  }

  const byCat = new Map();
  for (const p of out) {
    const cat = p.categoria || "Sin categoría";
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(p);
  }

  for (const [cat, arr] of byCat.entries()) {
    arr.sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"));
    byCat.set(cat, arr);
  }

  state.catalog = out;
  state.catalogByCat = byCat;
}

async function loadAll(force = false) {
  const now = Date.now();
  const ttlMs = Number(state.config.cache_ms ?? 60000);
  if (!force && state.lastLoadAt && now - state.lastLoadAt < ttlMs) return;
  if (state.loading) return;
  state.loading = true;
  try {
    await loadConfig();
    await loadCatalog();
    state.lastLoadAt = Date.now();
  } finally {
    state.loading = false;
  }
}

function getCfgText(key, fallback = "") {
  const v = state.config[key];
  if (v === undefined || v === null) return fallback;
  return String(v);
}

function mainKeyboard() {
  return {
    resize_keyboard: true,
    keyboard: [
      [{ text: "🛍️ Catálogo" }],
      [{ text: "🎟️ Sellos" }, { text: "📣 Compartir bot" }],
      [{ text: "🆘 Ayuda" }],
    ],
  };
}

function catKeyboard() {
  return {
    resize_keyboard: true,
    keyboard: [
      [{ text: "📚 Categorías" }, { text: "📚 Todas" }],
      [{ text: "🛒 Ver carrito" }, { text: "✅ Finalizar compra" }],
      [{ text: "🏠 Menú" }],
    ],
  };
}

function inlineCategories() {
  const cats = Array.from(state.catalogByCat.keys());
  cats.sort((a, b) => a.localeCompare(b, "es"));
  const rows = [];
  const perRow = 2;
  for (let i = 0; i < cats.length; i += perRow) {
    rows.push(
      cats.slice(i, i + perRow).map((c) => ({
        text: c,
        callback_data: `CAT|${c}`,
      }))
    );
  }
  rows.push([{ text: "Volver", callback_data: "BACK_MENU" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function productPage(cat, page, perPage) {
  const list = cat === "__ALL__" ? state.catalog : state.catalogByCat.get(cat) || [];
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const p = Math.min(Math.max(1, page), pages);
  const start = (p - 1) * perPage;
  const slice = list.slice(start, start + perPage);
  return { slice, total, page: p, pages };
}

function productText(p) {
  const line1 = p.nombre ? `*${escapeMd(p.nombre)}*` : "*Producto*";
  const code = p.codigo ? `\nCódigo: \`${escapeMd(p.codigo)}\`` : "";
  const desc = p.descripcion ? `\n${escapeMd(p.descripcion)}` : "";
  const unit = p.unidad ? `\nUnidad: ${escapeMd(p.unidad)}` : "";
  const price =
    p.precioPorKg > 0
      ? `\nPrecio: ${money(p.precioPorKg)} / kg`
      : p.precio > 0
      ? `\nPrecio: ${money(p.precio)}`
      : "";
  return `${line1}${code}${price}${unit}${desc}`;
}

function escapeMd(s) {
  return String(s)
    .replace(/[_*[\]()~`>#+-=|{}.!]/g, "\\$&")
    .trim();
}

async function showProducts(chatId, cat, page = 1) {
  await loadAll(false);

  const perPage = Number(state.config.catalog_per_page ?? 6);
  const { slice, total, pages, page: p } = productPage(cat, page, perPage);

  if (total === 0) {
    await bot.sendMessage(chatId, "No hay productos cargados en el catálogo.", { reply_markup: catKeyboard() });
    return;
  }

  const rows = [];
  for (const prod of slice) {
    const labelPrice = prod.precioPorKg > 0 ? `${money(prod.precioPorKg)}/kg` : prod.precio > 0 ? money(prod.precio) : "";
    const label = `${prod.nombre || prod.codigo}${labelPrice ? " • " + labelPrice : ""}`;
    rows.push([{ text: label.slice(0, 60), callback_data: `PROD|${cat}|${p}|${prod.codigo || prod.nombre}` }]);
  }

  const nav = [];
  if (p > 1) nav.push({ text: "⬅️", callback_data: `PAGE|${cat}|${p - 1}` });
  nav.push({ text: `Página ${p}/${pages}`, callback_data: "NOOP" });
  if (p < pages) nav.push({ text: "➡️", callback_data: `PAGE|${cat}|${p + 1}` });
  rows.push(nav);

  rows.push([{ text: "🛒 Ver carrito", callback_data: "CART" }, { text: "✅ Finalizar", callback_data: "CHECKOUT" }]);
  rows.push([{ text: "🏠 Menú", callback_data: "BACK_MENU" }]);

  const title = cat === "__ALL__" ? "Catálogo (todas)" : `Catálogo (${cat})`;
  await bot.sendMessage(chatId, `${title}\nProductos: ${total}`, {
    reply_markup: { inline_keyboard: rows },
  });

  const sess = sessions.get(chatId) || {};
  sessions.set(chatId, { ...sess, cat, page: p, step: "BROWSING", cart: sess.cart || [] });
}

function getProductByKey(cat, key) {
  const list = cat === "__ALL__" ? state.catalog : state.catalogByCat.get(cat) || [];
  const k = String(key || "").trim();
  return (
    list.find((p) => p.codigo && p.codigo === k) ||
    list.find((p) => p.nombre && p.nombre === k) ||
    state.catalog.find((p) => p.codigo && p.codigo === k) ||
    state.catalog.find((p) => p.nombre && p.nombre === k) ||
    null
  );
}

function cartTotal(cart) {
  let t = 0;
  for (const it of cart) t += (it.price || 0) * (it.qty || 0);
  return t;
}

function cartText(cart) {
  if (!cart.length) return "Tu carrito está vacío.";
  let txt = "🛒 *Tu carrito*\n\n";
  cart.forEach((it, i) => {
    txt += `${i + 1}) ${escapeMd(it.name)} • ${it.qty} x ${money(it.price)} = ${money(it.qty * it.price)}\n`;
  });
  txt += `\nTotal: *${money(cartTotal(cart))}*`;
  return txt;
}

function buildOrderWhatsApp(cart, extra = "") {
  const wa = String(state.config.whatsapp_order || state.config.whatsapp || "").trim();
  const phone = wa.replace(/[^\d]/g, "");
  const header = getCfgText("order_header", "Hola! Quiero hacer este pedido:");
  let msg = `${header}\n\n`;
  cart.forEach((it) => {
    msg += `- ${it.name} x${it.qty}\n`;
  });
  msg += `\nTotal aprox: ${money(cartTotal(cart))}`;
  if (extra) msg += `\n\n${extra}`;
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
  return { phone, url };
}

async function sendWelcome(chatId, firstName = "") {
  await loadAll(false);
  const brand = getCfgText("brand_name", "Todo Queso");
  const welcome =
    getCfgText("welcome_message", "") ||
    `Hola ${firstName || ""} 👋\nBienvenido/a a ${brand} 🧀\nElegí una opción 👇`;
  await bot.sendMessage(chatId, welcome.trim(), { reply_markup: mainKeyboard() });
}

async function sendHelp(chatId) {
  await loadAll(false);
  const help =
    getCfgText("help_message", "") ||
    "Si te faltó algo, no encontraste un producto o querés hacer una consulta, escribinos y te ayudamos 😊";
  await bot.sendMessage(chatId, help.trim(), { reply_markup: mainKeyboard() });
}

async function sendSellos(chatId) {
  await loadAll(false);
  const cardUrl = getCfgText("card_url", "").trim();
  const sellosText = getCfgText("sellos_message", "Abrí tu tarjeta acá:");
  if (cardUrl) {
    await bot.sendMessage(chatId, `${sellosText}\n${cardUrl}`, { reply_markup: mainKeyboard() });
  } else {
    await bot.sendMessage(chatId, "Falta card_url en Config.", { reply_markup: mainKeyboard() });
  }
}

async function sendShare(chatId) {
  await loadAll(false);
  const email = getCfgText("contact_email", "ezerbot.assistant@gmail.com");
  const demo = getCfgText("demo_bot", "");
  const wa = getCfgText("contact_whatsapp", "");
  const tg = getCfgText("contact_telegram", "");
  const txt =
    getCfgText("share_message", "¿Querés este sistema para tu negocio? Contactános") +
    `\n\n📩 Email: ${email}` +
    (demo ? `\n🔗 Demo: ${demo}` : "") +
    `\n\n${wa ? "📣 WhatsApp: " + wa : ""}${tg ? "\n✈️ Telegram: " + tg : ""}`;
  await bot.sendMessage(chatId, txt.trim(), { reply_markup: mainKeyboard() });
}

bot.onText(/^\/start$/i, async (msg) => {
  const chatId = msg.chat.id;
  sessions.set(chatId, { step: "MENU", cart: [] });
  await sendWelcome(chatId, msg.from?.first_name || "");
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text || text.startsWith("/")) return;

  const sess = sessions.get(chatId) || { step: "MENU", cart: [] };
  sessions.set(chatId, sess);

  if (text === "🏠 Menú") {
    sess.step = "MENU";
    await sendWelcome(chatId, msg.from?.first_name || "");
    return;
  }

  if (text === "🛍️ Catálogo") {
    sess.step = "CAT_MENU";
    await bot.sendMessage(chatId, "Elegí una opción:", { reply_markup: catKeyboard() });
    return;
  }

  if (text === "📚 Categorías") {
    await loadAll(false);
    await bot.sendMessage(chatId, "Categorías (elegí una):", inlineCategories());
    return;
  }

  if (text === "📚 Todas") {
    await showProducts(chatId, "__ALL__", 1);
    return;
  }

  if (text === "🎟️ Sellos") {
    await sendSellos(chatId);
    return;
  }

  if (text === "📣 Compartir bot") {
    await sendShare(chatId);
    return;
  }

  if (text === "🆘 Ayuda") {
    await sendHelp(chatId);
    return;
  }

  if (text === "🛒 Ver carrito") {
    const cart = sess.cart || [];
    await bot.sendMessage(chatId, cartText(cart), { parse_mode: "MarkdownV2", reply_markup: catKeyboard() });
    return;
  }

  if (text === "✅ Finalizar compra") {
    const cart = sess.cart || [];
    if (!cart.length) {
      await bot.sendMessage(chatId, "Tu carrito está vacío.", { reply_markup: catKeyboard() });
      return;
    }
    const { url } = buildOrderWhatsApp(cart);
    if (!url) {
      await bot.sendMessage(chatId, "Falta whatsapp_order en Config.", { reply_markup: catKeyboard() });
      return;
    }
    await bot.sendMessage(chatId, `Listo ✅\nEnviá tu pedido por WhatsApp:\n${url}`, { reply_markup: catKeyboard() });
    return;
  }

  if (sess.step === "ASK_QTY" && sess.current) {
    const q = Number(String(text).replace(",", "."));
    if (!Number.isFinite(q) || q <= 0) {
      await bot.sendMessage(chatId, "Ingresá una cantidad válida (ej: 1, 2, 0.25).");
      return;
    }
    const prod = sess.current;
    const item = { code: prod.codigo || prod.nombre, name: prod.nombre || prod.codigo, price: prod.price, qty: q };
    sess.cart = sess.cart || [];
    sess.cart.push(item);
    sess.current = null;
    sess.step = "BROWSING";
    await bot.sendMessage(chatId, `Agregado ✅\n${item.name} x${item.qty}`, { reply_markup: catKeyboard() });
    if (sess.cat) await showProducts(chatId, sess.cat, sess.page || 1);
    return;
  }
});

bot.on("callback_query", async (q) => {
  const chatId = q.message?.chat?.id;
  if (!chatId) return;

  const data = q.data || "";
  const sess = sessions.get(chatId) || { step: "MENU", cart: [] };
  sessions.set(chatId, sess);

  try {
    if (data === "NOOP") {
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data === "BACK_MENU") {
      await bot.answerCallbackQuery(q.id);
      await sendWelcome(chatId, "");
      return;
    }

    if (data.startsWith("CAT|")) {
      await bot.answerCallbackQuery(q.id);
      const cat = data.split("|").slice(1).join("|");
      await showProducts(chatId, cat, 1);
      return;
    }

    if (data.startsWith("PAGE|")) {
      await bot.answerCallbackQuery(q.id);
      const [, cat, pageStr] = data.split("|");
      const page = Number(pageStr || "1");
      await showProducts(chatId, cat, page);
      return;
    }

    if (data === "CART") {
      await bot.answerCallbackQuery(q.id);
      const cart = sess.cart || [];
      await bot.sendMessage(chatId, cartText(cart), { parse_mode: "MarkdownV2", reply_markup: catKeyboard() });
      return;
    }

    if (data === "CHECKOUT") {
      await bot.answerCallbackQuery(q.id);
      const cart = sess.cart || [];
      if (!cart.length) {
        await bot.sendMessage(chatId, "Tu carrito está vacío.", { reply_markup: catKeyboard() });
        return;
      }
      const { url } = buildOrderWhatsApp(cart);
      if (!url) {
        await bot.sendMessage(chatId, "Falta whatsapp_order en Config.", { reply_markup: catKeyboard() });
        return;
      }
      await bot.sendMessage(chatId, `Listo ✅\nEnviá tu pedido por WhatsApp:\n${url}`, { reply_markup: catKeyboard() });
      return;
    }

    if (data.startsWith("PROD|")) {
      await bot.answerCallbackQuery(q.id);
      await loadAll(false);

      const [, cat, pageStr, key] = data.split("|");
      const prod = getProductByKey(cat, key);
      if (!prod) {
        await bot.sendMessage(chatId, "No pude encontrar ese producto.", { reply_markup: catKeyboard() });
        return;
      }

      const price = prod.precioPorKg > 0 ? prod.precioPorKg : prod.precio;
      sess.current = { ...prod, price };
      sess.cat = cat;
      sess.page = Number(pageStr || "1");
      sess.step = "ASK_QTY";

      await bot.sendMessage(chatId, productText(prod), { parse_mode: "MarkdownV2" });
      await bot.sendMessage(chatId, "¿Qué cantidad querés? (ej: 1, 2, 0.25)", { reply_markup: catKeyboard() });
      return;
    }

    await bot.answerCallbackQuery(q.id);
  } catch (e) {
    try {
      await bot.answerCallbackQuery(q.id, { text: "Error" });
    } catch {}
    await bot.sendMessage(chatId, "Ocurrió un error. Reintentá con /start");
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.listen(PORT, () => console.log(`RUN ${PORT}`));

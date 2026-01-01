import express from "express";
import TelegramBot from "node-telegram-bot-api";
import { google } from "googleapis";

const {
  TELEGRAM_BOT_TOKEN,
  GOOGLE_SHEET_ID,
  GOOGLE_SERVICE_ACCOUNT_JSON,
  GOOGLE_SERVICE_ACCOUNT_B64,
  PORT,
} = process.env;

if (!TELEGRAM_BOT_TOKEN) throw new Error("Falta variable de entorno: TELEGRAM_BOT_TOKEN");
if (!GOOGLE_SHEET_ID) throw new Error("Falta variable de entorno: GOOGLE_SHEET_ID");

function loadServiceAccount() {
  if (GOOGLE_SERVICE_ACCOUNT_B64 && GOOGLE_SERVICE_ACCOUNT_B64.trim()) {
    const json = Buffer.from(GOOGLE_SERVICE_ACCOUNT_B64.trim(), "base64").toString("utf8");
    return JSON.parse(json);
  }
  if (GOOGLE_SERVICE_ACCOUNT_JSON && GOOGLE_SERVICE_ACCOUNT_JSON.trim()) {
    return JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON.trim());
  }
  throw new Error("Falta GOOGLE_SERVICE_ACCOUNT_B64 o GOOGLE_SERVICE_ACCOUNT_JSON");
}

const SA = loadServiceAccount();

const auth = new google.auth.JWT({
  email: SA.client_email,
  key: SA.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});

const sheets = google.sheets({ version: "v4", auth });

async function readRange(range) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  return res.data.values || [];
}

// Cache liviano para no golpear Sheets a cada click
let cache = {
  ts: 0,
  config: null,
  catalog: null,
};
const CACHE_MS = 30_000;

async function loadAll(force = false) {
  const now = Date.now();
  if (!force && cache.config && cache.catalog && now - cache.ts < CACHE_MS) return cache;

  const configRows = await readRange("Config!A:B");
  const catalogRows = await readRange("Catalogo!A:Z");

  const config = parseConfig(configRows);
  const catalog = parseCatalog(catalogRows);

  cache = { ts: now, config, catalog };
  return cache;
}

function parseConfig(rows) {
  // Espera formato: A=key, B=value (sin tocar tu hoja)
  const obj = {};
  for (const r of rows) {
    const k = (r?.[0] ?? "").toString().trim();
    if (!k) continue;
    const v = (r?.[1] ?? "").toString().trim();
    obj[k] = v;
  }

  // Defaults (si no existen en Config, igual funciona)
  const brand_name = obj.brand_name || "Todo Queso";
  const currency = obj.currency || "$";
  const catalog_per_page = Number(obj.catalog_per_page || 8);
  const welcome_message =
    obj.welcome_message ||
    `🧀 *${brand_name}*\n\nElegí una opción 👇`;
  const help_message =
    obj.help_message ||
    `Si te faltó algo, no encontraste un producto o querés hacer una consulta, escribinos y te ayudamos 😊\n\nGracias por elegir *${brand_name}* 🧀`;

  const sellos_message =
    obj.sellos_message ||
    "📌 *Sellos*\nAbrí tu tarjeta para ver tus sellos y beneficios.";

  const share_message =
    obj.share_message ||
    "📣 ¿Querés este sistema para tu negocio? Contactános:";

  return {
    ...obj,
    brand_name,
    currency,
    catalog_per_page: Number.isFinite(catalog_per_page) && catalog_per_page > 0 ? catalog_per_page : 8,
    welcome_message,
    help_message,
    sellos_message,
    share_message,
  };
}

function normalizeHeader(s) {
  return (s || "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[áàä]/g, "a")
    .replace(/[éèë]/g, "e")
    .replace(/[íìï]/g, "i")
    .replace(/[óòö]/g, "o")
    .replace(/[úùü]/g, "u")
    .replace(/ñ/g, "n");
}

function parseCatalog(rows) {
  if (!rows.length) return { items: [], categories: ["Todas"] };

  const header = rows[0].map(normalizeHeader);
  const idx = (nameCandidates) => {
    for (const c of nameCandidates) {
      const i = header.indexOf(normalizeHeader(c));
      if (i >= 0) return i;
    }
    return -1;
  };

  const iCodigo = idx(["codigo", "code", "id", "sku"]);
  const iNombre = idx(["nombre", "producto", "name"]);
  const iPrecio = idx(["precio", "price"]);
  const iCategoria = idx(["categoria", "categoría", "rubro"]);
  const iUnidad = idx(["unidad", "unit"]);
  const iImagen = idx(["imagen", "image", "foto"]);
  const iDescripcion = idx(["descripcion", "descripción", "desc"]);

  const items = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const codigo = (row?.[iCodigo] ?? "").toString().trim();
    const nombre = (row?.[iNombre] ?? "").toString().trim();
    const precio = row?.[iPrecio];
    const categoria = (row?.[iCategoria] ?? "").toString().trim() || "Sin categoría";
    const unidad = (row?.[iUnidad] ?? "").toString().trim();
    const imagen = (row?.[iImagen] ?? "").toString().trim();
    const descripcion = (row?.[iDescripcion] ?? "").toString().trim();

    if (!codigo && !nombre) continue;

    items.push({
      codigo: codigo || `ROW${r}`,
      nombre: nombre || codigo || `Producto ${r}`,
      precio: typeof precio === "number" ? precio : Number(precio || 0),
      categoria,
      unidad,
      imagen,
      descripcion,
    });
  }

  const categories = Array.from(new Set(items.map((x) => x.categoria))).sort((a, b) => a.localeCompare(b));
  categories.unshift("Todas");

  return { items, categories };
}

// Carritos en memoria por usuario (simple y funciona)
const carts = new Map(); // userId -> { [codigo]: qty }

function getCart(userId) {
  if (!carts.has(userId)) carts.set(userId, {});
  return carts.get(userId);
}
function cartCount(cart) {
  return Object.values(cart).reduce((a, b) => a + (Number(b) || 0), 0);
}

function mainKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🛍️ Catálogo" }],
        [{ text: "🎟️ Sellos" }, { text: "📣 Compartir bot" }],
        [{ text: "🆘 Ayuda" }],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
    parse_mode: "Markdown",
  };
}

function categoriesKeyboard(categories) {
  const rows = [];
  const row = [];
  for (const c of categories) {
    row.push({ text: `📚 ${c}` });
    if (row.length === 2) {
      rows.push([...row]);
      row.length = 0;
    }
  }
  if (row.length) rows.push([...row]);
  rows.push([{ text: "🏠 Menú" }]);
  return { reply_markup: { keyboard: rows, resize_keyboard: true } };
}

function money(n, currency) {
  const num = Number(n || 0);
  const rounded = Math.round(num);
  return `${currency} ${rounded.toLocaleString("es-AR")}`;
}

function buildCatalogPage({ items, category, page, perPage }) {
  const filtered = category && category !== "Todas"
    ? items.filter((x) => x.categoria === category)
    : items;

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const p = Math.min(Math.max(1, page), totalPages);
  const start = (p - 1) * perPage;
  const slice = filtered.slice(start, start + perPage);

  return { slice, total, totalPages, page: p, category: category || "Todas" };
}

function inlineCatalogKeyboard({ category, page, totalPages, slice }) {
  const rows = [];
  for (const it of slice) {
    rows.push([
      { text: `➕ ${it.nombre}`, callback_data: `ADD|${it.codigo}` },
    ]);
  }

  const nav = [];
  if (page > 1) nav.push({ text: "⬅️", callback_data: `PAGE|${category}|${page - 1}` });
  nav.push({ text: `📄 ${page}/${totalPages}`, callback_data: "NOP" });
  if (page < totalPages) nav.push({ text: "➡️", callback_data: `PAGE|${category}|${page + 1}` });

  rows.push(nav);

  rows.push([
    { text: "🛒 Ver carrito", callback_data: "CART" },
    { text: "📚 Categorías", callback_data: "CATS" },
  ]);

  return { reply_markup: { inline_keyboard: rows } };
}

function safeUrl(u) {
  if (!u) return "";
  const s = u.toString().trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) return "";
  return s;
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Web server (Render)
const app = express();
app.get("/", async (_req, res) => {
  res.status(200).send("OK");
});
app.listen(Number(PORT || 3000), () => {});

async function sendWelcome(chatId) {
  const { config } = await loadAll();
  await bot.sendMessage(chatId, config.welcome_message, mainKeyboard());
}

bot.onText(/\/start/, async (msg) => {
  try {
    await sendWelcome(msg.chat.id);
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `Error: ${e.message}`);
  }
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = (msg.text || "").trim();

  try {
    const { config, catalog } = await loadAll();

    if (text === "🏠 Menú") {
      await bot.sendMessage(chatId, config.welcome_message, mainKeyboard());
      return;
    }

    if (text === "🛍️ Catálogo") {
      if (!catalog.items.length) {
        await bot.sendMessage(
          chatId,
          `🛍️ *Catálogo*\n\nTodavía no hay productos cargados en *Catalogo* o no se están leyendo.\n\n✅ Revisá:\n- Que la hoja se llame *Catalogo*\n- Que tenga encabezados (Código/Nombre/Precio/Categoría)\n- Que la service account tenga acceso al Sheet`,
          { parse_mode: "Markdown" }
        );
        return;
      }

      await bot.sendMessage(chatId, "📚 *Categorías*\nElegí una:", {
        parse_mode: "Markdown",
        ...categoriesKeyboard(catalog.categories),
      });
      return;
    }

    if (text.startsWith("📚 ")) {
      const category = text.replace("📚 ", "").trim();
      const perPage = config.catalog_per_page;

      const pageData = buildCatalogPage({
        items: catalog.items,
        category,
        page: 1,
        perPage,
      });

      const lines = [];
      lines.push(`🛍️ *${config.brand_name}*`);
      lines.push(`📚 *${pageData.category}*`);
      lines.push("");
      for (const it of pageData.slice) {
        const p = money(it.precio, config.currency);
        const unit = it.unidad ? ` (${it.unidad})` : "";
        lines.push(`• *${it.nombre}*${unit} — ${p}`);
      }
      lines.push("");
      lines.push("Elegí un producto para agregar al carrito 👇");

      await bot.sendMessage(chatId, lines.join("\n"), {
        parse_mode: "Markdown",
        ...inlineCatalogKeyboard({
          category: pageData.category,
          page: pageData.page,
          totalPages: pageData.totalPages,
          slice: pageData.slice,
        }),
      });
      return;
    }

    if (text === "🎟️ Sellos") {
      const cardUrl = safeUrl(config.card_url);
      const lines = [];
      lines.push(config.sellos_message);
      if (cardUrl) lines.push(`\n🔗 ${cardUrl}`);
      await bot.sendMessage(chatId, lines.join("\n"), { parse_mode: "Markdown", ...mainKeyboard() });
      return;
    }

    if (text === "🆘 Ayuda") {
      await bot.sendMessage(chatId, config.help_message, { parse_mode: "Markdown", ...mainKeyboard() });
      return;
    }

    if (text === "📣 Compartir bot") {
      const demo = safeUrl(config.demo_bot);
      const email = config.contact_email || "";
      const wa = config.contact_whatsapp || "";
      const tg = config.contact_telegram || "";

      const parts = [];
      parts.push(config.share_message);
      if (email) parts.push(`✉️ Email: ${email}`);
      if (demo) parts.push(`🔗 Demo: ${demo}`);
      if (wa) parts.push(`📣 WhatsApp: ${wa}`);
      if (tg) parts.push(`✈️ Telegram: ${tg}`);

      await bot.sendMessage(chatId, parts.join("\n"), { ...mainKeyboard() });
      return;
    }

    // Si escriben algo random, volvemos a menú
    if (text && !text.startsWith("/")) {
      await bot.sendMessage(chatId, config.welcome_message, mainKeyboard());
      return;
    }
  } catch (e) {
    try {
      await bot.sendMessage(chatId, `Error: ${e.message}`);
    } catch {}
  }
});

bot.on("callback_query", async (q) => {
  const chatId = q.message?.chat?.id;
  const userId = q.from?.id;
  const data = q.data || "";

  try {
    if (!chatId || !userId) return;

    const { config, catalog } = await loadAll();

    if (data === "NOP") {
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data === "CATS") {
      await bot.answerCallbackQuery(q.id);
      await bot.sendMessage(chatId, "📚 *Categorías*\nElegí una:", {
        parse_mode: "Markdown",
        ...categoriesKeyboard(catalog.categories),
      });
      return;
    }

    if (data.startsWith("PAGE|")) {
      const [, category, pageStr] = data.split("|");
      const page = Number(pageStr || 1);
      const perPage = config.catalog_per_page;

      const pageData = buildCatalogPage({
        items: catalog.items,
        category,
        page,
        perPage,
      });

      const lines = [];
      lines.push(`🛍️ *${config.brand_name}*`);
      lines.push(`📚 *${pageData.category}*`);
      lines.push("");
      for (const it of pageData.slice) {
        const p = money(it.precio, config.currency);
        const unit = it.unidad ? ` (${it.unidad})` : "";
        lines.push(`• *${it.nombre}*${unit} — ${p}`);
      }
      lines.push("");
      lines.push("Elegí un producto para agregar al carrito 👇");

      await bot.answerCallbackQuery(q.id);
      await bot.editMessageText(lines.join("\n"), {
        chat_id: chatId,
        message_id: q.message.message_id,
        parse_mode: "Markdown",
        ...inlineCatalogKeyboard({
          category: pageData.category,
          page: pageData.page,
          totalPages: pageData.totalPages,
          slice: pageData.slice,
        }),
      });
      return;
    }

    if (data.startsWith("ADD|")) {
      const [, code] = data.split("|");
      const item = catalog.items.find((x) => x.codigo === code);
      if (!item) {
        await bot.answerCallbackQuery(q.id, { text: "No encontré ese producto." });
        return;
      }

      const cart = getCart(userId);
      cart[code] = (Number(cart[code] || 0) + 1);

      await bot.answerCallbackQuery(q.id, { text: `Agregado: ${item.nombre}` });
      return;
    }

    if (data === "CART") {
      const cart = getCart(userId);
      const codes = Object.keys(cart);
      if (!codes.length) {
        await bot.answerCallbackQuery(q.id);
        await bot.sendMessage(chatId, "🛒 Tu carrito está vacío.", { ...mainKeyboard() });
        return;
      }

      let total = 0;
      const lines = [];
      lines.push("🛒 *Tu carrito*");
      lines.push("");

      for (const code of codes) {
        const qty = Number(cart[code] || 0);
        const it = catalog.items.find((x) => x.codigo === code);
        if (!it || qty <= 0) continue;

        const sub = (Number(it.precio || 0) * qty);
        total += sub;

        lines.push(`• *${it.nombre}* x${qty} — ${money(sub, config.currency)}`);
      }

      lines.push("");
      lines.push(`*Total:* ${money(total, config.currency)}`);

      const orderText = lines.join("\n").replace(/\*/g, "");
      const waOrder = safeUrl(config.whatsapp_order);

      const inline = {
        inline_keyboard: [
          waOrder
            ? [{ text: "✅ Comprar por WhatsApp", url: `${waOrder}${encodeURIComponent("\n\n" + orderText)}` }]
            : [{ text: "✅ Comprar", callback_data: "BUYINFO" }],
          [{ text: "🗑️ Vaciar carrito", callback_data: "CLEARCART" }],
        ],
      };

      await bot.answerCallbackQuery(q.id);
      await bot.sendMessage(chatId, lines.join("\n"), { parse_mode: "Markdown", reply_markup: inline });
      return;
    }

    if (data === "CLEARCART") {
      carts.set(userId, {});
      await bot.answerCallbackQuery(q.id, { text: "Carrito vaciado." });
      await bot.sendMessage(chatId, "🗑️ Listo. Carrito vacío.", { ...mainKeyboard() });
      return;
    }

    if (data === "BUYINFO") {
      await bot.answerCallbackQuery(q.id);
      await bot.sendMessage(
        chatId,
        "Para habilitar compra directa por WhatsApp sin tocar tu Catálogo, cargá en *Config* la clave `whatsapp_order` con tu link base (wa.me/... ?text=). Si no querés tocar Config, decime y lo hardcodeo en ENV.",
        { parse_mode: "Markdown" }
      );
      return;
    }

    await bot.answerCallbackQuery(q.id);
  } catch (e) {
    try {
      await bot.answerCallbackQuery(q.id, { text: "Error" });
      await bot.sendMessage(chatId, `Error: ${e.message}`);
    } catch {}
  }
});

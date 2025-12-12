/**
 * EzerBot-System - index.js (LISTO PARA PEGAR)
 * ENV requeridas:
 * - BOT_TOKEN
 * - WEBHOOK_URL   (ej: https://ezerbot-system.onrender.com/webhook)
 * - GAS_URL       (tu Apps Script /exec que devuelve catálogo)
 * - PORT          (Render lo setea, default 10000)
 */

import express from "express";
import TelegramBot from "node-telegram-bot-api";

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const GAS_URL = process.env.GAS_URL;
const PORT = Number(process.env.PORT || 10000);

if (!BOT_TOKEN) throw new Error("Falta ENV BOT_TOKEN");
if (!GAS_URL) throw new Error("Falta ENV GAS_URL");
if (!WEBHOOK_URL) throw new Error("Falta ENV WEBHOOK_URL (https://.../webhook)");

/** =========================
 *  Helpers
 *  ========================= */
const safeText = (v) => (v === null || v === undefined ? "" : String(v));

function moneyARS(n) {
  const num = Number(String(n).replace(",", "."));
  if (!Number.isFinite(num)) return safeText(n);
  return num.toLocaleString("es-AR");
}

function waShareLink(text) {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

function buildShareText(tenantName, item) {
  const name = safeText(item.name);
  const price = safeText(item.price);
  const code = safeText(item.code);
  return `🧀 ${tenantName}\n\n🔥 Producto:\n${name}\n💲 ${price} ARS\n🆔 ${code}\n\nPedilo por acá 👇`;
}

/** =========================
 *  Bot + Webhook (Express)
 *  ========================= */
const bot = new TelegramBot(BOT_TOKEN, { webHook: true });

const app = express();
app.use(express.json());

app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

// Ver webhook actual
app.get("/debug", async (_req, res) => {
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
    const j = await r.json();
    res.status(200).json({ ok: true, webhook: j });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e) });
  }
});

// Ver qué devuelve GAS (CLAVE para tu "no hay categorías")
app.get("/gas", async (_req, res) => {
  try {
    const r = await fetch(GAS_URL, { method: "GET" });
    const raw = await r.text();
    let json = null;
    try { json = JSON.parse(raw); } catch {}
    res.status(200).json({
      ok: true,
      status: r.status,
      isJSON: !!json,
      preview: json ? json : raw.slice(0, 2000),
    });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e) });
  }
});

app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.listen(PORT, async () => {
  await bot.setWebHook(WEBHOOK_URL);
  console.log(`✅ Server activo en puerto ${PORT}`);
  console.log(`✅ Webhook seteado: ${WEBHOOK_URL}`);
  console.log(`✅ GAS_URL: ${GAS_URL}`);
});

// Nunca rompas el proceso por errores no capturados
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

/** =========================
 *  Config negocio
 *  ========================= */
const TENANT = {
  name: "TODO QUESO CLUB",
  welcome:
    "Productos frescos, promos y beneficios exclusivos.\n\n" +
    "Hola Jenny 👋\n" +
    "Soy el asistente de TODO QUESO CLUB 🧀\n\n" +
    "Desde acá podés:\n" +
    "• Ver el catálogo\n" +
    "• Armar tu pedido\n" +
    "• Sumar sellos\n" +
    "• Hablar con nosotros\n\n" +
    "👇 Elegí una opción",
};

/** =========================
 *  Estados (memoria)
 *  ========================= */
const browserState = new Map(); // chatId -> { category, page, items, perPage }
const pendingQty = new Map();   // chatId -> { item }
const lastCatalogMsgs = new Map(); // chatId -> [msgId...]

/** =========================
 *  Teclado principal (ReplyKeyboard)
 *  ========================= */
function mainMenuKeyboard() {
  return {
    keyboard: [
      ["🛍️ Catálogo", "🛒 Mi carrito"],
      ["🎁 Mis sellos"],
      ["💬 Hablar con el vendedor"],
      ["🏪 Información del local", "📣 Compartir el bot"],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

async function sendWelcome(chatId) {
  await bot.sendMessage(chatId, TENANT.welcome, {
    reply_markup: mainMenuKeyboard(),
    disable_web_page_preview: true,
  });
}

/** =========================
 *  GAS: traer catálogo (parser robusto)
 *  Acepta:
 *   - {items:[...]}
 *   - {data:{items:[...]}}
 *   - {result:{items:[...]}}
 *   - {data:[...]}
 *   - {result:[...]}
 *   - [...] (array directo)
 *  ========================= */
function normalizeItems(any) {
  // devuelve un array “candidato” donde sea que esté
  if (!any) return [];
  if (Array.isArray(any)) return any;

  if (Array.isArray(any.items)) return any.items;
  if (any.data && Array.isArray(any.data.items)) return any.data.items;
  if (any.result && Array.isArray(any.result.items)) return any.result.items;

  if (Array.isArray(any.data)) return any.data;
  if (Array.isArray(any.result)) return any.result;

  // algunos GAS devuelven {ok:true, payload:{...}}
  if (any.payload && Array.isArray(any.payload.items)) return any.payload.items;
  if (any.payload && Array.isArray(any.payload)) return any.payload;

  return [];
}

function normalizeOne(x) {
  return {
    code: safeText(x.code || x.id || x.ID || x.Codigo || x.codigo || x.sku || x.SKU),
    name: safeText(x.name || x.nombre || x.Nombre || x.producto || x.Producto),
    price: safeText(x.price || x.precio || x.Precio || x.valor || x.Valor),
    category: safeText(x.category || x.categoria || x.Categoria || x.rubro || x.Rubro || "General"),
    desc: safeText(x.desc || x.descripcion || x.Descripcion || ""),
    imageUrl: safeText(x.imageUrl || x.imagen || x.Imagen || x.foto || x.Foto || x.url || x.URL || ""),
  };
}

async function fetchCatalog() {
  const r = await fetch(GAS_URL, { method: "GET" });
  const raw = await r.text();

  let j = null;
  try { j = JSON.parse(raw); } catch {}

  const base = j ?? raw;
  const arr = normalizeItems(base);

  const items = arr
    .map(normalizeOne)
    .filter((it) => it.code && it.name);

  return items;
}

function getCategories(items) {
  const set = new Set();
  for (const it of items) set.add(it.category || "General");
  return Array.from(set).sort((a, b) => a.localeCompare(b, "es"));
}

/** =========================
 *  Catálogo: limpieza
 *  ========================= */
async function clearCatalogMsgs(chatId) {
  const ids = lastCatalogMsgs.get(chatId) || [];
  for (const id of ids) {
    try { await bot.deleteMessage(chatId, id); } catch {}
  }
  lastCatalogMsgs.set(chatId, []);
}

/** =========================
 *  UI: captions y teclados inline
 *  (SIEMPRE texto plano, SIN parse_mode)
 *  ========================= */
function itemCaption(item) {
  const name = safeText(item.name);
  const desc = safeText(item.desc);
  const price = moneyARS(item.price);
  const code = safeText(item.code);

  let cap = `${name}\n`;
  if (desc) cap += `${desc}\n`;
  cap += `\n💲 ${price} ARS\n🆔 ${code}`;
  return cap;
}

function productInlineKeyboard(item, category) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Quiero este", callback_data: `buy:${item.code}` },
        { text: "📣 Compartir promo", callback_data: `share:${item.code}` },
      ],
      [
        { text: "↩️ Volver a categoría", callback_data: `cat:${encodeURIComponent(category)}` },
      ],
    ],
  };
}

function navInlineKeyboard(category, page, totalPages) {
  const prev = page > 0 ? page - 1 : 0;
  const next = page < totalPages - 1 ? page + 1 : totalPages - 1;

  return {
    inline_keyboard: [
      [
        { text: "⬅️ Anterior", callback_data: `page:${encodeURIComponent(category)}:${prev}` },
        { text: "📁 Categorías", callback_data: `cats` },
        { text: "➡️ Siguiente", callback_data: `page:${encodeURIComponent(category)}:${next}` },
      ],
      [{ text: "🏠 Menú", callback_data: "menu" }],
    ],
  };
}

/** =========================
 *  Flujo Catálogo
 *  ========================= */
async function showCategories(chatId) {
  await clearCatalogMsgs(chatId);

  let items = [];
  try {
    items = await fetchCatalog();
  } catch (e) {
    console.error("fetchCatalog error:", e);
    await bot.sendMessage(chatId, "⚠️ No pude leer el catálogo. Revisá /gas en Render (endpoint).", {
      reply_markup: mainMenuKeyboard(),
      disable_web_page_preview: true,
    });
    return;
  }

  if (!items.length) {
    // IMPORTANTE: acá antes te decía “no hay categorías”, pero ahora además te guía a /gas
    await bot.sendMessage(
      chatId,
      "⚠️ No hay categorías / productos cargados todavía.\n" +
        "👉 Esto pasa cuando el GAS no está devolviendo items en el formato esperado.\n" +
        "Abrí /gas en Render para ver qué devuelve tu GAS y lo ajustamos.",
      { reply_markup: mainMenuKeyboard(), disable_web_page_preview: true }
    );
    return;
  }

  const cats = getCategories(items);
  browserState.set(chatId, { category: null, page: 0, items, perPage: 3 });

  const buttons = cats.map((c) => [{ text: `📁 ${c}`, callback_data: `cat:${encodeURIComponent(c)}` }]);
  buttons.push([{ text: "🏠 Menú", callback_data: "menu" }]);

  const msg = await bot.sendMessage(chatId, "📁 Elegí una categoría:", {
    reply_markup: { inline_keyboard: buttons },
  });

  lastCatalogMsgs.set(chatId, [msg.message_id]);
}

async function showCategoryPage(chatId, category, page) {
  const st = browserState.get(chatId);
  if (!st?.items?.length) {
    await showCategories(chatId);
    return;
  }

  const itemsCat = st.items.filter((x) => (x.category || "General") === category);
  const perPage = 3;
  const totalPages = Math.max(1, Math.ceil(itemsCat.length / perPage));
  const safePage = Math.min(Math.max(Number(page) || 0, 0), totalPages - 1);

  const start = safePage * perPage;
  const pageItems = itemsCat.slice(start, start + perPage);

  await clearCatalogMsgs(chatId);

  const sentIds = [];

  for (const it of pageItems) {
    const cap = itemCaption(it);
    const kb = productInlineKeyboard(it, category);

    let msg;
    if (it.imageUrl) {
      msg = await bot.sendPhoto(chatId, it.imageUrl, {
        caption: cap,
        reply_markup: kb,
      }).catch(async () => {
        return bot.sendMessage(chatId, cap, { reply_markup: kb });
      });
    } else {
      msg = await bot.sendMessage(chatId, cap, { reply_markup: kb });
    }
    sentIds.push(msg.message_id);
  }

  const navMsg = await bot.sendMessage(
    chatId,
    `🧭 Navegación: ${category} — Página ${safePage + 1}/${totalPages}`,
    { reply_markup: navInlineKeyboard(category, safePage, totalPages) }
  );
  sentIds.push(navMsg.message_id);

  lastCatalogMsgs.set(chatId, sentIds);
  browserState.set(chatId, { ...st, category, page: safePage, perPage });
}

/** =========================
 *  Compra simple (pregunta cantidad)
 *  ========================= */
async function askQuantity(chatId, item) {
  pendingQty.set(chatId, { item });

  await bot.sendMessage(
    chatId,
    `✅ Elegiste: ${item.name}\n🆔 ${item.code}\n\n¿Cuánto querés?\nEjemplos: 200g, 1kg, 2 unidades`,
    { reply_markup: mainMenuKeyboard() }
  );
}

/** =========================
 *  Handlers
 *  ========================= */
bot.onText(/^\/start$/, async (msg) => {
  await sendWelcome(msg.chat.id);
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = safeText(msg.text).trim();

  // Cantidad
  if (pendingQty.has(chatId) && text && !text.startsWith("/")) {
    const { item } = pendingQty.get(chatId);
    pendingQty.delete(chatId);

    await bot.sendMessage(
      chatId,
      `🧾 Perfecto. Anoté:\n• ${item.name}\n• Cantidad: ${text}\n\n¿Querés sumar otro producto desde Catálogo?`,
      { reply_markup: mainMenuKeyboard() }
    );
    return;
  }

  // Menú
  if (text === "🛍️ Catálogo") return showCategories(chatId);

  if (text === "🛒 Mi carrito") {
    await bot.sendMessage(chatId, "🛒 Mi carrito (simple): por ahora te guiamos por catálogo.", {
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  if (text === "🎁 Mis sellos") {
    await bot.sendMessage(chatId, "🎁 Todavía no tenés tarjeta.\nCuando hagas tu primera compra, empezás a sumar sellos 😁", {
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  if (text === "💬 Hablar con el vendedor") {
    await bot.sendMessage(chatId, "💬 Escribinos tu consulta y te respondemos a la brevedad.", {
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  if (text === "🏪 Información del local") {
    await bot.sendMessage(chatId, "🏪 TODO QUESO CLUB\n📍 (completamos dirección y horarios cuando me los confirmes)", {
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  if (text === "📣 Compartir el bot") {
    await bot.sendMessage(chatId, "📣 Compartí el bot:\nAbrí el perfil del bot y tocá “Compartir”.", {
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }
});

bot.on("callback_query", async (q) => {
  const chatId = q.message?.chat?.id;
  const data = safeText(q.data);

  try { await bot.answerCallbackQuery(q.id); } catch {}

  if (!chatId) return;

  try {
    if (data === "menu") {
      await sendWelcome(chatId);
      return;
    }

    if (data === "cats") {
      await showCategories(chatId);
      return;
    }

    if (data.startsWith("cat:")) {
      const category = decodeURIComponent(data.slice(4));
      await showCategoryPage(chatId, category, 0);
      return;
    }

    if (data.startsWith("page:")) {
      const parts = data.split(":");
      const category = decodeURIComponent(parts[1] || "");
      const page = Number(parts[2] || 0);
      await showCategoryPage(chatId, category, page);
      return;
    }

    if (data.startsWith("buy:")) {
      const code = data.slice(4);
      const st = browserState.get(chatId);
      const item = st?.items?.find((x) => x.code === code);
      if (!item) {
        await bot.sendMessage(chatId, "⚠️ No encontré ese producto. Volvé a Catálogo.", {
          reply_markup: mainMenuKeyboard(),
        });
        return;
      }
      await askQuantity(chatId, item);
      return;
    }

    if (data.startsWith("share:")) {
      const code = data.slice(6);
      const st = browserState.get(chatId);
      const item = st?.items?.find((x) => x.code === code);
      if (!item) {
        await bot.sendMessage(chatId, "⚠️ No encontré ese producto para compartir.", {
          reply_markup: mainMenuKeyboard(),
        });
        return;
      }

      const shareText = buildShareText(TENANT.name, item);
      const link = waShareLink(shareText);

      await bot.sendMessage(chatId, `📣 Compartir promo (WhatsApp):\n${link}`, {
        reply_markup: mainMenuKeyboard(),
        disable_web_page_preview: true,
      });
      return;
    }
  } catch (e) {
    // IMPORTANTÍSIMO: NUNCA mandamos el error crudo al chat (evita parse entities)
    console.error("Callback error:", e);
    await bot.sendMessage(chatId, "⚠️ Hubo un error en esa acción. Tocá 🏠 Menú y probá de nuevo.", {
      reply_markup: mainMenuKeyboard(),
    });
  }
});

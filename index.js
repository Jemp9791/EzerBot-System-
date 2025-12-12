/**
 * EzerBot-System - index.js (LISTO PARA PEGAR)
 * Requisitos ENV:
 * - BOT_TOKEN
 * - WEBHOOK_URL   (ej: https://ezerbot-system.onrender.com/webhook)
 * - GAS_URL       (tu Apps Script /exec que devuelve catálogo)
 * - PORT          (Render lo setea solo, igual soporta default 10000)
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
  const num = Number(n);
  if (!Number.isFinite(num)) return safeText(n);
  return num.toLocaleString("es-AR");
}

function buildShareText(tenantName, item) {
  const name = safeText(item.name);
  const price = safeText(item.price);
  const code = safeText(item.code);
  // Texto plano, sin Markdown
  return `🧀 ${tenantName}\n\n🔥 Promo / Producto:\n${name}\n💲 ${price} ARS\n🆔 ${code}\n\nPedilo por acá 👇`;
}

function waShareLink(text) {
  const enc = encodeURIComponent(text);
  return `https://wa.me/?text=${enc}`;
}

/** =========================
 *  Bot setup (Webhook)
 *  ========================= */
const bot = new TelegramBot(BOT_TOKEN, { webHook: true });

// Express server
const app = express();
app.use(express.json());

app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));
app.get("/debug", async (_req, res) => {
  // Debug básico sin usar métodos raros del bot
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
    const j = await r.json();
    res.status(200).json({ ok: true, webhook: j });
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
});

/** =========================
 *  Config negocio (simple)
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
 *  Estado (en memoria)
 *  - browser: navegación catálogo (1 mensaje editable)
 *  - pendingQty: esperando cantidad para un item
 *  ========================= */
const browserState = new Map(); // chatId -> { category, page, items, perPage, messageId }
const pendingQty = new Map();   // chatId -> { item }

/** =========================
 *  Teclado principal (NO inline)
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
 *  GAS: traer catálogo
 *  Esperado (ideal):
 *  { ok:true, items:[ {code,name,price,category,desc,imageUrl}... ] }
 *  Si tu GAS devuelve otra forma, adaptamos 1 sola función aquí.
 *  ========================= */
async function fetchCatalog() {
  const r = await fetch(GAS_URL, { method: "GET" });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error("GAS no devolvió JSON válido");
  const items = Array.isArray(j.items) ? j.items : Array.isArray(j) ? j : [];
  // Normalizo campos mínimos
  return items.map((x) => ({
    code: safeText(x.code || x.id || x.ID || x.Codigo || x.codigo),
    name: safeText(x.name || x.nombre || x.Nombre),
    price: safeText(x.price || x.precio || x.Precio),
    category: safeText(x.category || x.categoria || x.Categoria || "General"),
    desc: safeText(x.desc || x.descripcion || x.Descripcion || ""),
    imageUrl: safeText(x.imageUrl || x.imagen || x.Imagen || x.foto || x.Foto || ""),
  })).filter(it => it.code && it.name);
}

function getCategories(items) {
  const set = new Set();
  for (const it of items) set.add(it.category || "General");
  return Array.from(set).sort((a,b) => a.localeCompare(b, "es"));
}

/** =========================
 *  Catálogo UI
 *  - 3 productos por página (media group NO; 1 mensaje editable)
 *  - Se muestra 1 producto por "pantalla" dentro de la página? NO:
 *    Vos pediste 3 imágenes por vez. Telegram NO permite 3 fotos en un solo mensaje editable.
 *    Entonces hacemos esto prolijo:
 *      - En cada página mandamos 3 mensajes (uno por producto) + 1 mensaje de navegación (editable).
 *    Para que NO sea caos: borramos los 3 anteriores si se puede.
 *
 *  IMPORTANTE: Telegram solo deja borrar mensajes del bot.
 *  ========================= */
const lastCatalogMsgs = new Map(); // chatId -> [msgId...]

async function clearCatalogMsgs(chatId) {
  const ids = lastCatalogMsgs.get(chatId) || [];
  for (const id of ids) {
    try { await bot.deleteMessage(chatId, id); } catch {}
  }
  lastCatalogMsgs.set(chatId, []);
}

function itemCaption(item) {
  const name = safeText(item.name);
  const desc = safeText(item.desc);
  const price = moneyARS(item.price);
  const code = safeText(item.code);
  const lines = [
    `*${name}*`, // OJO: no usamos parse_mode, esto se verá con asteriscos, por eso lo saco abajo
  ];
  // Texto PLANO (sin markdown)
  let cap = `${name}\n\n`;
  if (desc) cap += `${desc}\n\n`;
  cap += `💲 ${price} ARS\n🆔 ${code}`;
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

async function showCategories(chatId) {
  await clearCatalogMsgs(chatId);

  let items = [];
  try {
    items = await fetchCatalog();
  } catch (e) {
    await bot.sendMessage(chatId, `⚠️ No pude leer el catálogo. Revisá el GAS.\n${safeText(e)}`, {
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  const cats = getCategories(items);
  if (!cats.length) {
    await bot.sendMessage(chatId, "⚠️ No hay categorías / productos cargados todavía.", {
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  // Guardamos items para este chat (para no pedir al GAS cada click)
  browserState.set(chatId, { category: null, page: 0, items, perPage: 3, messageId: null });

  const buttons = [];
  for (const c of cats) buttons.push([{ text: `📁 ${c}`, callback_data: `cat:${encodeURIComponent(c)}` }]);
  buttons.push([{ text: "🏠 Menú", callback_data: "menu" }]);

  const msg = await bot.sendMessage(chatId, "📁 Elegí una categoría:", {
    reply_markup: { inline_keyboard: buttons },
  });

  lastCatalogMsgs.set(chatId, [msg.message_id]);
}

async function showCategoryPage(chatId, category, page) {
  const st = browserState.get(chatId);
  if (!st?.items?.length) return showCategories(chatId);

  const itemsCat = st.items.filter((x) => (x.category || "General") === category);
  const perPage = 3;
  const totalPages = Math.max(1, Math.ceil(itemsCat.length / perPage));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = safePage * perPage;
  const pageItems = itemsCat.slice(start, start + perPage);

  await clearCatalogMsgs(chatId);

  const sentIds = [];

  // Enviamos 3 productos (cada uno con sus botones)
  for (const it of pageItems) {
    const cap = itemCaption(it);
    const kb = productInlineKeyboard(it, category);

    let msg;
    if (it.imageUrl) {
      msg = await bot.sendPhoto(chatId, it.imageUrl, {
        caption: cap,
        reply_markup: kb,
      }).catch(async () => {
        // Si falla la foto, caemos a texto
        return bot.sendMessage(chatId, cap, { reply_markup: kb });
      });
    } else {
      msg = await bot.sendMessage(chatId, cap, { reply_markup: kb });
    }
    sentIds.push(msg.message_id);
  }

  // Mensaje de navegación
  const navMsg = await bot.sendMessage(
    chatId,
    `🧭 Navegación: ${category} — Página ${safePage + 1}/${totalPages}`,
    { reply_markup: navInlineKeyboard(category, safePage, totalPages) }
  );
  sentIds.push(navMsg.message_id);

  lastCatalogMsgs.set(chatId, sentIds);

  browserState.set(chatId, {
    ...st,
    category,
    page: safePage,
    perPage,
    messageId: navMsg.message_id,
  });
}

/** =========================
 *  Compra simple: pide cantidad
 *  ========================= */
async function askQuantity(chatId, item) {
  pendingQty.set(chatId, { item });

  await bot.sendMessage(
    chatId,
    `✅ Elegiste: ${item.name} (ID ${item.code})\n\n` +
      `¿Cuánto querés?\n` +
      `Ejemplos: 200g, 1kg, 2 unidades`,
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

  // Si estaba esperando cantidad
  if (pendingQty.has(chatId) && text && !text.startsWith("/")) {
    const { item } = pendingQty.get(chatId);
    pendingQty.delete(chatId);

    // Acá después conectamos carrito real.
    await bot.sendMessage(
      chatId,
      `🧾 Perfecto. Anoté:\n• ${item.name}\n• Cantidad: ${text}\n\n` +
        `¿Querés sumar otro producto desde Catálogo?`,
      { reply_markup: mainMenuKeyboard() }
    );
    return;
  }

  // Menú principal por teclado
  if (text === "🛍️ Catálogo") {
    await showCategories(chatId);
    return;
  }
  if (text === "🛒 Mi carrito") {
    await bot.sendMessage(chatId, "🛒 Mi carrito (simple): por ahora el bot te guía por catálogo.", {
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
      const [_p, catEnc, pageStr] = data.split(":");
      const category = decodeURIComponent(catEnc);
      const page = Number(pageStr || 0);
      await showCategoryPage(chatId, category, page);
      return;
    }

    if (data.startsWith("buy:")) {
      const code = data.slice(4);
      const st = browserState.get(chatId);
      const item = st?.items?.find((x) => x.code === code);
      if (!item) {
        await bot.sendMessage(chatId, "⚠️ No encontré ese producto. Probá de nuevo desde Catálogo.", {
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
      const text = buildShareText(TENANT.name, item);
      const link = waShareLink(text);
      await bot.sendMessage(chatId, `📣 Compartir promo (WhatsApp):\n${link}`, {
        reply_markup: mainMenuKeyboard(),
        disable_web_page_preview: true,
      });
      return;
    }
  } catch (e) {
    // 👇 Nunca mandamos el error crudo con paréntesis/markdown.
    console.error("Callback error:", e);
    await bot.sendMessage(chatId, "⚠️ Hubo un error en esa acción. Probá otra vez o tocá 🏠 Menú.", {
      reply_markup: mainMenuKeyboard(),
    });
  }
});

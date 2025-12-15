import express from "express";
import TelegramBot from "node-telegram-bot-api";

const BOT_TOKEN = process.env.BOT_TOKEN;
const GAS_URL = process.env.https://script.google.com/macros/s/AKfycbwfYMqsIWzGDB8UiQx30XoV8K4yes54tJo2Rcb512Ku2ce9vgOL7OgOflE6fc90rnb0/exec;
const WEBHOOK_URL = process.env.https://ezerbot-system.onrender.com; // OBLIGATORIO: https://tuapp.onrender.com (sin /webhook)

const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) throw new Error("Falta ENV BOT_TOKEN");
if (!GAS_URL) throw new Error("Falta ENV GAS_URL");
if (!WEBHOOK_URL) throw new Error("Falta ENV WEBHOOK_URL (vamos SOLO con webhook para que no se rompa)");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.set("trust proxy", 1);

app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/health", async (_, res) => {
  try {
    const info = await bot.getWebHookInfo();
    res.status(200).json({ ok: true, webhook: info });
  } catch (e) {
    res.status(200).json({ ok: true, webhook: null, note: "No pude leer webhook info" });
  }
});

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

bot.on("error", (e) => console.error("bot_error:", e?.message || e));
bot.on("webhook_error", (e) => console.error("webhook_error:", e?.message || e));

const WEBHOOK_PATH = "/webhook";

// Endpoint que recibe TODO lo que Telegram manda
app.post(WEBHOOK_PATH, (req, res) => {
  try {
    bot.processUpdate(req.body);
  } catch (e) {
    console.error("processUpdate:", e?.message || e);
  }
  res.sendStatus(200);
});

app.listen(PORT, async () => {
  console.log("Server up on", PORT);

  // Forzar webhook correcto SIEMPRE
  const base = String(WEBHOOK_URL).replace(/\/$/, "");
  const full = base + WEBHOOK_PATH;

  try {
    await bot.deleteWebHook({ drop_pending_updates: true }).catch(() => {});
    await bot.setWebHook(full, { drop_pending_updates: true, max_connections: 40 });
    console.log("✅ Webhook seteado:", full);

    // (Opcional) comandos visibles
    await bot.setMyCommands([
      { command: "start", description: "Abrir menú" },
    ]).catch(() => {});

    const info = await bot.getWebHookInfo().catch(() => null);
    if (info) console.log("WebhookInfo:", info);
  } catch (e) {
    console.error("INIT ERROR:", e?.message || e);
  }
});

// ===================== Estado simple =====================
const stateByChatId = new Map();
function getState(chatId) {
  if (!stateByChatId.has(chatId)) {
    stateByChatId.set(chatId, {
      mode: "idle",
      categories: [],
      productos: [],
      currentCategory: null,
      pageIndex: 0,
      pendingProduct: null,
      cart: [],
    });
  }
  return stateByChatId.get(chatId);
}

// ===================== UI =====================
function mainMenuKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🛍️ Catálogo" }, { text: "🛒 Mi carrito" }],
        [{ text: "🎁 Mis sellos" }],
        [{ text: "💬 Hablar con el vendedor" }],
        [{ text: "🏪 Información del local" }, { text: "📣 Compartir el bot" }],
        [{ text: "🔄 Recargar catálogo" }],
      ],
      resize_keyboard: true,
    },
  };
}

function removeKeyboard() {
  return { reply_markup: { remove_keyboard: true } };
}

function navInlineKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "⬅️ Anterior", callback_data: "NAV_PREV" },
          { text: "📂 Categorías", callback_data: "NAV_CATS" },
          { text: "➡️ Siguiente", callback_data: "NAV_NEXT" },
        ],
      ],
    },
  };
}

function productInlineKeyboard(prod) {
  const shareText = encodeURIComponent(
    `🛍️ ${prod.nombre}\n💵 $${formatARS(displayPrice(prod))} ARS\n🆔 ${prod.codigo}\n\nPedilo desde el bot 👇`
  );
  const tgShare = `https://t.me/share/url?url=${encodeURIComponent("https://t.me/share/url")}&text=${shareText}`;

  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Quiero este", callback_data: `BUY:${prod.codigo}` },
          { text: "📣 Compartir promo", url: tgShare },
        ],
        [{ text: "↩️ Volver a categorías", callback_data: "NAV_CATS" }],
      ],
    },
  };
}

function cartInlineKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Finalizar compra", callback_data: "CHECKOUT" }],
        [
          { text: "🛍️ Seguir comprando", callback_data: "NAV_CATS" },
          { text: "🧹 Vaciar carrito", callback_data: "CART_CLEAR" },
        ],
      ],
    },
  };
}

function formatARS(n) {
  const num = Number(n || 0);
  return new Intl.NumberFormat("es-AR").format(num);
}

function displayPrice(prod) {
  const ppk = Number(prod.precioporkg || 0);
  const p = Number(prod.precio || 0);
  return ppk > 0 ? ppk : p;
}

// ===================== Fetch GAS (cache) =====================
let cache = { ts: 0, data: null };

async function fetchCatalog(force = false) {
  const now = Date.now();
  if (!force && cache.data && now - cache.ts < 30_000) return cache.data;

  const url = GAS_URL.includes("?") ? `${GAS_URL}&type=catalogo` : `${GAS_URL}?type=catalogo`;
  const res = await fetch(url, { method: "GET" });
  const json = await res.json();

  if (!json || json.ok !== true || !Array.isArray(json.productos)) {
    return { ok: false, productos: [] };
  }

  cache = { ts: now, data: json };
  return json;
}

// ===================== Catálogo =====================
async function showCategories(chatId, force = false) {
  const state = getState(chatId);
  const data = await fetchCatalog(force);

  const productos = (data.productos || []).filter(
    (p) =>
      p &&
      p.categoria &&
      p.codigo &&
      p.nombre &&
      (Number(p.precio || 0) > 0 || Number(p.precioporkg || 0) > 0)
  );

  const categories = [...new Set(productos.map((p) => String(p.categoria).trim()).filter(Boolean))];

  state.productos = productos;
  state.categories = categories;
  state.currentCategory = null;
  state.pageIndex = 0;
  state.mode = "catalog";

  if (!categories.length) {
    await bot.sendMessage(
      chatId,
      "⚠️ No hay categorías / productos visibles todavía (esto viene desde GAS_URL).",
      mainMenuKeyboard()
    );
    return;
  }

  const rows = [];
  for (let i = 0; i < categories.length; i += 2) {
    const row = [{ text: `📦 ${categories[i]}` }];
    if (categories[i + 1]) row.push({ text: `📦 ${categories[i + 1]}` });
    rows.push(row);
  }
  rows.push([{ text: "🏠 Menú" }]);

  await bot.sendMessage(chatId, "📂 Elegí una categoría:", {
    reply_markup: { keyboard: rows, resize_keyboard: true },
  });
}

async function showCategoryPage(chatId, category, pageIndex) {
  const state = getState(chatId);

  const items = state.productos.filter(
    (p) => String(p.categoria).trim().toLowerCase() === String(category).trim().toLowerCase()
  );

  if (!items.length) {
    await bot.sendMessage(chatId, "⚠️ Esa categoría no tiene productos visibles.", mainMenuKeyboard());
    return;
  }

  const pageSize = 3;
  const pages = Math.ceil(items.length / pageSize);
  const safeIndex = Math.max(0, Math.min(pageIndex, pages - 1));

  state.pageIndex = safeIndex;
  state.currentCategory = category;

  await bot.sendMessage(chatId, `🧾 ${category} — Página ${safeIndex + 1}/${pages}`, removeKeyboard());

  const slice = items.slice(safeIndex * pageSize, safeIndex * pageSize + pageSize);

  for (const prod of slice) {
    const caption = `${prod.nombre}\n💵 $${formatARS(displayPrice(prod))} ARS\n🆔 ${prod.codigo}`;

    if (prod.imagen && String(prod.imagen).startsWith("http")) {
      await bot.sendPhoto(chatId, prod.imagen, { caption, ...productInlineKeyboard(prod) });
    } else {
      await bot.sendMessage(chatId, caption, productInlineKeyboard(prod));
    }
  }

  await bot.sendMessage(chatId, "🧭 Navegación:", navInlineKeyboard());
}

// ===================== Carrito =====================
function cartTotal(state) {
  return state.cart.reduce((acc, x) => acc + Number(x.subtotal || 0), 0);
}
function cartText(state) {
  if (!state.cart.length) return "🛒 Tu carrito está vacío.";
  const lines = state.cart.map((x, i) => {
    return `${i + 1}) ${x.nombre} (${x.codigo})\n Cantidad: ${x.cantidadText}\n Subtotal: $${formatARS(x.subtotal)} ARS`;
  });
  return `🛒 Tu carrito:\n\n${lines.join("\n\n")}\n\n💰 Total: $${formatARS(cartTotal(state))} ARS`;
}

// ===================== START (blindado) =====================
async function startFlow(chatId) {
  const state = getState(chatId);
  state.mode = "idle";
  await bot.sendMessage(
    chatId,
    `Hola 👋\nSoy el asistente de TODO QUESO CLUB 🧀\n\n👇 Elegí una opción`,
    mainMenuKeyboard()
  );
}

bot.onText(/^\/start\b/i, async (msg) => {
  await startFlow(msg.chat.id);
});

// Backup: si onText falla, igual lo tomamos
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const state = getState(chatId);

  if (/^\/start\b/i.test(text)) {
    await startFlow(chatId);
    return;
  }

  if (text === "🔄 Recargar catálogo") {
    cache = { ts: 0, data: null };
    await bot.sendMessage(chatId, "🔄 Listo. Recargando catálogo…");
    await showCategories(chatId, true);
    return;
  }

  if (text === "🛍️ Catálogo" || text === "Catálogo") {
    await showCategories(chatId, false);
    return;
  }

  if (text === "🛒 Mi carrito" || text === "Mi carrito") {
    await bot.sendMessage(chatId, cartText(state), cartInlineKeyboard());
    return;
  }

  if (state.mode === "catalog" && text.startsWith("📦 ")) {
    const cat = text.replace("📦 ", "").trim();
    await showCategoryPage(chatId, cat, 0);
    return;
  }

  if (text === "🏠 Menú" || text === "Menú") {
    await bot.sendMessage(chatId, "🏠 Menú principal:", mainMenuKeyboard());
    return;
  }
});

// ===================== Callbacks =====================
bot.on("callback_query", async (cq) => {
  const chatId = cq.message.chat.id;
  const data = cq.data || "";
  const state = getState(chatId);

  try {
    if (data === "NAV_CATS") {
      await bot.answerCallbackQuery(cq.id);
      await showCategories(chatId, false);
      return;
    }

    if (data === "NAV_NEXT" || data === "NAV_PREV") {
      await bot.answerCallbackQuery(cq.id);
      if (!state.currentCategory) {
        await showCategories(chatId, false);
        return;
      }

      const items = state.productos.filter(
        (p) => String(p.categoria).trim().toLowerCase() === String(state.currentCategory).trim().toLowerCase()
      );

      const pageSize = 3;
      const pages = Math.ceil(items.length / pageSize);
      const delta = data === "NAV_NEXT" ? 1 : -1;

      let nextIndex = state.pageIndex + delta;
      if (nextIndex < 0) nextIndex = 0;
      if (nextIndex > pages - 1) nextIndex = pages - 1;

      await showCategoryPage(chatId, state.currentCategory, nextIndex);
      return;
    }

    if (data.startsWith("BUY:")) {
      await bot.answerCallbackQuery(cq.id);
      const code = data.split(":")[1];
      const prod = state.productos.find((p) => String(p.codigo) === String(code));
      if (!prod) {
        await bot.sendMessage(chatId, "⚠️ No encontré ese producto.");
        return;
      }

      const subtotal = Number(prod.precio || 0) || 0;
      state.cart.push({
        codigo: prod.codigo,
        nombre: prod.nombre,
        cantidad: 1,
        cantidadText: "1",
        subtotal,
      });

      await bot.sendMessage(
        chatId,
        `✅ Agregado al carrito:\n${prod.nombre}\nSubtotal: $${formatARS(subtotal)} ARS`,
        cartInlineKeyboard()
      );
      return;
    }

    if (data === "CART_CLEAR") {
      await bot.answerCallbackQuery(cq.id);
      state.cart = [];
      await bot.sendMessage(chatId, "🧹 Carrito vacío.", mainMenuKeyboard());
      return;
    }

    if (data === "CHECKOUT") {
      await bot.answerCallbackQuery(cq.id);
      await bot.sendMessage(chatId, "✅ Checkout: seguimos completándolo en el módulo A.", mainMenuKeyboard());
      return;
    }

    await bot.answerCallbackQuery(cq.id);
  } catch (e) {
    console.error("callback_error:", e?.message || e);
    try { await bot.answerCallbackQuery(cq.id); } catch {}
    await bot.sendMessage(chatId, "⚠️ Error interno.");
  }
});


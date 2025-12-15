import express from "express";
import TelegramBot from "node-telegram-bot-api";

const BOT_TOKEN = process.env.BOT_TOKEN;
const GAS_URL = process.env.GAS_URL; // endpoint GAS que devuelve { ok:true, productos:[...] }
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) throw new Error("Falta ENV BOT_TOKEN");
if (!GAS_URL) throw new Error("Falta ENV GAS_URL");

const app = express();
app.use(express.json({ limit: "2mb" }));

// ---------- DEBUG / ESTADO ----------
let bootedAt = new Date().toISOString();
let lastUpdateAt = null;
let lastChatId = null;
let lastText = null;
let lastError = null;

app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/health", (_, res) =>
  res.status(200).json({ ok: true, bootedAt, lastUpdateAt, lastChatId, lastText, lastError })
);

// Si esto devuelve JSON, tu código es el correcto (NO “Cannot GET /debug”)
app.get("/debug", async (_, res) => {
  try {
    const me = await bot.getMe();
    res.status(200).json({
      ok: true,
      bootedAt,
      bot: me,
      lastUpdateAt,
      lastChatId,
      lastText,
      lastError,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log("Server up on", PORT));

// ---------- BOT: FORZAR POLLING (FUNCIONA EN RENDER) ----------
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Esto es CLAVE: borra webhook viejo que te deja el bot “mudo”
bot.deleteWebHook({ drop_pending_updates: true }).catch(() => {});

process.on("unhandledRejection", (e) => {
  lastError = "unhandledRejection: " + String(e?.message || e);
  console.error(lastError);
});
process.on("uncaughtException", (e) => {
  lastError = "uncaughtException: " + String(e?.message || e);
  console.error(lastError);
});

bot.on("polling_error", (e) => {
  lastError = "polling_error: " + String(e?.message || e);
  console.error(lastError);
});
bot.on("error", (e) => {
  lastError = "bot_error: " + String(e?.message || e);
  console.error(lastError);
});

// -------------------- Estado simple en memoria --------------------
const stateByChatId = new Map();

function getState(chatId) {
  if (!stateByChatId.has(chatId)) {
    stateByChatId.set(chatId, {
      mode: "idle", // "idle" | "catalog" | "await_qty"
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

// -------------------- Helpers UI --------------------
function mainMenuKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🛍️ Catálogo" }, { text: "🛒 Mi carrito" }],
        [{ text: "🎁 Mis sellos" }],
        [{ text: "💬 Hablar con el vendedor" }],
        [{ text: "🏪 Información del local" }, { text: "📣 Compartir el bot" }],
      ],
      resize_keyboard: true,
    },
  };
}

function categoriesKeyboard(categories) {
  const rows = [];
  const pretty = (c) => {
    const s = String(c || "").toLowerCase();
    if (s.includes("ques")) return "🧀 Quesos";
    if (s.includes("fiam")) return "🍖 Fiambres";
    if (s.includes("láct") || s.includes("lact")) return "🥛 Lácteos";
    if (s.includes("pani") || s.includes("pan")) return "🥖 Panificados";
    if (s.includes("promo")) return "🎁 Promos";
    return "📦 " + c;
  };

  const mapped = categories.map((c) => ({ raw: c, label: pretty(c) }));

  for (let i = 0; i < mapped.length; i += 2) {
    const row = [{ text: mapped[i].label }];
    if (mapped[i + 1]) row.push({ text: mapped[i + 1].label });
    rows.push(row);
  }

  rows.push([{ text: "🏠 Menú" }]);

  return {
    reply_markup: {
      keyboard: rows,
      resize_keyboard: true,
      one_time_keyboard: false,
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
  const code = prod.codigo;
  const shareText = encodeURIComponent(
    `🛍️ ${prod.nombre}\n💵 $${formatARS(prod.precio)} ARS\n🆔 ${code}\n\nPedilo desde el bot 👇`
  );
  const shareUrl = encodeURIComponent("https://t.me/share/url");
  const tgShare = `https://t.me/share/url?url=${shareUrl}&text=${shareText}`;

  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Quiero este", callback_data: `BUY:${code}` },
          { text: "📣 Compartir promo", url: tgShare },
        ],
        [{ text: "↩️ Volver a categoría", callback_data: "NAV_CATS" }],
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

// -------------------- Sheets/GAS fetch (cache) --------------------
let cache = { ts: 0, data: null };

async function fetchCatalog() {
  const now = Date.now();
  if (cache.data && now - cache.ts < 30_000) return cache.data;

  const res = await fetch(GAS_URL, { method: "GET" });
  const json = await res.json();

  if (!json || json.ok !== true || !Array.isArray(json.productos)) {
    return { ok: false, productos: [] };
  }

  cache = { ts: now, data: json };
  return json;
}

function normalizeCategoryLabelToRaw(state, label) {
  const plain = String(label).replace(/[^\p{L}\p{N}\s]/gu, "").trim().toLowerCase();
  const raw =
    state.categories.find((c) => String(c).toLowerCase().includes(plain)) ||
    state.categories.find((c) => plain.includes(String(c).toLowerCase()));
  if (raw) return raw;

  const possible = label.replace(/^.*?\s/, "");
  return (
    state.categories.find((c) => String(c).toLowerCase() === String(possible).toLowerCase()) || null
  );
}

function isKgUnit(prod) {
  const u = String(prod.unidad || "").toLowerCase();
  return u.includes("kg") || u.includes("kilo");
}

function priceForProduct(prod) {
  const ppk = Number(prod.precioporkg || prod.precioporkilo || 0);
  const p = Number(prod.precio || 0);
  return ppk > 0 ? ppk : p;
}

// -------------------- Render catálogo (3 por página) --------------------
async function showCategories(chatId) {
  const state = getState(chatId);
  const data = await fetchCatalog();

  const productos = (data.productos || []).filter(
    (p) => p && p.categoria && p.codigo && p.nombre && (p.precio || p.precioporkg || p.precioporkilo) && p.imagen
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
      "⚠️ No hay categorías / productos cargados todavía.\nRevisá tu GAS: debe devolver productos con categoria,codigo,nombre,precio y/o precioporkg,imagen.",
      mainMenuKeyboard()
    );
    return;
  }

  await bot.sendMessage(chatId, "📂 Elegí una categoría:", categoriesKeyboard(categories));
}

async function showCategoryPage(chatId, category, pageIndex) {
  const state = getState(chatId);
  const items = state.productos.filter(
    (p) => String(p.categoria).trim().toLowerCase() === String(category).trim().toLowerCase()
  );

  if (!items.length) {
    await bot.sendMessage(chatId, "⚠️ Esa categoría no tiene productos.", categoriesKeyboard(state.categories));
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
    const priceShown = Number(prod.precio || 0);
    const caption =
      `${prod.nombre}\n` +
      `💵 $${formatARS(priceShown)} ARS\n` +
      `🆔 ${prod.codigo}`;

    await bot.sendPhoto(chatId, prod.imagen, {
      caption,
      ...productInlineKeyboard(prod),
    });
  }

  await bot.sendMessage(chatId, "🧭 Navegación:", navInlineKeyboard());
}

// -------------------- Carrito --------------------
function cartTotal(state) {
  return state.cart.reduce((acc, x) => acc + Number(x.subtotal || 0), 0);
}

function cartText(state) {
  if (!state.cart.length) return "🛒 Tu carrito está vacío.";

  const lines = state.cart.map((x, i) => {
    return `${i + 1}) ${x.nombre} (${x.codigo})\n Cantidad: ${x.cantidadText}\n Subtotal: $${formatARS(
      x.subtotal
    )} ARS`;
  });

  return `🛒 Tu carrito:\n\n${lines.join("\n\n")}\n\n💰 Total: $${formatARS(cartTotal(state))} ARS`;
}

// -------------------- /start + cualquier mensaje --------------------
async function welcome(chatId) {
  const state = getState(chatId);
  state.mode = "idle";
  await bot.sendMessage(
    chatId,
    `Hola Jenny 👋\nSoy el asistente de TODO QUESO CLUB 🧀\n\n👇 Elegí una opción`,
    mainMenuKeyboard()
  );
}

bot.onText(/\/start/, async (msg) => {
  lastUpdateAt = new Date().toISOString();
  lastChatId = msg.chat.id;
  lastText = msg.text || "/start";
  await welcome(msg.chat.id);
});

// ✅ responde también a CUALQUIER comando (/loquesea) y a cualquier texto
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  lastUpdateAt = new Date().toISOString();
  lastChatId = chatId;
  lastText = text || "(sin texto)";

  const state = getState(chatId);

  // Si es comando distinto a /start, igual mostramos menú
  if (text.startsWith("/") && text !== "/start") {
    await welcome(chatId);
    return;
  }

  // Si estamos esperando cantidad:
  if (state.mode === "await_qty" && state.pendingProduct) {
    const prod = state.pendingProduct;

    const raw = text.toLowerCase().replace(",", ".").replace(/\s+/g, "");
    let grams = null;

    const kgMatch = raw.match(/^(\d+(\.\d+)?)kg$/);
    const gMatch = raw.match(/^(\d+(\.\d+)?)g$/);
    const numMatch = raw.match(/^(\d+(\.\d+)?)$/);

    if (kgMatch) grams = Math.round(Number(kgMatch[1]) * 1000);
    else if (gMatch) grams = Math.round(Number(gMatch[1]));
    else if (numMatch) grams = Math.round(Number(numMatch[1]));
    else grams = null;

    if (!grams || grams <= 0) {
      await bot.sendMessage(chatId, "⚠️ Decime la cantidad.\nEj: 250g / 0.5kg / 500", removeKeyboard());
      return;
    }

    const unitPrice = priceForProduct(prod);
    const subtotal = Math.round((grams / 1000) * unitPrice);

    state.cart.push({
      codigo: prod.codigo,
      nombre: prod.nombre,
      unidad: "kg",
      precioUnit: unitPrice,
      cantidad: grams,
      cantidadText: `${grams} g`,
      subtotal,
    });

    state.pendingProduct = null;
    state.mode = "catalog";

    await bot.sendMessage(
      chatId,
      `✅ Agregado:\n${prod.nombre}\nCantidad: ${grams} g\nSubtotal: $${formatARS(subtotal)} ARS`,
      cartInlineKeyboard()
    );
    return;
  }

  // Menú principal
  if (text === "🛍️ Catálogo" || text === "Catálogo") {
    await showCategories(chatId);
    return;
  }

  if (text === "🛒 Mi carrito" || text === "Mi carrito") {
    await bot.sendMessage(chatId, cartText(state), cartInlineKeyboard());
    return;
  }

  if (text === "🏠 Menú" || text === "Menú") {
    await bot.sendMessage(chatId, "🏠 Menú principal:", mainMenuKeyboard());
    return;
  }

  // Categorías (viene del teclado)
  if (state.mode === "catalog" && state.categories.length) {
    const rawCat = normalizeCategoryLabelToRaw(state, text);
    if (rawCat) {
      await showCategoryPage(chatId, rawCat, 0);
      return;
    }
  }

  // Fallback
  if (text) {
    await bot.sendMessage(chatId, "👌 Dale. Elegí una opción del menú 👇", mainMenuKeyboard());
  } else {
    await welcome(chatId);
  }
});

// -------------------- Callbacks (inline buttons) --------------------
bot.on("callback_query", async (cq) => {
  const chatId = cq.message.chat.id;
  const data = cq.data || "";
  const state = getState(chatId);

  try {
    if (data === "NAV_CATS") {
      await bot.answerCallbackQuery(cq.id);
      await showCategories(chatId);
      return;
    }

    if (data === "NAV_NEXT" || data === "NAV_PREV") {
      await bot.answerCallbackQuery(cq.id);
      if (!state.currentCategory) {
        await showCategories(chatId);
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

      if (isKgUnit(prod)) {
        state.mode = "await_qty";
        state.pendingProduct = prod;
        await bot.sendMessage(
          chatId,
          `🧀 Elegiste: ${prod.nombre} (${prod.codigo})\nDecime la cantidad.\nEj: 250g / 0.5kg / 500`,
          removeKeyboard()
        );
        return;
      } else {
        const subtotal = Number(prod.precio || 0);
        state.cart.push({
          codigo: prod.codigo,
          nombre: prod.nombre,
          unidad: prod.unidad || "unidad",
          precioUnit: Number(prod.precio || 0),
          cantidad: 1,
          cantidadText: "1",
          subtotal,
        });
        await bot.sendMessage(
          chatId,
          `✅ Agregado:\n${prod.nombre}\nSubtotal: $${formatARS(subtotal)} ARS`,
          cartInlineKeyboard()
        );
        return;
      }
    }

    if (data === "CART_CLEAR") {
      await bot.answerCallbackQuery(cq.id);
      state.cart = [];
      await bot.sendMessage(chatId, "🧹 Listo. Carrito vacío.", mainMenuKeyboard());
      return;
    }

    if (data === "CHECKOUT") {
      await bot.answerCallbackQuery(cq.id);
      if (!state.cart.length) {
        await bot.sendMessage(chatId, "🛒 Tu carrito está vacío.", mainMenuKeyboard());
        return;
      }
      await bot.sendMessage(
        chatId,
        `✅ Checkout (en el próximo paso lo cerramos con envío/retiro + ticket)\n\n${cartText(state)}`,
        mainMenuKeyboard()
      );
      return;
    }

    await bot.answerCallbackQuery(cq.id);
  } catch (e) {
    lastError = "callback_error: " + String(e?.message || e);
    console.error(e);
    try {
      await bot.answerCallbackQuery(cq.id);
    } catch (_) {}
    await bot.sendMessage(chatId, "⚠️ Error interno. Probá de nuevo.");
  }
});

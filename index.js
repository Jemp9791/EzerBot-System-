import express from "express";
import TelegramBot from "node-telegram-bot-api";

const BOT_TOKEN = process.env.BOT_TOKEN;
const GAS_URL = process.env.GAS_URL; // endpoint GAS que devuelve { ok:true, productos:[...] }
const WEBHOOK_URL = process.env.WEBHOOK_URL; // opcional (si lo ponés, usa webhook). Si no, hace polling.
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) throw new Error("Falta ENV BOT_TOKEN");
if (!GAS_URL) throw new Error("Falta ENV GAS_URL");

const app = express();
app.use(express.json({ limit: "2mb" }));

// ---- Bot init (webhook o polling) ----
const bot = new TelegramBot(BOT_TOKEN, WEBHOOK_URL ? { webHook: true } : { polling: true });

app.get("/", (_, res) => res.status(200).send("OK"));
app.get("/health", (_, res) => res.status(200).json({ ok: true }));

if (WEBHOOK_URL) {
  const path = "/webhook";
  bot.setWebHook(WEBHOOK_URL + path);
  app.post(path, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
}

app.listen(PORT, () => console.log("Server up on", PORT));

// -------------------- Estado simple en memoria --------------------
/**
 * stateByChatId:
 * {
 *   mode: "idle" | "catalog" | "await_qty",
 *   categories: string[],
 *   productos: [],
 *   currentCategory: string|null,
 *   pageIndex: number,
 *   pendingProduct: object|null,
 *   cart: [{codigo,nombre,unidad,precioUnit,cantidad,cantidadText,subtotal}]
 * }
 */
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
  // Armamos botones grandes (2 por fila)
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
  // Telegram share: https://t.me/share/url?url=...&text=...
  const tgShare = `https://t.me/share/url?url=${shareUrl}&text=${shareText}`;

  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Quiero este", callback_data: `BUY:${code}` },
          { text: "📣 Compartir promo", url: tgShare },
        ],
        [
          { text: "↩️ Volver a categoría", callback_data: "NAV_CATS" },
        ],
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
  // label viene como "🧀 Quesos" o "📦 X". Convertimos buscando match por contiene.
  const plain = String(label).replace(/[^\p{L}\p{N}\s]/gu, "").trim().toLowerCase();

  // Buscamos categoría raw cuyo nombre esté incluido
  const raw = state.categories.find((c) => String(c).toLowerCase().includes(plain)) ||
              state.categories.find((c) => plain.includes(String(c).toLowerCase()));

  if (raw) return raw;

  // fallback: si el label era "📦 categoria", tratamos de quitar emoji
  const possible = label.replace(/^.*?\s/, ""); // quita emoji y espacio
  return state.categories.find((c) => String(c).toLowerCase() === String(possible).toLowerCase()) || null;
}

function isKgUnit(prod) {
  const u = String(prod.unidad || "").toLowerCase();
  return u.includes("kg") || u.includes("kilo");
}

function priceForProduct(prod) {
  // si es por kg y trae precioporkg, usamos ese. Sino precio.
  const ppk = Number(prod.precioporkg || 0);
  const p = Number(prod.precio || 0);
  return ppk > 0 ? ppk : p;
}

// -------------------- Render catálogo (3 por página) --------------------
async function showCategories(chatId) {
  const state = getState(chatId);
  const data = await fetchCatalog();

  const productos = (data.productos || []).filter(p => p && p.categoria && p.codigo && p.nombre && p.precio && p.imagen);
  const categories = [...new Set(productos.map(p => String(p.categoria).trim()).filter(Boolean))];

  state.productos = productos;
  state.categories = categories;
  state.currentCategory = null;
  state.pageIndex = 0;
  state.mode = "catalog";

  if (!categories.length) {
    await bot.sendMessage(
      chatId,
      "⚠️ No hay categorías / productos cargados todavía.\nRevisá tu Sheet/GAS: debe devolver productos con `categoria`, `codigo`, `nombre`, `precio`, `imagen`.",
      mainMenuKeyboard()
    );
    return;
  }

  await bot.sendMessage(
    chatId,
    "📂 Elegí una categoría:",
    categoriesKeyboard(categories)
  );
}

async function showCategoryPage(chatId, category, pageIndex) {
  const state = getState(chatId);
  const items = state.productos.filter(p => String(p.categoria).trim().toLowerCase() === String(category).trim().toLowerCase());

  if (!items.length) {
    await bot.sendMessage(chatId, "⚠️ Esa categoría no tiene productos cargados.", categoriesKeyboard(state.categories));
    return;
  }

  const pageSize = 3;
  const pages = Math.ceil(items.length / pageSize);
  const safeIndex = Math.max(0, Math.min(pageIndex, pages - 1));
  state.pageIndex = safeIndex;
  state.currentCategory = category;

  // Sacamos el teclado de categorías para que NO se encime con fotos/acciones
  await bot.sendMessage(chatId, `🧾 ${category} — Página ${safeIndex + 1}/${pages}`, removeKeyboard());

  const slice = items.slice(safeIndex * pageSize, safeIndex * pageSize + pageSize);

  // Enviamos 3 mensajes (1 por producto) con sus botones
  for (const prod of slice) {
    const caption =
      `${prod.nombre}\n` +
      `💵 $${formatARS(prod.precio)} ARS\n` +
      `🆔 ${prod.codigo}`;

    await bot.sendPhoto(chatId, prod.imagen, {
      caption,
      ...productInlineKeyboard(prod),
    });
  }

  // Un solo bloque de navegación (limpio)
  await bot.sendMessage(chatId, "🧭 Navegación:", navInlineKeyboard());
}

// -------------------- Carrito --------------------
function cartTotal(state) {
  return state.cart.reduce((acc, x) => acc + Number(x.subtotal || 0), 0);
}

function cartText(state) {
  if (!state.cart.length) return "🛒 Tu carrito está vacío.";

  const lines = state.cart.map((x, i) => {
    return `${i + 1}) ${x.nombre} (${x.codigo})\n   Cantidad: ${x.cantidadText}\n   Subtotal: $${formatARS(x.subtotal)} ARS`;
  });

  return `🛒 Tu carrito:\n\n${lines.join("\n\n")}\n\n💰 Total: $${formatARS(cartTotal(state))} ARS`;
}

// -------------------- Comandos y mensajes --------------------
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const state = getState(chatId);
  state.mode = "idle";

  await bot.sendMessage(
    chatId,
    `Hola Jenny 👋\nSoy el asistente de TODO QUESO CLUB 🧀\n\nDesde acá podés:\n• Ver el catálogo\n• Armar tu pedido\n• Sumar sellos\n• Hablar con nosotros\n\n👇 Elegí una opción`,
    mainMenuKeyboard()
  );
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const state = getState(chatId);

  // Si estamos esperando cantidad:
  if (state.mode === "await_qty" && state.pendingProduct) {
    const prod = state.pendingProduct;

    // Parse "250g", "0.5kg", "1kg", "200", "200 g"
    const raw = text.toLowerCase().replace(",", ".").replace(/\s+/g, "");
    let grams = null;

    const kgMatch = raw.match(/^(\d+(\.\d+)?)kg$/);
    const gMatch = raw.match(/^(\d+(\.\d+)?)g$/);
    const numMatch = raw.match(/^(\d+(\.\d+)?)$/);

    if (kgMatch) grams = Math.round(Number(kgMatch[1]) * 1000);
    else if (gMatch) grams = Math.round(Number(gMatch[1]));
    else if (numMatch) grams = Math.round(Number(numMatch[1])); // asumimos gramos si puso número solo
    else grams = null;

    if (!grams || grams <= 0) {
      await bot.sendMessage(chatId, "⚠️ Decime la cantidad en gramos o kilos.\nEjemplos: 250g / 0.5kg / 500", removeKeyboard());
      return;
    }

    const unitPrice = priceForProduct(prod); // precio por kg
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
      `✅ Agregado al carrito:\n${prod.nombre}\nCantidad: ${grams} g\nSubtotal: $${formatARS(subtotal)} ARS`,
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

  // Fallback “hablar con vendedor” etc. (simple)
  if (text === "💬 Hablar con el vendedor") {
    await bot.sendMessage(chatId, "Escribinos tu consulta y te respondemos a la brevedad.", mainMenuKeyboard());
    return;
  }

  if (text === "🏪 Información del local") {
    await bot.sendMessage(chatId, "🏪 TODO QUESO CLUB\n📍 (completamos dirección y horarios cuando me los confirmes)", mainMenuKeyboard());
    return;
  }

  if (text === "📣 Compartir el bot") {
    await bot.sendMessage(chatId, "📣 Compartí el bot:\nAbrí el perfil del bot y tocá “Compartir”.", mainMenuKeyboard());
    return;
  }

  if (text === "🎁 Mis sellos") {
    await bot.sendMessage(chatId, "🎁 Todavía no tenés tarjeta.\nCuando hagas tu primera compra, te la generamos y empezás a sumar sellos 😁", mainMenuKeyboard());
    return;
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
      const items = state.productos.filter(p => String(p.categoria).trim().toLowerCase() === String(state.currentCategory).trim().toLowerCase());
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
      const prod = state.productos.find(p => String(p.codigo) === String(code));
      if (!prod) {
        await bot.sendMessage(chatId, "⚠️ No encontré ese producto en el catálogo.");
        return;
      }

      if (isKgUnit(prod)) {
        state.mode = "await_qty";
        state.pendingProduct = prod;
        await bot.sendMessage(
          chatId,
          `🧀 Elegiste: ${prod.nombre} (${prod.codigo})\nDecime la cantidad.\nEjemplos: 250g / 0.5kg / 500`,
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
          `✅ Agregado al carrito:\n${prod.nombre}\nSubtotal: $${formatARS(subtotal)} ARS`,
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
        `✅ Checkout (simple por ahora)\n\n${cartText(state)}\n\n¿Querés:\n• 🚚 Envío\n• 🏪 Retiro\n\n(esto lo cerramos en el próximo paso)`,
        mainMenuKeyboard()
      );
      return;
    }

    await bot.answerCallbackQuery(cq.id);
  } catch (e) {
    console.error(e);
    try { await bot.answerCallbackQuery(cq.id); } catch (_) {}
    await bot.sendMessage(chatId, "⚠️ Ocurrió un error interno. Probá de nuevo.");
  }
});

/**
 * EzerBot - index.js (CommonJS) - listo para Render
 * Requiere: express, node-telegram-bot-api
 *
 * ENV:
 * BOT_TOKEN
 * GAS_URL  -> https://script.google.com/macros/s/XXXX/exec
 * PUBLIC_URL -> https://ezerbot-system.onrender.com
 * BOT_PUBLIC_LINK -> https://t.me/Ezer_IA_Bot?start=1
 */

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const GAS_URL = process.env.GAS_URL || "";
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const BOT_PUBLIC_LINK = process.env.BOT_PUBLIC_LINK || "";

if (!BOT_TOKEN) console.warn("⚠️ Falta BOT_TOKEN en Environment");
if (!GAS_URL) console.warn("⚠️ Falta GAS_URL en Environment (URL completa /exec)");
if (!PUBLIC_URL) console.warn("⚠️ Falta PUBLIC_URL en Environment");

const app = express();
app.use(express.json({ limit: "2mb" }));

// --- Bot en modo webhook ---
const bot = new TelegramBot(BOT_TOKEN, { webHook: true });

let CATALOGO = [];          // [{codigo,nombre,precio,unidad,precioporkg,codigobarras,descripcion,imagen,categoria}]
let CATS = [];              // ["Promos", "Quesos", ...]
let BOOTED_AT = new Date().toISOString();
let LAST_ERROR = null;
let CATALOGO_LOADED_AT = null;

// Estado simple por chat
const S = new Map(); // chatId -> { mode, catIndex, prodIndex, category, cart: [{codigo,nombre,unidad,qty,grams,priceUnit,subtotal}] }

function st(chatId) {
  if (!S.has(chatId)) S.set(chatId, { mode: "HOME", catIndex: 0, prodIndex: 0, category: null, cart: [] });
  return S.get(chatId);
}

function money(n) {
  const x = Number(n || 0);
  return x.toLocaleString("es-AR");
}

function safeText(x) {
  return (x ?? "").toString().trim();
}

function uniqCats() {
  const set = new Set();
  for (const p of CATALOGO) {
    const c = safeText(p.categoria) || "Sin categoría";
    set.add(c);
  }
  return [...set];
}

async function loadCatalogo() {
  LAST_ERROR = null;
  if (!GAS_URL || !/^https?:\/\//i.test(GAS_URL)) {
    LAST_ERROR = `GAS_URL inválida (debe ser URL completa): ${GAS_URL}`;
    return;
  }

  // Espera: GAS devuelve { ok:true, productos:[...] }
  const url = `${GAS_URL}${GAS_URL.includes("?") ? "&" : "?"}action=catalogo`;
  const r = await fetch(url, { method: "GET" });
  const j = await r.json().catch(() => null);

  // Fallback: si no existe action=catalogo, intenta sin action
  let data = j;
  if (!data || (!data.productos && !Array.isArray(data))) {
    const r2 = await fetch(GAS_URL, { method: "GET" });
    data = await r2.json().catch(() => null);
  }

  let productos = [];
  if (data && Array.isArray(data.productos)) productos = data.productos;
  else if (Array.isArray(data)) productos = data;
  else productos = [];

  // Normaliza
  CATALOGO = productos.map((p) => ({
    codigo: safeText(p.codigo),
    nombre: safeText(p.nombre),
    precio: Number(p.precio || 0),
    unidad: safeText(p.unidad) || "unidad", // "kg" o "unidad"
    precioporkg: Number(p.precioporkg || p.precio || 0),
    codigobarras: safeText(p.codigobarras),
    descripcion: safeText(p.descripcion),
    imagen: safeText(p.imagen),
    categoria: safeText(p.categoria) || "Sin categoría",
  }));

  CATS = uniqCats();
  CATALOGO_LOADED_AT = new Date().toISOString();
}

function mainMenuKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🛍️ Catálogo" }, { text: "🛒 Mi carrito" }],
        [{ text: "✅ Finalizar compra" }],
        [{ text: "📣 Compartir el bot" }],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };
}

function catsKeyboard() {
  const rows = [];
  // 2 columnas
  for (let i = 0; i < CATS.length; i += 2) {
    const a = CATS[i];
    const b = CATS[i + 1];
    const row = [{ text: `📁 ${a}` }];
    if (b) row.push({ text: `📁 ${b}` });
    rows.push(row);
  }
  rows.push([{ text: "🏠 Menú" }]);
  return { reply_markup: { keyboard: rows, resize_keyboard: true } };
}

function productInlineKeyboard() {
  // SOLO 2 botones como pediste
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Quiero este", callback_data: "P_WANT" }],
        [{ text: "📣 Compartir", callback_data: "P_SHARE" }],
        [
          { text: "⬅️ Anterior", callback_data: "P_PREV" },
          { text: "➡️ Siguiente", callback_data: "P_NEXT" },
        ],
        [{ text: "📁 Volver a categorías", callback_data: "P_BACK_CATS" }],
      ],
    },
  };
}

function shareInlineKeyboard(shareText) {
  const encoded = encodeURIComponent(shareText);
  const wa = `https://wa.me/?text=${encoded}`;
  const tg = `https://t.me/share/url?url=&text=${encoded}`;
  const em = `mailto:?subject=${encodeURIComponent("Promo / Producto")}&body=${encoded}`;

  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📲 WhatsApp", url: wa }],
        [{ text: "✈️ Telegram", url: tg }],
        [{ text: "✉️ Email", url: em }],
        [{ text: "⬅️ Volver al producto", callback_data: "SH_BACK" }],
      ],
    },
  };
}

function buildFixedShareText(p) {
  // ✅ TEXTO FIJO (no Config)
  // Podés editar acá el estilo, pero queda fijo siempre.
  const nombre = p.nombre || "Producto";
  const precio = p.unidad === "kg"
    ? `Desde $${money(p.precioporkg)} / kg`
    : `$${money(p.precio)}`;

  const lineas = [
    `🧀 *Todo Queso*`,
    `✨ Mirá esto: *${nombre}*`,
    `💰 ${precio}`,
  ];

  if (p.descripcion) lineas.push(`📝 ${p.descripcion}`);
  if (BOT_PUBLIC_LINK) lineas.push(`🤖 Pedilo acá: ${BOT_PUBLIC_LINK}`);

  return lineas.join("\n");
}

async function sendProduct(chatId) {
  const state = st(chatId);
  const category = state.category;

  const list = CATALOGO.filter((p) => (safeText(p.categoria) || "Sin categoría") === category);
  if (!list.length) {
    await bot.sendMessage(chatId, "⚠️ No hay productos en esta categoría.", mainMenuKeyboard());
    return;
  }

  if (state.prodIndex < 0) state.prodIndex = 0;
  if (state.prodIndex >= list.length) state.prodIndex = list.length - 1;

  const p = list[state.prodIndex];

  const precioLinea = p.unidad === "kg"
    ? `💰 $${money(p.precioporkg)} / kg`
    : `💰 $${money(p.precio)}`;

  const txt = [
    `📦 *${p.nombre}*`,
    `🏷️ Código: ${p.codigo || "-"}`,
    `📌 Categoría: ${p.categoria}`,
    `⚖️ Unidad: ${p.unidad}`,
    precioLinea,
    p.descripcion ? `\n📝 ${p.descripcion}` : "",
  ].join("\n");

  if (p.imagen && /^https?:\/\//i.test(p.imagen)) {
    await bot.sendPhoto(chatId, p.imagen, {
      caption: txt,
      parse_mode: "Markdown",
      ...productInlineKeyboard(),
    });
  } else {
    await bot.sendMessage(chatId, txt, { parse_mode: "Markdown", ...productInlineKeyboard() });
  }
}

function cartTotals(cart) {
  let total = 0;
  for (const it of cart) total += Number(it.subtotal || 0);
  return total;
}

async function showCart(chatId) {
  const state = st(chatId);
  if (!state.cart.length) {
    await bot.sendMessage(chatId, "🛒 Tu carrito está vacío.", mainMenuKeyboard());
    return;
  }

  const lines = ["🛒 *Tu carrito:*"];
  state.cart.forEach((it, i) => {
    const qtyTxt = it.unidad === "kg"
      ? `${it.grams}g`
      : `x${it.qty}`;
    lines.push(`${i + 1}) ${it.nombre} (${it.codigo}) — ${qtyTxt} — $${money(it.subtotal)}`);
  });

  const total = cartTotals(state.cart);
  lines.push(`\n💵 *Total:* $${money(total)}`);

  await bot.sendMessage(chatId, lines.join("\n"), { parse_mode: "Markdown", ...mainMenuKeyboard() });
}

// --- Webhook endpoint ---
app.post("/webhook", async (req, res) => {
  try {
    await bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (e) {
    LAST_ERROR = String(e?.message || e);
    res.sendStatus(200);
  }
});

app.get("/", (req, res) => res.status(200).send("ok"));
app.get("/debug", (req, res) => {
  res.json({
    ok: true,
    bootedAt: BOOTED_AT,
    publicUrl: PUBLIC_URL || null,
    gasUrlSet: !!GAS_URL,
    catalogoLoadedAt: CATALOGO_LOADED_AT,
    catalogoCount: CATALOGO.length,
    sampleCats: CATS.slice(0, 10),
    lastError: LAST_ERROR,
  });
});

// --- Handlers ---
bot.onText(/\/start/i, async (msg) => {
  const chatId = msg.chat.id;

  // Respuesta cálida (simple y clara)
  const nombre = msg.from?.first_name ? ` ${msg.from.first_name}` : "";
  const welcome = `Hola${nombre} 😊\n\nSoy el asistente de *Todo Queso* 🧀\nElegí una opción para comprar sin perderte 👇`;

  await bot.sendMessage(chatId, welcome, { parse_mode: "Markdown", ...mainMenuKeyboard() });
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = safeText(msg.text);

  // Evita duplicar /start (ya lo maneja onText)
  if (text.startsWith("/start")) return;

  try {
    // Menú
    if (text === "🏠 Menú" || text.toLowerCase() === "menu") {
      await bot.sendMessage(chatId, "Dale 😊 Elegí una opción del menú 👇", mainMenuKeyboard());
      return;
    }

    // Catálogo
    if (text === "🛍️ Catálogo" || text.toLowerCase().includes("catálogo") || text.toLowerCase().includes("catalogo")) {
      if (!CATALOGO.length) {
        await bot.sendMessage(chatId, "⏳ Todavía no cargó el catálogo. Probá de nuevo en 10 segundos.", mainMenuKeyboard());
        return;
      }
      await bot.sendMessage(chatId, "📁 Elegí una categoría:", catsKeyboard());
      return;
    }

    // Carrito
    if (text === "🛒 Mi carrito" || text.toLowerCase().includes("carrito")) {
      await showCart(chatId);
      return;
    }

    // Compartir bot (aparte)
    if (text === "📣 Compartir el bot") {
      if (!BOT_PUBLIC_LINK) {
        await bot.sendMessage(chatId, "⚠️ Falta configurar BOT_PUBLIC_LINK en Environment.", mainMenuKeyboard());
        return;
      }
      await bot.sendMessage(chatId, `📣 Compartí el bot con tus amigos 🙌\n${BOT_PUBLIC_LINK}`, mainMenuKeyboard());
      return;
    }

    // Si eligió una categoría (📁 ...)
    if (text.startsWith("📁 ")) {
      const cat = text.replace("📁 ", "").trim();
      const state = st(chatId);
      state.category = cat;
      state.prodIndex = 0;
      await sendProduct(chatId);
      return;
    }

    // Si el bot está esperando cantidad / gramos
    const state = st(chatId);
    if (state.mode === "ASK_QTY") {
      const v = text.replace(",", ".").trim();

      const pending = state.pendingItem;
      if (!pending) {
        state.mode = "HOME";
        await bot.sendMessage(chatId, "Listo 😊 Volvé al catálogo cuando quieras.", mainMenuKeyboard());
        return;
      }

      if (pending.unidad === "kg") {
        // gramos
        const grams = Math.max(0, parseInt(v, 10) || 0);
        if (!grams) {
          await bot.sendMessage(chatId, "Decime los gramos (ej: 250, 300, 500).");
          return;
        }
        const pricePerKg = pending.precioporkg || pending.precio || 0;
        const subtotal = Math.round((grams / 1000) * pricePerKg);

        state.cart.push({
          codigo: pending.codigo,
          nombre: pending.nombre,
          unidad: "kg",
          grams,
          qty: 0,
          priceUnit: pricePerKg,
          subtotal,
        });

        state.mode = "HOME";
        state.pendingItem = null;

        await bot.sendMessage(chatId, `✅ Agregado: ${pending.nombre}\nSubtotal: $${money(subtotal)}\n\n¿Querés seguir comprando o ver tu carrito?`, mainMenuKeyboard());
        return;
      } else {
        // unidades
        const qty = Math.max(0, parseInt(v, 10) || 0);
        if (!qty) {
          await bot.sendMessage(chatId, "Decime la cantidad (ej: 1, 2, 3).");
          return;
        }
        const subtotal = qty * (pending.precio || 0);

        state.cart.push({
          codigo: pending.codigo,
          nombre: pending.nombre,
          unidad: "unidad",
          grams: 0,
          qty,
          priceUnit: pending.precio || 0,
          subtotal,
        });

        state.mode = "HOME";
        state.pendingItem = null;

        await bot.sendMessage(chatId, `✅ Agregado: ${pending.nombre}\nSubtotal: $${money(subtotal)}\n\n¿Querés seguir comprando o ver tu carrito?`, mainMenuKeyboard());
        return;
      }
    }

    // Cualquier otra cosa: respuesta corta + menú
    await bot.sendMessage(chatId, "Dale 😊 Elegí una opción del menú 👇", mainMenuKeyboard());
  } catch (e) {
    LAST_ERROR = String(e?.message || e);
    await bot.sendMessage(chatId, "⚠️ Uy, algo falló. Probá de nuevo.", mainMenuKeyboard());
  }
});

// Callbacks (botones inline)
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const state = st(chatId);

  try {
    const data = q.data || "";

    // Lista de productos filtrada por categoría actual
    const category = state.category;
    const list = CATALOGO.filter((p) => (safeText(p.categoria) || "Sin categoría") === category);

    if (data === "P_NEXT") {
      state.prodIndex = (state.prodIndex || 0) + 1;
      await bot.answerCallbackQuery(q.id);
      await sendProduct(chatId);
      return;
    }
    if (data === "P_PREV") {
      state.prodIndex = (state.prodIndex || 0) - 1;
      await bot.answerCallbackQuery(q.id);
      await sendProduct(chatId);
      return;
    }
    if (data === "P_BACK_CATS") {
      await bot.answerCallbackQuery(q.id);
      await bot.sendMessage(chatId, "📁 Elegí una categoría:", catsKeyboard());
      return;
    }

    if (data === "P_WANT") {
      await bot.answerCallbackQuery(q.id);

      if (!list.length) {
        await bot.sendMessage(chatId, "⚠️ No hay productos en esta categoría.", mainMenuKeyboard());
        return;
      }

      const p = list[state.prodIndex];
      state.pendingItem = p;

      // Pregunta gramos / unidades
      if ((p.unidad || "").toLowerCase() === "kg") {
        state.mode = "ASK_QTY";
        await bot.sendMessage(chatId, `Perfecto ✅\n¿Cuántos *gramos* querés de *${p.nombre}*? (ej: 250, 300, 500)`, { parse_mode: "Markdown" });
      } else {
        state.mode = "ASK_QTY";
        await bot.sendMessage(chatId, `Perfecto ✅\n¿Cuántas *unidades* querés de *${p.nombre}*? (ej: 1, 2, 3)`, { parse_mode: "Markdown" });
      }
      return;
    }

    if (data === "P_SHARE") {
      await bot.answerCallbackQuery(q.id);

      if (!list.length) {
        await bot.sendMessage(chatId, "⚠️ No hay productos para compartir.", mainMenuKeyboard());
        return;
      }

      const p = list[state.prodIndex];
      const shareText = buildFixedShareText(p);

      await bot.sendMessage(
        chatId,
        `📣 Compartir *${p.nombre}*\n¿Dónde querés compartirlo?`,
        { parse_mode: "Markdown", ...shareInlineKeyboard(shareText) }
      );
      return;
    }

    if (data === "SH_BACK") {
      await bot.answerCallbackQuery(q.id);
      await sendProduct(chatId);
      return;
    }

    await bot.answerCallbackQuery(q.id);
  } catch (e) {
    LAST_ERROR = String(e?.message || e);
    try { await bot.answerCallbackQuery(q.id); } catch (_) {}
  }
});

// --- Arranque server ---
const PORT = process.env.PORT || 10000;

app.listen(PORT, async () => {
  console.log("✅ Server up on", PORT);

  // Carga catálogo al iniciar
  try {
    await loadCatalogo();
    console.log("✅ Catálogo cargado:", CATALOGO.length);
  } catch (e) {
    LAST_ERROR = String(e?.message || e);
    console.log("⚠️ Error cargando catálogo:", LAST_ERROR);
  }

  // Set webhook
  try {
    if (PUBLIC_URL) {
      const wh = `${PUBLIC_URL}/webhook`;
      await bot.setWebHook(wh);
      console.log("✅ Webhook seteado:", wh);
    } else {
      console.log("⚠️ Sin PUBLIC_URL, no se pudo setear webhook.");
    }
  } catch (e) {
    LAST_ERROR = String(e?.message || e);
    console.log("⚠️ Error setWebHook:", LAST_ERROR);
  }
});

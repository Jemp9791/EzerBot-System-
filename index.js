import express from "express";
import TelegramBot from "node-telegram-bot-api";

const BOT_TOKEN = process.env.BOT_TOKEN;
const GAS_URL = process.env.GAS_URL; // GAS endpoint: GET catalog/config + POST upsertCliente/crearPedido
const WEBHOOK_URL = process.env.WEBHOOK_URL; // opcional: si lo ponés, usa webhook. Si no, polling.
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
 *   mode: "idle" | "catalog" | "await_qty" | "await_receipt",
 *   categories: string[],
 *   productos: [],
 *   currentCategory: string|null,
 *   pageIndex: number,
 *   pendingProduct: object|null,
 *   cart: [{codigo,nombre,unidad,precioUnit,cantidad,cantidadText,subtotal}],
 *   checkout: { metodo:null|"envio"|"retiro", costoEnvio:number, ticketText:string|null, pedidoId:string|null }
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
      checkout: { metodo: null, costoEnvio: 0, ticketText: null, pedidoId: null },
    });
  }
  return stateByChatId.get(chatId);
}

// -------------------- Helpers UI --------------------
function mainMenuKeyboard(config) {
  const negocio = (config?.NegocioNombre || "TODO QUESO CLUB").toUpperCase();
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🛍️ Catálogo" }, { text: "🛒 Mi carrito" }],
        [{ text: config?.UsaSellos === "SI" || config?.UsaSellos === true ? "🎁 Mis sellos" : "🎁 Beneficios" }],
        [{ text: "💬 Hablar con el vendedor" }],
        [{ text: "🏪 Información del local" }, { text: "📣 Compartir el bot" }],
      ],
      resize_keyboard: true,
    },
    _meta: { negocio },
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

function shippingKeyboard(config) {
  const usarEnvio = config?.UsaEnvíoDomicilio === "SI" || config?.UsaEnvíoDomicilio === true;
  const usarRetiro = config?.UsaRetiroLocal === "SI" || config?.UsaRetiroLocal === true;

  const kb = { inline_keyboard: [] };

  if (usarEnvio) {
    const txt = config?.TextoEnvíoDomicilio || "🚚 Envío a domicilio";
    kb.inline_keyboard.push([{ text: `🚚 ${txt}`, callback_data: "SHIP_HOME" }]);
  }
  if (usarRetiro) {
    const txt = config?.TextoRetiroLocal || "🏪 Retiro en el local";
    kb.inline_keyboard.push([{ text: `🏪 ${txt}`, callback_data: "SHIP_PICKUP" }]);
  }

  // fallback si Config aún no está completo
  if (!kb.inline_keyboard.length) {
    kb.inline_keyboard = [
      [{ text: "🚚 Envío a domicilio", callback_data: "SHIP_HOME" }],
      [{ text: "🏪 Retiro en el local", callback_data: "SHIP_PICKUP" }],
    ];
  }

  return { reply_markup: kb };
}

function formatARS(n) {
  const num = Number(n || 0);
  return new Intl.NumberFormat("es-AR").format(num);
}

// -------------------- GAS fetch (cache) --------------------
let cacheCatalog = { ts: 0, data: null };
let cacheConfig = { ts: 0, data: null };

async function fetchCatalog() {
  const now = Date.now();
  if (cacheCatalog.data && now - cacheCatalog.ts < 30_000) return cacheCatalog.data;

  // soporta ambos: GAS_URL (sin type) o ?type=catalogo
  const url = GAS_URL.includes("?") ? `${GAS_URL}&type=catalogo` : `${GAS_URL}?type=catalogo`;
  const res = await fetch(url, { method: "GET" });
  const json = await res.json();

  if (!json || json.ok !== true || !Array.isArray(json.productos)) {
    return { ok: false, productos: [] };
  }

  cacheCatalog = { ts: now, data: json };
  return json;
}

async function fetchConfig() {
  const now = Date.now();
  if (cacheConfig.data && now - cacheConfig.ts < 30_000) return cacheConfig.data;

  const url = GAS_URL.includes("?") ? `${GAS_URL}&type=config` : `${GAS_URL}?type=config`;
  const res = await fetch(url, { method: "GET" });
  const json = await res.json();

  if (!json || json.ok !== true || !json.config) {
    cacheConfig = { ts: now, data: { ok: true, config: {} } };
    return cacheConfig.data;
  }

  cacheConfig = { ts: now, data: json };
  return json;
}

async function gasPost(payload) {
  const res = await fetch(GAS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  return json;
}

// -------------------- Normalizadores --------------------
function normalizeCategoryLabelToRaw(state, label) {
  const plain = String(label).replace(/[^\p{L}\p{N}\s]/gu, "").trim().toLowerCase();

  const raw =
    state.categories.find((c) => String(c).toLowerCase().includes(plain)) ||
    state.categories.find((c) => plain.includes(String(c).toLowerCase()));

  if (raw) return raw;

  const possible = label.replace(/^.*?\s/, "");
  return state.categories.find((c) => String(c).toLowerCase() === String(possible).toLowerCase()) || null;
}

function isKgUnit(prod) {
  const u = String(prod.unidad || "").toLowerCase();
  return u.includes("kg") || u.includes("kilo");
}

function priceForProduct(prod) {
  const ppk = Number(prod.precioporkg || 0);
  const p = Number(prod.precio || 0);
  return ppk > 0 ? ppk : p;
}

// -------------------- Render catálogo (3 por página) --------------------
async function showCategories(chatId) {
  const state = getState(chatId);
  const data = await fetchCatalog();

  const productos = (data.productos || []).filter(
    (p) => p && p.categoria && p.codigo && p.nombre && (p.precio || p.precioporkg) && p.imagen
  );
  const categories = [...new Set(productos.map((p) => String(p.categoria).trim()).filter(Boolean))];

  state.productos = productos;
  state.categories = categories;
  state.currentCategory = null;
  state.pageIndex = 0;
  state.mode = "catalog";

  const cfg = (await fetchConfig()).config || {};

  if (!categories.length) {
    await bot.sendMessage(
      chatId,
      "⚠️ No hay categorías / productos cargados todavía.\nRevisá tu Sheet/GAS: debe devolver productos con `categoria`, `codigo`, `nombre`, `precio|precioporkg`, `imagen`.",
      mainMenuKeyboard(cfg)
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
    await bot.sendMessage(chatId, "⚠️ Esa categoría no tiene productos cargados.", categoriesKeyboard(state.categories));
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
    const showPrice = prod.precioporkg ? prod.precioporkg : prod.precio;
    const caption =
      `${prod.nombre}\n` +
      `💵 $${formatARS(showPrice)} ARS\n` +
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
    return `${i + 1}) ${x.nombre} (${x.codigo})\n   Cantidad: ${x.cantidadText}\n   Subtotal: $${formatARS(
      x.subtotal
    )} ARS`;
  });

  return `🛒 Tu carrito:\n\n${lines.join("\n\n")}\n\n💰 Total: $${formatARS(cartTotal(state))} ARS`;
}

// -------------------- Checkout + Ticket (Módulo A) --------------------
function buildTicketPOS(state, config, pedidoId) {
  const negocio = config?.NegocioNombre || "TODO QUESO CLUB";
  const fecha = new Date().toLocaleString("es-AR");
  const alias = config?.AliasPago || "-";
  const cbu = config?.CBUPago || "-";
  const moneda = config?.Moneda || "ARS";

  const detalle = state.cart
    .map((x) => `• ${x.nombre} (${x.cantidadText})  $${formatARS(x.subtotal)} ${moneda}`)
    .join("\n");

  const envioTxt =
    state.checkout.metodo === "envio"
      ? `🚚 Envío: $${formatARS(state.checkout.costoEnvio)} ${moneda}`
      : `🏪 ${config?.TextoRetiroLocal || "Retiro en el local"}`;

  const total = cartTotal(state) + Number(state.checkout.costoEnvio || 0);

  const post = (config?.MensajePostCompra || "").trim();
  const postLine = post ? `\n\n${post}` : "";

  return (
    `🧾 *${negocio}*\n` +
    `Ticket Nº *${pedidoId || "TQ-" + Date.now().toString().slice(-6)}*\n` +
    `📅 ${fecha}\n\n` +
    `${detalle}\n\n` +
    `${envioTxt}\n\n` +
    `💰 *TOTAL: $${formatARS(total)} ${moneda}*\n\n` +
    `💳 Alias: ${alias}\n` +
    `🏦 CBU: ${cbu}\n\n` +
    `📩 Enviá el comprobante para preparar tu pedido.` +
    postLine
  );
}

function buildPedidoObject(msg, state, config, pedidoId) {
  const nombre = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ").trim() || "Cliente";
  const telefono = msg.from?.username ? `@${msg.from.username}` : ""; // Telegram no da teléfono
  const fecha = new Date().toISOString();

  const total = cartTotal(state) + Number(state.checkout.costoEnvio || 0);

  return {
    PedidoID: pedidoId,
    Fecha: fecha,
    ChatId: String(msg.chat.id),
    ClienteNombre: nombre,
    ClienteTelefono: telefono,
    Detalle: state.cart.map((x) => `${x.codigo} | ${x.nombre} | ${x.cantidadText} | ${x.subtotal}`).join("\n"),
    MetodoEntrega: state.checkout.metodo === "envio" ? "ENVIO" : "RETIRO",
    CostoEnvio: Number(state.checkout.costoEnvio || 0),
    Total: Number(total || 0),
    EstadoPedido: "PENDIENTE_COMPROBANTE",
    TicketTexto: state.checkout.ticketText || "",
  };
}

async function upsertClienteFromMsg(msg) {
  const nombre = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ").trim() || "Cliente";
  const telefono = msg.from?.username ? `@${msg.from.username}` : "";

  const cliente = {
    ChatId: String(msg.chat.id),
    Nombre: nombre,
    Telefono: telefono,
    FechaAlta: new Date().toISOString(),
  };

  await gasPost({ type: "upsertCliente", cliente });
}

// -------------------- Comandos y mensajes --------------------
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const state = getState(chatId);
  state.mode = "idle";

  const cfg = (await fetchConfig()).config || {};

  // Guardamos/actualizamos cliente (sheet Clientes en formato A/B lo hace GAS)
  try {
    await upsertClienteFromMsg(msg);
  } catch (e) {
    console.error("upsertCliente error:", e);
  }

  const negocio = cfg?.NegocioNombre || "TODO QUESO CLUB";

  // Si hay logo, mostramos logo + bienvenida
  if (cfg?.LogoURL) {
    try {
      await bot.sendPhoto(chatId, cfg.LogoURL, {
        caption:
          `Hola ${msg.from?.first_name || ""} 👋\n` +
          `Soy el asistente de *${negocio}* 🧀\n\n` +
          `Desde acá podés:\n• Ver el catálogo\n• Armar tu pedido\n• Finalizar compra\n\n👇 Elegí una opción`,
        parse_mode: "Markdown",
        ...mainMenuKeyboard(cfg),
      });
      return;
    } catch (e) {
      // si falla foto, caemos a texto
    }
  }

  await bot.sendMessage(
    chatId,
    `Hola ${msg.from?.first_name || ""} 👋\nSoy el asistente de *${negocio}* 🧀\n\nDesde acá podés:\n• Ver el catálogo\n• Armar tu pedido\n• Finalizar compra\n\n👇 Elegí una opción`,
    { parse_mode: "Markdown", ...mainMenuKeyboard(cfg) }
  );
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const state = getState(chatId);

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
      await bot.sendMessage(
        chatId,
        "⚠️ Decime la cantidad en gramos o kilos.\nEjemplos: 250g / 0.5kg / 500",
        removeKeyboard()
      );
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
      `✅ Agregado al carrito:\n${prod.nombre}\nCantidad: ${grams} g\nSubtotal: $${formatARS(subtotal)} ARS\n\n¿Seguimos sumando algo más? 😋`,
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
    const cfg = (await fetchConfig()).config || {};
    await bot.sendMessage(chatId, "🏠 Menú principal:", mainMenuKeyboard(cfg));
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

  // Fallback info desde Config
  const cfg = (await fetchConfig()).config || {};

  if (text === "💬 Hablar con el vendedor") {
    // Por ahora: mostramos WhatsAppLink si existe
    if (cfg?.WhatsAppLink) {
      await bot.sendMessage(
        chatId,
        `💬 Hablá con nosotros por WhatsApp 👇`,
        {
          reply_markup: {
            inline_keyboard: [[{ text: "📲 Abrir WhatsApp", url: cfg.WhatsAppLink }]],
          },
        }
      );
    } else {
      await bot.sendMessage(chatId, "Escribinos tu consulta y te respondemos a la brevedad.", mainMenuKeyboard(cfg));
    }
    return;
  }

  if (text === "🏪 Información del local") {
    const nombre = cfg?.NegocioNombre || "TODO QUESO CLUB";
    const dir = cfg?.Dirección || "-";
    const hor = cfg?.Horarios || "-";
    const tel = cfg?.TeléfonoNegocio || "-";
    const desc = cfg?.Descripcion ? `\n\n${cfg.Descripcion}` : "";
    await bot.sendMessage(
      chatId,
      `🏪 *${nombre}*\n📍 ${dir}\n🕒 ${hor}\n📞 ${tel}${desc}`,
      { parse_mode: "Markdown", ...mainMenuKeyboard(cfg) }
    );
    return;
  }

  if (text === "📣 Compartir el bot") {
    await bot.sendMessage(chatId, cfg?.TextoCompartirBot || "📣 Compartí el bot desde el botón de compartir de Telegram.", mainMenuKeyboard(cfg));
    return;
  }

  if (text === "🎁 Mis sellos" || text === "🎁 Beneficios") {
    if (cfg?.UsaSellos === "SI" || cfg?.UsaSellos === true) {
      await bot.sendMessage(
        chatId,
        "🎁 Tu tarjeta de sellos todavía no está visible en este módulo.\nLa activamos en el siguiente paso (sellos/níveles).",
        mainMenuKeyboard(cfg)
      );
    } else {
      await bot.sendMessage(chatId, "🎁 Beneficios disponibles próximamente.", mainMenuKeyboard(cfg));
    }
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
      const items = state.productos.filter(
        (p) =>
          String(p.categoria).trim().toLowerCase() ===
          String(state.currentCategory).trim().toLowerCase()
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
          `✅ Agregado al carrito:\n${prod.nombre}\nSubtotal: $${formatARS(subtotal)} ARS\n\n¿Sumamos algo más? 😋`,
          cartInlineKeyboard()
        );
        return;
      }
    }

    if (data === "CART_CLEAR") {
      await bot.answerCallbackQuery(cq.id);
      state.cart = [];
      state.checkout = { metodo: null, costoEnvio: 0, ticketText: null, pedidoId: null };
      const cfg = (await fetchConfig()).config || {};
      await bot.sendMessage(chatId, "🧹 Listo. Carrito vacío.", mainMenuKeyboard(cfg));
      return;
    }

    // ✅ MÓDULO A: CHECKOUT REAL
    if (data === "CHECKOUT") {
      await bot.answerCallbackQuery(cq.id);

      if (!state.cart.length) {
        const cfg = (await fetchConfig()).config || {};
        await bot.sendMessage(chatId, "🛒 Tu carrito está vacío.", mainMenuKeyboard(cfg));
        return;
      }

      const cfg = (await fetchConfig()).config || {};

      await bot.sendMessage(
        chatId,
        `🧾 *Finalizar compra*\n\n${cartText(state)}\n\n¿Cómo querés recibir tu pedido?`,
        { parse_mode: "Markdown", ...shippingKeyboard(cfg) }
      );
      return;
    }

    if (data === "SHIP_HOME" || data === "SHIP_PICKUP") {
      await bot.answerCallbackQuery(cq.id);

      const cfg = (await fetchConfig()).config || {};

      state.checkout.metodo = data === "SHIP_HOME" ? "envio" : "retiro";
      state.checkout.costoEnvio =
        state.checkout.metodo === "envio" ? Number(cfg?.CostoEnvíoBase || 0) : 0;

      // Crear PedidoID (primero en GAS para que sea único)
      // Si GAS no devuelve pedidoId, hacemos fallback local.
      const pedidoIdFallback = "TQ-" + Date.now().toString().slice(-6);

      // Armamos ticket con pedidoId provisional por ahora
      const ticketTemp = buildTicketPOS(state, cfg, pedidoIdFallback);
      state.checkout.ticketText = ticketTemp;

      // Registramos/actualizamos cliente (por si entró directo al checkout)
      try {
        await upsertClienteFromMsg({ chat: { id: chatId }, from: cq.from });
      } catch (e) {
        console.error("upsertClienteFromMsg (cq) error:", e);
      }

      // Creamos pedido en Sheets vía GAS
      let pedidoId = pedidoIdFallback;
      try {
        const pedidoObj = buildPedidoObject(
          { chat: { id: chatId }, from: cq.from },
          state,
          cfg,
          pedidoIdFallback
        );

        const created = await gasPost({ type: "crearPedido", pedido: pedidoObj });
        if (created?.ok && created?.pedidoId) {
          pedidoId = String(created.pedidoId);
        }

        // Re-armamos ticket con ID definitivo si vino
        const ticketFinal = buildTicketPOS(state, cfg, pedidoId);
        state.checkout.ticketText = ticketFinal;
        state.checkout.pedidoId = pedidoId;

        // Guardamos ticket definitivo también (opcional) — si querés que el GAS lo actualice, lo hacemos luego
        await bot.sendMessage(chatId, ticketFinal, { parse_mode: "Markdown" });
      } catch (e) {
        console.error("crearPedido error:", e);
        // Igual mostramos ticket para que el cliente pueda pagar
        await bot.sendMessage(chatId, state.checkout.ticketText, { parse_mode: "Markdown" });
      }

      state.mode = "await_receipt";
      return;
    }

    await bot.answerCallbackQuery(cq.id);
  } catch (e) {
    console.error(e);
    try {
      await bot.answerCallbackQuery(cq.id);
    } catch (_) {}
    await bot.sendMessage(chatId, "⚠️ Ocurrió un error interno. Probá de nuevo.");
  }
});

import express from "express";
import TelegramBot from "node-telegram-bot-api";

const TOKEN = "8130447159:AAHxzp5S1lcgYOemw5dgF5V1DGh141dHmkA";
const BACKEND =
  "https://script.google.com/macros/s/AKfycbxznmXVhDFd45kwrtsO0lORoGDn7AcHVdQIYQkgYy_63jaJCrjumzphVK_N39T_zjK_/exec";
const LOGO = "https://i.postimg.cc/q7WvjsYm/20251206-210311.jpg";
const URL_BASE = "https://ezerbot-system.onrender.com";

const app = express();
app.use(express.json());

// ✅ IMPORTANTE: no usamos webHook port en TelegramBot (evita conflictos con Render/Express)
const bot = new TelegramBot(TOKEN, { polling: false });

// ===============
// Helpers
// ===============
function menuInline() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🛍️ Catálogo", callback_data: "CATALOGO" },
          { text: "🛒 Mi carrito", callback_data: "CARRITO" },
        ],
        [{ text: "🏆 Mis sellos", callback_data: "SELLOS" }],
        [{ text: "💬 Hablar con el vendedor", callback_data: "HABLAR" }],
        [
          { text: "ℹ️ Info del local", callback_data: "INFO" },
          { text: "📣 Compartir bot", callback_data: "COMPARTIR" },
        ],
      ],
    },
  };
}

function backToMenuInline() {
  return {
    reply_markup: {
      inline_keyboard: [[{ text: "🏠 Menú", callback_data: "MENU" }]],
    },
  };
}

function escMd(s = "") {
  // markdown básico para no romper mensajes
  return String(s).replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

function toNum(x) {
  const n = Number(String(x).replace(",", ".").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function normalizeCatalogPayload(r) {
  const items =
    r?.items ||
    r?.data ||
    r?.catalogo ||
    r?.productos ||
    r?.Products ||
    r?.products ||
    [];
  return Array.isArray(items) ? items : [];
}

function catEmoji(cat) {
  const c = String(cat || "").toLowerCase();
  if (c.includes("ques")) return "🧀";
  if (c.includes("fiam") || c.includes("jam") || c.includes("sal")) return "🥓";
  if (c.includes("pan") || c.includes("lactal") || c.includes("panif")) return "🥖";
  if (c.includes("dulce") || c.includes("merm") || c.includes("batata") || c.includes("membr")) return "🍯";
  if (c.includes("beb") || c.includes("gase") || c.includes("jug") || c.includes("agua")) return "🥤";
  if (c.includes("lact") || c.includes("leche") || c.includes("yog")) return "🥛";
  if (c.includes("huev")) return "🥚";
  if (c.includes("combo") || c.includes("promo")) return "🔥";
  return "📦";
}

// ===============
// Cache + carrito
// ===============
const catalogCache = { ts: 0, items: [] };
const carts = new Map(); // chatId -> [{codigo,nombre,precio,cantidadTxt}]

function getCart(chatId) {
  if (!carts.has(chatId)) carts.set(chatId, []);
  return carts.get(chatId);
}

async function GAS(action, params = {}) {
  const url = new URL(BACKEND);
  url.searchParams.append("accion", action);
  for (const k in params) url.searchParams.append(k, params[k]);

  const r = await fetch(url.toString(), { method: "GET" });
  const data = await r.json().catch(() => ({}));
  return data;
}

async function getCatalogSafe() {
  // cache 20s para no matar GAS
  const now = Date.now();
  if (catalogCache.items.length && now - catalogCache.ts < 20000) return catalogCache.items;

  const r = await GAS("catalogo");
  const items = normalizeCatalogPayload(r);

  catalogCache.items = items;
  catalogCache.ts = now;
  return items;
}

function buildCategoryKeyboard(categories) {
  // 2 por fila
  const rows = [];
  for (let i = 0; i < categories.length; i += 2) {
    const a = categories[i];
    const b = categories[i + 1];
    const row = [{ text: `${catEmoji(a)} ${a}`, callback_data: `CAT_${a}` }];
    if (b) row.push({ text: `${catEmoji(b)} ${b}`, callback_data: `CAT_${b}` });
    rows.push(row);
  }
  rows.push([{ text: "🏠 Menú", callback_data: "MENU" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function suggestionFor(product, allItems) {
  const cat = String(product?.categoria || product?.category || "General");
  const name = String(product?.nombre || product?.name || "");
  const low = (cat + " " + name).toLowerCase();

  // Solo sugerir “andá a Catálogo > X”
  if (low.includes("ques")) {
    const sug = ["Panificados", "Dulces", "Fiambres"].find((c) =>
      allItems.some((p) => String(p.categoria || p.category || "General").toLowerCase().includes(c.toLowerCase()))
    );
    return sug ? `💡 Si querés acompañar, mirá en *Catálogo → ${escMd(sug)}* 😋` : `💡 Si querés acompañar, mirá *Catálogo → Panificados / Dulces* 😋`;
  }

  if (low.includes("fiam") || low.includes("jam") || low.includes("sal")) {
    return `💡 Para armar el sándwich completo, mirá en *Catálogo → Panificados* 🥖 (y si querés algo dulce, *Dulces* 🍯)`;
  }

  if (low.includes("leche") || low.includes("yog") || low.includes("lact")) {
    return `💡 ¿Te falta algo para el desayuno? Mirá en *Catálogo → Panificados* 🥖 y *Dulces* 🍯`;
  }

  if (low.includes("pan")) {
    return `💡 ¿Le sumamos algo para acompañar? Mirá en *Catálogo → Quesos* 🧀 o *Fiambres* 🥓`;
  }

  if (low.includes("dulce") || low.includes("merm") || low.includes("batata") || low.includes("membr")) {
    return `💡 Queda tremendo con queso 😄 Mirá en *Catálogo → Quesos* 🧀`;
  }

  return `💡 Si querés, mirá otras categorías en *Catálogo* y armamos el pedido completo 😄`;
}

// ===============
// Webhook (Express)
// ===============
app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (_, res) => res.send({ ok: true, msg: "EzerBot corriendo" }));

// Debugs para vos (útiles)
app.get("/debug", (_, res) => res.send({ ok: true, now: new Date().toISOString(), port: process.env.PORT || 10000 }));
app.get("/debug/config", async (_, res) => {
  try {
    const cfg = await GAS("config");
    res.send({ ok: true, cfg });
  } catch (e) {
    res.status(500).send({ ok: false, error: String(e) });
  }
});
app.get("/debug/catalogo", async (_, res) => {
  try {
    const r = await GAS("catalogo");
    const items = normalizeCatalogPayload(r);
    res.send({ ok: true, keys: Object.keys(r || {}), count: items.length, sample: items.slice(0, 5), raw: r });
  } catch (e) {
    res.status(500).send({ ok: false, error: String(e) });
  }
});

// ===============
// Start + Menú
// ===============
async function sendMainMenu(chatId, nombre = "amigo") {
  const caption =
    `Hola ${escMd(nombre)} 👋\n` +
    `Soy el asistente de *TODO QUESO CLUB* 🧀\n\n` +
    `Desde acá podés:\n` +
    `• Ver el catálogo\n` +
    `• Armar tu pedido\n` +
    `• Sumar sellos\n` +
    `• Hablar con nosotros\n\n` +
    `👇 *Elegí una opción*`;

  await bot.sendPhoto(chatId, LOGO, { caption, parse_mode: "Markdown", ...menuInline() });
}

bot.onText(/\/start|hola|hola!|Hola|HOLA|buenas|buen día|buen dia/i, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const nombre = msg.chat.first_name || "amigo";
    await sendMainMenu(chatId, nombre);
  } catch (e) {
    console.error("Error en start:", e);
  }
});

// ===============
// Acciones
// ===============
async function infoLocal(chatId) {
  try {
    const cfg = await GAS("config");
    const msg =
      `🏪 *${escMd(cfg?.NegocioNombre || "Todo Queso Club")}*\n` +
      `📍 ${escMd(cfg?.Dirección || cfg?.Direccion || "—")}\n` +
      `🕒 ${escMd(cfg?.Horarios || "—")}\n` +
      `📞 ${escMd(cfg?.TeléfonoNegocio || cfg?.TelefonoNegocio || "—")}\n` +
      `📸 Instagram: ${escMd(cfg?.Instagram || "—")}`;

    await bot.sendPhoto(chatId, LOGO, { caption: msg, parse_mode: "Markdown", ...backToMenuInline() });
  } catch (e) {
    console.error("infoLocal:", e);
    await bot.sendMessage(chatId, "⚠️ No pude leer la configuración del local.", backToMenuInline());
  }
}

async function hablarVendedor(chatId) {
  try {
    const cfg = await GAS("config");
    const w = cfg?.WhatsAppLink || "https://wa.me/5493484230184";

    await bot.sendMessage(
      chatId,
      `💬 *¿Necesitás ayuda?*\nHablá con nosotros por WhatsApp 👇`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📞 Abrir WhatsApp", url: w }],
            [{ text: "🏠 Menú", callback_data: "MENU" }],
          ],
        },
      }
    );
  } catch (e) {
    console.error("hablarVendedor:", e);
    await bot.sendMessage(chatId, "⚠️ No pude abrir el WhatsApp del local.", backToMenuInline());
  }
}

async function compartirBot(chatId) {
  const share = `https://t.me/Ezer_IA_Bot`;
  await bot.sendMessage(
    chatId,
    `📣 *Compartí este bot*\nPegalo en WhatsApp, Instagram o donde quieras:\n\n${share}`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[{ text: "🏠 Menú", callback_data: "MENU" }]],
      },
    }
  );
}

async function mostrarSellos(chatId) {
  try {
    const r = await GAS("estadoCliente", { chatId });
    if (!r?.tieneTarjeta) {
      return bot.sendMessage(
        chatId,
        "Todavía no tenés tarjeta. Comprando obtenés tu primera tarjeta automática 😄",
        backToMenuInline()
      );
    }
    await bot.sendPhoto(chatId, r?.tarjetaImagenUrl || LOGO, {
      caption: `🎉 *Tus sellos:* ${escMd(r?.sellosTotalesAcumulados || 0)}\nNivel: ${escMd(r?.nivelActual || "—")}`,
      parse_mode: "Markdown",
      ...backToMenuInline(),
    });
  } catch (e) {
    console.error("mostrarSellos:", e);
    await bot.sendMessage(chatId, "⚠️ No pude leer tus sellos ahora. Probá de nuevo en un rato.", backToMenuInline());
  }
}

async function mostrarCategorias(chatId) {
  try {
    const items = await getCatalogSafe();
    if (!items?.length) {
      return bot.sendMessage(
        chatId,
        "⚠️ No pude leer el catálogo. Revisá que el GAS esté devolviendo items.\n\nTip: abrí /debug/catalogo en tu navegador.",
        backToMenuInline()
      );
    }

    const categorias = [
      ...new Set(items.map((p) => String(p.categoria || p.category || "General").trim() || "General")),
    ].sort((a, b) => a.localeCompare(b, "es"));

    await bot.sendMessage(chatId, "📂 *Elegí una categoría:*", {
      parse_mode: "Markdown",
      ...buildCategoryKeyboard(categorias),
    });
  } catch (e) {
    console.error("mostrarCategorias:", e);
    await bot.sendMessage(chatId, "⚠️ Error leyendo catálogo.", backToMenuInline());
  }
}

async function mostrarProductos(chatId, categoria, page = 0) {
  try {
    const itemsAll = await getCatalogSafe();
    const items = itemsAll.filter(
      (p) => String(p.categoria || p.category || "General") === String(categoria)
    );

    const porPagina = 3;
    const inicio = page * porPagina;
    const lista = items.slice(inicio, inicio + porPagina);

    if (!lista.length) {
      return bot.sendMessage(chatId, "No hay productos en esta categoría.", backToMenuInline());
    }

    for (const p of lista) {
      const nombre = p.nombre || p.name || "Producto";
      const desc = p.descripcion || p.description || "";
      const precio = p.precio ?? p.price ?? "";
      const codigo = p.codigo || p.code || "SIN-CODIGO";
      const img = p.imagenUrl || p.imagen || p.imageUrl || p.foto || LOGO;

      await bot.sendPhoto(chatId, img, {
        caption:
          `*${escMd(nombre)}*\n` +
          `${escMd(desc)}\n` +
          `💲 ${escMd(precio)} ARS\n` +
          `🆔 Código: *${escMd(codigo)}*`,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🛒 Agregar", callback_data: `BUY_${codigo}` }],
            [{ text: "📣 Compartir", callback_data: `SHARE_${codigo}` }],
            [{ text: "🏠 Menú", callback_data: "MENU" }],
          ],
        },
      });
    }

    const nav = [];
    if (inicio > 0) nav.push({ text: "⬅️ Anterior", callback_data: `PAGE_${categoria}_${page - 1}` });
    if (inicio + porPagina < items.length) nav.push({ text: "Siguiente ➡️", callback_data: `PAGE_${categoria}_${page + 1}` });

    if (nav.length) {
      await bot.sendMessage(chatId, "📌 Navegación:", {
        reply_markup: { inline_keyboard: [nav, [{ text: "📂 Categorías", callback_data: "CATALOGO" }], [{ text: "🏠 Menú", callback_data: "MENU" }]] },
      });
    }
  } catch (e) {
    console.error("mostrarProductos:", e);
    await bot.sendMessage(chatId, "⚠️ Error mostrando productos.", backToMenuInline());
  }
}

async function agregarAlCarrito(chatId, codigo) {
  const itemsAll = await getCatalogSafe();
  const p = itemsAll.find((x) => String(x.codigo || x.code) === String(codigo));

  if (!p) {
    return bot.sendMessage(chatId, "⚠️ No encontré ese producto en el catálogo.", backToMenuInline());
  }

  const nombre = String(p.nombre || p.name || "Producto");
  const precio = toNum(p.precio ?? p.price ?? 0);

  // ✅ Como pediste: NO pedimos gramos/unidades acá para no complicar.
  // Guardamos “1” como texto, pero el ticket lo mostramos simple.
  const cart = getCart(chatId);
  cart.push({ codigo: String(codigo), nombre, precio, cantidadTxt: "1" });

  await bot.sendMessage(chatId, `✅ Listo. Agregué *${escMd(nombre)}* a tu carrito.`, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🛒 Ver carrito", callback_data: "CARRITO" }],
        [{ text: "🛍️ Seguir comprando", callback_data: "CATALOGO" }],
        [{ text: "🏠 Menú", callback_data: "MENU" }],
      ],
    },
  });

  // sugerencia “tipo vendedora” (solo orientar)
  const sug = suggestionFor(p, itemsAll);
  await bot.sendMessage(chatId, sug, { parse_mode: "Markdown", ...backToMenuInline() });
}

async function compartirProducto(chatId, codigo) {
  try {
    const itemsAll = await getCatalogSafe();
    const p = itemsAll.find((x) => String(x.codigo || x.code) === String(codigo));
    if (!p) return bot.sendMessage(chatId, "⚠️ No encontré ese producto.", backToMenuInline());

    const nombre = p.nombre || p.name || "Producto";
    await bot.sendMessage(
      chatId,
      `📣 *Promo Todo Queso Club*\nProbá: *${escMd(nombre)}* 😋\n\nEntrá al bot para ver el catálogo:\nhttps://t.me/Ezer_IA_Bot`,
      { parse_mode: "Markdown", ...backToMenuInline() }
    );
  } catch (e) {
    console.error("compartirProducto:", e);
    await bot.sendMessage(chatId, "⚠️ No pude armar el mensaje para compartir.", backToMenuInline());
  }
}

async function verCarrito(chatId) {
  const cart = getCart(chatId);
  if (!cart.length) {
    return bot.sendMessage(chatId, "🛒 Tu carrito está vacío por ahora.", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🛍️ Ir al catálogo", callback_data: "CATALOGO" }],
          [{ text: "🏠 Menú", callback_data: "MENU" }],
        ],
      },
    });
  }

  const total = cart.reduce((a, x) => a + (toNum(x.precio) || 0), 0);
  const lines = cart
    .map((x, i) => `${i + 1}) ${x.nombre} — $${toNum(x.precio).toLocaleString("es-AR")}`)
    .join("\n");

  await bot.sendMessage(
    chatId,
    `🛒 *Tu carrito*\n\n${escMd(lines)}\n\n💰 *Total aprox:* $${total.toLocaleString("es-AR")}`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🧹 Vaciar carrito", callback_data: "CART_CLEAR" }],
          [{ text: "🛍️ Seguir comprando", callback_data: "CATALOGO" }],
          [{ text: "🏠 Menú", callback_data: "MENU" }],
        ],
      },
    }
  );
}

function vaciarCarrito(chatId) {
  carts.set(chatId, []);
}

// ===============
// Callbacks
// ===============
bot.on("callback_query", async (q) => {
  const chatId = q.message?.chat?.id;
  const data = q.data || "";

  try {
    // evita “loading…” infinito
    await bot.answerCallbackQuery(q.id).catch(() => {});

    if (!chatId) return;

    if (data === "MENU") {
      const nombre = q.from?.first_name || "amigo";
      return sendMainMenu(chatId, nombre);
    }

    if (data === "INFO") return infoLocal(chatId);
    if (data === "CATALOGO") return mostrarCategorias(chatId);
    if (data === "COMPARTIR") return compartirBot(chatId);
    if (data === "SELLOS") return mostrarSellos(chatId);
    if (data === "HABLAR") return hablarVendedor(chatId);
    if (data === "CARRITO") return verCarrito(chatId);

    if (data === "CART_CLEAR") {
      vaciarCarrito(chatId);
      return bot.sendMessage(chatId, "🧹 Listo, vacié tu carrito.", backToMenuInline());
    }

    if (data.startsWith("CAT_")) {
      const categoria = data.replace("CAT_", "");
      return mostrarProductos(chatId, categoria, 0);
    }

    if (data.startsWith("PAGE_")) {
      const [_, categoria, page] = data.split("_");
      return mostrarProductos(chatId, categoria, Number(page));
    }

    if (data.startsWith("BUY_")) {
      const codigo = data.replace("BUY_", "");
      return agregarAlCarrito(chatId, codigo);
    }

    if (data.startsWith("SHARE_")) {
      const codigo = data.replace("SHARE_", "");
      return compartirProducto(chatId, codigo);
    }

    return bot.sendMessage(chatId, "No entendí esa opción.", backToMenuInline());
  } catch (e) {
    console.error("callback_query error:", e);
    if (chatId) await bot.sendMessage(chatId, "⚠️ Se produjo un error. Probá de nuevo.", backToMenuInline());
  }
});

// ===============
// Arranque server + webhook
// ===============
const PORT = process.env.PORT || 10000;

app.listen(PORT, async () => {
  console.log("Servidor activo en puerto", PORT);
  const hookUrl = `${URL_BASE}/webhook`;
  try {
    await bot.setWebHook(hookUrl);
    console.log("Webhook seteado:", hookUrl);
  } catch (e) {
    console.error("Error seteando webhook:", e);
  }
});

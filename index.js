import express from "express";
import TelegramBot from "node-telegram-bot-api";

const TOKEN =
  process.env.TELEGRAM_TOKEN ||
  "8130447159:AAHxzp5S1lcgYOemw5dgF5V1DGh141dHmkA";

const BACKEND =
  process.env.GAS_BACKEND ||
  "https://script.google.com/macros/s/AKfycbxznmXVhDFd45kwrtsO0lORoGDn7AcHVdQIYQkgYy_63jaJCrjumzphVK_N39T_zjK_/exec";

const LOGO =
  process.env.LOGO_URL ||
  "https://i.postimg.cc/q7WvjsYm/20251206-210311.jpg";

const URL_BASE = process.env.URL_BASE || "https://ezerbot-system.onrender.com";
const BOT_PUBLIC_LINK = process.env.BOT_PUBLIC_LINK || "https://t.me/Ezer_IA_Bot";

const PORT = Number(process.env.PORT || 10000);

const app = express();
app.use(express.json());

const bot = new TelegramBot(TOKEN);

// ===============================
// WEBHOOK
// ===============================
bot.setWebHook(`${URL_BASE}/webhook`).catch((e) => {
  console.error("❌ setWebHook error:", e?.response?.body || e);
});

app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (_, res) => res.send({ ok: true, msg: "EzerBot corriendo" }));

app.get("/debug", async (_, res) => {
  try {
    const info =
      typeof bot.getWebHookInfo === "function"
        ? await bot.getWebHookInfo()
        : { warning: "getWebHookInfo() no existe en esta versión" };

    res.send({
      ok: true,
      url_base: URL_BASE,
      webhook_expected: `${URL_BASE}/webhook`,
      webhook_info: info,
    });
  } catch (e) {
    res.status(500).send({
      ok: false,
      error: e?.response?.body || e?.message || String(e),
    });
  }
});

app.listen(PORT, () => {
  console.log("✅ Servidor activo en puerto", PORT);
  console.log("✅ Webhook esperado:", `${URL_BASE}/webhook`);
});

// ===============================
// Helpers
// ===============================
async function GAS(accion, params = {}) {
  const url = new URL(BACKEND);
  url.searchParams.set("accion", accion);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const r = await fetch(url.toString(), { method: "GET" });
  const txt = await r.text();

  let data;
  try {
    data = JSON.parse(txt);
  } catch {
    throw new Error(`GAS no devolvió JSON. Respuesta: ${txt.slice(0, 200)}`);
  }
  return data;
}

function extractItems(payload) {
  // Acepta MUCHAS formas: items, data.items, productos, catalogo, data, result, rows, array directo, etc.
  if (!payload) return [];

  // Si es array directo
  if (Array.isArray(payload)) return payload;

  // Keys comunes
  const candidates = [
    payload.items,
    payload.data?.items,
    payload.productos,
    payload.data?.productos,
    payload.catalogo,
    payload.data?.catalogo,
    payload.data,
    payload.result,
    payload.rows,
    payload.payload,
  ];

  for (const c of candidates) {
    if (Array.isArray(c)) return c;
    // si viene como objeto mapa {id: {..}, id2:{..}}
    if (c && typeof c === "object" && !Array.isArray(c)) {
      const vals = Object.values(c);
      if (vals.length && typeof vals[0] === "object") return vals;
    }
  }
  return [];
}

async function getCatalogItems() {
  // Probamos 3 acciones típicas automáticamente para no depender del nombre exacto
  const acciones = ["catalogo", "getCatalogo", "productos"];
  for (const a of acciones) {
    try {
      const r = await GAS(a);
      const items = extractItems(r);
      if (items.length) return items;
    } catch (e) {
      // seguimos con la siguiente acción
      console.error(`⚠️ GAS accion ${a} error:`, e?.message || e);
    }
  }
  return [];
}

function safeCat(p) {
  return String(p?.categoria || p?.Categoria || p?.cat || "General").trim() || "General";
}

function safeName(p) {
  return String(p?.nombre || p?.Nombre || p?.producto || p?.Producto || "Producto").trim() || "Producto";
}

function safeCode(p, fallbackIdx) {
  const c = p?.codigo ?? p?.Codigo ?? p?.id ?? p?.ID ?? p?.sku ?? p?.SKU;
  const s = String(c || "").trim();
  return s ? s : `P${fallbackIdx}`;
}

function safePrice(p) {
  const pr = p?.precio ?? p?.Precio ?? p?.price ?? p?.Price;
  if (pr === null || pr === undefined || pr === "") return null;
  return String(pr).trim();
}

function safeImg(p) {
  return (
    p?.imagenUrl ||
    p?.ImagenUrl ||
    p?.imagen ||
    p?.Imagen ||
    p?.foto ||
    p?.Foto ||
    null
  );
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function makeMainMenuInline() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🛍️ Catálogo", callback_data: "CATALOGO" },
          { text: "🛒 Mi carrito", callback_data: "CARRITO" },
        ],
        [{ text: "🎁 Mis sellos", callback_data: "SELLOS" }],
        [{ text: "💬 Hablar con el vendedor", callback_data: "HABLAR" }],
        [
          { text: "ℹ️ Info del local", callback_data: "INFO" },
          { text: "📣 Compartir bot", callback_data: "COMPARTIR" },
        ],
      ],
    },
  };
}

async function sendMainMenu(chatId, nombre = "Jenny") {
  // ✅ BORRA el teclado viejo (el “2do menú” de abajo)
  await bot.sendMessage(chatId, "✅ Menú actualizado.", {
    reply_markup: { remove_keyboard: true },
  });

  await bot.sendPhoto(chatId, LOGO, {
    caption:
      `Hola ${nombre} 👋\n` +
      `Soy el asistente de *TODO QUESO CLUB* 🧀\n\n` +
      `Desde acá podés:\n` +
      `• Ver el catálogo\n• Armar tu pedido\n• Sumar sellos\n• Hablar con nosotros\n\n` +
      `👇 Elegí una opción`,
    parse_mode: "Markdown",
    ...makeMainMenuInline(),
  });
}

function suggestionTextFor(p) {
  const name = safeName(p).toLowerCase();
  const cat = safeCat(p).toLowerCase();

  if (cat.includes("ques") || name.includes("queso")) {
    return "🧀 Para acompañar te recomiendo *pan fresco* y algo dulce tipo *batata/membrillo*.";
  }
  if (cat.includes("fiamb") || name.includes("jam") || name.includes("sal") || name.includes("mort")) {
    return "🥪 Para esos fiambres va genial *pan*, *mayo* y algo para picar tipo *aceitunas*.";
  }
  if (cat.includes("láct") || name.includes("leche") || name.includes("yog")) {
    return "☕ Para el desayuno: sumá *pan* y algo dulce (*mermelada*).";
  }
  if (cat.includes("panif") || name.includes("pan")) {
    return "🍞 Ya que llevás pan, ¿te sumo algo para acompañar? *queso* o *fiambre* queda de 10.";
  }
  if (cat.includes("promo") || name.includes("oferta")) {
    return "🔥 Si aprovechás promo, completá con algo que rinde: *pan* o un *dulce*.";
  }
  return "💡 Para completar el pedido, te conviene sumar *pan* o algún *acompañamiento*.";
}

// ===============================
// START / MENÚ
// ===============================
bot.onText(/\/start|^hola$|^hola!$|^buenas/i, async (msg) => {
  const chatId = msg.chat.id;
  const nombre = msg.chat.first_name || "amiga";
  try {
    await sendMainMenu(chatId, nombre);
  } catch (e) {
    console.error("Error /start:", e?.response?.body || e);
    bot.sendMessage(chatId, "⚠️ Tuve un problema iniciando el menú. Probá de nuevo en 10 segundos.");
  }
});

// ===============================
// CALLBACKS
// ===============================
bot.on("callback_query", async (q) => {
  const chatId = q.message?.chat?.id;
  const data = q.data || "";

  bot.answerCallbackQuery(q.id).catch(() => {});

  try {
    if (!chatId) return;

    if (data === "MENU") return sendMainMenu(chatId, q.from?.first_name || "amiga");
    if (data === "INFO") return infoLocal(chatId);
    if (data === "HABLAR") return hablarVendedor(chatId);
    if (data === "COMPARTIR") return compartirBot(chatId);
    if (data === "SELLOS") return mostrarSellos(chatId);

    if (data === "CARRITO") {
      return bot.sendMessage(chatId, "🛒 *Mi carrito* (simple): por ahora el bot te guía por catálogo. Si querés, activamos carrito real después 😉", {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "MENU" }]] },
      });
    }

    if (data === "CATALOGO") return mostrarCategorias(chatId);

    if (data.startsWith("CAT_")) {
      const categoria = decodeURIComponent(data.slice(4));
      return mostrarProductos(chatId, categoria, 0);
    }

    if (data.startsWith("PAGE_")) {
      const parts = data.split("|"); // PAGE_|categoria|page
      const categoria = decodeURIComponent(parts[1] || "General");
      const page = Number(parts[2] || 0);
      return mostrarProductos(chatId, categoria, page);
    }

    if (data.startsWith("BUY_")) {
      const codigo = data.slice(4);
      return comprarGuia(chatId, codigo);
    }

    if (data === "COPIAR_LINK") {
      return bot.sendMessage(chatId, `🔗 Link del bot: ${BOT_PUBLIC_LINK}`, {
        reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "MENU" }]] },
      });
    }
  } catch (e) {
    console.error("callback error:", e?.response?.body || e);
    bot.sendMessage(chatId, "⚠️ Se trabó algo. Tocá *Menú* y seguimos.", {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "MENU" }]] },
    });
  }
});

// ===============================
// Acciones
// ===============================
async function infoLocal(chatId) {
  const cfg = await GAS("config").catch(() => ({}));

  const nombre = cfg.NegocioNombre || "Todo Queso Club";
  const dir = cfg["Dirección"] || cfg.Direccion || "Consultanos por WhatsApp";
  const horarios = cfg.Horarios || "Consultanos horarios";
  const tel = cfg["TeléfonoNegocio"] || cfg.TelefonoNegocio || "—";
  const ig = cfg.Instagram || "—";

  const msg =
    `🏪 *${nombre}*\n` +
    `📍 ${dir}\n` +
    `🕒 ${horarios}\n` +
    `📞 ${tel}\n` +
    `📸 Instagram: ${ig}`;

  await bot.sendPhoto(chatId, LOGO, {
    caption: msg,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "MENU" }]] },
  });
}

async function hablarVendedor(chatId) {
  const cfg = await GAS("config").catch(() => ({}));
  const w = cfg.WhatsAppLink || "https://wa.me/5493484230184";

  await bot.sendMessage(
    chatId,
    `💬 *¿Querés que te atienda alguien del local?*\nTocá abajo y te respondemos por WhatsApp 👇`,
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
}

async function compartirBot(chatId) {
  await bot.sendMessage(
    chatId,
    `📣 *Compartí el bot*\nPasáselo a alguien y que también vea promos y catálogo 👇`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔗 Abrir en Telegram", url: BOT_PUBLIC_LINK }],
          [{ text: "📤 Copiar enlace", callback_data: "COPIAR_LINK" }],
          [{ text: "🏠 Menú", callback_data: "MENU" }],
        ],
      },
    }
  );
}

async function mostrarSellos(chatId) {
  const r = await GAS("estadoCliente", { chatId }).catch(() => ({}));

  if (!r.tieneTarjeta) {
    return bot.sendMessage(
      chatId,
      "🎁 Todavía no tenés tarjeta.\nCuando hagas tu primera compra, te la generamos y empezás a sumar sellos 😄",
      { reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "MENU" }]] } }
    );
  }

  await bot.sendPhoto(chatId, r.tarjetaImagenUrl || LOGO, {
    caption: `🎉 *Tus sellos:* ${r.sellosTotalesAcumulados || 0}\n🏅 *Nivel:* ${r.nivelActual || "—"}`,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "MENU" }]] },
  });
}

async function mostrarCategorias(chatId) {
  const items = await getCatalogItems();

  if (!items.length) {
    return bot.sendMessage(
      chatId,
      "⚠️ No pude leer el catálogo desde el GAS.\n(El GAS no está devolviendo productos en ninguna de las formas esperadas.)",
      { reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "MENU" }]] } }
    );
  }

  const categorias = [...new Set(items.map(safeCat))].sort((a, b) => a.localeCompare(b));

  // 2 columnas
  const rows = chunk(
    categorias.map((c) => ({ text: `📦 ${c}`, callback_data: `CAT_${encodeURIComponent(c)}` })),
    2
  );

  rows.push([{ text: "🏠 Menú", callback_data: "MENU" }]);

  await bot.sendMessage(chatId, "🗂️ *Elegí una categoría:*", {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: rows },
  });
}

async function mostrarProductos(chatId, categoria, page = 0) {
  const itemsAll = await getCatalogItems();
  const items = itemsAll.filter((p) => safeCat(p) === categoria);

  if (!items.length) {
    return bot.sendMessage(chatId, `No hay productos en *${categoria}*`, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "⬅️ Categorías", callback_data: "CATALOGO" }], [{ text: "🏠 Menú", callback_data: "MENU" }]] },
    });
  }

  const porPagina = 3;
  const totalPages = Math.ceil(items.length / porPagina);
  const p = Math.max(0, Math.min(page, totalPages - 1));
  const inicio = p * porPagina;
  const lista = items.slice(inicio, inicio + porPagina);

  await bot.sendMessage(chatId, `📌 *${categoria}* — Página ${p + 1}/${totalPages}`, {
    parse_mode: "Markdown",
  });

  for (let i = 0; i < lista.length; i++) {
    const prod = lista[i];
    const idx = inicio + i + 1;

    const code = safeCode(prod, idx);
    const precio = safePrice(prod);
    const precioTxt = precio ? `${precio} ARS` : "Consultar";
    const desc = prod.descripcion || prod.Descripcion ? `\n${String(prod.descripcion || prod.Descripcion)}` : "";
    const img = safeImg(prod) || LOGO;

    await bot.sendPhoto(chatId, img, {
      caption: `*${safeName(prod)}*${desc}\n💲 ${precioTxt}\n🆔 *${code}*`,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Quiero este", callback_data: `BUY_${code}` }],
          [{ text: "⬅️ Categorías", callback_data: "CATALOGO" }, { text: "🏠 Menú", callback_data: "MENU" }],
        ],
      },
    });
  }

  // navegación paginada
  const nav = [];
  if (p > 0) nav.push({ text: "⬅️ Anterior", callback_data: `PAGE_|${encodeURIComponent(categoria)}|${p - 1}` });
  if (p < totalPages - 1) nav.push({ text: "Siguiente ➡️", callback_data: `PAGE_|${encodeURIComponent(categoria)}|${p + 1}` });

  const extra = [];
  if (nav.length) extra.push(nav);
  extra.push([{ text: "⬅️ Categorías", callback_data: "CATALOGO" }, { text: "🏠 Menú", callback_data: "MENU" }]);

  await bot.sendMessage(chatId, "📄 Navegación:", {
    reply_markup: { inline_keyboard: extra },
  });
}

async function comprarGuia(chatId, codigo) {
  const items = await getCatalogItems();
  const p = items.find((x, idx) => safeCode(x, idx + 1) === String(codigo));

  if (!p) {
    return bot.sendMessage(chatId, "⚠️ No encontré ese producto en el catálogo.", {
      reply_markup: { inline_keyboard: [[{ text: "🛍️ Volver al catálogo", callback_data: "CATALOGO" }], [{ text: "🏠 Menú", callback_data: "MENU" }]] },
    });
  }

  await bot.sendMessage(
    chatId,
    `✅ Listo. *${safeName(p)}* anotado.\n\n${suggestionTextFor(p)}\n\n👉 Si querés te atiende un vendedor y lo cerramos por WhatsApp.`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🛍️ Seguir mirando", callback_data: "CATALOGO" }],
          [{ text: "💬 Hablar con el vendedor", callback_data: "HABLAR" }],
          [{ text: "🏠 Menú", callback_data: "MENU" }],
        ],
      },
    }
  );
                }

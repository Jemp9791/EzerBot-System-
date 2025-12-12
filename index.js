import express from "express";
import TelegramBot from "node-telegram-bot-api";

const TOKEN = "8130447159:AAHxzp5S1lcgYOemw5dgF5V1DGh141dHmkA";
const BACKEND =
  "https://script.google.com/macros/s/AKfycbxznmXVhDFd45kwrtsO0lORoGDn7AcHVdQIYQkgYy_63jaJCrjumzphVK_N39T_zjK_/exec";
const LOGO = "https://i.postimg.cc/q7WvjsYm/20251206-210311.jpg";
const URL_BASE = "https://ezerbot-system.onrender.com";

const app = express();
app.use(express.json());

// ✅ Importante: NO levantar webhook por puerto dentro del bot (evita EADDRINUSE).
const bot = new TelegramBot(TOKEN, { polling: false });

// Estado en memoria para mantener chat prolijo (borrar páginas previas)
const STATE = new Map(); // chatId -> { lastProductMsgIds: [], lastNavMsgId: null, catMap: {}, prodMap: {}, pendingBuy: null }

function getState(chatId) {
  if (!STATE.has(chatId)) {
    STATE.set(chatId, {
      lastProductMsgIds: [],
      lastNavMsgId: null,
      catMap: {}, // catId -> catName
      prodMap: {}, // code -> product
      pendingBuy: null,
    });
  }
  return STATE.get(chatId);
}

function safeText(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  return String(v);
}

// ===============================
// UTILIDAD REQUEST AL BACKEND GAS
// ===============================
async function GAS(action, params = {}) {
  const url = new URL(BACKEND);
  url.searchParams.set("accion", action);
  for (const k in params) url.searchParams.set(k, params[k]);

  const r = await fetch(url.toString(), { method: "GET" });
  // Si GAS devuelve HTML por error, esto explota: lo capturamos arriba donde se usa.
  return await r.json();
}

// ===============================
// MENÚ PRINCIPAL (INLINE)
// ===============================
function mainMenuMarkup() {
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

async function sendMainMenu(chatId, nombre = "Jenny") {
  // ✅ Esto “borra” el menú inferior (reply keyboard) si había quedado pegado
  await bot.sendMessage(chatId, " ", {
    reply_markup: { remove_keyboard: true },
  });

  const caption =
    `Hola ${nombre} 👋\n` +
    `Soy el asistente de *TODO QUESO CLUB* 🧀\n\n` +
    `Desde acá podés:\n` +
    `• Ver el catálogo\n` +
    `• Armar tu pedido\n` +
    `• Sumar sellos\n` +
    `• Hablar con nosotros\n\n` +
    `👇 *Elegí una opción*`;

  // 1) Foto + presentación (sin teclado)
  await bot.sendPhoto(chatId, LOGO, { caption, parse_mode: "Markdown" });

  // 2) Menú inline (el único que queremos)
  await bot.sendMessage(chatId, "📌 *Menú principal*", {
    parse_mode: "Markdown",
    ...mainMenuMarkup(),
  });
}

// ===============================
// LIMPIEZA DE MENSAJES DE CATÁLOGO
// ===============================
async function clearCatalogMessages(chatId) {
  const st = getState(chatId);

  // borrar productos anteriores
  for (const mid of st.lastProductMsgIds) {
    try {
      await bot.deleteMessage(chatId, mid);
    } catch (_) {}
  }
  st.lastProductMsgIds = [];

  // borrar navegación anterior
  if (st.lastNavMsgId) {
    try {
      await bot.deleteMessage(chatId, st.lastNavMsgId);
    } catch (_) {}
    st.lastNavMsgId = null;
  }
}

// ===============================
// CATEGORÍAS (INLINE LINDAS)
// ===============================
function prettyCategoryEmoji(name) {
  const n = name.toLowerCase();
  if (n.includes("fiambre")) return "🥓";
  if (n.includes("láct") || n.includes("lact")) return "🧈";
  if (n.includes("pan")) return "🥖";
  if (n.includes("promo")) return "🔥";
  if (n.includes("ques")) return "🧀";
  if (n.includes("dulc")) return "🍯";
  if (n.includes("beb")) return "🥤";
  return "📦";
}

function buildCategoryKeyboard(categories, st) {
  // ids cortos para callback_data
  const catMap = {};
  const rows = [];

  // 2 columnas como en tu captura
  let i = 0;
  while (i < categories.length) {
    const left = categories[i];
    const right = categories[i + 1];

    const leftId = "c" + i;
    catMap[leftId] = left;

    const row = [
      {
        text: `${prettyCategoryEmoji(left)} ${left}`,
        callback_data: `CAT_${leftId}`,
      },
    ];

    if (right) {
      const rightId = "c" + (i + 1);
      catMap[rightId] = right;
      row.push({
        text: `${prettyCategoryEmoji(right)} ${right}`,
        callback_data: `CAT_${rightId}`,
      });
    }

    rows.push(row);
    i += 2;
  }

  // Botón volver al menú
  rows.push([{ text: "🏠 Menú", callback_data: "MENU" }]);

  st.catMap = catMap;

  return { reply_markup: { inline_keyboard: rows } };
}

async function mostrarCategorias(chatId) {
  const st = getState(chatId);
  await clearCatalogMessages(chatId);

  let r;
  try {
    r = await GAS("catalogo");
  } catch (e) {
    console.error("GAS catalogo error:", e);
    return bot.sendMessage(chatId, "⚠️ No pude leer el catálogo (respuesta inválida del GAS).");
  }

  const items = Array.isArray(r?.items) ? r.items : [];
  if (!items.length) {
    return bot.sendMessage(
      chatId,
      "⚠️ El catálogo está vacío o el GAS no está devolviendo `items`."
    );
  }

  // guardo productos por código para comprar
  st.prodMap = {};
  for (const p of items) {
    const code = safeText(p.codigo || p.code || p.id || "").trim();
    if (code) st.prodMap[code] = p;
  }

  const categorias = [...new Set(items.map((p) => safeText(p.categoria, "General").trim() || "General"))];

  const kb = buildCategoryKeyboard(categorias, st);

  // Mensaje prolijo
  await bot.sendMessage(chatId, "📂 *Elegí una categoría:*", {
    parse_mode: "Markdown",
    ...kb,
  });
}

// ===============================
// PRODUCTOS PAGINADOS (3 POR PÁGINA)
// ===============================
function normalizeProduct(p) {
  return {
    nombre: safeText(p.nombre, "Producto"),
    descripcion: safeText(p.descripcion, ""),
    precio: safeText(p.precio, ""),
    codigo: safeText(p.codigo || p.code || p.id || "SIN-CODIGO"),
    imagenUrl: safeText(p.imagenUrl || p.imagen || p.foto || ""),
    categoria: safeText(p.categoria, "General"),
    unidad: safeText(p.unidad || p.tipoUnidad || "", ""), // opcional
  };
}

function suggestCategoriesFor(catName, allCats) {
  // Sugerencias “vendedor real” pero SOLO como guía hacia dónde ir (sin sumar al carrito).
  const cat = catName.toLowerCase();
  const picks = [];

  const want = (keyword) => allCats.find((c) => c.toLowerCase().includes(keyword));
  const addIf = (c) => c && !picks.includes(c) && c !== catName && picks.push(c);

  if (cat.includes("ques")) {
    addIf(want("pan"));
    addIf(want("fiambre"));
    addIf(want("promo"));
    addIf(want("dulc"));
  } else if (cat.includes("fiambre")) {
    addIf(want("pan"));
    addIf(want("ques"));
    addIf(want("lact"));
    addIf(want("promo"));
  } else if (cat.includes("lact") || cat.includes("láct")) {
    addIf(want("pan"));
    addIf(want("dulc"));
    addIf(want("promo"));
    addIf(want("ques"));
  } else if (cat.includes("pan")) {
    addIf(want("ques"));
    addIf(want("fiambre"));
    addIf(want("dulc"));
    addIf(want("promo"));
  } else {
    addIf(want("promo"));
    addIf(want("ques"));
    addIf(want("pan"));
  }

  return picks.slice(0, 3);
}

async function mostrarProductos(chatId, catId, page = 0) {
  const st = getState(chatId);
  await clearCatalogMessages(chatId);

  const categoria = st.catMap?.[catId] || "General";

  let r;
  try {
    r = await GAS("catalogo");
  } catch (e) {
    console.error("GAS catalogo error:", e);
    return bot.sendMessage(chatId, "⚠️ No pude leer el catálogo (respuesta inválida del GAS).");
  }

  const all = Array.isArray(r?.items) ? r.items.map(normalizeProduct) : [];
  const items = all.filter((p) => (p.categoria || "General") === categoria);

  if (!items.length) {
    return bot.sendMessage(chatId, "😕 No hay productos en esta categoría por ahora.", {
      reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "MENU" }]] },
    });
  }

  const porPagina = 3;
  const maxPage = Math.floor((items.length - 1) / porPagina);
  const safePage = Math.max(0, Math.min(page, maxPage));
  const inicio = safePage * porPagina;
  const lista = items.slice(inicio, inicio + porPagina);

  // Enviamos 3 productos y guardamos IDs para borrar al cambiar de página
  for (const p of lista) {
    const kb = {
      inline_keyboard: [
        [{ text: "🛒 Comprar", callback_data: `BUY_${p.codigo}` }],
        [{ text: "📣 Compartir", callback_data: `SHARE_${p.codigo}` }],
        [{ text: "🏠 Menú", callback_data: "MENU" }],
      ],
    };

    if (p.imagenUrl) {
      const sent = await bot.sendPhoto(chatId, p.imagenUrl, {
        caption:
          `*${p.nombre}*\n` +
          `${p.descripcion ? p.descripcion + "\n" : ""}` +
          `💲 ${p.precio} ARS\n` +
          `🆔 Código: *${p.codigo}*`,
        parse_mode: "Markdown",
        reply_markup: kb,
      });
      st.lastProductMsgIds.push(sent.message_id);
    } else {
      const sent = await bot.sendMessage(
        chatId,
        `*${p.nombre}*\n` +
          `${p.descripcion ? p.descripcion + "\n" : ""}` +
          `💲 ${p.precio} ARS\n` +
          `🆔 Código: *${p.codigo}*`,
        { parse_mode: "Markdown", reply_markup: kb }
      );
      st.lastProductMsgIds.push(sent.message_id);
    }
  }

  // Navegación (un solo mensajito)
  const nav = [];
  if (safePage > 0) nav.push({ text: "⬅️ Anterior", callback_data: `PAGE_${catId}_${safePage - 1}` });
  nav.push({ text: `📄 ${safePage + 1}/${maxPage + 1}`, callback_data: "NOOP" });
  if (safePage < maxPage) nav.push({ text: "Siguiente ➡️", callback_data: `PAGE_${catId}_${safePage + 1}` });

  const navRows = [[...nav], [{ text: "📂 Categorías", callback_data: "CATALOGO" }, { text: "🏠 Menú", callback_data: "MENU" }]];

  const sentNav = await bot.sendMessage(chatId, `📌 *${categoria}*`, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: navRows },
  });
  st.lastNavMsgId = sentNav.message_id;

  // Sugerencia estilo vendedor (solo guiando a categorías)
  const cats = [...new Set(all.map((p) => p.categoria || "General"))];
  const sug = suggestCategoriesFor(categoria, cats);
  if (sug.length) {
    const sugRows = sug.map((c) => {
      // buscamos el id de esa categoría en el map actual
      const foundId = Object.entries(st.catMap).find(([, name]) => name === c)?.[0];
      return [
        {
          text: `👉 Ver ${c}`,
          callback_data: foundId ? `CAT_${foundId}` : "CATALOGO",
        },
      ];
    });

    sugRows.push([{ text: "📂 Volver a categorías", callback_data: "CATALOGO" }]);

    const sentSug = await bot.sendMessage(
      chatId,
      `💡 *Ya que estás en ${categoria}...*\n¿Te agrego algo para acompañar? Mirá estas opciones 👇`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: sugRows } }
    );
    st.lastProductMsgIds.push(sentSug.message_id);
  }
}

// ===============================
// COMPRAR (mínimo, sin complicar)
// ===============================
async function iniciarCompra(chatId, code) {
  const st = getState(chatId);
  const pRaw = st.prodMap?.[code];
  if (!pRaw) return bot.sendMessage(chatId, "⚠️ No encuentro ese producto. Probá desde Catálogo.");

  const p = normalizeProduct(pRaw);
  st.pendingBuy = { code: p.codigo, nombre: p.nombre };

  await bot.sendMessage(
    chatId,
    `🛒 *${p.nombre}*\n¿Cuánto querés?\n` +
      `Ejemplos: *500g* / *1kg* / *2u*`,
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "MENU" }]] },
    }
  );
}

function parseQty(text) {
  const t = text.toLowerCase().replace(",", ".").trim();
  // 500g / 1kg / 2u / 2
  const m = t.match(/(\d+(\.\d+)?)(\s*)(kg|g|u|un|unidad|unidades)?/);
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[4] || "u";
  return { n, u };
}

bot.on("message", async (msg) => {
  // Evitar procesar mensajes que son callbacks
  if (!msg.text) return;

  const chatId = msg.chat.id;
  const st = getState(chatId);

  // Si está esperando cantidad
  if (st.pendingBuy) {
    const qty = parseQty(msg.text);
    if (!qty) {
      return bot.sendMessage(chatId, "Decime cantidad tipo *500g* / *1kg* / *2u* 🙂", {
        parse_mode: "Markdown",
      });
    }

    const itemTxt = `${qty.n}${qty.u}`;
    const nombre = st.pendingBuy.nombre;
    st.pendingBuy = null;

    // Acá podrías guardar carrito real en GAS después, pero por ahora solo confirmación (sin romper nada)
    await bot.sendMessage(
      chatId,
      `✅ Listo. Agregué *${itemTxt}* de *${nombre}*.\n\n¿Seguimos? Podés volver al *Catálogo* 👇`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🛍️ Volver al Catálogo", callback_data: "CATALOGO" }],
            [{ text: "🏠 Menú", callback_data: "MENU" }],
          ],
        },
      }
    );
  }
});

// ===============================
// INFO / HABLAR / COMPARTIR / SELLOS / CARRITO (placeholders seguros)
// ===============================
async function infoLocal(chatId) {
  let cfg = {};
  try {
    cfg = await GAS("config");
  } catch (e) {
    console.error("config error:", e);
  }

  const msg =
    `🏪 *${safeText(cfg.NegocioNombre, "TODO QUESO CLUB")}*\n` +
    `📍 ${safeText(cfg.Dirección, "Dirección no configurada")}\n` +
    `🕒 ${safeText(cfg.Horarios, "Horarios no configurados")}\n` +
    `📞 ${safeText(cfg.TeléfonoNegocio, "Teléfono no configurado")}\n` +
    `📸 Instagram: ${safeText(cfg.Instagram, "-")}\n\n` +
    `🏠 Volvé al menú cuando quieras.`;

  await bot.sendPhoto(chatId, LOGO, { caption: msg, parse_mode: "Markdown", ...mainMenuMarkup() });
}

async function hablarVendedor(chatId) {
  let cfg = {};
  try {
    cfg = await GAS("config");
  } catch (e) {
    console.error("config error:", e);
  }

  const w = safeText(cfg.WhatsAppLink, "https://wa.me/5493484230184");
  await bot.sendMessage(
    chatId,
    `💬 *¿Necesitás ayuda?*\nEscribinos por WhatsApp y te respondemos al toque 👇`,
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "📞 Abrir WhatsApp", url: w }], [{ text: "🏠 Menú", callback_data: "MENU" }]] },
    }
  );
}

async function compartirBot(chatId) {
  const share = "https://t.me/Ezer_IA_Bot";
  await bot.sendMessage(
    chatId,
    `📣 *Compartí este bot*\nPegalo en WhatsApp/Instagram y que compren con promos 😉`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔗 Abrir enlace", url: share }],
          [{ text: "🏠 Menú", callback_data: "MENU" }],
        ],
      },
    }
  );
}

async function mostrarSellos(chatId) {
  let r = {};
  try {
    r = await GAS("estadoCliente", { chatId });
  } catch (e) {
    console.error("estadoCliente error:", e);
  }

  if (!r?.tieneTarjeta) {
    return bot.sendMessage(chatId, "Todavía no tenés tarjeta. Comprando se genera automática 😄", {
      reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "MENU" }]] },
    });
  }

  await bot.sendPhoto(chatId, r.tarjetaImagenUrl || LOGO, {
    caption: `🏆 *Tus sellos:* ${safeText(r.sellosTotalesAcumulados, "0")}\n🎖️ Nivel: ${safeText(r.nivelActual, "-")}`,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "MENU" }]] },
  });
}

async function mostrarCarrito(chatId) {
  // Placeholder sin romper (si querés, después lo conectamos al GAS)
  await bot.sendMessage(chatId, "🛒 Tu carrito lo armamos en el siguiente paso. (Ya quedó el catálogo prolijo 😉)", {
    reply_markup: { inline_keyboard: [[{ text: "🛍️ Ir al Catálogo", callback_data: "CATALOGO" }], [{ text: "🏠 Menú", callback_data: "MENU" }]] },
  });
}

// ===============================
// START
// ===============================
bot.onText(/\/start|hola|hola!|buenas/i, async (msg) => {
  const chatId = msg.chat.id;
  const nombre = msg.chat.first_name || "Jenny";
  try {
    await sendMainMenu(chatId, nombre);
  } catch (e) {
    console.error("start error:", e);
  }
});

// ===============================
// CALLBACKS
// ===============================
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const data = q.data;

  // Siempre respondemos callback para que no quede “cargando…”
  try { await bot.answerCallbackQuery(q.id); } catch (_) {}

  if (data === "NOOP") return;

  if (data === "MENU") return sendMainMenu(chatId, q.from?.first_name || "Jenny");
  if (data === "CATALOGO") return mostrarCategorias(chatId);
  if (data === "INFO") return infoLocal(chatId);
  if (data === "HABLAR") return hablarVendedor(chatId);
  if (data === "COMPARTIR") return compartirBot(chatId);
  if (data === "SELLOS") return mostrarSellos(chatId);
  if (data === "CARRITO") return mostrarCarrito(chatId);

  if (data.startsWith("CAT_")) {
    const catId = data.replace("CAT_", "");
    return mostrarProductos(chatId, catId, 0);
  }

  if (data.startsWith("PAGE_")) {
    const [, catId, page] = data.split("_");
    return mostrarProductos(chatId, catId, Number(page || 0));
  }

  if (data.startsWith("BUY_")) {
    const code = data.replace("BUY_", "");
    return iniciarCompra(chatId, code);
  }

  if (data.startsWith("SHARE_")) {
    const code = data.replace("SHARE_", "");
    const st = getState(chatId);
    const pRaw = st.prodMap?.[code];
    const p = pRaw ? normalizeProduct(pRaw) : { nombre: "Producto", precio: "", codigo: code };

    const txt = encodeURIComponent(`🧀 TODO QUESO CLUB\n${p.nombre}\n💲 ${p.precio} ARS\n🆔 ${p.codigo}\n\nPedilo por el bot: https://t.me/Ezer_IA_Bot`);
    const wa = `https://wa.me/?text=${txt}`;

    return bot.sendMessage(chatId, "📣 Compartí esta promo 👇", {
      reply_markup: { inline_keyboard: [[{ text: "📲 Compartir por WhatsApp", url: wa }], [{ text: "🏠 Menú", callback_data: "MENU" }]] },
    });
  }
});

// ===============================
// WEBHOOK (EXPRESS)
// ===============================
app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (_, res) => res.json({ ok: true, msg: "EzerBot corriendo" }));

// Debug útil (no molesta al bot)
app.get("/debug/catalogo", async (_, res) => {
  try {
    const r = await GAS("catalogo");
    const items = Array.isArray(r?.items) ? r.items : [];
    res.json({
      ok: true,
      hasItems: Array.isArray(r?.items),
      count: items.length,
      keys: items[0] ? Object.keys(items[0]) : [],
      sample: items[0] || null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/debug/config", async (_, res) => {
  try {
    const r = await GAS("config");
    res.json({ ok: true, r });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, async () => {
  console.log("Servidor activo en puerto", PORT);
  // Seteo webhook al iniciar
  try {
    await bot.setWebHook(`${URL_BASE}/webhook`);
    console.log("Webhook seteado:", `${URL_BASE}/webhook`);
  } catch (e) {
    console.error("Error setWebHook:", e);
  }
});

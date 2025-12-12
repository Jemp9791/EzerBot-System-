import express from "express";
import TelegramBot from "node-telegram-bot-api";

/**
 * =========================
 * CONFIG
 * =========================
 */
const TOKEN = process.env.TELEGRAM_TOKEN || "8130447159:AAHxzp5S1lcgYOemw5dgF5V1DGh141dHmkA";
const BACKEND =
  process.env.GAS_BACKEND ||
  "https://script.google.com/macros/s/AKfycbxznmXVhDFd45kwrtsO0lORoGDn7AcHVdQIYQkgYy_63jaJCrjumzphVK_N39T_zjK_/exec";

const LOGO =
  process.env.LOGO_URL ||
  "https://i.postimg.cc/q7WvjsYm/20251206-210311.jpg";

// En Render suele venir RENDER_EXTERNAL_URL (si no, poné tu dominio fijo)
const URL_BASE =
  process.env.RENDER_EXTERNAL_URL ||
  process.env.URL_BASE ||
  "https://ezerbot-system.onrender.com";

const PORT = Number(process.env.PORT || 10000);

/**
 * =========================
 * EXPRESS
 * =========================
 */
const app = express();
app.use(express.json({ limit: "1mb" }));

/**
 * =========================
 * TELEGRAM BOT (WEBHOOK)
 * =========================
 * IMPORTANTE:
 * - NO uses webHook:{port:...} en node-telegram-bot-api si ya tenés Express escuchando,
 *   porque te da EADDRINUSE o deja el bot colgado.
 */
const bot = new TelegramBot(TOKEN, { polling: false });

/**
 * Webhook endpoint
 */
app.post("/webhook", (req, res) => {
  try {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error("Error processUpdate:", err);
    res.sendStatus(200);
  }
});

app.get("/", (_, res) => res.send({ ok: true, msg: "EzerBot corriendo" }));
app.get("/health", (_, res) => res.send({ ok: true }));

/**
 * Arranca server y recién ahí setea webhook
 */
app.listen(PORT, async () => {
  console.log("Servidor activo en puerto", PORT);
  try {
    const hookUrl = `${URL_BASE.replace(/\/$/, "")}/webhook`;
    await bot.setWebHook(hookUrl);
    console.log("Webhook seteado:", hookUrl);
  } catch (e) {
    console.error("Error setWebHook:", e);
  }
});

/**
 * =========================
 * HELPERS
 * =========================
 */
async function GAS(action, params = {}) {
  const url = new URL(BACKEND);
  url.searchParams.set("accion", action);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  // Timeout defensivo
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 12000);

  try {
    const r = await fetch(url.toString(), { signal: controller.signal });
    const text = await r.text();

    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, error: "Respuesta no JSON del backend", raw: text?.slice(0, 300) };
    }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

function mdEscape(s = "") {
  return String(s)
    .replace(/_/g, "\\_")
    .replace(/\*/g, "\\*")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/~/g, "\\~")
    .replace(/`/g, "\\`")
    .replace(/>/g, "\\>")
    .replace(/#/g, "\\#")
    .replace(/\+/g, "\\+")
    .replace(/-/g, "\\-")
    .replace(/=/g, "\\=")
    .replace(/\|/g, "\\|")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\./g, "\\.")
    .replace(/!/g, "\\!");
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function normalizeCat(s) {
  return (s || "General").toString().trim() || "General";
}

/**
 * Emojis por categoría (lindos y grandes)
 */
function emojiForCategory(cat) {
  const c = cat.toLowerCase();
  if (c.includes("ques")) return "🧀";
  if (c.includes("fiam") || c.includes("jam") || c.includes("sal")) return "🥓";
  if (c.includes("pan")) return "🥖";
  if (c.includes("lact") || c.includes("leche")) return "🥛";
  if (c.includes("dulc") || c.includes("post") || c.includes("mermel")) return "🍯";
  if (c.includes("beb") || c.includes("gase") || c.includes("agua")) return "🥤";
  if (c.includes("promo") || c.includes("combo")) return "🔥";
  return "📦";
}

/**
 * Sugerencias vendedor (NO agrega al carrito, solo sugiere y manda a categoría)
 */
function buildSuggestions(productName, categoriasDisponibles = []) {
  const name = (productName || "").toLowerCase();

  const wants = [];
  // reglas simples por palabras clave
  if (name.includes("ques") || name.includes("sardo") || name.includes("cremos") || name.includes("muzz")) {
    wants.push("Pan");
    wants.push("Dulces");
    wants.push("Fiambres");
  } else if (name.includes("jam") || name.includes("sal") || name.includes("fiamb") || name.includes("bond")) {
    wants.push("Pan");
    wants.push("Quesos");
    wants.push("Mayonesa");
  } else if (name.includes("leche") || name.includes("yog") || name.includes("lact")) {
    wants.push("Dulces");
    wants.push("Pan");
  } else if (name.includes("dulce") || name.includes("membrillo") || name.includes("batata")) {
    wants.push("Quesos");
    wants.push("Galletitas");
  } else {
    wants.push("Promos");
    wants.push("Pan");
    wants.push("Quesos");
  }

  // mapeo contra categorías reales (match parcial)
  const picks = [];
  for (const w of wants) {
    const found = categoriasDisponibles.find((c) => c.toLowerCase().includes(w.toLowerCase()));
    if (found && !picks.includes(found)) picks.push(found);
  }

  // si no matchea nada, toma hasta 3 categorías
  if (picks.length === 0) return categoriasDisponibles.slice(0, 3);
  return picks.slice(0, 3);
}

/**
 * =========================
 * START / SALUDO
 * =========================
 */
bot.onText(/\/start|^hola$|hola!|buenas|buen día|buen dia/i, async (msg) => {
  const chatId = msg.chat.id;
  const nombre = msg.chat.first_name || "amiga";

  const cfg = await GAS("config");
  const negocio = cfg?.NegocioNombre || "Todo Queso";
  const descripcion = cfg?.Descripcion || "Productos frescos, promos y beneficios exclusivos.";

  // Menú 2 columnas
  const menu = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🛍️ Catálogo", callback_data: "CATALOGO" },
          { text: "🛒 Mi carrito", callback_data: "CARRITO" }
        ],
        [
          { text: "🏆 Mis sellos", callback_data: "SELLOS" },
          { text: "💬 Hablar con el vendedor", callback_data: "HABLAR" }
        ],
        [
          { text: "🏪 Info del local", callback_data: "INFO" },
          { text: "📣 Compartir", callback_data: "COMPARTIR" }
        ]
      ]
    }
  };

  const caption =
    `*${mdEscape(negocio)}*\n` +
    `${mdEscape(descripcion)}\n\n` +
    `Hola ${mdEscape(nombre)} 👋\n` +
    `Soy tu asistente de *${mdEscape(negocio)}*.\n` +
    `Desde acá podés ver el catálogo, armar tu pedido y hablar con nosotros.\n\n` +
    `👇 Elegí una opción del menú:`;

  try {
    await bot.sendPhoto(chatId, cfg?.LogoURL || LOGO, { caption, parse_mode: "MarkdownV2" });
    await bot.sendMessage(chatId, " ", menu);
  } catch (e) {
    console.error("Error start:", e);
  }
});

/**
 * =========================
 * CALLBACKS
 * =========================
 */
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const data = q.data || "";

  // evita “loading” infinito
  try { await bot.answerCallbackQuery(q.id); } catch {}

  if (data === "INFO") return infoLocal(chatId);
  if (data === "CATALOGO") return mostrarCategorias(chatId);
  if (data === "COMPARTIR") return compartirBot(chatId);
  if (data === "SELLOS") return mostrarSellos(chatId);
  if (data === "HABLAR") return hablarVendedor(chatId);

  // carrito (por ahora simple)
  if (data === "CARRITO") {
    return bot.sendMessage(chatId, "🛒 Por ahora el carrito se maneja desde el flujo de compra. Seguimos con eso después 👍");
  }

  if (data === "COPIAR_LINK") {
    const cfg = await GAS("config");
    const negocio = cfg?.NegocioNombre || "Todo Queso";
    const link = `https://t.me/${(await bot.getMe()).username}`;
    return bot.sendMessage(
      chatId,
      `📣 *${mdEscape(negocio)}*\nAcá tenés el link para copiar y pegar:\n${link}`,
      { parse_mode: "MarkdownV2" }
    );
  }

  if (data.startsWith("CAT_")) {
    const categoria = data.replace("CAT_", "");
    return mostrarProductos(chatId, categoria, 0);
  }

  if (data.startsWith("PAGE_")) {
    const parts = data.split("_");
    const categoria = parts.slice(1, parts.length - 1).join("_");
    const page = Number(parts[parts.length - 1] || 0);
    return mostrarProductos(chatId, categoria, page);
  }

  // “comprar” (por ahora SOLO sugiere y manda al catálogo, sin cantidades)
  if (data.startsWith("BUY_")) {
    const codigo = data.replace("BUY_", "");
    return sugerirCompra(chatId, codigo);
  }

  // compartir producto (simple)
  if (data.startsWith("SHARE_")) {
    const codigo = data.replace("SHARE_", "");
    const r = await GAS("catalogo");
    const items = Array.isArray(r?.items) ? r.items : [];
    const p = items.find((x) => String(x.codigo || "") === String(codigo));
    const negocio = (await GAS("config"))?.NegocioNombre || "Todo Queso";
    const link = `https://t.me/${(await bot.getMe()).username}`;
    const texto =
      `🔥 *${mdEscape(negocio)}*\n` +
      `Promo recomendada:\n` +
      `• *${mdEscape(p?.nombre || "Producto")}*\n` +
      `• Precio: ${mdEscape(p?.precio ?? "—")} \n\n` +
      `Entrá al bot y pedilo acá 👉 ${link}`;
    return bot.sendMessage(chatId, texto, { parse_mode: "MarkdownV2" });
  }
});

/**
 * =========================
 * INFO LOCAL
 * =========================
 */
async function infoLocal(chatId) {
  const cfg = await GAS("config");
  const negocio = cfg?.NegocioNombre || "Todo Queso";

  const msg =
    `🏪 *${mdEscape(negocio)}*\n` +
    `📍 ${mdEscape(cfg?.Dirección || "Dirección no configurada")}\n` +
    `🕒 ${mdEscape(cfg?.Horarios || "Horarios no configurados")}\n` +
    `📞 ${mdEscape(cfg?.TeléfonoNegocio || "Teléfono no configurado")}\n` +
    (cfg?.Instagram ? `📸 Instagram: ${mdEscape(cfg.Instagram)}\n` : "") +
    (cfg?.Facebook ? `📘 Facebook: ${mdEscape(cfg.Facebook)}\n` : "");

  await bot.sendPhoto(chatId, cfg?.LogoURL || LOGO, { caption: msg, parse_mode: "MarkdownV2" });
}

/**
 * =========================
 * HABLAR CON VENDEDOR
 * =========================
 */
async function hablarVendedor(chatId) {
  const cfg = await GAS("config");
  const w = cfg?.WhatsAppLink || "https://wa.me/5493484230184";

  await bot.sendMessage(
    chatId,
    "💬 *Escribime tu consulta por acá* y un vendedor real te responde.\n\nSi querés, también podés ir directo a WhatsApp 👇",
    {
      parse_mode: "MarkdownV2",
      reply_markup: { inline_keyboard: [[{ text: "📞 Abrir WhatsApp", url: w }]] }
    }
  );
}

/**
 * =========================
 * COMPARTIR BOT
 * =========================
 */
async function compartirBot(chatId) {
  const me = await bot.getMe();
  const link = `https://t.me/${me.username}`;

  await bot.sendMessage(
    chatId,
    `📣 *Compartí este bot*\n` +
      `Mandalo por WhatsApp, Instagram o mail para que también aprovechen promos y beneficios.\n\n` +
      `👉 ${link}`,
    {
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔗 Abrir link del bot", url: link }],
          [{ text: "📋 Copiar link", callback_data: "COPIAR_LINK" }]
        ]
      }
    }
  );
}

/**
 * =========================
 * CATEGORÍAS
 * =========================
 */
async function mostrarCategorias(chatId) {
  const r = await GAS("catalogo");

  const items = Array.isArray(r?.items) ? r.items : [];

  if (items.length === 0) {
    return bot.sendMessage(
      chatId,
      "😕 En este momento no puedo mostrar el catálogo.\nProbá de nuevo en unos segundos."
    );
  }

  const cats = [...new Set(items.map((i) => normalizeCat(i.categoria)))];

  // 2 columnas de botones (más prolijo)
  const rows = chunk(
    cats.map((c) => ({
      text: `${emojiForCategory(c)} ${c}`,
      callback_data: "CAT_" + c
    })),
    2
  ).map((row) => row.map((b) => b));

  await bot.sendMessage(chatId, "📂 *Elegí una categoría:*", {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: rows }
  });
}

/**
 * =========================
 * PRODUCTOS POR CATEGORÍA (PAGINADO)
 * =========================
 */
async function mostrarProductos(chatId, categoria, page = 0) {
  const r = await GAS("catalogo");
  const all = Array.isArray(r?.items) ? r.items : [];

  if (all.length === 0) {
    return bot.sendMessage(chatId, "⚠️ No pude cargar productos ahora. Intentá nuevamente.");
  }

  const cat = normalizeCat(categoria);
  const items = all.filter((p) => normalizeCat(p.categoria) === cat);

  const porPagina = 3;
  const inicio = page * porPagina;
  const lista = items.slice(inicio, inicio + porPagina);

  if (lista.length === 0) {
    return bot.sendMessage(chatId, "No hay productos en esta categoría.");
  }

  for (const p of lista) {
    const nombre = p?.nombre || "Producto";
    const precio = p?.precio ?? "";
    const desc = p?.descripcion || "";
    const codigo = p?.codigo || "SIN-CODIGO";
    const img = p?.imagenUrl || LOGO;

    const caption =
      `*${mdEscape(nombre)}*\n` +
      (desc ? `${mdEscape(desc)}\n\n` : "\n") +
      `💲 ${mdEscape(String(precio))}\n` +
      `🆔 Código: *${mdEscape(String(codigo))}*`;

    await bot.sendPhoto(chatId, img, {
      caption,
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🛒 Comprar", callback_data: "BUY_" + codigo },
            { text: "📣 Compartir", callback_data: "SHARE_" + codigo }
          ]
        ]
      }
    });
  }

  // navegación
  const nav = [];
  if (inicio > 0) nav.push({ text: "⬅️ Anterior", callback_data: `PAGE_${cat}_${page - 1}` });
  if (inicio + porPagina < items.length) nav.push({ text: "Siguiente ➡️", callback_data: `PAGE_${cat}_${page + 1}` });

  if (nav.length) {
    await bot.sendMessage(chatId, "📌 Navegación:", {
      reply_markup: { inline_keyboard: [nav] }
    });
  }
}

/**
 * =========================
 * “COMPRAR” (por ahora: sugerencia vendedora + ir a categoría)
 * - NO agrega unidades/gramos
 * - NO toca carrito
 * =========================
 */
async function sugerirCompra(chatId, codigo) {
  const catResp = await GAS("catalogo");
  const items = Array.isArray(catResp?.items) ? catResp.items : [];
  const p = items.find((x) => String(x.codigo || "") === String(codigo));

  // mensaje principal (modo vendedora)
  const nombre = p?.nombre || "ese producto";
  await bot.sendMessage(
    chatId,
    `✅ Listo. Elegiste *${nombre}*.\n\n💡 Ya que estás… ¿querés llevar algo para acompañar?`,
    { parse_mode: "Markdown" }
  );

  // sugerencias por categorías (solo navegar)
  const categorias = [...new Set(items.map((i) => normalizeCat(i.categoria)))];
  const sugCats = buildSuggestions(nombre, categorias);

  const sugButtons = sugCats.map((c) => [{ text: `${emojiForCategory(c)} ${c}`, callback_data: "CAT_" + c }]);

  await bot.sendMessage(chatId, "Elegí una opción rápida 👇", {
    reply_markup: { inline_keyboard: sugButtons }
  });

  await bot.sendMessage(chatId, "🛍️ Si querés seguir mirando, tocá *Catálogo* abajo cuando quieras.", {
    parse_mode: "Markdown"
  });
}

/**
 * =========================
 * SELLOS
 * =========================
 */
async function mostrarSellos(chatId) {
  const r = await GAS("estadoCliente", { chatId });

  // si tu backend no tiene esto aún, no rompemos:
  if (!r || r.ok === false) {
    return bot.sendMessage(chatId, "🎁 El sistema de sellos todavía no está disponible en este comercio.");
  }

  if (!r.tieneTarjeta) {
    return bot.sendMessage(chatId, "🏆 Todavía no tenés tarjeta. Con tu primera compra se genera automáticamente 😄");
  }

  const sellos = r.sellosTotalesAcumulados ?? 0;
  const nivel = r.nivelActual ?? "—";
  const img = r.tarjetaImagenUrl || LOGO;

  await bot.sendPhoto(chatId, img, {
    caption: `🏆 *Tus sellos:* ${sellos}\n⭐ Nivel: ${nivel}`,
    parse_mode: "Markdown"
  });
}

/**
 * EzerBot System - Catálogo limpio con paginado visual (3 productos por página)
 * - Menú principal: Reply Keyboard (siempre abajo, no se mezcla)
 * - Catálogo: 3 fotos por página, cada foto con botones:
 *   ✅ Quiero este | 📣 Compartir promo | ↩️ Volver a categoría
 * - Navegación: ⬅️ Anterior | ➡️ Siguiente | 📂 Categorías
 * - Limpieza: borra mensajes anteriores del catálogo para que NO se encime
 *
 * ENV requeridas en Render:
 * BOT_TOKEN=xxxx
 * WEBHOOK_URL=https://tu-servicio.onrender.com/webhook
 * GAS_URL=https://script.google.com/macros/s/XXXX/exec
 *
 * Opcionales:
 * BRAND_NAME=TODO QUESO CLUB
 * BRAND_HELLO=Hola
 * BRAND_DESC=Productos frescos, promos y beneficios exclusivos.
 * BOT_PUBLIC=@TuBot
 * SELLER_WA=54911XXXXXXXXX
 * LOCAL_INFO=Direccion + horarios
 */

import http from "http";
import TelegramBot from "node-telegram-bot-api";

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const GAS_URL = process.env.GAS_URL;

if (!BOT_TOKEN) throw new Error("Falta ENV BOT_TOKEN");
if (!WEBHOOK_URL) throw new Error("Falta ENV WEBHOOK_URL (https://.../webhook)");
if (!GAS_URL) throw new Error("Falta ENV GAS_URL (endpoint del Apps Script)");

const BRAND_NAME = process.env.BRAND_NAME || "TODO QUESO CLUB";
const BRAND_HELLO = process.env.BRAND_HELLO || "Hola";
const BRAND_DESC =
  process.env.BRAND_DESC || "Productos frescos, promos y beneficios exclusivos.";
const BOT_PUBLIC = process.env.BOT_PUBLIC || "@EzerBot"; // para compartir
const SELLER_WA = process.env.SELLER_WA || ""; // ej: 5491122538102
const LOCAL_INFO = process.env.LOCAL_INFO || "📍 Consultá dirección y horarios con el vendedor.";

const PORT = process.env.PORT || 10000;

// ============ BOT (webhook) ============
const bot = new TelegramBot(BOT_TOKEN);
await bot.setWebHook(WEBHOOK_URL);
console.log("✅ Webhook seteado:", WEBHOOK_URL);

// ============ SESIONES EN MEMORIA ============
/**
 * session:
 * {
 *   mode: "idle" | "picking_category" | "browsing",
 *   category: string|null,
 *   page: number,
 *   lastCatalogMessageIds: number[]
 * }
 */
const sessions = new Map();
function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      mode: "idle",
      category: null,
      page: 0,
      lastCatalogMessageIds: [],
    });
  }
  return sessions.get(chatId);
}

// ============ UTIL: TIMEOUT FETCH ============
async function fetchJSON(url, opts = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Respuesta no JSON desde GAS. Texto: ${text.slice(0, 200)}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    return json;
  } finally {
    clearTimeout(t);
  }
}

// ============ DATA: Traer catálogo desde GAS ============
/**
 * Espera que GAS devuelva algo como:
 * { items: [{ codigo/id, nombre, precio, categoria, imagen/url, descripcion }] }
 * (nombres tolerantes)
 */
function normalizeItem(raw) {
  const codigo =
    raw.codigo ?? raw.Codigo ?? raw.CÓDIGO ?? raw.id ?? raw.ID ?? raw.Id ?? "";
  const nombre =
    raw.nombre ?? raw.Nombre ?? raw.NOMBRE ?? raw.producto ?? raw.Producto ?? "";
  const precio =
    raw.precio ?? raw.Precio ?? raw.PRECIO ?? raw.price ?? raw.Price ?? "";
  const categoria =
    raw.categoria ?? raw.Categoria ?? raw.CATEGORIA ?? raw.category ?? "General";
  const imagen =
    raw.imagen ??
    raw.Imagen ??
    raw.IMAGEN ??
    raw.urlImagen ??
    raw.image ??
    raw.Image ??
    raw.foto ??
    raw.Foto ??
    raw.URL ??
    raw.url ??
    "";
  const descripcion =
    raw.descripcion ??
    raw.Descripcion ??
    raw.DESCRIPCION ??
    raw.detalle ??
    raw.Detalle ??
    "";

  return {
    codigo: String(codigo || "").trim(),
    nombre: String(nombre || "").trim(),
    precio: String(precio || "").toString().trim(),
    categoria: String(categoria || "General").trim(),
    imagen: String(imagen || "").trim(),
    descripcion: String(descripcion || "").trim(),
  };
}

async function getCatalog() {
  const data = await fetchJSON(GAS_URL, { method: "GET" });
  const itemsRaw = data.items ?? data.Items ?? data.productos ?? data.Productos ?? [];
  if (!Array.isArray(itemsRaw)) return { items: [] };

  const items = itemsRaw.map(normalizeItem).filter((x) => x.nombre && x.codigo);
  return { items };
}

function uniq(arr) {
  return [...new Set(arr)];
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ============ UI: Menú principal (Reply Keyboard) ============
function mainMenuKeyboard() {
  return {
    keyboard: [
      [{ text: "🛍️ Catálogo" }, { text: "🛒 Mi pedido" }],
      [{ text: "🎁 Mis sellos" }],
      [{ text: "💬 Hablar con el vendedor" }],
      [{ text: "ℹ️ Info del local" }, { text: "📣 Compartir" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

// ============ LIMPIEZA: borrar mensajes anteriores del catálogo ============
async function clearCatalogMessages(chatId) {
  const s = getSession(chatId);
  const ids = s.lastCatalogMessageIds || [];
  if (!ids.length) return;

  for (const mid of ids) {
    try {
      await bot.deleteMessage(chatId, mid);
    } catch {
      // ignorar (Telegram a veces no deja borrar algunos)
    }
  }
  s.lastCatalogMessageIds = [];
}

function rememberMsg(chatId, messageId) {
  const s = getSession(chatId);
  s.lastCatalogMessageIds.push(messageId);
}

// ============ CATEGORÍAS ============
async function showCategories(chatId) {
  const s = getSession(chatId);
  s.mode = "picking_category";
  s.category = null;
  s.page = 0;

  await clearCatalogMessages(chatId);

  const { items } = await getCatalog();
  const categories = uniq(items.map((i) => i.categoria)).sort((a, b) => a.localeCompare(b));

  // Teclado de categorías (reply keyboard) para mantener limpio y claro
  const rows = [];
  const catButtons = categories.map((c) => ({ text: `📂 ${c}` }));
  for (let i = 0; i < catButtons.length; i += 2) {
    rows.push(catButtons.slice(i, i + 2));
  }
  rows.push([{ text: "🏠 Menú" }]);

  const sent = await bot.sendMessage(
    chatId,
    "📂 Elegí una categoría:",
    {
      reply_markup: {
        keyboard: rows,
        resize_keyboard: true,
        is_persistent: true,
      },
    }
  );

  // Este mensaje sí lo consideramos parte del “catálogo” para limpiarlo al cambiar.
  rememberMsg(chatId, sent.message_id);
}

// ============ CATÁLOGO: 3 por página con fotos ============
function buildShareUrl(item) {
  // URL para compartir por Telegram (abre pantalla de compartir)
  // Incluye texto con producto
  const text = encodeURIComponent(
    `🔥 Promo en ${BRAND_NAME}\n${item.nombre} – $${item.precio}\n🆔 ${item.codigo}\n\nPedilo acá: ${BOT_PUBLIC}`
  );
  const url = encodeURIComponent(`https://t.me/${(BOT_PUBLIC || "@").replace("@", "")}`);
  return `https://t.me/share/url?url=${url}&text=${text}`;
}

function productCaption(item) {
  const price = item.precio ? `$ ${item.precio} ARS` : "";
  const desc = item.descripcion ? `\n${item.descripcion}` : "";
  return `*${escapeMd(item.nombre)}*\n${escapeMd(desc)}\n\n${price ? `💲 ${escapeMd(price)}\n` : ""}🆔 *${escapeMd(item.codigo)}*`;
}

function escapeMd(t = "") {
  return String(t).replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

async function showCatalogPage(chatId, category, page) {
  const s = getSession(chatId);
  s.mode = "browsing";
  s.category = category;
  s.page = Math.max(0, page || 0);

  await clearCatalogMessages(chatId);

  const { items } = await getCatalog();
  const filtered = items.filter((i) => (i.categoria || "General") === category);

  if (!filtered.length) {
    const m = await bot.sendMessage(chatId, "⚠️ No hay productos en esta categoría.", {
      reply_markup: mainMenuKeyboard(),
    });
    rememberMsg(chatId, m.message_id);
    return;
  }

  const pages = chunk(filtered, 3);
  const maxPage = pages.length - 1;
  if (s.page > maxPage) s.page = maxPage;

  const pageItems = pages[s.page];

  // Header corto (una sola línea)
  const header = await bot.sendMessage(
    chatId,
    `📂 *${escapeMd(category)}* — página ${s.page + 1}/${pages.length}`,
    { parse_mode: "MarkdownV2" }
  );
  rememberMsg(chatId, header.message_id);

  // 3 productos (cada uno: FOTO + botones)
  for (const item of pageItems) {
    const inline = {
      inline_keyboard: [
        [
          { text: "✅ Quiero este", callback_data: `want:${item.codigo}` },
          { text: "📣 Compartir promo", url: buildShareUrl(item) },
        ],
        [
          { text: "↩️ Volver a categoría", callback_data: `backcat:${encodeURIComponent(category)}` },
        ],
      ],
    };

    // Si no hay imagen válida, manda como texto (fallback)
    if (!item.imagen || !/^https?:\/\//i.test(item.imagen)) {
      const txt = await bot.sendMessage(chatId, productCaption(item), {
        parse_mode: "MarkdownV2",
        reply_markup: inline,
      });
      rememberMsg(chatId, txt.message_id);
      continue;
    }

    try {
      const msg = await bot.sendPhoto(chatId, item.imagen, {
        caption: productCaption(item),
        parse_mode: "MarkdownV2",
        reply_markup: inline,
      });
      rememberMsg(chatId, msg.message_id);
    } catch {
      // si falla foto (link caído), cae a texto
      const txt = await bot.sendMessage(chatId, productCaption(item), {
        parse_mode: "MarkdownV2",
        reply_markup: inline,
      });
      rememberMsg(chatId, txt.message_id);
    }
  }

  // Navegación (una sola fila)
  const navInline = {
    inline_keyboard: [
      [
        { text: "⬅️ Anterior", callback_data: `nav:${encodeURIComponent(category)}:${Math.max(0, s.page - 1)}` },
        { text: "📂 Categorías", callback_data: "cats" },
        { text: "➡️ Siguiente", callback_data: `nav:${encodeURIComponent(category)}:${Math.min(maxPage, s.page + 1)}` },
      ],
    ],
  };

  const nav = await bot.sendMessage(chatId, "🧭 Navegación:", { reply_markup: navInline });
  rememberMsg(chatId, nav.message_id);
}

// ============ ACCIONES ============
async function handleWant(chatId, code) {
  // Mensaje corto y vendedor
  await bot.sendMessage(
    chatId,
    `✅ Perfecto 👌\nElegiste: *${escapeMd(code)}*\n\n¿Querés que te preguntemos cantidad (gramos/kilos) ahora o preferís seguir mirando?`,
    {
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [
          [{ text: "⚖️ Poner cantidad", callback_data: `qty:${code}` }],
          [{ text: "🛍️ Seguir mirando", callback_data: "keep" }],
          [{ text: "💬 Hablar con el vendedor", callback_data: "seller" }],
        ],
      },
    }
  );
}

function sellerLink() {
  if (!SELLER_WA) return null;
  const text = encodeURIComponent(`Hola! Quiero hacer un pedido en ${BRAND_NAME}.`);
  return `https://wa.me/${SELLER_WA}?text=${text}`;
}

// ============ MENSAJE INICIAL ============
async function sendWelcome(chatId, firstName = "") {
  const name = firstName || "👋";
  const text =
    `${BRAND_DESC}\n\n` +
    `${BRAND_HELLO} ${name} 👋\n` +
    `Soy el asistente de *${BRAND_NAME}* 🧀\n\n` +
    `Desde acá podés:\n` +
    `• Ver el catálogo\n` +
    `• Armar tu pedido\n` +
    `• Sumar sellos\n` +
    `• Hablar con nosotros\n\n` +
    `👇 Elegí una opción`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: mainMenuKeyboard(),
  });
}

// ============ HANDLERS (mensajes) ============
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const s = getSession(chatId);

  try {
    if (text === "/start" || text === "🏠 Menú") {
      s.mode = "idle";
      s.category = null;
      s.page = 0;
      await clearCatalogMessages(chatId);
      await sendWelcome(chatId, msg.from?.first_name || "");
      return;
    }

    if (text === "🛍️ Catálogo") {
      await showCategories(chatId);
      return;
    }

    if (text.startsWith("📂 ") && s.mode === "picking_category") {
      const category = text.replace(/^📂\s*/, "").trim();
      await showCatalogPage(chatId, category, 0);
      return;
    }

    if (text === "🛒 Mi pedido") {
      await bot.sendMessage(chatId, "🛒 *Mi pedido*: lo armamos en el siguiente paso (cantidad/gramos/kilos).", {
        parse_mode: "Markdown",
        reply_markup: mainMenuKeyboard(),
      });
      return;
    }

    if (text === "🎁 Mis sellos") {
      await bot.sendMessage(chatId, "🎁 Todavía no tenés tarjeta. Cuando hagas tu primera compra, te la generamos 😄", {
        reply_markup: mainMenuKeyboard(),
      });
      return;
    }

    if (text === "💬 Hablar con el vendedor") {
      const wa = sellerLink();
      if (wa) {
        await bot.sendMessage(chatId, "💬 Dale. Tocá para hablar por WhatsApp:", {
          reply_markup: { inline_keyboard: [[{ text: "📲 Abrir WhatsApp", url: wa }]] },
        });
      } else {
        await bot.sendMessage(chatId, "💬 Pasame el WhatsApp del vendedor en la variable SELLER_WA y lo activo.");
      }
      return;
    }

    if (text === "ℹ️ Info del local") {
      await bot.sendMessage(chatId, `ℹ️ ${LOCAL_INFO}`, { reply_markup: mainMenuKeyboard() });
      return;
    }

    if (text === "📣 Compartir") {
      const botUser = (BOT_PUBLIC || "@EzerBot").replace("@", "");
      const url = `https://t.me/${botUser}`;
      const share = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(
        `🧀 ${BRAND_NAME}\nMirá catálogo y promos acá 👇`
      )}`;
      await bot.sendMessage(chatId, "📣 Compartí el bot:", {
        reply_markup: { inline_keyboard: [[{ text: "📣 Compartir ahora", url: share }]] },
      });
      return;
    }

    // Si el usuario escribe cualquier cosa mientras está en categorías, lo guiamos sin spamear
    if (s.mode === "picking_category") {
      await bot.sendMessage(chatId, "📂 Elegí una categoría desde el teclado 👇");
      return;
    }
  } catch (e) {
    await bot.sendMessage(chatId, `⚠️ Error: ${e.message || e}`);
  }
});

// ============ HANDLERS (callbacks) ============
bot.on("callback_query", async (q) => {
  const chatId = q.message?.chat?.id;
  if (!chatId) return;

  const data = q.data || "";
  const s = getSession(chatId);

  try {
    // Evita “loading…”
    await bot.answerCallbackQuery(q.id).catch(() => {});

    if (data === "cats") {
      await showCategories(chatId);
      return;
    }

    if (data.startsWith("backcat:")) {
      const category = decodeURIComponent(data.split(":")[1] || "");
      // volvemos a la misma página actual
      await showCatalogPage(chatId, category, s.page || 0);
      return;
    }

    if (data.startsWith("nav:")) {
      const [, encCat, p] = data.split(":");
      const category = decodeURIComponent(encCat || "");
      const page = parseInt(p || "0", 10);
      await showCatalogPage(chatId, category, page);
      return;
    }

    if (data.startsWith("want:")) {
      const code = data.split(":")[1] || "";
      await handleWant(chatId, code);
      return;
    }

    if (data.startsWith("qty:")) {
      const code = data.split(":")[1] || "";
      await bot.sendMessage(
        chatId,
        `⚖️ Ok. (Siguiente paso) Cantidad para *${escapeMd(code)}*:\n\nElegí una opción:\n• 100g\n• 200g\n• 500g\n• 1kg\n\n(Esto lo armamos después, ahora cerramos catálogo limpio)`,
        { parse_mode: "MarkdownV2" }
      );
      return;
    }

    if (data === "keep") {
      if (s.category) await showCatalogPage(chatId, s.category, s.page || 0);
      else await showCategories(chatId);
      return;
    }

    if (data === "seller") {
      const wa = sellerLink();
      if (wa) {
        await bot.sendMessage(chatId, "💬 Tocá para hablar por WhatsApp:", {
          reply_markup: { inline_keyboard: [[{ text: "📲 Abrir WhatsApp", url: wa }]] },
        });
      } else {
        await bot.sendMessage(chatId, "💬 Configurame SELLER_WA y lo activo.");
      }
      return;
    }
  } catch (e) {
    await bot.sendMessage(chatId, `⚠️ Error: ${e.message || e}`);
  }
});

// ============ SERVER WEBHOOK ============
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK - EzerBot is running");
      return;
    }

    if (req.method === "POST" && req.url === "/webhook") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const update = JSON.parse(body || "{}");
          await bot.processUpdate(update);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Server Error");
  }
});

server.listen(PORT, () => {
  console.log(`✅ Server activo en puerto ${PORT}`);
});

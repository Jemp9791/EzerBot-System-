import express from "express";
import TelegramBot from "node-telegram-bot-api";

const TOKEN = process.env.TELEGRAM_TOKEN;                 // <-- en Render ENV
const BACKEND = process.env.GAS_BACKEND;                  // <-- en Render ENV
const URL_BASE = process.env.URL_BASE;                    // <-- en Render ENV
const LOGO = process.env.LOGO_URL;                        // <-- en Render ENV

if (!TOKEN) throw new Error("Falta TELEGRAM_TOKEN en Environment");
if (!BACKEND) throw new Error("Falta GAS_BACKEND en Environment");
if (!URL_BASE) throw new Error("Falta URL_BASE en Environment");
if (!LOGO) throw new Error("Falta LOGO_URL en Environment");

const PORT = process.env.PORT || 10000;

const app = express();
app.use(express.json({ limit: "2mb" }));

// Bot sin “webHook: {port: ...}” (eso suele traer conflictos). Webhook lo manejamos con Express.
const bot = new TelegramBot(TOKEN, { polling: false });

/* ---------------------------
   Helpers
---------------------------- */

const MAIN_MENU = {
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

function mdEscape(s = "") {
  // Markdown simple (para no romper por símbolos raros)
  return String(s).replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&");
}

async function GAS(action, params = {}) {
  const url = new URL(BACKEND);
  url.searchParams.set("accion", action);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000);

  try {
    const r = await fetch(url.toString(), { signal: controller.signal });
    const text = await r.text();

    // Intento parsear JSON aunque venga con basura
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, error: "Respuesta no JSON del GAS", raw: text.slice(0, 400) };
    }
    return json;
  } catch (e) {
    return { ok: false, error: "Falla consultando GAS", detail: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

async function showMenu(chatId, firstName = "amiga") {
  const caption =
    `Hola ${mdEscape(firstName)} 👋\n` +
    `Soy el asistente de *TODO QUESO CLUB* 🧀\n\n` +
    `Desde acá podés:\n` +
    `• Ver el catálogo\n` +
    `• Armar tu pedido\n` +
    `• Sumar sellos\n` +
    `• Hablar con nosotros\n\n` +
    `👇 *Elegí una opción*`;

  await bot.sendPhoto(chatId, LOGO, { caption, parse_mode: "MarkdownV2", ...MAIN_MENU });
}

function buildCategoriesKeyboard(cats) {
  // 2 columnas prolijo
  const rows = [];
  for (let i = 0; i < cats.length; i += 2) {
    const row = [];
    row.push({ text: cats[i], callback_data: `CAT_${cats[i]}` });
    if (cats[i + 1]) row.push({ text: cats[i + 1], callback_data: `CAT_${cats[i + 1]}` });
    rows.push(row);
  }
  rows.push([{ text: "🏠 Menú", callback_data: "MENU" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/* ---------------------------
   Commands
---------------------------- */

bot.onText(/\/start|\/menu/i, async (msg) => {
  const chatId = msg.chat.id;
  const nombre = msg.chat.first_name || "amiga";
  try {
    await showMenu(chatId, nombre);
  } catch (e) {
    console.error("start/menu error:", e);
  }
});

/* ---------------------------
   Callback Queries
---------------------------- */

bot.on("callback_query", async (q) => {
  const chatId = q.message?.chat?.id;
  const data = q.data;

  // Siempre “ack” para que Telegram no quede pensando
  try { await bot.answerCallbackQuery(q.id); } catch {}

  try {
    if (!chatId) return;

    if (data === "MENU") return showMenu(chatId, q.from?.first_name || "amiga");
    if (data === "CATALOGO") return mostrarCategorias(chatId);
    if (data === "INFO") return infoLocal(chatId);
    if (data === "HABLAR") return hablarVendedor(chatId);
    if (data === "SELLOS") return mostrarSellos(chatId);
    if (data === "COMPARTIR") return compartirBot(chatId);
    if (data === "CARRITO") return bot.sendMessage(chatId, "🛒 Tu carrito lo activamos en el próximo paso 😉\nPor ahora podés mirar el catálogo y consultar.");

    if (data.startsWith("CAT_")) {
      const categoria = data.slice(4);
      return mostrarProductos(chatId, categoria, 0);
    }

    if (data.startsWith("PAGE_")) {
      const parts = data.split("|"); // PAGE_|categoria|page
      const categoria = parts[1];
      const page = Number(parts[2] || 0);
      return mostrarProductos(chatId, categoria, page);
    }

  } catch (e) {
    console.error("callback error:", e);
    try { await bot.sendMessage(chatId, "⚠️ Se me trabó un segundo. Probá de nuevo o tocá 🏠 Menú."); } catch {}
  }
});

/* ---------------------------
   Flows
---------------------------- */

async function mostrarCategorias(chatId) {
  const r = await GAS("catalogo");
  const items = Array.isArray(r?.items) ? r.items : [];

  if (!items.length) {
    return bot.sendMessage(
      chatId,
      "⚠️ No pude leer el catálogo.\nRevisá que el GAS devuelva `items` (array) en la acción `catalogo`.\n\nTocá 🏠 Menú y probá otra vez."
    );
  }

  const cats = [...new Set(items.map(p => (p.categoria || "General").trim()))]
    .filter(Boolean)
    .slice(0, 40);

  // Emojis “vendedor” Todo Queso
  const mapEmoji = (c) => {
    const x = c.toLowerCase();
    if (x.includes("fiambre")) return "🥓 " + c;
    if (x.includes("láct") || x.includes("lact") || x.includes("leche")) return "🧈 " + c;
    if (x.includes("pan") || x.includes("panif")) return "🥖 " + c;
    if (x.includes("promo")) return "🔥 " + c;
    if (x.includes("ques")) return "🧀 " + c;
    return "📦 " + c;
  };

  const labeled = cats.map(mapEmoji);

  await bot.sendMessage(chatId, "📂 *Elegí una categoría:*", {
    parse_mode: "Markdown",
    ...buildCategoriesKeyboard(labeled),
  });
}

async function mostrarProductos(chatId, categoriaLabel, page = 0) {
  const r = await GAS("catalogo");
  const itemsAll = Array.isArray(r?.items) ? r.items : [];

  if (!itemsAll.length) {
    return bot.sendMessage(chatId, "⚠️ No pude leer el catálogo. Tocá 🏠 Menú.");
  }

  // categoriaLabel viene con emoji. Sacamos emoji y espacios iniciales
  const categoria = categoriaLabel.replace(/^[^\wÁÉÍÓÚÜÑáéíóúüñ]+/g, "").trim();

  const items = itemsAll.filter(p => (p.categoria || "General").trim() === categoria);

  const perPage = 3;
  const maxPages = Math.max(1, Math.ceil(items.length / perPage));
  const safePage = Math.min(Math.max(0, page), maxPages - 1);

  const slice = items.slice(safePage * perPage, safePage * perPage + perPage);

  if (!slice.length) {
    return bot.sendMessage(chatId, "No encontré productos en esa categoría. Tocá 🏠 Menú.");
  }

  // En vez de “agregar al carrito” (que te rompe por kg/unidad), solo sugerimos y guiamos.
  for (const p of slice) {
    const nombre = p.nombre || "Producto";
    const desc = p.descripcion || "";
    const precio = p.precio ? `💲 ${p.precio} ARS` : "";
    const img = p.imagenUrl || LOGO;

    await bot.sendPhoto(chatId, img, {
      caption: `*${mdEscape(nombre)}*\n${mdEscape(desc)}\n${mdEscape(precio)}`.trim(),
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🛒 ¿Cómo lo pido?", callback_data: "HABLAR" }],
          [{ text: "🏠 Menú", callback_data: "MENU" }],
        ],
      },
    });

    // Sugerencia “tipo vendedor” SIN sumar unidades
    const sug = sugerenciaVenta(nombre, categoria);
    if (sug) {
      await bot.sendMessage(chatId, `💡 ${sug}\n\n👉 Si querés, buscá eso en *Catálogo* (categoría: *${mdEscape(sugCategoria(sug))}*).`, {
        parse_mode: "MarkdownV2",
        reply_markup: { inline_keyboard: [[{ text: "🛍️ Volver a Catálogo", callback_data: "CATALOGO" }]] },
      });
    }
  }

  // Paginación abajo (prolijo, 1 sola fila)
  const navRow = [];
  if (safePage > 0) navRow.push({ text: "⬅️ Anterior", callback_data: `PAGE_|${categoriaLabel}|${safePage - 1}` });
  navRow.push({ text: `📄 ${safePage + 1}/${maxPages}`, callback_data: "NOOP" });
  if (safePage < maxPages - 1) navRow.push({ text: "Siguiente ➡️", callback_data: `PAGE_|${categoriaLabel}|${safePage + 1}` });

  await bot.sendMessage(chatId, `📌 *${mdEscape(categoria)}* — Navegación`, {
    parse_mode: "MarkdownV2",
    reply_markup: { inline_keyboard: [navRow, [{ text: "🏠 Menú", callback_data: "MENU" }]] },
  });
}

function sugerenciaVenta(nombre, categoria) {
  const n = (nombre || "").toLowerCase();
  const c = (categoria || "").toLowerCase();

  // Reglas simples “Todo Queso vendedor”
  if (c.includes("ques") || n.includes("ques")) {
    return "Ya que llevás queso 🧀, te recomiendo sumar *pan fresco* o *pan lactal* para acompañar. Queda espectacular.";
  }
  if (c.includes("fiambre") || n.includes("jam") || n.includes("salame") || n.includes("mortad")) {
    return "Con fiambres 🥓 va perfecto *pan fresco* y *mayonesa/mostaza*. ¿Te lo busco en el catálogo?";
  }
  if (c.includes("láct") || c.includes("lact") || n.includes("leche") || n.includes("yogur")) {
    return "Si llevás lácteos 🧈, suele ir bien *azúcar* o *mermelada* y algo de *pan*. ¿Querés que te lo ubique en el catálogo?";
  }
  if (c.includes("pan") || n.includes("pan")) {
    return "Con pan 🥖, mucha gente suma *queso cremoso* o *dulce de batata/membrillo*. ¿Te tentó?";
  }
  if (c.includes("promo")) {
    return "En promos 🔥, si querés cerrar el pedido, sumá *pan* o algún *queso* para que rinda más.";
  }
  return "";
}

// Solo para mostrar un “texto categoría” en sugerencia (básico)
function sugCategoria(sug) {
  const s = sug.toLowerCase();
  if (s.includes("pan")) return "Panificados";
  if (s.includes("mermelada") || s.includes("batata") || s.includes("membrillo")) return "Panificados";
  if (s.includes("queso")) return "Quesos";
  if (s.includes("fiambre")) return "Fiambres";
  return "Catálogo";
}

async function infoLocal(chatId) {
  const cfg = await GAS("config");
  if (!cfg || cfg.ok === false) {
    return bot.sendMessage(chatId, "⚠️ No pude leer la info del local. Probá más tarde.");
  }

  const msg =
    `🏪 *${mdEscape(cfg.NegocioNombre || "Todo Queso Club")}*\n` +
    `📍 ${mdEscape(cfg.Dirección || "—")}\n` +
    `🕒 ${mdEscape(cfg.Horarios || "—")}\n` +
    `📞 ${mdEscape(cfg.TeléfonoNegocio || "—")}\n` +
    `📸 Instagram: ${mdEscape(cfg.Instagram || "—")}`;

  await bot.sendPhoto(chatId, LOGO, { caption: msg, parse_mode: "MarkdownV2", reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "MENU" }]] } });
}

async function hablarVendedor(chatId) {
  const cfg = await GAS("config");
  const w = cfg?.WhatsAppLink || "https://wa.me/5493484230184";

  await bot.sendMessage(
    chatId,
    "💬 *¿Querés que te ayude como vendedor?*\nAbrime WhatsApp y lo armamos rápido 👇",
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "📞 Abrir WhatsApp", url: w }], [{ text: "🏠 Menú", callback_data: "MENU" }]] },
    }
  );
}

async function compartirBot(chatId) {
  // Cambiá esto por tu @ real si querés
  const share = "https://t.me/Ezer_IA_Bot";
  await bot.sendMessage(
    chatId,
    "📣 *Compartí el bot*\nPasáselo a alguien y que chusmee el catálogo 😄",
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "🔗 Abrir link", url: share }], [{ text: "🏠 Menú", callback_data: "MENU" }]] },
    }
  );
}

async function mostrarSellos(chatId) {
  const r = await GAS("estadoCliente", { chatId });
  if (!r || r.ok === false) return bot.sendMessage(chatId, "⚠️ No pude leer tus sellos ahora. Probá luego.");

  if (!r.tieneTarjeta) {
    return bot.sendMessage(chatId, "Todavía no tenés tarjeta. Cuando compres te la creamos automática 😄", {
      reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "MENU" }]] },
    });
  }

  await bot.sendPhoto(chatId, r.tarjetaImagenUrl || LOGO, {
    caption: `🎉 *Tus sellos:* ${mdEscape(r.sellosTotalesAcumulados)}\n⭐ Nivel: ${mdEscape(r.nivelActual || "—")}`,
    parse_mode: "MarkdownV2",
    reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "MENU" }]] },
  });
}

/* ---------------------------
   Webhook endpoints
---------------------------- */

app.post("/webhook", (req, res) => {
  try {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (e) {
    console.error("processUpdate error:", e);
    res.sendStatus(500);
  }
});

app.get("/", (_, res) => res.json({ ok: true, msg: "EzerBot corriendo" }));

app.get("/debug", async (_, res) => {
  try {
    const info = await bot.getWebHookInfo();
    res.json({
      ok: true,
      url_base: URL_BASE,
      webhook_expected: `${URL_BASE}/webhook`,
      webhook_info: info,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ---------------------------
   Start server + setWebhook
---------------------------- */

app.listen(PORT, async () => {
  console.log("Servidor activo en puerto", PORT);

  const hookUrl = `${URL_BASE}/webhook`;
  try {
    // Limpia webhook viejo y setea el nuevo (clave para que no “se muera”)
    await bot.deleteWebHook({ drop_pending_updates: true });
    await bot.setWebHook(hookUrl);
    console.log("Webhook seteado:", hookUrl);
  } catch (e) {
    console.error("ERROR setWebhook:", e?.response?.body || e);
  }
});

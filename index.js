import express from "express";
import TelegramBot from "node-telegram-bot-api";

// ===============================
// CONFIG (mejor por ENV en Render)
// ===============================
const TOKEN =
  process.env.TELEGRAM_TOKEN ||
  "PONE_ACA_TU_TOKEN"; // <- ideal: en Render ENV

const BACKEND =
  process.env.GAS_BACKEND ||
  "PONE_ACA_TU_URL_DE_GAS"; // <- tu WebApp GAS /exec

const LOGO =
  process.env.LOGO_URL ||
  "https://i.postimg.cc/q7WvjsYm/20251206-210311.jpg";

const URL_BASE =
  process.env.URL_BASE ||
  "https://ezerbot-system.onrender.com"; // tu render URL

const PORT = Number(process.env.PORT || 10000);

// ===============================
// APP
// ===============================
const app = express();
app.use(express.json({ limit: "2mb" }));

// ===============================
// BOT (SIN webHook interno)
// ===============================
const bot = new TelegramBot(TOKEN, { polling: false });

// ===============================
// HELPERS
// ===============================
function mainMenuInline() {
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

// esto “intenta” borrar teclado viejo (reply keyboard) que haya quedado pegado
function removeOldKeyboard() {
  return { reply_markup: { remove_keyboard: true } };
}

async function GAS(action, params = {}) {
  const url = new URL(BACKEND);
  url.searchParams.set("accion", action);
  for (const k of Object.keys(params)) url.searchParams.set(k, params[k]);

  // Node 22: fetch nativo (NO node-fetch)
  const resp = await fetch(url.toString(), { method: "GET" });

  const text = await resp.text();

  // A veces GAS devuelve HTML (error). Lo detectamos.
  if (!text || text.trim().startsWith("<")) {
    throw new Error(
      `GAS no devolvió JSON. Primeros 120 chars: ${text.slice(0, 120)}`
    );
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(
      `No pude parsear JSON de GAS. Primeros 200 chars: ${text.slice(0, 200)}`
    );
  }
}

function safeCatName(c) {
  return (c || "").toString().trim() || "General";
}

function catEmoji(cat) {
  const t = cat.toLowerCase();
  if (t.includes("fiambre")) return "🥓";
  if (t.includes("láct") || t.includes("lact") || t.includes("leche")) return "📦";
  if (t.includes("pan") || t.includes("panif")) return "🥖";
  if (t.includes("promo") || t.includes("oferta")) return "🔥";
  if (t.includes("ques")) return "🧀";
  if (t.includes("beb")) return "🥤";
  return "🛍️";
}

function chunkPairs(arr) {
  // Botones en 2 columnas
  const rows = [];
  for (let i = 0; i < arr.length; i += 2) rows.push(arr.slice(i, i + 2));
  return rows;
}

// ===============================
// START / SALUDO
// ===============================
bot.onText(/\/start(\s+.*)?|hola|hola!|buenas/i, async (msg) => {
  const chatId = msg.chat.id;
  const nombre = msg.chat.first_name || "amigo";

  try {
    // 1) Intento borrar teclado viejo “pegado”
    await bot.sendMessage(chatId, "✅ Listo.", removeOldKeyboard());

    // 2) Presentación + menú inline (SOLO este menú)
    await bot.sendPhoto(chatId, LOGO, {
      caption:
        `Hola ${nombre} 👋\n` +
        `Soy el asistente de *TODO QUESO CLUB* 🧀\n\n` +
        `Desde acá podés:\n` +
        `• Ver el catálogo\n` +
        `• Armar tu pedido\n` +
        `• Sumar sellos\n` +
        `• Hablar con nosotros\n\n` +
        `👇 *Elegí una opción*`,
      parse_mode: "Markdown",
      ...mainMenuInline(),
    });
  } catch (e) {
    console.error("ERROR /start:", e);
    await bot.sendMessage(
      chatId,
      "⚠️ Tuve un problema iniciando. Probá de nuevo en 10 segundos."
    );
  }
});

// ===============================
// CALLBACKS
// ===============================
bot.on("callback_query", async (query) => {
  const chatId = query.message?.chat?.id;
  const data = query.data || "";

  // siempre respondo el callback para que Telegram no “cuelgue” el botón
  try {
    await bot.answerCallbackQuery(query.id);
  } catch (_) {}

  if (!chatId) return;

  try {
    if (data === "MENU") return mostrarMenu(chatId);
    if (data === "INFO") return infoLocal(chatId);
    if (data === "CATALOGO") return mostrarCategorias(chatId);
    if (data === "COMPARTIR") return compartirBot(chatId);
    if (data === "SELLOS") return mostrarSellos(chatId);
    if (data === "HABLAR") return hablarVendedor(chatId);
    if (data === "CARRITO") return verCarrito(chatId);

    if (data.startsWith("CAT_")) {
      const categoria = data.slice(4);
      return mostrarProductos(chatId, categoria, 0);
    }

    if (data.startsWith("PAGE_")) {
      const parts = data.split("_");
      // PAGE_{categoriaBase64}_{page}
      const page = Number(parts.at(-1));
      const catB64 = parts.slice(1, -1).join("_");
      const categoria = Buffer.from(catB64, "base64").toString("utf8");
      return mostrarProductos(chatId, categoria, page);
    }

    if (data.startsWith("SHARE_")) {
      const codigo = data.slice(6);
      return shareProducto(chatId, codigo);
    }

    // Si llega algo desconocido, vuelvo al menú
    return mostrarMenu(chatId);
  } catch (e) {
    console.error("ERROR callback:", data, e);
    await bot.sendMessage(chatId, "⚠️ Me trabé con esa acción. Tocá *Menú*.", {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "MENU" }]] },
    });
  }
});

// ===============================
// MENÚ (inline, limpio)
// ===============================
async function mostrarMenu(chatId) {
  await bot.sendMessage(chatId, "🏠 *Menú principal*:", {
    parse_mode: "Markdown",
    ...mainMenuInline(),
  });
}

// ===============================
// INFO LOCAL
// ===============================
async function infoLocal(chatId) {
  try {
    const cfg = await GAS("config");
    const msg =
      `🏪 *${cfg?.NegocioNombre || "Todo Queso"}*\n` +
      `📍 ${cfg?.Dirección || "-"}\n` +
      `🕒 ${cfg?.Horarios || "-"}\n` +
      `📞 ${cfg?.TeléfonoNegocio || "-"}\n` +
      `📸 Instagram: ${cfg?.Instagram || "-"}`;

    await bot.sendPhoto(chatId, LOGO, {
      caption: msg,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "MENU" }]] },
    });
  } catch (e) {
    console.error("ERROR infoLocal:", e);
    await bot.sendMessage(chatId, "⚠️ No pude leer la configuración del local.", {
      reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "MENU" }]] },
    });
  }
}

// ===============================
// HABLAR CON VENDEDOR
// ===============================
async function hablarVendedor(chatId) {
  try {
    const cfg = await GAS("config");
    const w = cfg?.WhatsAppLink || "https://wa.me/5490000000000";

    await bot.sendMessage(
      chatId,
      `💬 *¿Necesitás ayuda?*\nEscribinos por WhatsApp y te respondemos 😊`,
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
    console.error("ERROR hablarVendedor:", e);
    await bot.sendMessage(chatId, "⚠️ No pude cargar WhatsApp ahora.", {
      reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "MENU" }]] },
    });
  }
}

// ===============================
// COMPARTIR BOT
// ===============================
async function compartirBot(chatId) {
  const share = "https://t.me/Ezer_IA_Bot";

  await bot.sendMessage(
    chatId,
    `📣 *Compartí este bot*\nAsí tus contactos también ven promos y suman sellos.\n\n🔗 ${share}`,
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

// ===============================
// SELLOS
// ===============================
async function mostrarSellos(chatId) {
  try {
    const r = await GAS("estadoCliente", { chatId });

    if (!r?.tieneTarjeta) {
      return bot.sendMessage(
        chatId,
        "Todavía no tenés tarjeta 😊\nCuando hagas tu primera compra, se crea automáticamente.",
        { reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "MENU" }]] } }
      );
    }

    await bot.sendPhoto(chatId, r.tarjetaImagenUrl || LOGO, {
      caption: `🏆 *Tus sellos:* ${r.sellosTotalesAcumulados || 0}\n⭐ Nivel: ${r.nivelActual || "-"}`,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "MENU" }]] },
    });
  } catch (e) {
    console.error("ERROR sellos:", e);
    await bot.sendMessage(chatId, "⚠️ No pude leer tus sellos ahora.", {
      reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "MENU" }]] },
    });
  }
}

// ===============================
// CATÁLOGO: CATEGORÍAS (2 por fila)
// ===============================
async function mostrarCategorias(chatId) {
  try {
    const r = await GAS("catalogo");
    const items = Array.isArray(r?.items) ? r.items : [];

    if (!items.length) {
      return bot.sendMessage(chatId, "⚠️ No pude leer el catálogo (items vacío).", {
        reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "MENU" }]] },
      });
    }

    const categoriasUnicas = [...new Set(items.map((p) => safeCatName(p.categoria)))];

    const botones = categoriasUnicas.map((c) => ({
      text: `${catEmoji(c)} ${c}`,
      callback_data: "CAT_" + c,
    }));

    const rows = chunkPairs(botones);

    // agrego botón menú abajo
    rows.push([{ text: "🏠 Menú", callback_data: "MENU" }]);

    await bot.sendMessage(chatId, "📂 *Elegí una categoría:*", {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: rows },
    });
  } catch (e) {
    console.error("ERROR mostrarCategorias:", e);
    await bot.sendMessage(chatId, "⚠️ No pude leer el catálogo.", {
      reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "MENU" }]] },
    });
  }
}

// ===============================
// CATÁLOGO: PRODUCTOS PAGINADOS (3 por página)
// ===============================
async function mostrarProductos(chatId, categoria, page = 0) {
  try {
    const r = await GAS("catalogo");
    const itemsAll = Array.isArray(r?.items) ? r.items : [];

    const items = itemsAll.filter((p) => safeCatName(p.categoria) === safeCatName(categoria));

    const porPagina = 3;
    const totalPages = Math.max(1, Math.ceil(items.length / porPagina));
    const safePage = Math.min(Math.max(0, page), totalPages - 1);

    const inicio = safePage * porPagina;
    const lista = items.slice(inicio, inicio + porPagina);

    if (!lista.length) {
      return bot.sendMessage(chatId, "No hay productos en esta categoría.", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "📂 Volver a categorías", callback_data: "CATALOGO" }],
            [{ text: "🏠 Menú", callback_data: "MENU" }],
          ],
        },
      });
    }

    await bot.sendMessage(
      chatId,
      `🧾 *${categoria}* — Página ${safePage + 1}/${totalPages}`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📂 Volver a categorías", callback_data: "CATALOGO" }],
            [{ text: "🏠 Menú", callback_data: "MENU" }],
          ],
        },
      }
    );

    for (const p of lista) {
      const nombre = p.nombre || "Producto";
      const precio = p.precio || "";
      const desc = p.descripcion ? `\n${p.descripcion}` : "";
      const codigo = p.codigo || "";

      await bot.sendPhoto(chatId, p.imagenUrl || LOGO, {
        caption: `*${nombre}*\n💲 ${precio} ARS${desc}\n🆔 Código: *${codigo || "SIN"}*`,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📣 Compartir", callback_data: "SHARE_" + (codigo || nombre) }],
          ],
        },
      });
    }

    // paginación abajo (limpio)
    const catB64 = Buffer.from(String(categoria), "utf8").toString("base64");
    const nav = [];
    if (safePage > 0) nav.push({ text: "⬅️ Anterior", callback_data: `PAGE_${catB64}_${safePage - 1}` });
    if (safePage < totalPages - 1) nav.push({ text: "Siguiente ➡️", callback_data: `PAGE_${catB64}_${safePage + 1}` });

    const keyboard = [];
    if (nav.length) keyboard.push(nav);
    keyboard.push([{ text: "📂 Categorías", callback_data: "CATALOGO" }, { text: "🏠 Menú", callback_data: "MENU" }]);

    await bot.sendMessage(chatId, "Navegación:", { reply_markup: { inline_keyboard: keyboard } });
  } catch (e) {
    console.error("ERROR mostrarProductos:", e);
    await bot.sendMessage(chatId, "⚠️ No pude mostrar productos ahora.", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "📂 Categorías", callback_data: "CATALOGO" }],
          [{ text: "🏠 Menú", callback_data: "MENU" }],
        ],
      },
    });
  }
}

// ===============================
// SHARE PRODUCTO (solo sugerir dónde ir, sin sumar unidades)
// ===============================
async function shareProducto(chatId, codigo) {
  await bot.sendMessage(
    chatId,
    `📣 *Compartí esta promo*\nPasale el bot a alguien y decile qué producto querés:\n\n🆔 ${codigo}\n\n💡 Si querés, buscá *Panificados* o *Lácteos* para acompañar 😉`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🛍️ Ir al catálogo", callback_data: "CATALOGO" }],
          [{ text: "🏠 Menú", callback_data: "MENU" }],
        ],
      },
    }
  );
}

// ===============================
// CARRITO (mínimo, sin romper nada)
// ===============================
async function verCarrito(chatId) {
  await bot.sendMessage(
    chatId,
    "🛒 Tu carrito por ahora se arma desde el catálogo (en esta etapa lo estamos dejando simple para que no se rompa).\n\nTocá *Catálogo* para seguir viendo productos.",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🛍️ Catálogo", callback_data: "CATALOGO" }],
          [{ text: "🏠 Menú", callback_data: "MENU" }],
        ],
      },
    }
  );
}

// ===============================
// WEBHOOK ROUTE
// ===============================
app.post("/webhook", (req, res) => {
  try {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (e) {
    console.error("ERROR processUpdate:", e);
    res.sendStatus(500);
  }
});

// health
app.get("/", (_, res) => res.status(200).send({ ok: true, service: "EzerBot", status: "running" }));

// debug real (para que NO diga Cannot GET /debug)
app.get("/debug", async (_, res) => {
  try {
    const info = await bot.getWebhookInfo();
    let catalogoOk = false;
    let catalogoCount = 0;

    try {
      const r = await GAS("catalogo");
      const items = Array.isArray(r?.items) ? r.items : [];
      catalogoOk = items.length > 0;
      catalogoCount = items.length;
    } catch (e) {
      catalogoOk = false;
    }

    res.status(200).send({
      ok: true,
      webhook: info,
      url_base: URL_BASE,
      webhook_should_be: `${URL_BASE}/webhook`,
      catalogoOk,
      catalogoCount,
      node: process.version,
    });
  } catch (e) {
    res.status(500).send({ ok: false, error: String(e?.message || e) });
  }
});

// ===============================
// START SERVER + SET WEBHOOK
// ===============================
app.listen(PORT, async () => {
  console.log("Servidor activo en puerto", PORT);

  const hookUrl = `${URL_BASE}/webhook`;

  try {
    await bot.setWebHook(hookUrl);
    const info = await bot.getWebhookInfo();
    console.log("Webhook seteado:", hookUrl);
    console.log("Webhook info:", info);
  } catch (e) {
    console.error("ERROR setWebHook:", e);
  }
});

// logs útiles
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

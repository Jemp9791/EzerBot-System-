import express from "express";
import TelegramBot from "node-telegram-bot-api";

// ===============================
// CONFIG
// ===============================
const TOKEN = "8130447159:AAHxzp5S1lcgYOemw5dgF5V1DGh141dHmkA";
const BACKEND =
  "https://script.google.com/macros/s/AKfycbxznmXVhDFd45kwrtsO0lORoGDn7AcHVdQIYQkgYy_63jaJCrjumzphVK_N39T_zjK_/exec";
const LOGO = "https://i.postimg.cc/q7WvjsYm/20251206-210311.jpg";
const URL_BASE = "https://ezerbot-system.onrender.com";

const PORT = Number(process.env.PORT || 10000);

// ===============================
// EXPRESS
// ===============================
const app = express();
app.use(express.json());

// ===============================
// TELEGRAM BOT (Webhook manejado por Express)
// ===============================
const bot = new TelegramBot(TOKEN);
bot.setWebHook(`${URL_BASE}/webhook`);

// ===============================
// UTILIDAD REQUEST AL BACKEND GAS
// ===============================
async function GAS(action, params = {}) {
  const url = new URL(BACKEND);
  url.searchParams.append("accion", action);
  for (const k in params) url.searchParams.append(k, String(params[k]));

  const r = await fetch(url.toString(), { method: "GET" });
  const j = await r.json().catch(() => ({}));
  return j || {};
}

function safe(v, fallback = "No configurado") {
  return (v === undefined || v === null || String(v).trim() === "") ? fallback : String(v);
}

function getCatalogItems(r) {
  // soporta diferentes nombres de payload
  return (
    r.items ||
    r.products ||
    r.productos ||
    r.data ||
    []
  );
}

// ===============================
// PRESENTACIÓN / START
// ===============================
bot.onText(/\/start|hola|hola!|buenas/i, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const nombre = msg.chat.first_name || "amigo";

    const cfg = await GAS("config");
    const negocio = safe(cfg.NegocioNombre, "Todo Queso");

    const menu = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🛍️ Catálogo", callback_data: "CATALOGO" },
            { text: "🛒 Mi carrito", callback_data: "CARRITO" }
          ],
          [
            { text: "🎁 Mis sellos", callback_data: "SELLOS" },
            { text: "💬 Hablar", callback_data: "HABLAR" }
          ],
          [
            { text: "🏪 Info del local", callback_data: "INFO" },
            { text: "📣 Compartir", callback_data: "COMPARTIR" }
          ]
        ]
      }
    };

    await bot.sendPhoto(chatId, LOGO, {
      caption:
        `*${negocio}*\n` +
        `Productos frescos, promos y beneficios exclusivos.\n\n` +
        `Hola ${nombre} 👋\n` +
        `Soy el asistente de *${negocio}*.\n` +
        `Desde acá podés ver el catálogo, armar tu pedido, sumar sellos y hablar con el vendedor.\n\n` +
        `👇 Elegí una opción para empezar`,
      parse_mode: "Markdown"
    });

    await bot.sendMessage(chatId, " ", menu);
  } catch (e) {
    console.error("Error en start:", e);
  }
});

// ===============================
// BOTONES PRINCIPALES
// ===============================
bot.on("callback_query", async (query) => {
  const chatId = query.message?.chat?.id;
  const data = query.data || "";

  if (!chatId) return;

  try {
    // evita el "loading..." infinito en Telegram
    await bot.answerCallbackQuery(query.id).catch(() => {});
  } catch {}

  try {
    if (data === "INFO") return infoLocal(chatId);
    if (data === "CATALOGO") return mostrarCategorias(chatId);
    if (data === "COMPARTIR") return compartirBot(chatId);
    if (data === "SELLOS") return mostrarSellos(chatId);
    if (data === "HABLAR") return hablarVendedor(chatId);

    // si todavía no implementaste carrito en este index, no rompe:
    if (data === "CARRITO") {
      return bot.sendMessage(chatId, "🧺 Tu carrito se maneja desde el flujo de compra. (Si querés, lo integramos después).");
    }

    if (data === "COPIAR_LINK") {
      const cfg = await GAS("config");
      const negocio = safe(cfg.NegocioNombre, "Todo Queso");
      const share = `https://t.me/Ezer_IA_Bot`;
      return bot.sendMessage(
        chatId,
        `📌 Copiá y pegá este link:\n${share}\n\n💛 ${negocio} — promos y beneficios.`,
      );
    }

    // categoría
    if (data.startsWith("CAT_")) {
      const categoria = data.replace("CAT_", "");
      return mostrarProductos(chatId, categoria, 0);
    }

    // paginación
    if (data.startsWith("PAGE_")) {
      const [_, categoria, page] = data.split("_");
      return mostrarProductos(chatId, categoria, Number(page || 0));
    }

    // placeholders para no romper si apretás comprar/compartir promo
    if (data.startsWith("BUY_")) {
      return bot.sendMessage(chatId, "🛒 OK. Compra por este botón la conectamos en el próximo paso (no rompe nada).");
    }
    if (data.startsWith("SHARE_")) {
      return bot.sendMessage(chatId, "📣 Promo lista para compartir (lo dejamos para el próximo paso).");
    }

  } catch (e) {
    console.error("callback_query error:", e);
    return bot.sendMessage(chatId, "Ups, hubo un error. Probá de nuevo 🙏");
  }
});

// ===============================
// INFO DEL LOCAL
// ===============================
async function infoLocal(chatId) {
  const cfg = await GAS("config");
  const negocio = safe(cfg.NegocioNombre, "Tu tienda");

  const msg =
`🏪 *${negocio}*
📍 Dirección: ${safe(cfg.Dirección)}
🕒 Horarios: ${safe(cfg.Horarios)}
📞 Teléfono: ${safe(cfg.TeléfonoNegocio)}
📸 Instagram: ${safe(cfg.Instagram)}`;

  await bot.sendPhoto(chatId, LOGO, { caption: msg, parse_mode: "Markdown" });
}

// ===============================
// HABLAR CON VENDEDOR
// ===============================
async function hablarVendedor(chatId) {
  const cfg = await GAS("config");
  const w = safe(cfg.WhatsAppLink, "https://wa.me/5491122538102");

  await bot.sendMessage(chatId,
`💬 *¿Te ayudo con algo?*
Escribime por WhatsApp y te respondo como si estuvieras en el mostrador 👇`,
{
  parse_mode: "Markdown",
  reply_markup: { inline_keyboard: [[{ text: "📞 Abrir WhatsApp", url: w }]] }
});
}

// ===============================
// COMPARTIR BOT
// ===============================
async function compartirBot(chatId) {
  const cfg = await GAS("config");
  const negocio = safe(cfg.NegocioNombre, "Tu tienda");

  const share = `https://t.me/Ezer_IA_Bot`;

  await bot.sendMessage(chatId,
`📣 *Compartí este bot*
Invitá a tus contactos a comprar en *${negocio}* y aprovechar promos.

🔗 Link del bot:
${share}

👇 Elegí una opción:`,
{
  parse_mode: "Markdown",
  reply_markup: {
    inline_keyboard: [
      [
        { text: "🔗 Abrir en Telegram", url: share },
        { text: "📋 Copiar link", callback_data: "COPIAR_LINK" }
      ]
    ]
  }
});
}

// ===============================
// MOSTRAR CATEGORÍAS
// ===============================
async function mostrarCategorias(chatId) {
  const r = await GAS("catalogo");
  const items = getCatalogItems(r);

  if (!Array.isArray(items) || items.length === 0) {
    return bot.sendMessage(chatId, "📦 Todavía no hay productos cargados en el catálogo.");
  }

  const categorias = [...new Set(items.map(p => safe(p.categoria, "General")))];
  // emojis más “lindos” y grandes por categoría (fallback 📦)
  const emojiPorCat = (c) => {
    const x = String(c).toLowerCase();
    if (x.includes("ques")) return "🧀";
    if (x.includes("fiam") || x.includes("jam") || x.includes("sal")) return "🥓";
    if (x.includes("pan")) return "🥖";
    if (x.includes("lact")) return "🥛";
    if (x.includes("promo")) return "🔥";
    if (x.includes("dulc") || x.includes("post")) return "🍬";
    return "📦";
  };

  // 2 columnas (2 botones por fila)
  const rows = [];
  for (let i = 0; i < categorias.length; i += 2) {
    const c1 = categorias[i];
    const c2 = categorias[i + 1];
    const row = [
      { text: `${emojiPorCat(c1)} ${c1}`, callback_data: "CAT_" + c1 }
    ];
    if (c2) row.push({ text: `${emojiPorCat(c2)} ${c2}`, callback_data: "CAT_" + c2 });
    rows.push(row);
  }

  await bot.sendMessage(chatId, "📂 *Elegí una categoría:*", {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: rows }
  });
}

// ===============================
// MOSTRAR PRODUCTOS POR CATEGORÍA (3 por página)
// ===============================
async function mostrarProductos(chatId, categoria, page = 0) {
  const r = await GAS("catalogo");
  const all = getCatalogItems(r);

  const items = (Array.isArray(all) ? all : []).filter(
    (p) => safe(p.categoria, "General") === categoria
  );

  const porPagina = 3;
  const inicio = page * porPagina;
  const lista = items.slice(inicio, inicio + porPagina);

  if (lista.length === 0) {
    return bot.sendMessage(chatId, "No hay productos en esta categoría.");
  }

  for (const p of lista) {
    const nombre = safe(p.nombre, "Producto");
    const desc = safe(p.descripcion, "");
    const precio = safe(p.precio, "-");
    const codigo = safe(p.codigo, "SIN-CODIGO");
    const img = safe(p.imagenUrl, LOGO);

    await bot.sendPhoto(chatId, img, {
      caption:
`*${nombre}*
${desc ? desc + "\n" : ""}💲 ${precio} ARS
🆔 Código: *${codigo}*`,
      parse_mode: "Markdown",
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

  // paginación (1 fila)
  const nav = [];
  if (inicio > 0) nav.push({ text: "⬅️ Anterior", callback_data: `PAGE_${categoria}_${page - 1}` });
  if (inicio + porPagina < items.length) nav.push({ text: "Siguiente ➡️", callback_data: `PAGE_${categoria}_${page + 1}` });

  if (nav.length) {
    await bot.sendMessage(chatId, "📌 Navegación:", {
      reply_markup: { inline_keyboard: [nav] }
    });
  }
}

// ===============================
// MOSTRAR SELLOS
// ===============================
async function mostrarSellos(chatId) {
  const r = await GAS("estadoCliente", { chatId });

  if (!r || !r.tieneTarjeta) {
    return bot.sendMessage(
      chatId,
      "🎁 Este comercio todavía no activó los sellos o todavía no tenés tarjeta.\nComprando obtenés tu primera tarjeta automática 😄"
    );
  }

  await bot.sendPhoto(chatId, safe(r.tarjetaImagenUrl, LOGO), {
    caption: `🎉 *Tus sellos:* ${safe(r.sellosTotalesAcumulados, "0")}\n⭐ Nivel: ${safe(r.nivelActual, "—")}`,
    parse_mode: "Markdown"
  });
}

// ===============================
// WEBHOOK (Express recibe y pasa a Telegram)
// ===============================
app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (_, res) => res.send({ ok: true, msg: "EzerBot corriendo" }));

app.listen(PORT, () => console.log("Servidor activo en puerto", PORT));

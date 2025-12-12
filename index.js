import express from "express";
import TelegramBot from "node-telegram-bot-api";
import fetch from "node-fetch";

const TOKEN = "8130447159:AAHxzp5S1lcgYOemw5dgF5V1DGh141dHmkA";
const BACKEND = "https://script.google.com/macros/s/AKfycbxznmXVhDFd45kwrtsO0lORoGDn7AcHVdQIYQkgYy_63jaJCrjumzphVK_N39T_zjK_/exec";
const LOGO = "https://i.postimg.cc/q7WvjsYm/20251206-210311.jpg";
const URL_BASE = "https://ezerbot-system.onrender.com";

const app = express();
app.use(express.json());

const bot = new TelegramBot(TOKEN, { webHook: { port: process.env.PORT || 10000 } });
bot.setWebHook(`${URL_BASE}/webhook`);

// ===============================
// UTILIDAD REQUEST AL BACKEND GAS
// ===============================
async function GAS(action, params = {}) {
  const url = new URL(BACKEND);
  url.searchParams.append("accion", action);
  for (const k in params) url.searchParams.append(k, params[k]);

  const r = await fetch(url);
  return r.json();
}

// ===============================
// PRESENTACIÓN / START
// ===============================
bot.onText(/\/start|hola|hola!|buenas/i, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const nombre = msg.chat.first_name || "amigo";

    const menu = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🛒 Catálogo", callback_data: "CATALOGO" }],
          [{ text: "🎁 Mis sellos", callback_data: "SELLOS" }],
          [{ text: "📞 Hablar con el vendedor", callback_data: "HABLAR" }],
          [{ text: "📣 Compartir bot", callback_data: "COMPARTIR" }],
          [{ text: "ℹ️ Info del local", callback_data: "INFO" }]
        ]
      }
    };

    await bot.sendPhoto(chatId, LOGO, { caption: `¡Hola ${nombre}! 👋\nSoy tu asistente de *Todo Queso* 😄\nElegí una opción:` , parse_mode : "Markdown"});
    await bot.sendMessage(chatId, "👇 *Elegí una opción para comenzar:*", { parse_mode: "Markdown", ...menu });

  } catch (e) { console.error("Error en start:", e); }
});

// ===============================
// BOTONES PRINCIPALES
// ===============================
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data === "INFO") return infoLocal(chatId);
  if (data === "CATALOGO") return mostrarCategorias(chatId);
  if (data === "COMPARTIR") return compartirBot(chatId);
  if (data === "SELLOS") return mostrarSellos(chatId);
  if (data === "HABLAR") return hablarVendedor(chatId);

  // categoría seleccionada
  if (data.startsWith("CAT_")) {
    const categoria = data.replace("CAT_", "");
    return mostrarProductos(chatId, categoria, 0);
  }

  // paginación
  if (data.startsWith("PAGE_")) {
    const [_, categoria, page] = data.split("_");
    return mostrarProductos(chatId, categoria, Number(page));
  }

});

// ===============================
// INFO DEL LOCAL
// ===============================
async function infoLocal(chatId) {
  const cfg = await GAS("config");
  const msg =
`🏪 *${cfg.NegocioNombre}*
📍 ${cfg.Dirección}
🕒 ${cfg.Horarios}
📞 ${cfg.TeléfonoNegocio}
📸 Instagram: ${cfg.Instagram}`;

  await bot.sendPhoto(chatId, LOGO, { caption: msg, parse_mode: "Markdown" });
}

// ===============================
// HABLAR CON VENDEDOR
// ===============================
async function hablarVendedor(chatId) {
  const cfg = await GAS("config");
  const w = cfg.WhatsAppLink || "https://wa.me/5493484230184";

  await bot.sendMessage(chatId,
`💬 *¿Necesitás ayuda real?*
Hablá con nosotros por WhatsApp 👇`,
{ parse_mode: "Markdown",
  reply_markup: { inline_keyboard: [[{ text: "📞 Abrir WhatsApp", url: w }]] }
});
}

// ===============================
// COMPARTIR BOT
// ===============================
async function compartirBot(chatId) {
  const share = `https://t.me/Ezer_IA_Bot`;

  await bot.sendMessage(chatId,
`📣 *Compartí este bot con tus amigos*
¡Sumás sellos cada vez que ellos compran!

👇 Elegí dónde compartir:`,
{ parse_mode: "Markdown",
  reply_markup: {
    inline_keyboard: [
      [{ text: "🔗 Compartir en Telegram", url: share }],
      [{ text: "📤 Copiar enlace", callback_data: "COPIAR_LINK" }]
    ]
  }
});
}

// ===============================
// MOSTRAR CATEGORÍAS
// ===============================
async function mostrarCategorias(chatId) {
  const r = await GAS("catalogo");
  const items = r.items || [];

  const categorias = [...new Set(items.map(p => p.categoria || "General"))];

  const botones = categorias.map(c => [{ text: `📦 ${c}`, callback_data: "CAT_" + c }]);

  await bot.sendMessage(chatId, "📂 *Elegí una categoría:*", {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: botones }
  });
}

// ===============================
// MOSTRAR PRODUCTOS POR CATEGORÍA
// ===============================
async function mostrarProductos(chatId, categoria, page = 0) {
  const r = await GAS("catalogo");
  const items = (r.items || []).filter(p => (p.categoria || "General") === categoria);

  const porPagina = 3;
  const inicio = page * porPagina;
  const lista = items.slice(inicio, inicio + porPagina);

  if (lista.length === 0) return bot.sendMessage(chatId, "No hay productos en esta categoría.");

  for (const p of lista) {
    await bot.sendPhoto(chatId, p.imagenUrl, {
      caption:
`*${p.nombre}*
${p.descripcion}
💲 ${p.precio} ARS
🆔 Código: *${p.codigo || "SIN-CODIGO"}*`,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🛒 Comprar", callback_data: "BUY_" + p.codigo }],
          [{ text: "📣 Compartir promo", callback_data: "SHARE_" + p.codigo }]
        ]
      }
    });
  }

  // paginación
  const botones = [];
  if (inicio > 0) botones.push({ text: "⬅️ Anterior", callback_data: `PAGE_${categoria}_${page - 1}`});
  if (inicio + porPagina < items.length) botones.push({ text: "Siguiente ➡️", callback_data: `PAGE_${categoria}_${page + 1}`});

  if (botones.length)
    await bot.sendMessage(chatId, "Navegación:", {
      reply_markup: { inline_keyboard: [botones] }
    });
}

// ===============================
// MOSTRAR SELLOS
// ===============================
async function mostrarSellos(chatId) {
  const r = await GAS("estadoCliente", { chatId });

  if (!r.tieneTarjeta) return bot.sendMessage(chatId, "Todavía no tenés tarjeta. Comprando obtenés tu primera tarjeta automática 😄");

  await bot.sendPhoto(chatId, r.tarjetaImagenUrl || LOGO,
    { caption: `🎉 *Tus sellos:* ${r.sellosTotalesAcumulados}\nNivel: ${r.nivelActual}`, parse_mode: "Markdown" });
}

// ===============================
// EXPRESS WEBHOOK
// ===============================
app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (_, res) => res.send({ ok: true, msg: "EzerBot corriendo" }));

app.listen(process.env.PORT || 10000, () => {
  console.log("Servidor activo");
});

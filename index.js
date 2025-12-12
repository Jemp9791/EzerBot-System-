import express from "express";
import TelegramBot from "node-telegram-bot-api";
import fetch from "node-fetch";

const TOKEN = process.env.TOKEN;
const BACKEND = process.env.BACKEND;
const LOGO = process.env.LOGO;
const URL_BASE = process.env.URL_BASE;

const app = express();
app.use(express.json());

const bot = new TelegramBot(TOKEN);
bot.setWebHook(`${URL_BASE}/webhook`);

// =======================
// UTIL GAS
// =======================
async function GAS(action, params = {}) {
  const url = new URL(BACKEND);
  url.searchParams.append("accion", action);
  for (const k in params) url.searchParams.append(k, params[k]);
  const r = await fetch(url);
  return r.json();
}

// =======================
// START
// =======================
bot.onText(/\/start|hola/i, async (msg) => {
  const chatId = msg.chat.id;
  const nombre = msg.chat.first_name || "amigo";

  // 🔴 BORRA CUALQUIER TECLADO VIEJO
  await bot.sendMessage(chatId, " ", {
    reply_markup: { remove_keyboard: true }
  });

  await bot.sendPhoto(chatId, LOGO, {
    caption:
`Hola ${nombre} 👋  
Soy el asistente de *TODO QUESO CLUB* 🧀  

Desde acá podés:
• Ver el catálogo  
• Armar tu pedido  
• Sumar sellos  
• Hablar con nosotros  

👇 Elegí una opción`,
    parse_mode: "Markdown"
  });

  await menuPrincipal(chatId);
});

// =======================
// MENÚ PRINCIPAL
// =======================
async function menuPrincipal(chatId) {
  await bot.sendMessage(chatId, "🧾 *Menú principal*", {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🛍️ Catálogo", callback_data: "CATALOGO" },
          { text: "🛒 Mi carrito", callback_data: "CARRITO" }
        ],
        [{ text: "🏆 Mis sellos", callback_data: "SELLOS" }],
        [{ text: "💬 Hablar con el vendedor", callback_data: "HABLAR" }],
        [
          { text: "ℹ️ Info del local", callback_data: "INFO" },
          { text: "📣 Compartir bot", callback_data: "COMPARTIR" }
        ]
      ]
    }
  });
}

// =======================
// CALLBACKS
// =======================
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const data = q.data;

  if (data === "MENU") return menuPrincipal(chatId);
  if (data === "CATALOGO") return mostrarCategorias(chatId);
  if (data === "INFO") return infoLocal(chatId);
  if (data === "COMPARTIR") return compartirBot(chatId);
  if (data === "HABLAR") return hablarVendedor(chatId);
  if (data === "SELLOS") return mostrarSellos(chatId);

  if (data.startsWith("CAT_")) {
    return mostrarProductos(chatId, data.replace("CAT_", ""), 0);
  }

  if (data.startsWith("PAGE_")) {
    const [_, cat, page] = data.split("_");
    return mostrarProductos(chatId, cat, Number(page));
  }
});

// =======================
// CATEGORÍAS
// =======================
async function mostrarCategorias(chatId) {
  const r = await GAS("catalogo");

  if (!r.items || !Array.isArray(r.items)) {
    return bot.sendMessage(chatId, "⚠️ No pude leer el catálogo.");
  }

  const categorias = [...new Set(r.items.map(i => i.categoria || "General"))];

  const botones = categorias.map(c => [
    { text: `📦 ${c}`, callback_data: `CAT_${c}` }
  ]);

  botones.push([{ text: "⬅️ Volver al menú", callback_data: "MENU" }]);

  await bot.sendMessage(chatId, "📂 *Elegí una categoría*", {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: botones }
  });
}

// =======================
// PRODUCTOS (PAGINADO)
// =======================
async function mostrarProductos(chatId, categoria, page) {
  const r = await GAS("catalogo");
  const items = r.items.filter(i => (i.categoria || "General") === categoria);

  const porPagina = 3;
  const start = page * porPagina;
  const slice = items.slice(start, start + porPagina);

  for (const p of slice) {
    await bot.sendPhoto(chatId, p.imagenUrl, {
      caption:
`*${p.nombre}*  
${p.descripcion}  
💰 ${p.precio} ARS`,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🛒 Comprar", callback_data: `BUY_${p.codigo}` }],
          [{ text: "⬅️ Volver", callback_data: "CATALOGO" }]
        ]
      }
    });
  }

  const nav = [];
  if (start > 0) nav.push({ text: "⬅️ Anterior", callback_data: `PAGE_${categoria}_${page - 1}` });
  if (start + porPagina < items.length) nav.push({ text: "Siguiente ➡️", callback_data: `PAGE_${categoria}_${page + 1}` });

  if (nav.length) {
    await bot.sendMessage(chatId, "📑 Navegación", {
      reply_markup: { inline_keyboard: [nav] }
    });
  }
}

// =======================
// OTROS
// =======================
async function infoLocal(chatId) {
  const c = await GAS("config");
  await bot.sendMessage(chatId,
`🏪 *${c.NegocioNombre}*
📍 ${c.Dirección}
🕒 ${c.Horarios}`,
{ parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "⬅️ Menú", callback_data: "MENU" }]] }});
}

async function hablarVendedor(chatId) {
  const c = await GAS("config");
  await bot.sendMessage(chatId, "💬 Hablá con nosotros:", {
    reply_markup: { inline_keyboard: [[{ text: "📲 WhatsApp", url: c.WhatsAppLink }]] }
  });
}

async function compartirBot(chatId) {
  await bot.sendMessage(chatId, "📣 Compartí el bot:", {
    reply_markup: { inline_keyboard: [[{ text: "🔗 Abrir bot", url: "https://t.me/Ezer_IA_Bot" }]] }
  });
}

async function mostrarSellos(chatId) {
  const r = await GAS("estadoCliente", { chatId });
  await bot.sendMessage(chatId, `🏆 Sellos: ${r.sellosTotales || 0}`);
}

// =======================
// EXPRESS
// =======================
app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (_, res) => res.send("EzerBot OK"));

app.listen(process.env.PORT || 10000);

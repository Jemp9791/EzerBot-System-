import express from "express";
import TelegramBot from "node-telegram-bot-api";

const TOKEN = "8130447159:AAHxzp5S1lcgYOemw5dgF5V1DGh141dHmkA";
const BACKEND = "https://script.google.com/macros/s/AKfycbxznmXVhDFd45kwrtsO0lORoGDn7AcHVdQIYQkgYy_63jaJCrjumzphVK_N39T_zjK_/exec";
const LOGO = "https://i.postimg.cc/q7WvjsYm/20251206-210311.jpg";
const URL_BASE = process.env.PUBLIC_URL || "https://ezerbot-system.onrender.com";

const app = express();
app.use(express.json());

const bot = new TelegramBot(TOKEN);
bot.setWebHook(`${URL_BASE}/webhook`);

// ===============================
// UTILIDAD GAS
// ===============================
async function GAS(action, params = {}) {
  const url = new URL(BACKEND);
  url.searchParams.append("accion", action);
  for (const k in params) url.searchParams.append(k, params[k]);

  const r = await fetch(url);
  return r.json();
}

// ===============================
// START
// ===============================
bot.onText(/\/start|hola|buenas/i, async (msg) => {
  const chatId = msg.chat.id;
  const nombre = msg.chat.first_name || "amigo";

  await bot.sendPhoto(chatId, LOGO, {
    caption: `¡Hola ${nombre}! 👋\nSoy tu asistente de *Todo Queso* 🧀`,
    parse_mode: "Markdown"
  });

  await bot.sendMessage(chatId, "¿Qué te llevo hoy?", {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🛍 Catálogo", callback_data: "CATALOGO" },
          { text: "🛒 Mi carrito", callback_data: "CARRITO" }
        ],
        [
          { text: "🏆 Mis sellos", callback_data: "SELLOS" }
        ],
        [
          { text: "💬 Hablar con el vendedor", callback_data: "HABLAR" }
        ],
        [
          { text: "ℹ️ Info del local", callback_data: "INFO" },
          { text: "📣 Compartir bot", callback_data: "COMPARTIR" }
        ]
      ]
    }
  });
});

// ===============================
// CALLBACKS
// ===============================
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const d = q.data;

  if (d === "CATALOGO") return mostrarCategorias(chatId);
  if (d === "INFO") return infoLocal(chatId);
  if (d === "HABLAR") return hablarVendedor(chatId);
  if (d === "SELLOS") return mostrarSellos(chatId);
  if (d === "COMPARTIR") return compartirBot(chatId);

  if (d.startsWith("CAT_")) {
    return mostrarProductos(chatId, d.replace("CAT_", ""), 0);
  }

  if (d.startsWith("PAGE_")) {
    const [, cat, p] = d.split("_");
    return mostrarProductos(chatId, cat, Number(p));
  }
});

// ===============================
// FUNCIONES
// ===============================
async function mostrarCategorias(chatId) {
  const r = await GAS("catalogo");

if (!r || !Array.isArray(r.items)) {
  return bot.sendMessage(chatId, "⚠️ No pude cargar los productos. Intentá nuevamente.");
}

const items = r.items.filter(
  p => (p.categoria || "General") === categoria
);
  }

  const categorias = [
    ...new Set(r.items.map(p => p.categoria || "General"))
  ];

  await bot.sendMessage(chatId, "📦 Elegí una categoría:", {
    reply_markup: {
      inline_keyboard: categorias.map(c => [
        { text: `📂 ${c}`, callback_data: "CAT_" + c }
      ])
    }
  });
}


async function mostrarProductos(chatId, categoria, page) {
  const r = await GAS("catalogo");
  const items = r.items.filter(i => (i.categoria || "General") === categoria);

  const porPagina = 3;
  const slice = items.slice(page * porPagina, page * porPagina + porPagina);

  for (const p of slice) {
    await bot.sendPhoto(chatId, p.imagenUrl, {
      caption: `*${p.nombre}*\n${p.descripcion}\n💲 ${p.precio}`,
      parse_mode: "Markdown"
    });

    // 🔥 SUGERENCIA VENDEDOR
    if (categoria.toLowerCase().includes("queso")) {
      await bot.sendMessage(chatId,
        "💡 Tip del vendedor: este queso va genial con pan fresco o dulce de batata 😋"
      );
    }
  }

  const nav = [];
  if (page > 0) nav.push({ text: "⬅️", callback_data: `PAGE_${categoria}_${page - 1}` });
  if ((page + 1) * porPagina < items.length) nav.push({ text: "➡️", callback_data: `PAGE_${categoria}_${page + 1}` });

  if (nav.length) {
    await bot.sendMessage(chatId, "Más productos:", {
      reply_markup: { inline_keyboard: [nav] }
    });
  }
}

async function infoLocal(chatId) {
  const c = await GAS("config");
  await bot.sendMessage(chatId,
    `🏪 *${c.NegocioNombre}*\n📍 ${c.Dirección}\n🕒 ${c.Horarios}`,
    { parse_mode: "Markdown" }
  );
}

async function hablarVendedor(chatId) {
  const c = await GAS("config");
  await bot.sendMessage(chatId,
    "💬 Te atiendo por WhatsApp 👇",
    { reply_markup: { inline_keyboard: [[{ text: "Abrir WhatsApp", url: c.WhatsAppLink }]] } }
  );
}

async function mostrarSellos(chatId) {
  const r = await GAS("estadoCliente", { chatId });
  await bot.sendMessage(chatId,
    `🏆 Sellos: ${r.sellosTotalesAcumulados || 0}`
  );
}

async function compartirBot(chatId) {
  await bot.sendMessage(chatId,
    "📣 Compartí Todo Queso:",
    { reply_markup: { inline_keyboard: [[{ text: "Compartir", url: "https://t.me/Ezer_IA_Bot" }]] } }
  );
}

// ===============================
// WEBHOOK
// ===============================
app.post("/webhook", (req, res) => {
  console.log("📩 Update recibido");
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (_, res) => res.send({ ok: true, msg: "EzerBot backend activo" }));

app.listen(process.env.PORT || 10000, () =>
  console.log("🚀 Servidor activo")
);

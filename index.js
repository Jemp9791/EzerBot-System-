import express from "express";
import fetch from "node-fetch";
import TelegramBot from "node-telegram-bot-api";

/* ================== ENV ================== */
const TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // https://xxx.onrender.com/webhook
const GAS_URL = process.env.GAS_URL; // tu endpoint GAS

if (!TOKEN) throw new Error("Falta BOT_TOKEN");
if (!WEBHOOK_URL) throw new Error("Falta WEBHOOK_URL");
if (!GAS_URL) throw new Error("Falta GAS_URL");

/* ================== BOT ================== */
const bot = new TelegramBot(TOKEN, { webHook: true });
bot.setWebHook(`${WEBHOOK_URL}/webhook`);

const app = express();
app.use(express.json());

app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (_, res) => res.send("EzerBot OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server up", PORT));

/* ================== STATE ================== */
const userState = new Map();

/* ================== HELPERS ================== */
function escapeMD(text) {
  return String(text || "")
    .replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

async function getCatalog() {
  const r = await fetch(GAS_URL);
  const data = await r.json();

  if (!data || data.ok !== true || !Array.isArray(data.productos)) {
    return [];
  }

  return data.productos.map(p => ({
    codigo: p.codigo,
    nombre: p.nombre,
    precio: p.precio,
    unidad: p.unidad,
    precioporkg: p.precioporkg,
    descripcion: p.descripcion,
    imagen: p.imagen,
    categoria: p.categoria || "General"
  }));
}

function groupByCategory(products) {
  const map = {};
  products.forEach(p => {
    if (!map[p.categoria]) map[p.categoria] = [];
    map[p.categoria].push(p);
  });
  return map;
}

/* ================== UI BUILDERS ================== */
function mainMenu(chatId, name) {
  bot.sendMessage(
    chatId,
    `Hola ${escapeMD(name)} 👋\n\nSoy el asistente de *TODO QUESO CLUB* 🧀\n\n👇 Elegí una opción`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        keyboard: [
          ["🛍 Catálogo", "🛒 Mi carrito"],
          ["🎁 Mis sellos"],
          ["💬 Hablar con el vendedor"],
          ["🏪 Información del local", "📣 Compartir el bot"]
        ],
        resize_keyboard: true
      }
    }
  );
}

function categoryKeyboard(categories) {
  return {
    reply_markup: {
      inline_keyboard: [
        ...categories.map(c => [{ text: c, callback_data: `cat:${c}` }])
      ]
    }
  };
}

function productMessage(p, index, total) {
  return {
    photo: p.imagen,
    caption:
`🧀 *${escapeMD(p.nombre)}*

💲 Precio: $${p.precio} ARS
🏷 Código: ${escapeMD(p.codigo)}

${p.descripcion ? "📝 " + escapeMD(p.descripcion) : ""}

📦 ${index + 1} / ${total}`,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Quiero este", callback_data: `want:${p.codigo}` },
          { text: "📣 Compartir promo", callback_data: `share:${p.codigo}` }
        ],
        [
          { text: "↩ Volver a categoría", callback_data: `back_cat:${p.categoria}` }
        ],
        [
          { text: "⬅ Anterior", callback_data: "prev" },
          { text: "📂 Categorías", callback_data: "cats" },
          { text: "➡ Siguiente", callback_data: "next" }
        ]
      ]
    }
  };
}

/* ================== HANDLERS ================== */
bot.on("message", async msg => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const name = msg.from.first_name || "👋";

  if (text === "/start") {
    mainMenu(chatId, name);
    return;
  }

  if (text === "🛍 Catálogo") {
    const products = await getCatalog();
    if (!products.length) {
      bot.sendMessage(chatId, "⚠️ No hay productos cargados todavía.");
      return;
    }

    const byCat = groupByCategory(products);
    userState.set(chatId, { products, byCat });

    bot.sendMessage(chatId, "📂 Elegí una categoría:", categoryKeyboard(Object.keys(byCat)));
  }
});

/* ================== CALLBACKS ================== */
bot.on("callback_query", async q => {
  const chatId = q.message.chat.id;
  const data = q.data;
  const state = userState.get(chatId);

  if (!state) return bot.answerCallbackQuery(q.id);

  if (data === "cats") {
    bot.sendMessage(chatId, "📂 Categorías:", categoryKeyboard(Object.keys(state.byCat)));
    return bot.answerCallbackQuery(q.id);
  }

  if (data.startsWith("cat:")) {
    const cat = data.split(":")[1];
    state.currentCategory = cat;
    state.index = 0;
    const p = state.byCat[cat][0];
    bot.sendPhoto(chatId, p.imagen, productMessage(p, 0, state.byCat[cat].length));
    return bot.answerCallbackQuery(q.id);
  }

  if (data === "next" || data === "prev") {
    const list = state.byCat[state.currentCategory];
    state.index =
      data === "next"
        ? (state.index + 1) % list.length
        : (state.index - 1 + list.length) % list.length;

    const p = list[state.index];
    bot.sendPhoto(chatId, p.imagen, productMessage(p, state.index, list.length));
    return bot.answerCallbackQuery(q.id);
  }

  if (data.startsWith("back_cat:")) {
    bot.sendMessage(chatId, "📂 Categorías:", categoryKeyboard(Object.keys(state.byCat)));
    return bot.answerCallbackQuery(q.id);
  }

  if (data.startsWith("share:")) {
    bot.sendMessage(chatId, "📣 Podés compartir el bot desde su perfil.");
    return bot.answerCallbackQuery(q.id);
  }

  if (data.startsWith("want:")) {
    bot.sendMessage(chatId, "🛒 Perfecto 👍\n\n(Próximo paso: preguntar cantidad y unidad)");
    return bot.answerCallbackQuery(q.id);
  }
});

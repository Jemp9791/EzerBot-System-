import express from "express";
import TelegramBot from "node-telegram-bot-api";
import fetch from "node-fetch";

const BOT_TOKEN = process.env.BOT_TOKEN;
const GAS_URL = process.env.GAS_URL;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN || !GAS_URL) {
  throw new Error("Faltan variables de entorno");
}
const app = express();
app.use(express.json());

app.get("/", (_, res) => res.send("OK"));

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// ================= WEBHOOK / POLLING =================
const WEBHOOK_PATH = "/webhook";

app.post(WEBHOOK_PATH, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.listen(PORT, async () => {
  if (WEBHOOK_URL) {
    const full = WEBHOOK_URL.replace(/\/$/, "") + WEBHOOK_PATH;
    await bot.deleteWebHook({ drop_pending_updates: true });
    await bot.setWebHook(full);
    console.log("Webhook activo:", full);
  } else {
    await bot.deleteWebHook({ drop_pending_updates: true });
    await bot.startPolling();
    console.log("Polling activo");
  }
});

// ================= ESTADO =================
const state = new Map();
const getState = (id) => {
  if (!state.has(id)) state.set(id, { cart: [] });
  return state.get(id);
};

// ================= MENÚ =================
const mainMenu = {
  reply_markup: {
    keyboard: [
      ["🛍️ Catálogo", "🛒 Mi carrito"],
      ["🎁 Mis sellos"],
      ["💬 Hablar con el vendedor"],
      ["🏪 Información del local", "📣 Compartir el bot"],
      ["🔄 Recargar catálogo"]
    ],
    resize_keyboard: true
  }
};

async function startMenu(chatId) {
  await bot.sendMessage(
    chatId,
    `👋 Hola Jenny  
Soy el asistente de *Todo Queso Club* 🧀

Desde acá podés:
• Ver el catálogo  
• Armar tu pedido  
• Finalizar compra  

👇 Elegí una opción`,
    { parse_mode: "Markdown", ...mainMenu }
  );
}

// ================= CATÁLOGO =================
async function getCatalogo() {
  const url = GAS_URL.includes("?")
    ? `${GAS_URL}&type=catalogo`
    : `${GAS_URL}?type=catalogo`;

  const res = await fetch(url);
  const json = await res.json();
  return json.productos || [];
}

// ================= MENSAJES =================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  // 🔥 CUALQUIER COMANDO /ALGO
  if (text.startsWith("/")) {
    await startMenu(chatId);
    return;
  }

  if (text === "🛍️ Catálogo") {
    const productos = await getCatalogo();
    if (!productos.length) {
      await bot.sendMessage(chatId, "⚠️ No hay productos visibles.");
      return;
    }

    const categorias = [...new Set(productos.map(p => p.categoria))];

    const kb = categorias.map(c => [`📦 ${c}`]);
    kb.push(["🏠 Menú"]);

    await bot.sendMessage(chatId, "📂 Elegí una categoría:", {
      reply_markup: { keyboard: kb, resize_keyboard: true }
    });
    return;
  }

  if (text.startsWith("📦 ")) {
    const cat = text.replace("📦 ", "");
    const productos = await getCatalogo();
    const items = productos.filter(p => p.categoria === cat);

    if (!items.length) {
      await bot.sendMessage(chatId, "No hay productos en esta categoría.");
      return;
    }

    for (const p of items) {
      const caption = `*${p.nombre}*
💵 $${p.precio} ARS
🆔 ${p.codigo}`;

      if (p.imagen) {
        await bot.sendPhoto(chatId, p.imagen, {
          caption,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Quiero este", callback_data: `BUY:${p.codigo}` }]
            ]
          }
        });
      } else {
        await bot.sendMessage(chatId, caption, { parse_mode: "Markdown" });
      }
    }
    return;
  }

  if (text === "🛒 Mi carrito") {
    const st = getState(chatId);
    if (!st.cart.length) {
      await bot.sendMessage(chatId, "🛒 Tu carrito está vacío.", mainMenu);
      return;
    }
  }

  if (text === "🏠 Menú") {
    await startMenu(chatId);
    return;
  }

  // ❗ CUALQUIER OTRA COSA → NO SE QUEDA MUDO
  await startMenu(chatId);
});

// ================= CALLBACKS =================
bot.on("callback_query", async (cq) => {
  const chatId = cq.message.chat.id;
  const data = cq.data;

  if (data.startsWith("BUY:")) {
    const code = data.split(":")[1];
    const st = getState(chatId);
    st.cart.push(code);
    await bot.answerCallbackQuery(cq.id, { text: "Agregado al carrito ✅" });
    await bot.sendMessage(chatId, "🛒 Producto agregado.", mainMenu);
  }
});

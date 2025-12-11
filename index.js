import express from "express";
import TelegramBot from "node-telegram-bot-api";

const TOKEN = "8130447159:AAHxzp5S1lcgYOemw5dgF5V1DGh141dHmkA";
const GOOGLE_SHEET_URL = "https://script.google.com/macros/s/AKfycbyxm5E2Y7t0hgqh48-AVWpiru2MBXM3E-53T5WgnljMZb_CXZx-F-akgIJVJ4j76MjE/exec";
const LOGO_URL = "https://i.postimg.cc/q7WvjsYm/20251206-210311.jpg";

const bot = new TelegramBot(TOKEN, { polling: true });
const app = express();

const PORT = process.env.PORT || 10000;

// ---------- PRESENTACIÓN ----------
function menuPrincipal(chatId) {
  bot.sendPhoto(chatId, LOGO_URL, {
    caption:
      "🧀 *¡Bienvenido a TODO QUESO CLUB!*\n" +
      "Productos frescos, de calidad y con beneficios exclusivos.\n\n" +
      "Elegí una opción del menú 👇",
    parse_mode: "Markdown",
    reply_markup: {
      keyboard: [
        ["🛍️ Catálogo"],
        ["🛒 Mi carrito", "🏆 Mis sellos"],
        ["💬 Hablar con el vendedor"],
        ["📢 Compartir el bot"]
      ],
      resize_keyboard: true
    }
  });
}

// ---------- OBTENER PRODUCTOS DESDE GOOGLE SHEETS ----------
async function obtenerCatalogo() {
  try {
    const res = await fetch(GOOGLE_SHEET_URL + "?action=getCatalogo");
    return await res.json();
  } catch (e) {
    console.log("Error obteniendo productos:", e);
    return [];
  }
}

// ---------- MOSTRAR CATEGORÍAS ----------
bot.onText(/🛍️ Catálogo/, async (msg) => {
  const chatId = msg.chat.id;
  const productos = await obtenerCatalogo();

  const categorias = [...new Set(productos.map(p => p.categoria || "General"))];

  bot.sendMessage(chatId, "Elegí una categoría:", {
    reply_markup: {
      keyboard: categorias.map(c => [c]),
      resize_keyboard: true
    }
  });
});

// ---------- MOSTRAR PRODUCTOS DE UNA CATEGORÍA ----------
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const texto = msg.text;

  if (!texto) return;

  const productos = await obtenerCatalogo();
  const categorias = [...new Set(productos.map(p => p.categoria || "General"))];

  if (categorias.includes(texto)) {
    const productosFiltrados = productos.filter(p => p.categoria === texto);

    for (const prod of productosFiltrados) {
      await bot.sendPhoto(chatId, prod.imagen || LOGO_URL, {
        caption:
          `*${prod.nombre}*\n\n` +
          `Código: ${prod.codigo}\n` +
          `Precio: $${prod.precio}`,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🛒 Comprar", callback_data: `comprar_${prod.codigo}` }],
            [{ text: "📤 Compartir", switch_inline_query: prod.nombre }]
          ]
        }
      });
    }

    return;
  }
});

// ---------- BOTÓN COMPRAR ----------
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data.startsWith("comprar_")) {
    const codigo = data.replace("comprar_", "");

    bot.sendMessage(chatId, `🧾 Agregado al carrito: *${codigo}*`, {
      parse_mode: "Markdown"
    });

    // Aquí se guardaría el carrito en Apps Script en el futuro
  }
});

// ---------- MIS SELLOS ----------
bot.onText(/🏆 Mis sellos/, (msg) => {
  const chatId = msg.chat.id;

  bot.sendPhoto(chatId, LOGO_URL, {
    caption:
      "🏆 *Tu tarjeta de sellos*\n\n" +
      "Próximamente vas a ver tus sellos acumulados aquí.\n" +
      "Cada compra suma beneficios 🧀💛",
    parse_mode: "Markdown"
  });
});

// ---------- MI CARRITO ----------
bot.onText(/🛒 Mi carrito/, (msg) => {
  bot.sendMessage(msg.chat.id, "🛒 Tu carrito está vacío por ahora.\nSeguimos comprando 🧀💛");
});

// ---------- HABLAR CON EL VENDEDOR ----------
bot.onText(/💬 Hablar con el vendedor/, (msg) => {
  bot.sendMessage(msg.chat.id, "Escribí tu consulta y un vendedor te responderá 💛");
});

// ---------- COMPARTIR EL BOT ----------
bot.onText(/📢 Compartir el bot/, (msg) => {
  const chatId = msg.chat.id;

  bot.sendMessage(chatId,
    "Compartí este mensaje para que tus contactos también ganen sellos 🧀👇\n\n" +
    "🧀 *Sumate a TODO QUESO CLUB*\n" +
    "Comprá directo desde el bot, sumá sellos y canjeá beneficios.\n\n" +
    "👉 https://t.me/Ezer_IABot",
    { parse_mode: "Markdown" }
  );
});

// ---------- MENSAJE INICIAL ----------
bot.onText(/\/start/, (msg) => {
  menuPrincipal(msg.chat.id);
});

// ---------- EXPRESS PARA RENDER ----------
app.get("/", (req, res) => res.send("EzerBot funcionando"));
app.listen(PORT, () => console.log("Servidor iniciado en puerto", PORT));

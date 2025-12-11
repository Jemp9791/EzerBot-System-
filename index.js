import express from "express";
import TelegramBot from "node-telegram-bot-api";
import axios from "axios";

const TOKEN = "8130447159:AAHxzp5S1lcgYOemw5dgF5V1DGh141dHmkA";
const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyxm5E2Y7t0hgqh48-AVWpiru2MBXM3E-53T5WgnljMZb_CXZx-F-akgIJVJ4j76MjE/exec";
const LOGO_URL = "https://i.postimg.cc/q7WvjsYm/20251206-210311.jpg";

const bot = new TelegramBot(TOKEN, { polling: false });

const app = express();
app.use(express.json());

// ============= MENÚ PRINCIPAL =============
function mainMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🛍️ Catálogo" }],
        [{ text: "🛒 Mi carrito" }],
        [{ text: "🏆 Mis sellos" }],
        [{ text: "💬 Hablar con el vendedor" }],
        [{ text: "ℹ️ Información del local" }],
        [{ text: "📣 Compartir el bot" }]
      ],
      resize_keyboard: true
    }
  };
}

// ============= PRESENTACIÓN =============
async function welcomeMessage(chatId) {
  await bot.sendPhoto(chatId, LOGO_URL, {
    caption:
      "🧀 *¡Bienvenido a TODO QUESO CLUB!* 🧀\n\n" +
      "Tu fiambrería y quesería favorita ahora *tiene su propio asistente inteligente* 🤖💛\n\n" +
      "Desde acá podés:\n" +
      "✨ Ver el catálogo\n" +
      "✨ Comprar directamente\n" +
      "✨ Ganar sellos y beneficios\n" +
      "✨ Hablar con el vendedor\n\n" +
      "Elegí una opción del menú de abajo para empezar 👇",
    parse_mode: "Markdown"
  });
}

// ============= LEER PRODUCTOS DE SHEETS =============
async function getProducts() {
  const res = await axios.get(SCRIPT_URL + "?action=getProducts");
  return res.data.products ?? [];
}

// ============= CATEGORÍAS =============
async function showCategories(chatId) {
  const products = await getProducts();
  const categorias = [...new Set(products.map((p) => p.CATEGORIA))];

  await bot.sendMessage(chatId, "Elegí una categoría:", {
    reply_markup: {
      inline_keyboard: categorias.map((c) => [
        { text: `📦 ${c}`, callback_data: `cat_${c}` }
      ])
    }
  });
}

// ============= MOSTRAR PRODUCTOS =============
async function showCategoryProducts(chatId, category) {
  const products = await getProducts();
  const filtered = products.filter((p) => p.CATEGORIA === category);

  if (filtered.length === 0) {
    await bot.sendMessage(chatId, "No hay productos en esta categoría aún.");
    return;
  }

  for (const p of filtered) {
    await bot.sendPhoto(chatId, p.IMAGEN, {
      caption:
        `*${p.NOMBRE}*\n\n` +
        `Código: *${p.CODIGO}*\n` +
        `Precio: *$${p.PRECIO}*\n\n` +
        `${p.DESCRIPCION ?? ""}`,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🛍️ Comprar", callback_data: `buy_${p.CODIGO}` }],
          [{ text: "📣 Compartir promo", callback_data: `share_${p.CODIGO}` }]
        ]
      }
    });
  }
}

// ============= COMPARTIR PROMO =============
async function shareProduct(chatId, productCode) {
  const products = await getProducts();
  const prod = products.find((p) => p.CODIGO === productCode);

  if (!prod) return bot.sendMessage(chatId, "Producto no encontrado.");

  const msg =
    `📣 *Recomendación de TODO QUESO CLUB*\n\n` +
    `Probá *${prod.NOMBRE}* por solo *$${prod.PRECIO}* 😍🧀\n` +
    `¡Pedilo desde el bot y ganá sellos! 👉 @Ezer_IA_Bot`;

  await bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
}

// ============= TARJETA DE SELLOS =============
async function showLoyaltyCard(chatId) {
  const res = await axios.get(SCRIPT_URL + `?action=getUser&chatId=${chatId}`);
  const user = res.data.user;

  if (!user) {
    return bot.sendMessage(
      chatId,
      "Todavía no estás registrado. Comprá por primera vez y tu tarjeta se activará 💛",
      mainMenu()
    );
  }

  await bot.sendPhoto(chatId, LOGO_URL, {
    caption:
      `🏆 *Tu tarjeta de sellos*\n\n` +
      `Cliente: *${user.nombre}*\n` +
      `Sellos acumulados: *${user.sellos}*\n\n` +
      `Seguí comprando para desbloquear beneficios 😍`,
    parse_mode: "Markdown"
  });
}

// ============= COMPRA =============
async function startPurchase(chatId, code) {
  await bot.sendMessage(
    chatId,
    `🛍️ Escribí la *cantidad* que querés del producto *${code}*`
  );

  // Avisar al Apps Script que se inició una compra
  await axios.get(SCRIPT_URL + `?action=startBuy&chatId=${chatId}&code=${code}`);
}

// ============= INFO DEL LOCAL =============
async function infoLocal(chatId) {
  await bot.sendPhoto(chatId, LOGO_URL, {
    caption:
      "🏪 *TODO QUESO CLUB*\n\n" +
      "📍 Dirección: Garín, zona centro\n" +
      "🕒 Horarios: Lun a Sáb 9 a 20 hs\n" +
      "📞 Contacto: 11 2253-8102\n\n" +
      "Gracias por elegir productos frescos y de calidad 💛",
    parse_mode: "Markdown"
  });
}

// ============= COMPARTIR EL BOT =============
async function shareBot(chatId) {
  await bot.sendMessage(
    chatId,
    "Compartí este mensaje para que tus contactos también ganen sellos 🧀👇\n\n" +
      "🧀 *Sumate a TODO QUESO CLUB*\n" +
      "Comprá directo desde el bot, sumá sellos y canjeá beneficios.\n\n" +
      "👉 https://t.me/Ezer_IA_Bot",
    { parse_mode: "Markdown" }
  );
}

// ================== CALLBACKS ==================
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const data = q.data;

  if (data.startsWith("cat_")) {
    const cat = data.replace("cat_", "");
    showCategoryProducts(chatId, cat);
  }

  if (data.startsWith("buy_")) {
    const code = data.replace("buy_", "");
    startPurchase(chatId, code);
  }

  if (data.startsWith("share_")) {
    const code = data.replace("share_", "");
    shareProduct(chatId, code);
  }
});

// ================== MENSAJES ==================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (text === "/start") return welcomeMessage(chatId);

  switch (text) {
    case "🛍️ Catálogo":
      return showCategories(chatId);

    case "🛒 Mi carrito":
      return bot.sendMessage(chatId, "Tu carrito está vacío por ahora 🛒");

    case "🏆 Mis sellos":
      return showLoyaltyCard(chatId);

    case "💬 Hablar con el vendedor":
      return bot.sendMessage(chatId, "Escribí tu consulta y un vendedor te responderá 💛");

    case "ℹ️ Información del local":
      return infoLocal(chatId);

    case "📣 Compartir el bot":
      return shareBot(chatId);

    default:
      return bot.sendMessage(chatId, "Elegí una opción del menú 👇", mainMenu());
  }
});

// ============= WEBHOOK =============
app.post(`/webhook`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ============= SERVER =============
app.listen(10000, () => {
  console.log("Bot funcionando en Render 🚀");
});

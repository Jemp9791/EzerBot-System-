// index.js - EzerBot Todo Queso
// Versión: flujo envío/retiro + pagos + menú principal funcionando

import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import http from "http";

dotenv.config();

// --- Mini server para que Render vea un puerto abierto ---
http
  .createServer((req, res) => {
    res.write("OK");
    res.end();
  })
  .listen(process.env.PORT || 3000);

// --- Bot ---
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("Falta TELEGRAM_BOT_TOKEN en las variables de entorno");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// --- Estado por usuario ---
const sessions = {}; // { [chatId]: { state, temp, cart: [] } }

function getSession(chatId) {
  if (!sessions[chatId]) {
    sessions[chatId] = {
      state: null,
      temp: {},
      cart: [], // para futuro carrito real
    };
  }
  return sessions[chatId];
}

// --- Config "quemada" desde tu hoja Config (ya la tenés así) ---
const CONFIG = {
  NegocioNombre: "Todo Queso",
  LogoURL: "https://i.postimg.cc/q7WvjsYm/20251206-210311.jpg",
  Descripcion:
    "Somos Todo Queso. Aquí encontrarás los mejores precios, las picadas más ricas y los mejores beneficios de ser parte de nuestro club.",
  Direccion: "Fructuoso Díaz 893, Garin",
  Horarios: "LUN a SAB 08:30-14:00/16:30-21:00",
  TelefonoNegocio: "5493484230184",
  Instagram: "@todoqueso.club",
  WhatsAppLink:
    "https://wa.me/5493484230184?text=Hola%20quiero%20hacer%20una%20consulta",
  UsaEnvioDomicilio: true,
  CostoEnvioBase: 2000,
  TextoEnvioDomicilio: "Tu envío se realizará a partir de las 16:00 hs",
  UsaRetiroLocal: true,
  TextoRetiroLocal:
    "Tu pedido será preparado y podés pasar a retirarlo hasta las 20:00 hs",
  TipoPagoOnline: "TRANSFERENCIA",
  AliasPago: "jennyocampos.mp",
};

// --- Menú principal ---
function mainMenuKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        ["🛍️ Catálogo", "🛒 Ver carrito"],
        ["✅ Finalizar compra", "🎟️ Mis sellos"],
        ["📍 Horarios y dirección", "📣 Compartir bot"],
      ],
      resize_keyboard: true,
    },
  };
}

// --- Saludo / bienvenida ---
async function sendWelcome(chatId) {
  // Logo + descripción
  await bot.sendPhoto(chatId, CONFIG.LogoURL, {
    caption: `🧀 *${CONFIG.NegocioNombre}*\n\n${CONFIG.Descripcion}`,
    parse_mode: "Markdown",
  });

  // Info básica del local
  await bot.sendMessage(
    chatId,
    `📍 *Dirección:* ${CONFIG.Direccion}\n⏰ *Horarios:* ${CONFIG.Horarios}\n📞 *Teléfono:* +${CONFIG.TelefonoNegocio}\n📸 *Instagram:* ${CONFIG.Instagram}`,
    {
      parse_mode: "Markdown",
    }
  );

  // Explicación breve
  await bot.sendMessage(
    chatId,
    "👉 Podés ver el *catálogo*, armar tu *carrito* y *finalizar tu compra* desde acá. Elegí una opción del menú de abajo para empezar 👇",
    mainMenuKeyboard()
  );

  const session = getSession(chatId);
  session.state = null;
  session.temp = {};
}

// --- Flujo de FINALIZAR COMPRA (envío / retiro + datos + forma de pago) ---

function askDeliveryType(chatId) {
  const session = getSession(chatId);
  session.state = "ASK_DELIVERY_TYPE";
  session.temp = {};

  const buttons = [];
  if (CONFIG.UsaEnvioDomicilio) {
    buttons.push([{ text: "🚚 Envío a domicilio" }]);
  }
  if (CONFIG.UsaRetiroLocal) {
    buttons.push([{ text: "🏬 Retiro por el local" }]);
  }

  bot.sendMessage(chatId, "Elegí cómo querés recibir tu pedido 👇", {
    reply_markup: { keyboard: buttons.concat(mainMenuKeyboard().reply_markup.keyboard), resize_keyboard: true },
  });
}

async function handleDeliveryType(chatId, text) {
  const session = getSession(chatId);

  if (text.startsWith("🚚")) {
    session.temp.deliveryType = "ENVIO";
    session.state = "ASK_ADDRESS";
    await bot.sendMessage(chatId, "📍 Decime tu dirección completa:");
  } else if (text.startsWith("🏬")) {
    session.temp.deliveryType = "RETIRO";
    session.state = "ASK_NAME";
    await bot.sendMessage(chatId, "🧾 Tu nombre:");
  }
}

async function handleAddress(chatId, text) {
  const session = getSession(chatId);
  session.temp.address = text;
  session.state = "ASK_NAME";
  await bot.sendMessage(chatId, "🧾 Tu nombre:");
}

async function handleName(chatId, text) {
  const session = getSession(chatId);
  session.temp.name = text;
  session.state = "ASK_PHONE";
  await bot.sendMessage(chatId, "📞 Tu teléfono:");
}

async function handlePhone(chatId, text) {
  const session = getSession(chatId);
  session.temp.phone = text;
  session.state = "ASK_PAYMENT";

  await bot.sendMessage(
    chatId,
    "Perfecto 🙌\n\nAhora elegí cómo querés pagar:",
    {
      reply_markup: {
        keyboard: [
          ["💵 Efectivo"],
          [`🏦 ${CONFIG.TipoPagoOnline} (${CONFIG.AliasPago})`],
          ...mainMenuKeyboard().reply_markup.keyboard,
        ],
        resize_keyboard: true,
      },
    }
  );
}

async function handlePayment(chatId, text) {
  const session = getSession(chatId);

  if (text.startsWith("💵")) {
    session.temp.payment = "EFECTIVO";
  } else if (text.startsWith("🏦")) {
    session.temp.payment = CONFIG.TipoPagoOnline;
  } else {
    // si manda otra cosa, lo ignoro
    return;
  }

  session.state = null;

  const { deliveryType, address, name, phone } = session.temp;

  let resumen = `Perfecto! Resumen del pedido:\n\n👤 Nombre: *${name}*\n📞 Teléfono: *${phone}*\n`;

  if (deliveryType === "ENVIO") {
    resumen += `📦 Tipo: *Envío a domicilio*\n📍 Dirección: *${address}*\n\n🚚 Costo de envío estimado: *$${CONFIG.CostoEnvioBase}*\n_${CONFIG.TextoEnvioDomicilio}_\n\n`;
  } else {
    resumen += `🏬 Tipo: *Retiro por el local*\n_${CONFIG.TextoRetiroLocal}_\n\n`;
  }

  if (session.temp.payment === "EFECTIVO") {
    resumen += "💵 *Pago en efectivo al recibir.*\n";
  } else {
    resumen += `🏦 *Pago por ${CONFIG.TipoPagoOnline}*\n💳 Alias: *${CONFIG.AliasPago}*\n`;
  }

  await bot.sendMessage(chatId, resumen, { parse_mode: "Markdown" });

  await bot.sendMessage(
    chatId,
    "Cuando hagas el pago avisanos por acá con el comprobante o escribinos a este WhatsApp:\n" +
      CONFIG.WhatsAppLink,
    mainMenuKeyboard()
  );

  session.temp = {};
}

// --- Otros botones del menú ---

async function handleCatalog(chatId) {
  // Por ahora respuesta simple para que no quede mudo.
  // Después acá volvemos a conectar el catálogo real con carrusel.
  await bot.sendMessage(
    chatId,
    "🛍️ Acá va a estar el *catálogo completo* con fotos y promos.\nPor ahora estoy terminando de conectarlo, pero ya podés usar el flujo de *envío / retiro* y formas de pago.",
    mainMenuKeyboard()
  );
}

async function handleCart(chatId) {
  const session = getSession(chatId);
  if (!session.cart.length) {
    await bot.sendMessage(
      chatId,
      "🧺 Tu carrito está vacío por ahora.\nUsá *Catálogo* para ir agregando productos 😊",
      mainMenuKeyboard()
    );
  } else {
    // Placeholder
    await bot.sendMessage(
      chatId,
      "🧺 Tenés productos en el carrito (vista detallada pendiente de conectar).",
      mainMenuKeyboard()
    );
  }
}

async function handleStamps(chatId) {
  // Placeholder: más adelante lo conectamos a Fideliza/Fideliza360
  await bot.sendMessage(
    chatId,
    "🎟️ Próximamente vas a poder ver acá tus *sellos y niveles* de Todo Queso Club.\nPor ahora seguimos sumando compras normalmente 🧀",
    mainMenuKeyboard()
  );
}

async function handleStoreInfo(chatId) {
  await bot.sendMessage(
    chatId,
    `🧀 *${CONFIG.NegocioNombre}*\n\n📍 *Dirección:* ${CONFIG.Direccion}\n⏰ *Horarios:* ${CONFIG.Horarios}\n📞 *Teléfono:* +${CONFIG.TelefonoNegocio}\n📸 *Instagram:* ${CONFIG.Instagram}`,
    { parse_mode: "Markdown", ...mainMenuKeyboard() }
  );
}

async function handleShareBot(chatId) {
  const botLink = "https://t.me/Ezer_IA_Bot"; // cambiá esto si tu @ del bot es otro

  const text =
    "Compartí este *EzerBot* con tus amigos y ganá sellos extras 🧀\n\n" +
    `Link directo del bot:\n${botLink}`;

  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(
    `Mirá este bot de Todo Queso para hacer pedidos: ${botLink}`
  )}`;
  const telegramUrl = `https://t.me/share/url?url=${encodeURIComponent(
    botLink
  )}&text=${encodeURIComponent("Bot de Todo Queso para hacer pedidos")}`;
  const emailUrl = `mailto:?subject=${encodeURIComponent(
    "Bot de Todo Queso"
  )}&body=${encodeURIComponent(
    `Te comparto el bot de Todo Queso para hacer pedidos:\n\n${botLink}`
  )}`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📲 Compartir por WhatsApp", url: whatsappUrl }],
        [{ text: "📨 Compartir por Telegram", url: telegramUrl }],
        [{ text: "✉️ Compartir por Email", url: emailUrl }],
      ],
    },
  });
}

// --- Router principal de mensajes ---

bot.onText(/\/start/i, async (msg) => {
  const chatId = msg.chat.id;
  await sendWelcome(chatId);
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  // Ignoramos mensajes sin texto
  if (!text) return;

  const session = getSession(chatId);

  // Atajos globales: menú principal SIEMPRE tiene prioridad
  if (text === "🛍️ Catálogo") {
    session.state = null;
    session.temp = {};
    return handleCatalog(chatId);
  }
  if (text === "🛒 Ver carrito") {
    session.state = null;
    session.temp = {};
    return handleCart(chatId);
  }
  if (text === "✅ Finalizar compra") {
    session.temp = {};
    return askDeliveryType(chatId);
  }
  if (text === "🎟️ Mis sellos") {
    session.state = null;
    session.temp = {};
    return handleStamps(chatId);
  }
  if (text === "📍 Horarios y dirección") {
    session.state = null;
    session.temp = {};
    return handleStoreInfo(chatId);
  }
  if (text === "📣 Compartir bot") {
    session.state = null;
    session.temp = {};
    return handleShareBot(chatId);
  }

  // Si escribe "hola" o cualquier cosa al principio, reenviamos bienvenida
  if (/^hola$/i.test(text)) {
    return sendWelcome(chatId);
  }

  // Manejo del flujo de FINALIZAR COMPRA
  switch (session.state) {
    case "ASK_DELIVERY_TYPE":
      return handleDeliveryType(chatId, text);
    case "ASK_ADDRESS":
      return handleAddress(chatId, text);
    case "ASK_NAME":
      return handleName(chatId, text);
    case "ASK_PHONE":
      return handlePhone(chatId, text);
    case "ASK_PAYMENT":
      return handlePayment(chatId, text);
    default:
      // Si no estamos en ningún flujo, simplemente recordamos el menú
      return bot.sendMessage(
        chatId,
        "Usá el menú de abajo para seguir: Catálogo, Ver carrito, Finalizar compra, Mis sellos o Compartir bot 😊",
        mainMenuKeyboard()
      );
  }
});

bot.on("polling_error", (err) => {
  console.error("Polling error", err);
});

console.log("EzerBot Todo Queso iniciado con éxito 🧀"); 

import TelegramBot from "node-telegram-bot-api";

// ========= ENV ==========
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("Falta BOT_TOKEN");

// ========= BOT ==========
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ========= DATA USERS ========
const USERS = {}; // memoria temporal para pruebas

const getUser = (id) => {
  if (!USERS[id]) {
    USERS[id] = {
      paso: "",
      envioTipo: "",
      direccion: "",
      nombre: "",
      telefono: ""
    };
  }
  return USERS[id];
};

// ========= MENÚ ==========
function menuEnvio() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🚚 Envío a domicilio", callback_data: "e" }],
        [{ text: "🏪 Retiro por el local", callback_data: "r" }],
      ],
    },
  };
}

// ========= START ==========
bot.onText(/\/start/, (msg) => {
  const id = msg.chat.id;
  bot.sendMessage(
    id,
    "Elegí cómo querés recibir tu pedido 👇",
    menuEnvio()
  );
});


// ========= CALLBACKS ==========
bot.on("callback_query", async (q) => {
  const id = q.message.chat.id;
  const user = getUser(id);

  if (q.data === "e") {
    user.envioTipo = "envio";
    user.paso = "direccion";
    bot.sendMessage(id, "📍 Decime tu dirección completa:");
    return;
  }

  if (q.data === "r") {
    user.envioTipo = "retiro";
    user.paso = "nombre";
    bot.sendMessage(id, "🧾 Tu nombre para el retiro:");
    return;
  }
});


// ========= FLUJO POR TEXTO ==========
bot.on("message", (msg) => {
  const id = msg.chat.id;
  const user = getUser(id);

  const t = msg.text?.trim();
  if (!t || t.startsWith("/start")) return;

  // DIRECCIÓN
  if (user.paso === "direccion") {
    user.direccion = t;
    user.paso = "nombre";
    bot.sendMessage(id, "🧾 Tu nombre:");
    return;
  }

  // NOMBRE
  if (user.paso === "nombre") {
    user.nombre = t;
    user.paso = "telefono";
    bot.sendMessage(id, "📞 Tu teléfono:");
    return;
  }

  // TELÉFONO
  if (user.paso === "telefono") {
    user.telefono = t;
    user.paso = "final";

    // RESPUESTA FINAL
    if (user.envioTipo === "envio") {
      bot.sendMessage(
        id,
        `Perfecto! Resumen:\n\n` +
        `Tipo: Envío a domicilio 🚚\n` +
        `Dirección: ${user.direccion}\n` +
        `Nombre: ${user.nombre}\n` +
        `Teléfono: ${user.telefono}`
      );
    } else {
      bot.sendMessage(
        id,
        `Perfecto! Resumen:\n\n` +
        `Tipo: Retiro por el local 🏪\n` +
        `Nombre: ${user.nombre}\n` +
        `Teléfono: ${user.telefono}`
      );
    }

    return;
  }
});

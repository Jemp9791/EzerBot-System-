// index.js
// Bot de fidelización Todo Queso – usa Apps Script como "cerebro"

const express = require("express");
const fetch = require("node-fetch");

const BOT_TOKEN = process.env.BOT_TOKEN;
const SHEETS_URL = process.env.SHEETS_URL;

if (!BOT_TOKEN || !SHEETS_URL) {
  console.error("⚠️ Falta BOT_TOKEN o SHEETS_URL en variables de entorno");
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const app = express();
app.use(express.json());

// =============== HELPERS ===============

async function callTelegram(method, payload) {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    console.error("Error Telegram", method, data);
  }
  return data;
}

async function getJSONFromSheets(params) {
  const url = `${SHEETS_URL}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error("Error Sheets", res.status, await res.text());
    throw new Error("Error consultando Sheets");
  }
  return res.json();
}

// ================== MENSAJES BASE ==================

function buildMainMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🛒 Ver catálogo" }, { text: "🏆 Mis sellos y puntos" }],
        [{ text: "🎁 Canjear beneficio" }],
        [{ text: "🏪 Información del local" }],
      ],
      resize_keyboard: true,
    },
  };
}

async function sendWelcome(chatId, nombre) {
  const text =
    `✨🧀 ¡Bienvenido a *Todo Queso Club*, ${nombre}! 🧀✨\n` +
    `Soy tu asistente para:\n` +
    `• Ver el catálogo con fotos 📸\n` +
    `• Armar tu pedido y ver formas de pago 💳\n` +
    `• Ver tus sellos, niveles y beneficios 🏆\n\n` +
    `Elegí una opción del menú de abajo 👇`;

  await callTelegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    ...buildMainMenu(),
  });
}

// ================== FIDELIZACIÓN ==================

// ----- 1) Ver estado de sellos, nivel, beneficio -----

async function handleMisSellos(chatId, userId) {
  try {
    const data = await getJSONFromSheets({
      accion: "estadoCliente",
      chatId: String(userId),
    });

    if (!data.ok) {
      await callTelegram("sendMessage", {
        chat_id: chatId,
        text:
          "No encontré tu tarjeta todavía. Hacé una compra en el local para empezar a sumar sellos 🧾✨",
      });
      return;
    }

    const {
      sellos,
      nivelActual,
      beneficioActual,
      proximoNivelNombre,
      proximoNivelSellos,
      faltanSellos,
      porcentajeProgreso,
      tarjetaUrl,
      montoPorSello,
    } = data;

    const barraBloques = Math.round((porcentajeProgreso || 0) / 10);
    const barra =
      "█".repeat(barraBloques) + "░".repeat(10 - barraBloques);

    let texto =
      `🏆 *Tus sellos – Todo Queso Club*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `Nivel actual: *${nivelActual || "Sin nivel"}*\n` +
      `Sellos acumulados: *${sellos}*\n\n`;

    if (beneficioActual) {
      texto += `🎁 Beneficio actual: ${beneficioActual}\n\n`;
    }

    if (proximoNivelNombre && proximoNivelSellos != null) {
      texto +=
        `🎯 Próximo nivel: *${proximoNivelNombre}* (${proximoNivelSellos} sellos)\n` +
        `Te faltan: *${faltanSellos}* sellos\n\n` +
        `Progreso: [${barra}] ${porcentajeProgreso || 0}%\n\n`;
    }

    texto +=
      `💡 Cada $${montoPorSello || 10000} de compra = 1 sello.\n` +
      `🤝 Compartí el bot con tus amigos y ganá sellos extra.`;

    if (tarjetaUrl) {
      await callTelegram("sendPhoto", {
        chat_id: chatId,
        photo: tarjetaUrl,
        caption: texto,
        parse_mode: "Markdown",
      });
    } else {
      await callTelegram("sendMessage", {
        chat_id: chatId,
        text: texto,
        parse_mode: "Markdown",
      });
    }
  } catch (e) {
    console.error("handleMisSellos error", e);
    await callTelegram("sendMessage", {
      chat_id: chatId,
      text:
        "Hubo un problema mostrando tus sellos. Intentá de nuevo en unos segundos.",
    });
  }
}

// ----- 2) Preguntar y gestionar canje de beneficio -----

async function handleCanjearBeneficio(chatId, userId) {
  try {
    const data = await getJSONFromSheets({
      accion: "consultarCanjePendiente",
      chatId: String(userId),
    });

    if (!data.ok || !data.puedeCanjear) {
      await callTelegram("sendMessage", {
        chat_id: chatId,
        text:
          "Por ahora no tenés ningún beneficio listo para canjear. Seguí sumando sellos y pronto vas a desbloquear un premio 🎁",
      });
      return;
    }

    const texto =
      `🎉 *¡Felicitaciones!* Completaste el nivel *${data.nivel}*.\n\n` +
      `🎁 Beneficio desbloqueado:\n` +
      `${data.beneficio}\n\n` +
      `¿Querés canjearlo ahora o seguir acumulando sellos?`;

    await callTelegram("sendMessage", {
      chat_id: chatId,
      text: texto,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🎁 Canjear ahora", callback_data: "canjear_ahora" },
            {
              text: "➕ Seguir acumulando",
              callback_data: "canjear_luego",
            },
          ],
        ],
      },
    });
  } catch (e) {
    console.error("handleCanjearBeneficio error", e);
    await callTelegram("sendMessage", {
      chat_id: chatId,
      text:
        "Hubo un problema consultando tu beneficio. Intentá de nuevo más tarde.",
    });
  }
}

async function procesarCanjeAhora(chatId, userId) {
  try {
    const data = await getJSONFromSheets({
      accion: "generarCanje",
      chatId: String(userId),
    });

    if (!data.ok) {
      await callTelegram("sendMessage", {
        chat_id: chatId,
        text:
          "No pude generar el canje en este momento. Intentá de nuevo en un ratito.",
      });
      return;
    }

    const texto =
      `🎁 *Código de canje generado*\n` +
      `Código: *${data.codigo}*\n` +
      `Beneficio: ${data.beneficio}\n` +
      (data.vence
        ? `Vence: ${data.vence}\n\n`
        : `\n`) +
      `Mostrá este código en el local para usar tu premio.\n` +
      (data.reset
        ? `\n🔄 Tus sellos vuelven a 0 y podés empezar una nueva tarjeta.`
        : ``);

    await callTelegram("sendMessage", {
      chat_id: chatId,
      text: texto,
      parse_mode: "Markdown",
    });
  } catch (e) {
    console.error("procesarCanjeAhora error", e);
    await callTelegram("sendMessage", {
      chat_id: chatId,
      text:
        "Hubo un problema generando el canje. Intentá de nuevo en unos segundos.",
    });
  }
}

// ----- 3) Información del local (desde Config) -----

async function handleInfoLocal(chatId) {
  try {
    const cfg = await getJSONFromSheets({ accion: "config" });
    if (!cfg.ok) throw new Error("config !ok");

    const texto =
      `🏪 *${cfg.NegocioNombre || "Nuestro local"}*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      (cfg.Descripcion ? `${cfg.Descripcion}\n\n` : "") +
      (cfg.Direccion ? `📍 Dirección: ${cfg.Direccion}\n` : "") +
      (cfg.Horarios ? `🕒 Horarios: ${cfg.Horarios}\n` : "") +
      (cfg.TelefonoNegocio
        ? `📞 Teléfono: ${cfg.TelefonoNegocio}\n`
        : "") +
      (cfg.WhatsAppLink
        ? `📱 WhatsApp: ${cfg.WhatsAppLink}\n`
        : "") +
      (cfg.Instagram ? `📷 Instagram: ${cfg.Instagram}\n` : "") +
      (cfg.Facebook ? `📘 Facebook: ${cfg.Facebook}\n` : "");

    await callTelegram("sendMessage", {
      chat_id: chatId,
      text: texto,
      parse_mode: "Markdown",
    });
  } catch (e) {
    console.error("handleInfoLocal error", e);
    await callTelegram("sendMessage", {
      chat_id: chatId,
      text:
        "No pude mostrar la información del local en este momento. Intentá de nuevo más tarde.",
    });
  }
}

// ================== WEBHOOK ==================

app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
  try {
    const body = req.body;

    if (body.message) {
      const msg = body.message;
      const chatId = msg.chat.id;
      const userId = msg.from.id;
      const text = (msg.text || "").trim();

      if (text === "/start") {
        const nombre = msg.from.first_name || "amigo/a";
        await sendWelcome(chatId, nombre);
      } else if (text === "🏆 Mis sellos y puntos") {
        await handleMisSellos(chatId, userId);
      } else if (text === "🎁 Canjear beneficio") {
        await handleCanjearBeneficio(chatId, userId);
      } else if (text === "🏪 Información del local") {
        await handleInfoLocal(chatId);
      } else {
        await callTelegram("sendMessage", {
          chat_id: chatId,
          text:
            "Podés usar el menú de abajo para ver tu tarjeta de sellos, canjear beneficios o ver info del local 🧀",
        });
      }
    }

    if (body.callback_query) {
      const cq = body.callback_query;
      const data = cq.data;
      const chatId = cq.message.chat.id;
      const userId = cq.from.id;

      if (data === "canjear_ahora") {
        await procesarCanjeAhora(chatId, userId);
      } else if (data === "canjear_luego") {
        await callTelegram("sendMessage", {
          chat_id: chatId,
          text:
            "Perfecto, seguís acumulando sellos hacia el próximo nivel ⭐",
        });
      }

      await callTelegram("answerCallbackQuery", {
        callback_query_id: cq.id,
      });
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error", e);
    res.sendStatus(200);
  }
});

// ================== SERVER ==================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Bot de fidelización escuchando en puerto", PORT);
});

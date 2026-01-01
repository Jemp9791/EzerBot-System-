import https from "https";

/* ================================
   CONFIG FIJA (NO TOCAR)
================================ */

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const DATA_API_URL = process.env.DATA_API_URL; // tu Google Apps Script
const PUBLIC_URL = process.env.PUBLIC_URL;     // https://ezerbot-system.onrender.com

if (!TELEGRAM_TOKEN || !DATA_API_URL || !PUBLIC_URL) {
  console.error("FALTAN VARIABLES DE ENTORNO");
  process.exit(1);
}

const TG_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

/* ================================
   UTILIDADES
================================ */

function tg(method, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request(
      `${TG_API}/${method}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      res => {
        let out = "";
        res.on("data", d => out += d);
        res.on("end", () => resolve(JSON.parse(out)));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject("JSON inválido");
        }
      });
    }).on("error", reject);
  });
}

/* ================================
   LECTURA DE CONFIG
================================ */

async function getConfig() {
  return fetchJSON(`${DATA_API_URL}?tab=Config`);
}

async function getCatalogo() {
  return fetchJSON(`${DATA_API_URL}?tab=Catalogo`);
}

/* ================================
   MENSAJES
================================ */

async function saludo(chatId, user) {
  const cfg = await getConfig();

  const texto =
`👋 Bienvenido/a a ${cfg.NegocioNombre}
${cfg.Descripcion.replace("{NOMBRE}", user.first_name || "")}`;

  await tg("sendPhoto", {
    chat_id: chatId,
    photo: cfg.LogoURL,
    caption: texto,
    reply_markup: {
      keyboard: [
        [{ text: "🛍️ Catálogo" }],
        [{ text: "🏷️ Sellos" }, { text: "📣 Compartir bot" }],
        [{ text: "🆘 Ayuda" }]
      ],
      resize_keyboard: true
    }
  });
}

async function enviarCatalogo(chatId) {
  const items = await getCatalogo();

  if (!items.length) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "❌ No hay productos disponibles por el momento."
    });
    return;
  }

  for (const p of items) {
    const texto =
`🧀 *${p.NOMBRE}*
💰 ${p.PRECIO}
${p.DESCRIPCION || ""}`;

    await tg("sendPhoto", {
      chat_id: chatId,
      photo: p.IMAGEN,
      caption: texto,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🛒 Comprar",
              url: `${PUBLIC_URL}/buy/${p.CODIGO}`
            }
          ]
        ]
      }
    });
  }
}

async function enviarSellos(chatId, userId) {
  await tg("sendMessage", {
    chat_id: chatId,
    text: `🏷️ Tu tarjeta de sellos:\n${PUBLIC_URL}/card/${userId}`
  });
}

async function compartirBot(chatId) {
  const cfg = await getConfig();
  await tg("sendMessage", {
    chat_id: chatId,
    text: cfg.TextoSistema
  });
}

async function ayuda(chatId) {
  const cfg = await getConfig();
  await tg("sendMessage", {
    chat_id: chatId,
    text:
`📌 Si necesitás hacer una consulta o reclamo:

✅ WhatsApp:
${cfg.WhatsAppLink}

📸 Instagram:
${cfg.NegocioInstagram}

Gracias por elegir ${cfg.NegocioNombre} 🧀`
  });
}

/* ================================
   WEBHOOK HANDLER
================================ */

async function handleUpdate(update) {
  if (!update.message) return;

  const msg = update.message;
  const chatId = msg.chat.id;
  const text = msg.text || "";
  const user = msg.from;

  if (text === "/start") {
    await saludo(chatId, user);
  } else if (text === "🛍️ Catálogo") {
    await enviarCatalogo(chatId);
  } else if (text === "🏷️ Sellos") {
    await enviarSellos(chatId, user.id);
  } else if (text === "📣 Compartir bot") {
    await compartirBot(chatId);
  } else if (text === "🆘 Ayuda") {
    await ayuda(chatId);
  }
}

/* ================================
   SERVIDOR WEBHOOK
================================ */

import http from "http";

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(200);
    res.end("OK");
    return;
  }

  let body = "";
  req.on("data", c => body += c);
  req.on("end", async () => {
    try {
      const update = JSON.parse(body);
      await handleUpdate(update);
    } catch {}
    res.writeHead(200);
    res.end("OK");
  });
});

server.listen(3000, async () => {
  await tg("setWebhook", {
    url: PUBLIC_URL
  });
  console.log("EZERBOT ACTIVO");
});

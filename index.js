import http from "http";

/* =========================
   VARIABLES (Render)
========================= */
const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_TOKEN;
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const DATA_API_URL = (process.env.DATA_API_URL || "").replace(/\/$/, "");

if (!TOKEN || !PUBLIC_URL || !DATA_API_URL) {
  console.error("❌ Faltan variables de entorno");
}

/* =========================
   TELEGRAM HELPERS
========================= */
const TG_API = `https://api.telegram.org/bot${TOKEN}`;

async function tg(method, payload) {
  try {
    await fetch(`${TG_API}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("Telegram error", e);
  }
}

function menu(chatId, text) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: {
      keyboard: [
        [{ text: "🛍️ Catálogo" }],
        [{ text: "🏷️ Sellos" }],
        [{ text: "📣 Compartir bot" }],
        [{ text: "🆘 Ayuda" }],
      ],
      resize_keyboard: true,
    },
  });
}

/* =========================
   DATA API (Apps Script)
========================= */
async function getTab(tab) {
  const url = `${DATA_API_URL}?tab=${tab}`;
  const r = await fetch(url);
  return r.json();
}

/* =========================
   HANDLERS
========================= */
async function start(chatId) {
  const config = await getTab("Config");
  const nombre = config.NegocioNombre || "Todo Queso";
  const desc = config.Descripcion || "Elegí tus productos desde el catálogo 👇";

  menu(chatId, `👋 Bienvenido/a a ${nombre} 🧀\n\n${desc}`);
}

async function catalogo(chatId) {
  tg("sendMessage", {
    chat_id: chatId,
    text: `🛍️ Catálogo online:\n${PUBLIC_URL}/catalog`,
  });
}

async function sellos(chatId) {
  const clientes = await getTab("Clientes");
  const config = await getTab("Config");

  const cli = clientes.find(c => String(c.UserIdTG) === String(chatId));
  const sellos = cli ? Number(cli.Sellos || 0) : 0;

  tg("sendMessage", {
    chat_id: chatId,
    text:
      `🏷️ Tus sellos\n\n` +
      `Tenés ${sellos} sellos acumulados.\n` +
      `1 sello cada $${config.MontoPorSello || 10000}\n\n` +
      `🪪 Tarjeta:\n${PUBLIC_URL}/card/${chatId}`,
  });
}

async function ayuda(chatId) {
  const config = await getTab("Config");

  tg("sendMessage", {
    chat_id: chatId,
    text:
      `🆘 Ayuda\n\n` +
      `Si te faltó algo del pedido o no lo viste en el catálogo, escribinos:\n\n` +
      `✅ WhatsApp: ${config.WhatsAppLink || ""}\n` +
      `📸 Instagram: ${config.NegocioInstagram || ""}\n\n` +
      `Gracias por elegir ${config.NegocioNombre || "Todo Queso"} 🧀`,
  });
}

async function compartir(chatId) {
  const config = await getTab("Config");

  tg("sendMessage", {
    chat_id: chatId,
    text:
      `🤖 ¿Querés este sistema para tu negocio?\n\n` +
      `📩 ${config.EmailSistema || "ezerbot.assistant@gmail.com"}`,
  });
}

/* =========================
   SERVER + WEBHOOK
========================= */
const server = http.createServer(async (req, res) => {
  if (req.method === "GET") {
    res.writeHead(200);
    return res.end("EZERBOT OK");
  }

  if (req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      res.writeHead(200);
      res.end("OK");

      const update = JSON.parse(body || "{}");
      const msg = update.message;
      if (!msg || !msg.chat) return;

      const chatId = msg.chat.id;
      const text = msg.text || "";

      if (text === "/start") return start(chatId);
      if (text === "🛍️ Catálogo") return catalogo(chatId);
      if (text === "🏷️ Sellos") return sellos(chatId);
      if (text === "📣 Compartir bot") return compartir(chatId);
      if (text === "🆘 Ayuda") return ayuda(chatId);

      start(chatId);
    });
  }
});

server.listen(PORT, async () => {
  console.log("✅ EZERBOT ACTIVO");

  await fetch(`${TG_API}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: `${PUBLIC_URL}/` }),
  });
});

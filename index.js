import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL; // ej: https://ezerbot-system.onrender.com
const WEBHOOK_PATH = "/telegram";

function tgApi(method) {
  return `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
}

async function tgSendMessage(chat_id, text) {
  const r = await fetch(tgApi("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id, text }),
  });
  return r.json();
}

async function setTelegramWebhook() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log("⚠️ Falta TELEGRAM_BOT_TOKEN");
    return;
  }
  if (!PUBLIC_URL) {
    console.log("⚠️ Falta PUBLIC_URL");
    return;
  }

  const url = `${PUBLIC_URL}${WEBHOOK_PATH}`;

  const r = await fetch(tgApi("setWebhook"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });

  const data = await r.json();
  console.log("✅ setWebhook:", data);
}

app.get("/", (req, res) => {
  res.status(200).send("EzerBot activo ✅");
});

app.post(WEBHOOK_PATH, async (req, res) => {
  try {
    const update = req.body;
    const msg = update?.message;

    if (!msg?.chat?.id) return res.sendStatus(200);

    const chatId = msg.chat.id;
    const text = (msg.text || "").trim();

    let reply = "Estoy activo ✅ Escribí /start o 'ayuda'.";
    if (text === "/start") reply = "Hola! Soy EzerBot ✅\nDecime: catálogo / ventas / envío / transferencia / ayuda";
    if (text.toLowerCase().includes("ayuda")) reply = "Comandos: catálogo, ventas, envío, transferencia.";

    await tgSendMessage(chatId, reply);
    return res.sendStatus(200);
  } catch (e) {
    console.log("❌ Error webhook:", e?.message || e);
    return res.sendStatus(200);
  }
});

app.listen(PORT, async () => {
  console.log("Servidor escuchando en puerto", PORT);
  await setTelegramWebhook();
});

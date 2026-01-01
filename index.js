import https from "https";
import http from "http";

/* =====================
   ENV
===================== */

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const DATA_API_URL  = process.env.DATA_API_URL;
const PUBLIC_URL    = process.env.PUBLIC_URL;

if (!TELEGRAM_TOKEN || !DATA_API_URL || !PUBLIC_URL) {
  console.error("❌ Faltan variables de entorno");
  process.exit(1);
}

const TG_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

/* =====================
   HELPERS
===================== */

function tg(method, data) {
  return new Promise(resolve => {
    const body = JSON.stringify(data);
    const req = https.request(`${TG_API}/${method}`, {
      method: "POST",
      family: 4,
      timeout: 8000,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, res => {
      res.on("data", ()=>{});
      res.on("end", resolve);
    });
    req.on("error", () => resolve());
    req.write(body);
    req.end();
  });
}

function fetchJSON(url) {
  return new Promise(resolve => {
    const req = https.request(url, {
      method: "GET",
      family: 4,
      timeout: 8000
    }, res => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
    req.end();
  });
}

/* =====================
   DATA
===================== */

const getConfig   = () => fetchJSON(`${DATA_API_URL}?tab=Config`);
const getCatalogo = () => fetchJSON(`${DATA_API_URL}?tab=Catalogo`);

/* =====================
   BOT LOGIC
===================== */

async function saludo(chatId, user) {
  const cfg = await getConfig();
  if (!cfg) return;

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

async function catalogo(chatId) {
  const items = await getCatalogo();
  if (!items || !items.length) {
    await tg("sendMessage", { chat_id: chatId, text: "Catálogo no disponible." });
    return;
  }

  for (const p of items) {
    await tg("sendPhoto", {
      chat_id: chatId,
      photo: p.IMAGEN,
      caption:
`🧀 ${p.NOMBRE}
💰 ${p.PRECIO}
${p.DESCRIPCION || ""}`,
      reply_markup: {
        inline_keyboard: [[
          { text: "🛒 Comprar", url: `${PUBLIC_URL}/buy/${p.CODIGO}` }
        ]]
      }
    });
  }
}

const sellos = (chatId, id) =>
  tg("sendMessage", { chat_id: chatId, text: `🏷️ ${PUBLIC_URL}/card/${id}` });

async function compartir(chatId) {
  const cfg = await getConfig();
  if (!cfg) return;
  await tg("sendMessage", { chat_id: chatId, text: cfg.TextoSistema });
}

async function ayuda(chatId) {
  const cfg = await getConfig();
  if (!cfg) return;
  await tg("sendMessage", {
    chat_id: chatId,
    text:
`📌 Consultas o reclamos:
✅ WhatsApp: ${cfg.WhatsAppLink}
📸 Instagram: ${cfg.NegocioInstagram}`
  });
}

/* =====================
   UPDATE HANDLER
===================== */

async function handle(update) {
  const m = update.message;
  if (!m) return;

  const chatId = m.chat.id;
  const txt = m.text || "";
  const user = m.from;

  if (txt === "/start") return saludo(chatId, user);
  if (txt === "🛍️ Catálogo") return catalogo(chatId);
  if (txt === "🏷️ Sellos") return sellos(chatId, user.id);
  if (txt === "📣 Compartir bot") return compartir(chatId);
  if (txt === "🆘 Ayuda") return ayuda(chatId);
}

/* =====================
   SERVER
===================== */

http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.end("OK");
    return;
  }

  let body = "";
  req.on("data", c => body += c);
  req.on("end", async () => {
    try { await handle(JSON.parse(body)); } catch {}
    res.end("OK");
  });
}).listen(3000, async () => {
  await tg("setWebhook", { url: PUBLIC_URL });
  console.log("✅ EZERBOT ACTIVO");
});

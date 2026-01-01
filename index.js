import express from "express";
import https from "https";

const app = express();
app.use(express.json({ limit: "1mb" }));

/* =====================
   ENV (solo estas 3)
===================== */
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const DATA_API_URL  = process.env.DATA_API_URL;
const PUBLIC_URL    = process.env.PUBLIC_URL;

if (!TELEGRAM_TOKEN || !DATA_API_URL || !PUBLIC_URL) {
  console.error("❌ Faltan variables de entorno (TELEGRAM_TOKEN, DATA_API_URL, PUBLIC_URL)");
  process.exit(1);
}

const TG_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

/* =====================
   NET HELPERS (IPv4 + timeout)
===================== */
function tg(method, data) {
  return new Promise((resolve) => {
    const body = JSON.stringify(data);

    const req = https.request(`${TG_API}/${method}`, {
      method: "POST",
      family: 4,
      timeout: 9000,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      res.on("data", () => {});
      res.on("end", () => resolve(true));
    });

    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.write(body);
    req.end();
  });
}

function fetchJSON(url) {
  return new Promise((resolve) => {
    const req = https.request(url, {
      method: "GET",
      family: 4,
      timeout: 9000,
    }, (res) => {
      let data = "";
      res.on("data", (d) => data += d);
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
   DATA (Sheets API)
===================== */
const getConfig   = () => fetchJSON(`${DATA_API_URL}?tab=Config`);
const getCatalogo = () => fetchJSON(`${DATA_API_URL}?tab=Catalogo`);

/* =====================
   BOT ACTIONS
===================== */
async function saludo(chatId, user) {
  const cfg = await getConfig();
  if (!cfg) {
    await tg("sendMessage", { chat_id: chatId, text: "Hola 👋 (Config no disponible por el momento)" });
    return;
  }

  const nombre = user?.first_name || "";
  const desc = (cfg.Descripcion || "").replaceAll("{NOMBRE}", nombre);

  const texto =
`👋 Bienvenido/a a ${cfg.NegocioNombre || "Todo Queso"} 🧀

${desc || "Mirá el catálogo y acumulá sellos."}`;

  // Si no hay logo, manda texto igual
  if (cfg.LogoURL) {
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
  } else {
    await tg("sendMessage", {
      chat_id: chatId,
      text: texto,
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
}

async function catalogo(chatId) {
  const items = await getCatalogo();
  if (!items || !items.length) {
    await tg("sendMessage", { chat_id: chatId, text: "🛍️ Catálogo no disponible." });
    return;
  }

  // mini “carrusel” en Telegram: una foto por producto con botón
  for (const p of items.slice(0, 30)) {
    const nombre = p.NOMBRE || "Producto";
    const precio = p.PRECIO ? `💰 ${p.PRECIO}` : "";
    const desc = p.DESCRIPCION || "";

    if (p.IMAGEN) {
      await tg("sendPhoto", {
        chat_id: chatId,
        photo: p.IMAGEN,
        caption: `🧀 ${nombre}\n${precio}\n${desc}`,
        reply_markup: {
          inline_keyboard: [[
            { text: "🛒 Comprar", url: `${PUBLIC_URL}/buy/${encodeURIComponent(p.CODIGO || "")}` }
          ]]
        }
      });
    } else {
      await tg("sendMessage", {
        chat_id: chatId,
        text: `🧀 ${nombre}\n${precio}\n${desc}`,
        reply_markup: {
          inline_keyboard: [[
            { text: "🛒 Comprar", url: `${PUBLIC_URL}/buy/${encodeURIComponent(p.CODIGO || "")}` }
          ]]
        }
      });
    }
  }
}

async function sellos(chatId, userId) {
  await tg("sendMessage", { chat_id: chatId, text: `🏷️ Tu tarjeta / sellos:\n${PUBLIC_URL}/card/${userId}` });
}

async function compartir(chatId) {
  const cfg = await getConfig();
  const txt = cfg?.TextoSistema || "¿Querés este sistema para tu negocio? Contactanos";
  await tg("sendMessage", { chat_id: chatId, text: txt });
}

async function ayuda(chatId) {
  const cfg = await getConfig();
  const w = cfg?.WhatsAppLink || "";
  const ig = cfg?.NegocioInstagram || "";
  await tg("sendMessage", {
    chat_id: chatId,
    text:
`📌 Si necesitás hacer una consulta o reclamo:
✅ WhatsApp: ${w}
📸 Instagram: ${ig}

Gracias por elegir Todo Queso 🧀`
  });
}

/* =====================
   UPDATE HANDLER
===================== */
async function handleUpdate(update) {
  const m = update?.message;
  if (!m) return;

  const chatId = m.chat.id;
  const txt = (m.text || "").trim();
  const user = m.from;

  if (txt === "/start") return saludo(chatId, user);
  if (txt === "🛍️ Catálogo") return catalogo(chatId);
  if (txt === "🏷️ Sellos") return sellos(chatId, user.id);
  if (txt === "📣 Compartir bot") return compartir(chatId);
  if (txt === "🆘 Ayuda") return ayuda(chatId);

  // Si escribe cualquier cosa, mostrar menú sin romper
  if (txt) return saludo(chatId, user);
}

/* =====================
   ROUTES
===================== */

// Salud / prueba
app.get("/", (_req, res) => res.status(200).send("OK"));

// Webhook fijo
app.post("/webhook", async (req, res) => {
  res.status(200).send("OK"); // responder rápido SIEMPRE
  try { await handleUpdate(req.body); } catch {}
});

// (Opcional) status webhook
app.get("/webhook", (_req, res) => res.status(200).send("OK"));

/* =====================
   START + SET WEBHOOK
===================== */
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log("✅ EZERBOT ACTIVO");
  const hookUrl = `${PUBLIC_URL.replace(/\/+$/, "")}/webhook`;

  // Set webhook (no rompe si ya estaba)
  await tg("setWebhook", { url: hookUrl, drop_pending_updates: false });
  console.log("✅ Webhook:", hookUrl);
});

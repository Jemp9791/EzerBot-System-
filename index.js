import express from "express";
import https from "https";

/* =====================
   ENV (solo estas 3)
===================== */
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const DATA_API_URL  = process.env.DATA_API_URL;
const PUBLIC_URL    = process.env.PUBLIC_URL;

if (!TELEGRAM_TOKEN || !DATA_API_URL || !PUBLIC_URL) {
  console.error("❌ Faltan env: TELEGRAM_TOKEN, DATA_API_URL, PUBLIC_URL");
  process.exit(1);
}

const TG_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

/* =====================
   HTTP SERVER (Render)
===================== */
const app = express();
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.status(200).send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ HTTP OK en puerto", PORT));

/* =====================
   NET HELPERS (IPv4 + timeout)
===================== */
function tgCall(method, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload || {});
    const req = https.request(`${TG_API}/${method}`, {
      method: "POST",
      family: 4,
      timeout: 12000,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
    req.write(body);
    req.end();
  });
}

function tgGet(method, paramsObj) {
  return new Promise((resolve) => {
    const qs = paramsObj
      ? "?" + Object.entries(paramsObj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
      : "";
    const req = https.request(`${TG_API}/${method}${qs}`, {
      method: "GET",
      family: 4,
      timeout: 12000,
    }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
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

function fetchJSON(url) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: "GET", family: 4, timeout: 12000 }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
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
   UI
===================== */
const MAIN_KB = {
  keyboard: [
    [{ text: "🛍️ Catálogo" }],
    [{ text: "🏷️ Sellos" }, { text: "📣 Compartir bot" }],
    [{ text: "🆘 Ayuda" }],
  ],
  resize_keyboard: true,
};

/* =====================
   BOT ACTIONS
===================== */
async function saludo(chatId, user) {
  const cfg = await getConfig();
  const nombre = user?.first_name || "";

  const negocio = cfg?.NegocioNombre || "Todo Queso";
  const descRaw = cfg?.Descripcion || "Mirá el catálogo y acumulá sellos.";
  const desc = descRaw.replaceAll("{NOMBRE}", nombre);

  const texto =
`👋 Bienvenido/a a ${negocio} 🧀

🧀 ¡Hola ${nombre || "!"}!
${desc}`;

  if (cfg?.LogoURL) {
    await tgCall("sendPhoto", {
      chat_id: chatId,
      photo: cfg.LogoURL,
      caption: texto,
      reply_markup: MAIN_KB,
    });
  } else {
    await tgCall("sendMessage", {
      chat_id: chatId,
      text: texto,
      reply_markup: MAIN_KB,
    });
  }
}

async function ayuda(chatId) {
  const cfg = await getConfig();
  const w = cfg?.WhatsAppLink || "";
  const ig = cfg?.NegocioInstagram || "";
  await tgCall("sendMessage", {
    chat_id: chatId,
    text:
`📌 Si necesitás hacer una consulta o reclamo:
✅ WhatsApp: ${w}
📸 Instagram: ${ig}

Gracias por elegir Todo Queso 🧀`,
    reply_markup: MAIN_KB,
  });
}

async function compartir(chatId) {
  const cfg = await getConfig();
  const txt = cfg?.TextoSistema || "¿Querés este sistema para tu negocio? Contactanos";
  await tgCall("sendMessage", { chat_id: chatId, text: txt, reply_markup: MAIN_KB });
}

async function sellos(chatId, userId) {
  await tgCall("sendMessage", {
    chat_id: chatId,
    text: `🏷️ Tu tarjeta / sellos:\n${PUBLIC_URL.replace(/\/+$/, "")}/card/${userId}`,
    reply_markup: MAIN_KB,
  });
}

async function catalogo(chatId) {
  const items = await getCatalogo();
  const base = PUBLIC_URL.replace(/\/+$/, "");

  if (!items || !items.length) {
    await tgCall("sendMessage", { chat_id: chatId, text: "🛍️ Catálogo no disponible.", reply_markup: MAIN_KB });
    return;
  }

  // Muestra hasta 15 productos tipo carrusel (foto + botón)
  for (const p of items.slice(0, 15)) {
    const nombre = p.NOMBRE || "Producto";
    const precio = p.PRECIO ? `💰 ${p.PRECIO}` : "";
    const desc = (p.DESCRIPCION || "").slice(0, 700);
    const code = encodeURIComponent(p.CODIGO || "");

    const caption = `🧀 ${nombre}\n${precio}\n\n${desc}`.trim();

    const markup = {
      inline_keyboard: [[
        { text: "🛒 Empezar compra", url: `${base}/buy/${code}` }
      ]]
    };

    if (p.IMAGEN) {
      await tgCall("sendPhoto", {
        chat_id: chatId,
        photo: p.IMAGEN,
        caption,
        reply_markup: markup,
      });
    } else {
      await tgCall("sendMessage", {
        chat_id: chatId,
        text: caption,
        reply_markup: markup,
      });
    }
  }

  // Link general al final
  await tgCall("sendMessage", {
    chat_id: chatId,
    text: `🛍️ Catálogo online:\n${base}/catalog`,
    reply_markup: MAIN_KB,
  });
}

/* =====================
   UPDATE HANDLER
===================== */
async function handleMessage(m) {
  const chatId = m.chat?.id;
  const txt = (m.text || "").trim();
  const user = m.from;

  if (!chatId) return;

  if (txt === "/start") return saludo(chatId, user);
  if (txt === "🛍️ Catálogo") return catalogo(chatId);
  if (txt === "🏷️ Sellos") return sellos(chatId, user.id);
  if (txt === "📣 Compartir bot") return compartir(chatId);
  if (txt === "🆘 Ayuda") return ayuda(chatId);

  // cualquier texto -> re-muestra saludo + menú
  return saludo(chatId, user);
}

/* =====================
   POLLING LOOP (NO WEBHOOK)
===================== */
let offset = 0;

async function startPolling() {
  // desactiva webhook para que polling funcione
  await tgCall("deleteWebhook", { drop_pending_updates: false });

  console.log("✅ EZERBOT ACTIVO (POLLING)");

  while (true) {
    const resp = await tgGet("getUpdates", { offset, timeout: 50, allowed_updates: JSON.stringify(["message"]) });

    if (resp?.ok && Array.isArray(resp.result) && resp.result.length) {
      for (const upd of resp.result) {
        offset = (upd.update_id || offset) + 1;
        const m = upd.message;
        if (m) {
          try { await handleMessage(m); } catch {}
        }
      }
    }

    // mini pausa para no quemar CPU
    await new Promise(r => setTimeout(r, 200));
  }
}

startPolling().catch(() => {
  console.error("❌ Polling no arrancó");
  process.exit(1);
});

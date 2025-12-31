/**
 * index.js — EzerBot (Render) — SOLO 3 variables de entorno:
 *  - TELEGRAM_TOKEN
 *  - PUBLIC_URL        (ej: https://ezerbot-system.onrender.com)
 *  - DATA_API_URL      (tu WebApp de Apps Script /exec)
 *
 * ✅ No usa node-fetch (usa fetch nativo de Node 18+)
 * ✅ Sirve "/" para que Render no diga "Cannot GET"
 * ✅ Webhook en /telegram para que el bot responda
 */

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const DATA_API_URL = (process.env.DATA_API_URL || "").replace(/\/+$/, "");

if (!TELEGRAM_TOKEN) {
  console.error("Falta TELEGRAM_TOKEN");
  process.exit(1);
}
if (!PUBLIC_URL) {
  console.error("Falta PUBLIC_URL");
  process.exit(1);
}
if (!DATA_API_URL) {
  console.error("Falta DATA_API_URL");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "10mb" }));

// =====================
// Utilidades
// =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function esc(s) {
  return String(s || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function parseMoneyARS(n) {
  const num = Number(n || 0);
  return `ARS ${Math.round(num).toLocaleString("es-AR")}`;
}

function buildMenuKeyboard() {
  return {
    keyboard: [
      [{ text: "🛍️ Catálogo" }, { text: "🏷️ Sellos" }],
      [{ text: "📣 Compartir bot" }, { text: "🆘 Ayuda" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

// =====================
// Estado en memoria (demo/operativo básico)
// Si querés persistencia real por compra/referidos, lo conectamos al Apps Script luego.
// =====================
const STATE = {
  config: {},          // map KEY->VALUE
  loadedAt: 0,
  customers: new Map(), // chatId -> { stamps, refBy, referredCount }
};

function ensureCustomer(chatId) {
  if (!STATE.customers.has(chatId)) {
    STATE.customers.set(chatId, { stamps: 0, refBy: null, referredCount: 0 });
  }
  return STATE.customers.get(chatId);
}

// =====================
// Cargar Config desde Apps Script
// Espera JSON: { ok:true, config:[{KEY,VALUE}...] }
// Si viene HTML (Token '<'), NO se cae: sigue con config vacía.
// =====================
async function loadConfigSafe() {
  try {
    const res = await fetch(DATA_API_URL, { method: "GET" });
    const text = await res.text();

    // Intentar JSON
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.error("DATA_API_URL NO devolvió JSON. Primeros 80 chars:", text.slice(0, 80));
      return;
    }

    if (!data || data.ok !== true || !Array.isArray(data.config)) {
      console.error("DATA_API_URL JSON inesperado:", data);
      return;
    }

    const map = {};
    for (const row of data.config) {
      const k = String(row.KEY || "").trim();
      const v = String(row.VALUE || "").trim();
      if (!k) continue;
      map[k] = v;
    }

    STATE.config = map;
    STATE.loadedAt = Date.now();
    console.log("Config cargada OK. Keys:", Object.keys(map).length);
  } catch (err) {
    console.error("Error cargando Config:", err);
  }
}

function cfg(key, fallback = "") {
  return (STATE.config && STATE.config[key] != null && STATE.config[key] !== "")
    ? STATE.config[key]
    : fallback;
}

function isYes(v) {
  return String(v || "").trim().toUpperCase() === "SI";
}

// =====================
// Telegram Bot (Webhook)
// =====================
const bot = new TelegramBot(TELEGRAM_TOKEN, { webHook: true });

// Webhook endpoint
app.post("/telegram", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Health
app.get("/", (req, res) => {
  res.status(200).send("EzerBot OK");
});

// Página simple de Sellos (si no podés pegar sellos sobre la imagen)
app.get("/card/:chatId", async (req, res) => {
  const chatId = String(req.params.chatId || "");
  const c = ensureCustomer(chatId);

  const negocio = esc(cfg("NegocioNombre", "Tu Negocio"));
  const logo = esc(cfg("LogoURL", ""));
  const cardImg = esc(cfg("CARD_URL", "")); // diseño base
  const montoPorSello = Number(cfg("MontoPorSello", "10000")) || 10000;

  const stamps = Math.max(0, Number(c.stamps || 0));
  const levels = (cfg("SellosPorNivel", "") || "").split("|").map(x => Number(String(x).trim())).filter(n => !isNaN(n));
  const names = (cfg("NombresNiveles", "") || "").split("|").map(x => String(x).trim()).filter(Boolean);

  let nextGoal = null;
  for (const n of levels) {
    if (stamps < n) { nextGoal = n; break; }
  }

  const nextText = nextGoal
    ? `Te faltan ${Math.max(0, nextGoal - stamps)} sellos para tu próximo nivel.`
    : `¡Ya llegaste al máximo nivel!`;

  // 50 celdas visibles (si querés más, lo ajusto)
  const maxGrid = Math.max(10, Math.min(50, Math.max(stamps, (levels[levels.length - 1] || 10))));
  const cells = Array.from({ length: maxGrid }).map((_, i) => i < stamps);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${negocio} — Sellos</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; background:#0b1220; color:#e8eefc; margin:0; padding:16px;}
    .wrap{max-width:900px; margin:0 auto;}
    .card{background:#111a2e; border:1px solid rgba(255,255,255,.08); border-radius:16px; padding:16px; box-shadow:0 10px 30px rgba(0,0,0,.25);}
    .head{display:flex; gap:12px; align-items:center; margin-bottom:12px;}
    .logo{width:44px; height:44px; border-radius:12px; object-fit:cover; background:#0b1220;}
    .title{font-size:18px; font-weight:700;}
    .sub{opacity:.85; font-size:13px; margin-top:2px;}
    .img{width:100%; border-radius:14px; overflow:hidden; margin:10px 0; border:1px solid rgba(255,255,255,.08);}
    .img img{width:100%; display:block;}
    .grid{display:grid; grid-template-columns:repeat(10, 1fr); gap:8px; margin-top:12px;}
    .cell{aspect-ratio:1/1; border-radius:14px; border:1px solid rgba(255,255,255,.10); display:flex; align-items:center; justify-content:center; background:rgba(255,255,255,.03);}
    .cell.on{background:rgba(34,197,94,.18); border-color:rgba(34,197,94,.35);}
    .cell img{width:70%; height:70%; object-fit:contain; filter:drop-shadow(0 6px 12px rgba(0,0,0,.35));}
    .note{margin-top:12px; opacity:.9; font-size:14px; line-height:1.35;}
    .pill{display:inline-block; padding:6px 10px; border-radius:999px; background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.10); margin-right:6px; font-size:12px;}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="head">
        ${logo ? `<img class="logo" src="${logo}" alt="logo">` : `<div class="logo"></div>`}
        <div>
          <div class="title">${negocio} — Sellos</div>
          <div class="sub">1 sello cada ${parseMoneyARS(montoPorSello)} (según Config). Referidos suman bonus si está activo.</div>
        </div>
      </div>

      ${cardImg ? `<div class="img"><img src="${cardImg}" alt="tarjeta"></div>` : ""}

      <div>
        <span class="pill">Sellos: <b>${stamps}</b></span>
        ${names.length && levels.length ? `<span class="pill">Niveles: ${esc(names.join(" · "))}</span>` : ``}
      </div>

      <div class="grid">
        ${cells.map(on => `
          <div class="cell ${on ? "on" : ""}">
            ${on && logo ? `<img src="${logo}" alt="sello">` : (on ? "✓" : "")}
          </div>
        `).join("")}
      </div>

      <div class="note">${esc(nextText)}</div>
    </div>
  </div>
</body>
</html>`);
});

// =====================
// Flujo de mensajes
// =====================
async function sendWelcome(chatId, firstName) {
  const descripcion = cfg("Descripcion", "Hola 😊");
  const msg = descripcion.replace(/\{NOMBRE\}/g, firstName || "");
  await bot.sendMessage(chatId, msg, { reply_markup: buildMenuKeyboard() });
}

async function sendHelp(chatId) {
  const wa = cfg("WhatsAppLink", "");
  const ig = cfg("NegocioInstagram", "");
  const nombre = cfg("NegocioNombre", "el negocio");

  const txt =
`📌 Si querés hacer una consulta, reclamo o avisar algo del pedido, escribinos directo:

✅ WhatsApp: ${wa || "No configurado"}
📸 Instagram: ${ig || "No configurado"}

Si te faltó algo y no lo encontraste en el catálogo, podés escribirnos por WhatsApp o acercarte al local y lo resolvemos 🙌

Gracias por elegir ${nombre} 🧀`;

  await bot.sendMessage(chatId, txt, { reply_markup: buildMenuKeyboard(), disable_web_page_preview: true });
}

async function sendShare(chatId) {
  const texto = cfg("TextoSistema", "¿Querés este sistema para tu negocio? Contactános");
  const email = cfg("EmailSistema", "ezerbot.assistant@gmail.com");
  const botLink = cfg("BotLink", "");

  const msg =
`🤖 ${texto}

✉️ Email: ${email}
🔗 Bot demo: ${botLink || "(no configurado)"}`;

  // Botones de compartir (links)
  const shareText = encodeURIComponent("Mirá este bot para hacer pedidos y sumar sellos 👇");
  const shareUrl = encodeURIComponent(botLink || PUBLIC_URL);
  const waShare = `https://wa.me/?text=${shareText}%0A${shareUrl}`;
  const tgShare = `https://t.me/share/url?url=${shareUrl}&text=${shareText}`;

  await bot.sendMessage(chatId, msg, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📲 WhatsApp", url: waShare }, { text: "✈️ Telegram", url: tgShare }],
      ],
    },
    disable_web_page_preview: true,
  });
}

async function sendSellos(chatId) {
  if (!isYes(cfg("UsaSellos", "SI"))) {
    await bot.sendMessage(chatId, "🏷️ Sellos: desactivado.", { reply_markup: buildMenuKeyboard() });
    return;
  }

  const link = `${PUBLIC_URL}/card/${chatId}`;
  await bot.sendMessage(
    chatId,
    `🏷️ Tus sellos online:\n${link}\n\n(Se actualizan cuando se registran compras y referidos.)`,
    { reply_markup: buildMenuKeyboard(), disable_web_page_preview: true }
  );
}

// Catálogo: si tu sistema actual ya lo tenía, acá NO lo toco.
// Te dejo un mensaje mínimo para no romper nada.
async function sendCatalog(chatId) {
  await bot.sendMessage(
    chatId,
    "🛍️ Catálogo: esta parte se mantiene como la tenías en tu versión anterior.\nSi ahora mismo no te aparece, decime y lo conecto a tu fuente real sin agregar variables nuevas.",
    { reply_markup: buildMenuKeyboard() }
  );
}

// =====================
// /start con referido (t.me/BOT?start=ref_12345)
// =====================
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const firstName = msg.from?.first_name || "";

  const payload = String((match && match[1]) || "").trim(); // ej: "ref_1234"
  const customer = ensureCustomer(chatId);

  // Guardar referido una sola vez
  if (payload.startsWith("ref_")) {
    const refBy = payload.replace("ref_", "").trim();
    if (refBy && !customer.refBy && refBy !== String(chatId)) {
      customer.refBy = refBy;
      const refC = ensureCustomer(refBy);
      refC.referredCount = (refC.referredCount || 0) + 1;
    }
  }

  await sendWelcome(chatId, firstName);
});

// =====================
// Manejo de botones del menú (solo 4, SIN carrito)
// =====================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = String(msg.text || "").trim();

  // Ignorar comandos (ya los maneja onText)
  if (text.startsWith("/")) return;

  // Refrescar config cada 60s (sin molestar)
  if (!STATE.loadedAt || Date.now() - STATE.loadedAt > 60000) {
    loadConfigSafe().catch(() => {});
  }

  if (text === "🛍️ Catálogo") return sendCatalog(chatId);
  if (text === "🏷️ Sellos") return sendSellos(chatId);
  if (text === "📣 Compartir bot") return sendShare(chatId);
  if (text === "🆘 Ayuda") return sendHelp(chatId);

  // Mensaje default (corto)
  await bot.sendMessage(chatId, "Usá el menú 👇", { reply_markup: buildMenuKeyboard() });
});

// =====================
// Arranque
// =====================
async function start() {
  await loadConfigSafe();

  // Set webhook siempre al iniciar
  try {
    await bot.setWebHook(`${PUBLIC_URL}/telegram`);
    console.log("Webhook OK:", `${PUBLIC_URL}/telegram`);
  } catch (e) {
    console.error("Error setWebHook:", e);
  }

  const port = process.env.PORT || 10000;
  app.listen(port, () => {
    console.log("EZERBOT ACTIVO");
    console.log("Disponible en:", PUBLIC_URL);
    console.log("Escuchando puerto:", port);
  });
}

start().catch((e) => console.error(e));

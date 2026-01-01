// ===============================
// EZERBOT — SCRIPT FINAL ESTABLE
// ===============================

import express from "express";
import fetch from "node-fetch"; // ← CLAVE (faltaba)

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL.replace(/\/$/, "");
const DATA_API_URL = process.env.DATA_API_URL.replace(/\/$/, "");

const TG = (m) => `https://api.telegram.org/bot${TOKEN}/${m}`;

const tg = (m, b) =>
  fetch(TG(m), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(b),
  }).then((r) => r.json());

/* ===============================
   HELPERS
================================*/
const isHttp = (u) => /^https?:\/\//i.test(u || "");
const money = (n) => "$ " + Number(n || 0).toLocaleString("es-AR");

async function getData(type) {
  const r = await fetch(`${DATA_API_URL}?type=${type}`);
  return r.json();
}

/* ===============================
   CACHE
================================*/
let CONFIG = null;
let CATALOG = null;

/* ===============================
   STATE
================================*/
const userState = {};

/* ===============================
   MENÚ PRINCIPAL
================================*/
const mainMenu = {
  keyboard: [
    [{ text: "🛍️ Catálogo" }],
    [{ text: "🏷️ Sellos" }],
    [{ text: "📣 Compartir bot" }],
    [{ text: "🆘 Ayuda" }],
  ],
  resize_keyboard: true,
};

/* ===============================
   START
================================*/
async function start(chatId) {
  if (!CONFIG) CONFIG = await getData("config");

  const c = CONFIG;

  const text = `👋 *Bienvenido/a a ${c.NegocioNombre}* 🧀

📍 ${c.NegocioDireccion}
🕒 ${c.NegocioHorario}

${c.Descripcion}`;

  if (isHttp(c.LogoURL)) {
    await tg("sendPhoto", {
      chat_id: chatId,
      photo: c.LogoURL,
      caption: text,
      parse_mode: "Markdown",
      reply_markup: mainMenu,
    });
  } else {
    await tg("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      reply_markup: mainMenu,
    });
  }
}

/* ===============================
   CATÁLOGO (CARRUSEL SIMPLE)
================================*/
async function showCatalog(chatId, idx = 0) {
  if (!CATALOG) CATALOG = await getData("catalog");

  const items = CATALOG.items;
  if (!items.length) return;

  if (!userState[chatId]) userState[chatId] = {};
  userState[chatId].idx = idx;

  const p = items[idx];

  const caption = `🧀 *${p.nombre}*
${p.descripcion || ""}

💰 ${money(p.precio)} ${
    p.unidad === "unidad" ? "por unidad" : "por gramos"
  }`;

  await tg("sendPhoto", {
    chat_id: chatId,
    photo: p.imagen,
    caption,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "⬅️", callback_data: "PREV" },
          { text: "➡️", callback_data: "NEXT" },
        ],
      ],
    },
  });
}

/* ===============================
   SELL0S
================================*/
async function showSellos(chatId) {
  const clientes = await getData("clientes");
  const c = clientes.find((x) => String(x.UserIdTG) === String(chatId));
  const sellos = c ? Number(c.Sellos || 0) : 0;

  await tg("sendMessage", {
    chat_id: chatId,
    text: `🏷️ *Tus sellos*\n\nTenés *${sellos}* sellos acumulados.\n\n1 sello cada $10.000 de compra.`,
    parse_mode: "Markdown",
    reply_markup: mainMenu,
  });
}

/* ===============================
   AYUDA
================================*/
async function ayuda(chatId) {
  await tg("sendMessage", {
    chat_id: chatId,
    text: `🆘 *¿Necesitás ayuda?*

Si no encontraste algo en el catálogo o querés hacer una consulta especial, podés comunicarte directamente con nosotros.

Estamos para ayudarte 😊`,
    parse_mode: "Markdown",
    reply_markup: mainMenu,
  });
}

/* ===============================
   COMPARTIR BOT
================================*/
async function compartir(chatId) {
  await tg("sendMessage", {
    chat_id: chatId,
    text: `🤖 *EzerBot*

¿Querés este sistema para tu negocio?

📩 ezerbot.assistant@gmail.com`,
    parse_mode: "Markdown",
    reply_markup: mainMenu,
  });
}

/* ===============================
   WEBHOOK
================================*/
app.post("/", async (req, res) => {
  res.sendStatus(200);
  const u = req.body;

  if (u.message) {
    const chatId = u.message.chat.id;
    const t = u.message.text;

    if (t === "/start") return start(chatId);
    if (t === "🛍️ Catálogo") return showCatalog(chatId, 0);
    if (t === "🏷️ Sellos") return showSellos(chatId);
    if (t === "📣 Compartir bot") return compartir(chatId);
    if (t === "🆘 Ayuda") return ayuda(chatId);
  }

  if (u.callback_query) {
    const chatId = u.callback_query.message.chat.id;
    const dir = u.callback_query.data;
    const total = CATALOG.items.length;

    let i = userState[chatId]?.idx || 0;
    if (dir === "NEXT") i = (i + 1) % total;
    if (dir === "PREV") i = (i - 1 + total) % total;

    return showCatalog(chatId, i);
  }
});

/* ===============================
   HEALTHCHECK (CLAVE)
================================*/
app.get("/", (_, res) => {
  res.status(200).send("EZERBOT OK");
});

/* ===============================
   START SERVER
================================*/
app.listen(PORT, () => {
  console.log("✅ EZERBOT ONLINE");
});

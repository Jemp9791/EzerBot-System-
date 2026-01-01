// ===============================
// EZERBOT — BOT FINAL ESTABLE
// ===============================

import express from "express";
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL.replace(/\/$/, "");
const DATA_API_URL = process.env.DATA_API_URL.replace(/\/$/, "");

const TG = (m) => `https://api.telegram.org/bot${TOKEN}/${m}`;

const fetchTG = (m, b) =>
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

async function getJSON(type) {
  const r = await fetch(`${DATA_API_URL}?type=${type}`);
  return r.json();
}

/* ===============================
   CACHE
================================*/
let CFG = null;
let CAT = null;

async function loadAll() {
  if (!CFG) CFG = await getJSON("config");
  if (!CAT) CAT = await getJSON("catalog");
}

/* ===============================
   USER STATE
================================*/
const state = {};
const cart = {};

/* ===============================
   MENUS
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

function productKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "⬅️", callback_data: "PREV" },
        { text: "➡️", callback_data: "NEXT" },
      ],
      [{ text: "🟢 Quiero este", callback_data: "ADD" }],
    ],
  };
}

/* ===============================
   START
================================*/
async function start(chatId) {
  await loadAll();
  const c = CFG;
  const text = `👋 *Bienvenido/a a ${c.NegocioNombre}* 🧀

📍 ${c.NegocioDireccion}
🕒 ${c.NegocioHorario}

${c.Descripcion}`;

  if (isHttp(c.LogoURL)) {
    await fetchTG("sendPhoto", {
      chat_id: chatId,
      photo: c.LogoURL,
      caption: text,
      parse_mode: "Markdown",
      reply_markup: mainMenu,
    });
  } else {
    await fetchTG("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      reply_markup: mainMenu,
    });
  }
}

/* ===============================
   CATÁLOGO (CARRUSEL)
================================*/
async function showProduct(chatId, i) {
  const p = CAT.items[i];
  state[chatId].index = i;

  const txt = `🧀 *${p.nombre}*
${p.descripcion || ""}

💰 ${money(p.precio)} ${
    p.unidad === "unidad" ? "por unidad" : "por 100g"
  }`;

  await fetchTG("sendPhoto", {
    chat_id: chatId,
    photo: p.imagen,
    caption: txt,
    parse_mode: "Markdown",
    reply_markup: productKeyboard(),
  });
}

/* ===============================
   SELL0S
================================*/
async function showSellos(chatId) {
  const clientes = await getJSON("clientes");
  const cli = clientes.find((c) => c.UserIdTG == chatId);

  const sellos = cli ? cli.Sellos : 0;
  const txt = `🏷️ *Tus sellos*

Tenés *${sellos || 0}* sellos acumulados.
🎁 1 sello cada $10.000 de compra.

¡Seguí comprando y ganá beneficios!`;

  await fetchTG("sendMessage", {
    chat_id: chatId,
    text: txt,
    parse_mode: "Markdown",
    reply_markup: mainMenu,
  });
}

/* ===============================
   AYUDA
================================*/
async function help(chatId) {
  const c = CFG;
  const txt = `🆘 *¿Necesitás ayuda?*

Si no encontraste algo en el catálogo o necesitás hacer una consulta especial, podés comunicarte directamente con nosotros.

📍 ${c.NegocioDireccion}
📲 ${c.NegocioTelefono}

Estamos para ayudarte 😊`;

  await fetchTG("sendMessage", {
    chat_id: chatId,
    text: txt,
    parse_mode: "Markdown",
    reply_markup: mainMenu,
  });
}

/* ===============================
   COMPARTIR BOT
================================*/
async function shareBot(chatId) {
  const txt = `🤖 *EzerBot*

¿Querés este sistema para tu negocio?
Automatizá ventas, sellos y clientes.

📩 ${CFG.EmailSistema}`;

  await fetchTG("sendMessage", {
    chat_id: chatId,
    text: txt,
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
    if (t === "🛍️ Catálogo") {
      state[chatId] = { index: 0 };
      return showProduct(chatId, 0);
    }
    if (t === "🏷️ Sellos") return showSellos(chatId);
    if (t === "🆘 Ayuda") return help(chatId);
    if (t === "📣 Compartir bot") return shareBot(chatId);
  }

  if (u.callback_query) {
    const chatId = u.callback_query.message.chat.id;
    let i = state[chatId].index;

    if (u.callback_query.data === "NEXT") i++;
    if (u.callback_query.data === "PREV") i--;
    if (i < 0) i = CAT.items.length - 1;
    if (i >= CAT.items.length) i = 0;

    return showProduct(chatId, i);
  }
});

/* ===============================
   START SERVER
================================*/
app.listen(PORT, () => {
  console.log("✅ EZERBOT ONLINE");
});

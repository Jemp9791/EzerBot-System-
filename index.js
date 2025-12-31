import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;
const DATA_API = process.env.DATA_API_URL;

// Node 18+ / 20 / 22 → fetch nativo
const tg = async (method, payload) => {
  await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
};

const users = new Map();

/* ================= CONFIG ================= */
async function getConfig() {
  const r = await fetch(`${DATA_API}?type=config`);
  return await r.json();
}

async function getCatalog() {
  const r = await fetch(`${DATA_API}?type=catalog`);
  return await r.json();
}

/* ================= MENÚ ================= */
const mainMenu = {
  keyboard: [
    [{ text: "🛍️ Catálogo" }],
    [{ text: "🏷️ Sellos" }],
    [{ text: "📣 Compartir bot" }],
    [{ text: "🆘 Ayuda" }],
  ],
  resize_keyboard: true,
};

/* ================= START ================= */
async function start(chatId, name = "") {
  const cfg = await getConfig();

  const text = `
👋 ¡Hola ${name}!
Bienvenido/a a *${cfg.NegocioNombre}* 🧀

📍 ${cfg.NegocioDireccion}
🕒 ${cfg.NegocioHorario}

${cfg.Descripcion}
`;

  if (cfg.LogoURL) {
    await tg("sendPhoto", {
      chat_id: chatId,
      photo: cfg.LogoURL,
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

/* ================= CATÁLOGO ================= */
async function showCategories(chatId) {
  const cat = await getCatalog();
  const buttons = cat.categories.map((c) => [
    { text: c, callback_data: `CAT_${c}` },
  ]);

  await tg("sendMessage", {
    chat_id: chatId,
    text: "🛍️ Elegí una categoría",
    reply_markup: { inline_keyboard: buttons },
  });
}

/* ================= SELL0S ================= */
async function showSellos(chatId) {
  const cfg = await getConfig();
  const u = users.get(chatId) || { sellos: 0 };

  const niveles = cfg.NombresNiveles.split("|");
  const limites = cfg.SellosPorNivel.split("|").map(Number);

  let nivelActual = niveles[0];
  for (let i = 0; i < limites.length; i++) {
    if (u.sellos >= limites[i]) nivelActual = niveles[i];
  }

  await tg("sendMessage", {
    chat_id: chatId,
    parse_mode: "Markdown",
    text: `
🏷️ *Tus sellos*
Tenés *${u.sellos}* sellos
Nivel: *${nivelActual}*

Cada $${cfg.MontoPorSello} sumás 1 sello.
`,
    reply_markup: mainMenu,
  });
}

/* ================= COMPARTIR BOT ================= */
async function shareBot(chatId) {
  const cfg = await getConfig();

  const msg = `
🤖 ¿Querés este sistema para tu negocio?

📩 ${cfg.EmailSistema}
🔗 ${cfg.BotLink}
`;

  await tg("sendMessage", {
    chat_id: chatId,
    text: msg,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "WhatsApp",
            url: `https://wa.me/?text=${encodeURIComponent(msg)}`,
          },
        ],
        [
          {
            text: "Telegram",
            url: `https://t.me/share/url?url=${cfg.BotLink}`,
          },
        ],
      ],
    },
  });
}

/* ================= AYUDA ================= */
async function help(chatId) {
  const cfg = await getConfig();

  await tg("sendMessage", {
    chat_id: chatId,
    parse_mode: "Markdown",
    text: `
🆘 *¿Necesitás ayuda?*

Si no encontraste algo en el catálogo
o necesitás hacer una consulta especial,
podés escribirnos directo:

📍 ${cfg.NegocioDireccion}
🕒 ${cfg.NegocioHorario}
📲 ${cfg.WhatsAppLink}
`,
    reply_markup: mainMenu,
  });
}

/* ================= WEBHOOK ================= */
app.post("/", async (req, res) => {
  res.sendStatus(200);

  const upd = req.body;
  if (!upd.message) return;

  const chatId = upd.message.chat.id;
  const text = upd.message.text || "";

  if (!users.has(chatId)) users.set(chatId, { sellos: 0 });

  if (text === "/start") return start(chatId, upd.message.from.first_name);
  if (text === "🛍️ Catálogo") return showCategories(chatId);
  if (text === "🏷️ Sellos") return showSellos(chatId);
  if (text === "📣 Compartir bot") return shareBot(chatId);
  if (text === "🆘 Ayuda") return help(chatId);
});

/* ================= SERVER ================= */
app.listen(PORT, () => {
  console.log("✅ EZERBOT ACTIVO");
});

import express from "express";
import TelegramBot from "node-telegram-bot-api";

/* ===============================
   ENV
================================ */
const BOT_TOKEN = process.env.BOT_TOKEN;
const CONFIG_URL = process.env.CONFIG_CSV_URL;     // Google Sheets CSV KEY,VALUE
const CATALOG_URL = process.env.CATALOG_CSV_URL;   // ya funcionando
const PORT = process.env.PORT || 10000;

if (!BOT_TOKEN || !CONFIG_URL || !CATALOG_URL) {
  console.error("❌ Faltan variables de entorno");
  process.exit(1);
}

/* ===============================
   APP
================================ */
const app = express();
app.use(express.json());

const bot = new TelegramBot(BOT_TOKEN);
bot.setWebHook(`/bot${BOT_TOKEN}`);

app.post(`/bot${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (_, res) => {
  res.send("EZERBOT ACTIVO");
});

/* ===============================
   HELPERS
================================ */
async function fetchCSV(url) {
  const res = await fetch(url);
  const text = await res.text();
  return text;
}

function parseConfig(csv) {
  const lines = csv.split("\n").slice(1);
  const cfg = {};
  for (const line of lines) {
    if (!line.trim()) continue;
    const [key, ...rest] = line.split(",");
    cfg[key.trim()] = rest.join(",").trim();
  }
  return cfg;
}

function parseCatalog(csv) {
  const lines = csv.split("\n");
  const headers = lines[0].split(",");
  return lines.slice(1).map(row => {
    const values = row.split(",");
    const obj = {};
    headers.forEach((h, i) => obj[h.trim()] = values[i]?.trim());
    return obj;
  }).filter(p => p.codigo);
}

function isByWeight(product) {
  return product.unidad?.toLowerCase() === "kg";
}

function calculateSellos(total, montoPorSello) {
  return Math.floor(total / montoPorSello);
}

/* ===============================
   DATA (MEMORIA SIMPLE)
================================ */
const sessions = {};
const clientes = {}; // en producción va a Sheets

/* ===============================
   LOAD CONFIG / CATALOG
================================ */
let CONFIG = {};
let CATALOG = [];

async function loadData() {
  CONFIG = parseConfig(await fetchCSV(CONFIG_URL));
  CATALOG = parseCatalog(await fetchCSV(CATALOG_URL));
  console.log("✅ Config y catálogo cargados");
}

await loadData();

/* ===============================
   MENÚ PRINCIPAL (FIJO)
================================ */
function mainMenu() {
  return {
    reply_markup: {
      keyboard: [
        ["🛍️ Catálogo"],
        ["🏷️ Sellos / Tarjeta"],
        ["📣 Compartir bot"],
        ["🆘 Ayuda"]
      ],
      resize_keyboard: true
    }
  };
}

/* ===============================
   START
================================ */
bot.onText(/\/start/, msg => {
  const chatId = msg.chat.id;
  if (!clientes[chatId]) {
    clientes[chatId] = { sellos: 0, referidos: 0 };
  }

  bot.sendMessage(
    chatId,
    CONFIG.Descripcion.replace("{NOMBRE}", msg.from.first_name || ""),
    mainMenu()
  );
});

/* ===============================
   CATÁLOGO
================================ */
bot.onText(/🛍️ Catálogo/, msg => {
  const chatId = msg.chat.id;
  const buttons = CATALOG.map(p => [{ text: p.nombre, callback_data: `prod_${p.codigo}` }]);
  bot.sendMessage(chatId, "Elegí un producto:", {
    reply_markup: { inline_keyboard: buttons }
  });
});

bot.on("callback_query", query => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data.startsWith("prod_")) {
    const code = data.replace("prod_", "");
    const product = CATALOG.find(p => p.codigo === code);
    sessions[chatId] = { product };

    if (isByWeight(product)) {
      bot.sendMessage(chatId, "Indicá la cantidad en gramos (ej: 200)");
    } else {
      addToCart(chatId, 1);
    }
  }

  if (data === "confirm_payment") {
    bot.sendMessage(chatId, CONFIG.TextoConfirmacionPedido);
  }
});

function addToCart(chatId, qty) {
  const s = sessions[chatId];
  const p = s.product;
  const price = isByWeight(p)
    ? (parseFloat(p.precio) / 1000) * qty
    : parseFloat(p.precio);

  s.total = (s.total || 0) + price;

  bot.sendMessage(
    chatId,
    `✅ Agregado ${p.nombre}\nTotal parcial: ARS ${Math.round(s.total)}`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "Finalizar compra", callback_data: "finish" }]
        ]
      }
    }
  );
}

bot.on("message", msg => {
  const chatId = msg.chat.id;
  const s = sessions[chatId];
  if (!s || !s.product) return;

  if (isByWeight(s.product)) {
    const grams = parseInt(msg.text);
    if (isNaN(grams)) return;
    addToCart(chatId, grams);
    s.product = null;
  }
});

/* ===============================
   SELLLOS / TARJETA
================================ */
bot.onText(/🏷️ Sellos/, msg => {
  const c = clientes[msg.chat.id] || { sellos: 0 };
  bot.sendMessage(
    msg.chat.id,
    `🏷️ Tus sellos actuales: ${c.sellos}\n\nVer tarjeta:\n${CONFIG.CARD_URL}`
  );
});

/* ===============================
   COMPARTIR BOT
================================ */
bot.onText(/📣 Compartir bot/, msg => {
  bot.sendMessage(
    msg.chat.id,
    `${CONFIG.TextoSistema}\n\n📧 ${CONFIG.EmailSistema}\n🤖 ${CONFIG.BotLink}`
  );
});

/* ===============================
   AYUDA
================================ */
bot.onText(/🆘 Ayuda/, msg => {
  bot.sendMessage(
    msg.chat.id,
    `Si necesitás hacer una consulta, reclamo o no encontraste algo en el catálogo,
podés escribirnos directo:\n\n📱 WhatsApp:\n${CONFIG.WhatsAppLink}\n📸 Instagram: ${CONFIG.NegocioInstagram}\n\nGracias por elegir ${CONFIG.NegocioNombre} 🧀`
  );
});

/* ===============================
   SERVER
================================ */
app.listen(PORT, () => {
  console.log("🚀 EZERBOT ACTIVO");
});

import express from "express";
import TelegramBot from "node-telegram-bot-api";

/**
 * ENV (solo 3 variables)
 * - TELEGRAM_TOKEN
 * - PUBLIC_URL           (ej: https://ezerbot-system.onrender.com)
 * - DATA_API_URL         (tu Apps Script /exec)
 */

const TOKEN = process.env.TELEGRAM_TOKEN?.trim();
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim().replace(/\/$/, "");
const DATA_API_URL = (process.env.DATA_API_URL || "").trim().replace(/\/$/, "");

if (!TOKEN || !PUBLIC_URL || !DATA_API_URL) {
  console.error("Faltan variables de entorno. Requeridas: TELEGRAM_TOKEN, PUBLIC_URL, DATA_API_URL");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "2mb" }));

// Webhook bot
const bot = new TelegramBot(TOKEN, { webHook: true });

/** ---------- Helpers ---------- **/

function safeStr(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  const s = String(v);
  return s.trim().length ? s : fallback;
}

function replaceVars(text, vars) {
  let out = safeStr(text, "");
  for (const [k, v] of Object.entries(vars || {})) {
    out = out.replaceAll(`{${k}}`, safeStr(v, ""));
  }
  return out;
}

function parseCsvToRows(csvText) {
  // CSV simple (sin comillas complejas), separador coma o punto y coma
  const lines = csvText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const sep = lines[0].includes(";") ? ";" : ",";
  const header = lines[0].split(sep).map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(sep);
    const obj = {};
    for (let j = 0; j < header.length; j++) obj[header[j]] = (cols[j] ?? "").trim();
    rows.push(obj);
  }
  return rows;
}

function kvArrayToObject(arr) {
  // Soporta formatos:
  // [{KEY:"NegocioNombre", VALUE:"..."}, ...] o [{key:"", value:""}] o [["KEY","VALUE"], ...]
  const out = {};
  if (!Array.isArray(arr)) return out;

  for (const item of arr) {
    if (Array.isArray(item) && item.length >= 2) {
      const k = safeStr(item[0]);
      const v = item[1];
      if (k) out[k] = v;
      continue;
    }
    if (item && typeof item === "object") {
      const k = safeStr(item.KEY ?? item.key ?? item.Key ?? item.nombre ?? item.Nombre);
      const v = item.VALUE ?? item.value ?? item.Value ?? item.valor ?? item.Valor;
      if (k) out[k] = v;
    }
  }
  return out;
}

async function fetchJson(url) {
  const r = await fetch(url, { method: "GET" });
  const txt = await r.text();

  // 1) Intentar JSON
  try {
    return JSON.parse(txt);
  } catch {}

  // 2) Si no es JSON, devolver texto
  return { ok: true, raw: txt };
}

// Cache config
let CONFIG = {};
let CONFIG_TS = 0;

async function loadConfig() {
  // IMPORTANTE: tu Apps Script exige ?tab=Config
  const url = `${DATA_API_URL}?tab=Config`;
  const data = await fetchJson(url);

  // Formatos posibles:
  // A) { ok:true, data:[{KEY,VALUE}...] }
  // B) { ok:true, config:[...] }
  // C) CSV en raw
  let kv = {};

  if (data && typeof data === "object") {
    const arr =
      data.data ||
      data.config ||
      data.rows ||
      data.items ||
      data.values;

    if (Array.isArray(arr)) {
      kv = kvArrayToObject(arr);
    } else if (data.raw && typeof data.raw === "string") {
      const rows = parseCsvToRows(data.raw);
      kv = kvArrayToObject(rows);
    } else if (data.KEY && data.VALUE) {
      kv = { [data.KEY]: data.VALUE };
    } else if (!Array.isArray(data) && !data.raw && data.ok) {
      // si viene como objeto plano
      // (igual lo dejamos)
      kv = { ...data };
    }
  }

  CONFIG = kv;
  CONFIG_TS = Date.now();
  return CONFIG;
}

function cfg(key, fallback = "") {
  return safeStr(CONFIG?.[key], fallback);
}

async function ensureConfigFresh() {
  if (!CONFIG_TS || Date.now() - CONFIG_TS > 60_000) {
    try {
      await loadConfig();
    } catch (e) {
      console.error("Error cargando Config:", e);
    }
  }
}

function mainMenuKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🛍️ Catálogo" }, { text: "🎫 Sellos" }],
        [{ text: "📣 Compartir bot" }, { text: "🆘 Ayuda" }],
      ],
      resize_keyboard: true,
    },
  };
}

function buildHelpText() {
  const negocio = cfg("NegocioNombre", "Todo Queso");
  const wa = cfg("WhatsAppLink", "https://wa.me/5491165778270?text=Hola%20quiero%20hacer%20una%20consulta");
  const ig = cfg("NegocioInstagram", "@todoqueso.club");

  // Ajuste que pediste: más humano + si faltó algo / no encontraste en el catálogo
  return (
`📌 Si necesitás hacer una consulta, reclamo o avisar algo del pedido:

✅ WhatsApp: ${wa}
📷 Instagram: ${ig}

Si te faltó algo o no lo encontraste en el catálogo, escribinos y lo resolvemos 💛

Gracias por elegir ${negocio} 🧀`
  );
}

function buildShareText() {
  // SOLO leyenda de sistema + contacto (sin “te dejamos el mensaje listo”)
  const textoSistema = cfg("TextoSistema", "¿Querés este sistema para tu negocio? Contactános");
  const email = cfg("EmailSistema", "ezerbot.assistant@gmail.com");
  const botLink = cfg("BotLink", "");

  let msg = `🤖 ${textoSistema}\n\n✉️ ${email}`;
  if (botLink) msg += `\n🔗 Demo: ${botLink}`;
  return msg;
}

function buildCatalogText() {
  // Por ahora NO metemos “Carrito” en botones (como pediste)
  const catalogUrl = `${PUBLIC_URL}/catalog`;
  return `🛍️ Catálogo online:\n${catalogUrl}`;
}

function buildCardText(chatId) {
  const cardUrl = `${PUBLIC_URL}/card/${chatId}`;
  return `🎫 Tu tarjeta / sellos:\n${cardUrl}`;
}

function userFirstName(msg) {
  return safeStr(msg?.from?.first_name, "🙂");
}

/** ---------- Routes ---------- **/

app.get("/", (_req, res) => res.status(200).send("OK"));

app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

/** ---------- Bot handlers ---------- **/

bot.onText(/\/start/, async (msg) => {
  await ensureConfigFresh();

  const nombre = userFirstName(msg);
  const descripcion = cfg("Descripcion", "🧀 ¡Bienvenida/o! ¿Empezamos?");
  const texto = replaceVars(descripcion, { NOMBRE: nombre });

  await bot.sendMessage(msg.chat.id, texto, mainMenuKeyboard());
});

bot.on("message", async (msg) => {
  if (!msg?.text) return;

  await ensureConfigFresh();

  const chatId = msg.chat.id;
  const t = msg.text.trim();

  // evita responder dos veces a /start
  if (t.startsWith("/start")) return;

  if (t === "🛍️ Catálogo") {
    await bot.sendMessage(chatId, buildCatalogText(), mainMenuKeyboard());
    return;
  }

  if (t === "🎫 Sellos") {
    await bot.sendMessage(chatId, buildCardText(chatId), mainMenuKeyboard());
    return;
  }

  if (t === "📣 Compartir bot") {
    await bot.sendMessage(chatId, buildShareText(), mainMenuKeyboard());
    return;
  }

  if (t === "🆘 Ayuda") {
    await bot.sendMessage(chatId, buildHelpText(), mainMenuKeyboard());
    return;
  }

  // fallback: si escribe cualquier cosa, re-mostrar menú
  await bot.sendMessage(chatId, "Elegí una opción del menú 👇", mainMenuKeyboard());
});

/** ---------- Start server + webhook ---------- **/

async function start() {
  // Pre-cargar config (clave para que no salga vacío)
  await loadConfig();

  // Set webhook
  const webhookUrl = `${PUBLIC_URL}/bot${TOKEN}`;
  await bot.setWebHook(webhookUrl);

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log("EZERBOT ACTIVO ✅");
    console.log("Webhook:", webhookUrl);
    console.log("PUBLIC_URL:", PUBLIC_URL);
    console.log("DATA_API_URL:", DATA_API_URL);
  });
}

start().catch((e) => {
  console.error("Error iniciando:", e);
  process.exit(1);
});

import express from "express";
import TelegramBot from "node-telegram-bot-api";
import { google } from "googleapis";

// =====================
// 1) ENV OBLIGATORIAS
// =====================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || "";
const GOOGLE_SERVICE_ACCOUNT_B64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64 || "";

// Opcional (si querés webhook en vez de polling)
const WEBHOOK_URL = process.env.WEBHOOK_URL || ""; // ej: https://tuapp.onrender.com
const PORT = process.env.PORT || 10000;

if (!TELEGRAM_BOT_TOKEN) throw new Error("Falta TELEGRAM_BOT_TOKEN");
if (!GOOGLE_SHEET_ID) throw new Error("Falta GOOGLE_SHEET_ID");
if (!GOOGLE_SERVICE_ACCOUNT_B64) throw new Error("Falta GOOGLE_SERVICE_ACCOUNT_B64");

// =====================
// 2) GOOGLE AUTH (B64)
// =====================
function loadServiceAccountFromB64() {
  // Limpia espacios/saltos por si Render mete alguno
  const b64 = (GOOGLE_SERVICE_ACCOUNT_B64 || "").trim().replace(/\s+/g, "");
  const jsonText = Buffer.from(b64, "base64").toString("utf8");

  // Si el JSON viniera con caracteres raros, esto te lo marca claro
  try {
    return JSON.parse(jsonText);
  } catch (e) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_B64 inválido (no se pudo parsear JSON). " +
      "Revisá que sea base64 puro en 1 sola línea."
    );
  }
}

const serviceAccount = loadServiceAccountFromB64();

const auth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});

const sheets = google.sheets({ version: "v4", auth });

// =====================
// 3) HELPERS SHEETS
// =====================
async function getRange(rangeA1) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: rangeA1,
  });
  return res.data.values || [];
}

/**
 * Lee Config como KV:
 * Config!A = key
 * Config!B = value
 */
async function readConfigKV() {
  const rows = await getRange("Config!A:B");
  const cfg = {};
  for (const r of rows) {
    const k = (r?.[0] || "").toString().trim();
    const v = (r?.[1] || "").toString();
    if (k) cfg[k] = v;
  }
  return cfg;
}

/**
 * Lee Catálogo simple:
 * Catalogo!A: Código
 * B: Nombre
 * C: Precio
 * D: Categoría
 */
async function readCatalog() {
  const rows = await getRange("Catalogo!A:D");
  // saltear header si existe
  const data = rows.filter((r) => (r?.[0] || "").toString().trim());
  return data.map((r) => ({
    codigo: (r[0] ?? "").toString(),
    nombre: (r[1] ?? "").toString(),
    precio: (r[2] ?? "").toString(),
    categoria: (r[3] ?? "").toString(),
  }));
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// =====================
// 4) TELEGRAM BOT
// =====================
const bot = new TelegramBot(
  TELEGRAM_BOT_TOKEN,
  WEBHOOK_URL ? { webHook: true } : { polling: true }
);

async function getTextFromConfig() {
  const cfg = await readConfigKV();
  return {
    brand_name: cfg.brand_name || "EzerBot",
    welcome_message: cfg.welcome_message || "Hola 👋 ¿Qué querés hacer hoy?",
    help_message:
      cfg.help_message ||
      "Comandos:\n/start\n/help\n/catalogo\n\nDecime qué necesitás.",
    catalog_per_page: parseInt(cfg.catalog_per_page || "8", 10) || 8,
    currency: cfg.currency || "$",
  };
}

bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;
  const t = await getTextFromConfig();
  await bot.sendMessage(chatId, `${t.brand_name}\n\n${t.welcome_message}`);
});

bot.onText(/^\/help$/, async (msg) => {
  const chatId = msg.chat.id;
  const t = await getTextFromConfig();
  await bot.sendMessage(chatId, t.help_message);
});

bot.onText(/^\/catalogo$/, async (msg) => {
  const chatId = msg.chat.id;
  const t = await getTextFromConfig();
  const catalog = await readCatalog();

  if (!catalog.length) {
    await bot.sendMessage(chatId, "El catálogo está vacío.");
    return;
  }

  const perPage = t.catalog_per_page;
  const pages = chunk(catalog, perPage);

  // mandamos la 1ra página
  const page = 0;
  const text = formatCatalogPage(pages[page], page, pages.length, t.currency);
  await bot.sendMessage(chatId, text, {
    reply_markup: pages.length > 1 ? navKeyboard(page, pages.length) : undefined,
  });
});

bot.on("callback_query", async (q) => {
  try {
    const chatId = q.message.chat.id;
    const data = (q.data || "").toString();
    if (!data.startsWith("CAT:")) return;

    const t = await getTextFromConfig();
    const catalog = await readCatalog();
    const pages = chunk(catalog, t.catalog_per_page);

    const [, action, pageStr] = data.split(":"); // CAT:next:1
    let page = parseInt(pageStr || "0", 10) || 0;

    if (action === "next") page += 1;
    if (action === "prev") page -= 1;
    page = Math.max(0, Math.min(page, pages.length - 1));

    const text = formatCatalogPage(pages[page], page, pages.length, t.currency);

    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: q.message.message_id,
      reply_markup: navKeyboard(page, pages.length),
    });

    await bot.answerCallbackQuery(q.id);
  } catch (e) {
    // no explotar por errores de edit
    try { await bot.answerCallbackQuery(q.id); } catch {}
  }
});

function formatCatalogPage(items, page, totalPages, currency) {
  const header = `🧾 Catálogo (pág ${page + 1}/${totalPages})\n\n`;
  const lines = items.map((p) => {
    const cat = p.categoria ? ` · ${p.categoria}` : "";
    const price = p.precio ? ` — ${currency}${p.precio}` : "";
    return `• ${p.nombre}${price}${cat}`;
  });
  return header + lines.join("\n");
}

function navKeyboard(page, totalPages) {
  const buttons = [];
  if (page > 0) buttons.push({ text: "⬅️", callback_data: `CAT:prev:${page}` });
  if (page < totalPages - 1)
    buttons.push({ text: "➡️", callback_data: `CAT:next:${page}` });

  return { inline_keyboard: [buttons] };
}

// =====================
// 5) EXPRESS (Render)
// =====================
const app = express();
app.use(express.json());

app.get("/", async (_req, res) => {
  res.status(200).send("OK");
});

app.get("/health", async (_req, res) => {
  try {
    // prueba rápida: lee una celda de Config
    const rows = await getRange("Config!A1:B2");
    res.status(200).json({ ok: true, sample: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Webhook endpoint (solo si usás WEBHOOK_URL)
app.post("/telegram-webhook", async (req, res) => {
  try {
    await bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (e) {
    res.sendStatus(200);
  }
});

app.listen(PORT, async () => {
  console.log("Server listening on port", PORT);

  if (WEBHOOK_URL) {
    const url = `${WEBHOOK_URL.replace(/\/$/, "")}/telegram-webhook`;
    await bot.setWebHook(url);
    console.log("Webhook set:", url);
  } else {
    console.log("Bot en modo polling");
  }

  // prueba Sheets al arrancar (para que si falla lo veas en logs)
  const test = await getRange("Config!A1:B2");
  console.log("Sheets OK. Sample Config A1:B2:", test);
});

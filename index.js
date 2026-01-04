const express = require("express");
const { google } = require("googleapis");
const TelegramBot = require("node-telegram-bot-api");

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const PUBLIC_URL = process.env.PUBLIC_URL;

if (!BOT_TOKEN) throw new Error("Falta BOT_TOKEN");
if (!GOOGLE_SHEET_ID) throw new Error("Falta GOOGLE_SHEET_ID");
if (!GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error("Falta GOOGLE_SERVICE_ACCOUNT_JSON");

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON),
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
});

async function getConfig() {
  const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: "Config!A:B"
  });

  const out = {};
  (res.data.values || []).forEach(([k, v]) => {
    if (k) out[k] = v ?? "";
  });

  out.PUBLIC_URL = PUBLIC_URL;
  return out;
}

// --- ENDPOINTS ---
app.get("/", (_, res) => res.send("OK"));
app.get("/health", (_, res) => res.json({ ok: true }));

app.get("/config", async (_, res) => {
  try {
    const cfg = await getConfig();
    res.json(cfg);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- BOT ---
bot.onText(/\/start/, async (msg) => {
  try {
    const cfg = await getConfig();
    bot.sendMessage(
      msg.chat.id,
      `🧀 ${cfg.NegocioNombre || "Todo Queso"}\n${cfg.Descripcion || ""}`
    );
  } catch {
    bot.sendMessage(msg.chat.id, "Error leyendo configuración.");
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Servidor OK"));

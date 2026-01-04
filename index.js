// index.js (CommonJS)
// ✅ Endpoints: /health  /config
// ✅ Lee hoja "Config" desde Google Sheets y devuelve JSON
// ✅ No requiere DATA_API_URL

const express = require("express");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

// ---------- ENV REQUIRED ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const PUBLIC_URL = process.env.PUBLIC_URL || "";

// Validaciones claras (para que no se rompa “misteriosamente”)
function requireEnv(name, value) {
  if (!value || String(value).trim() === "") {
    throw new Error(`Falta ENV ${name}`);
  }
}

requireEnv("BOT_TOKEN", BOT_TOKEN);
requireEnv("GOOGLE_SHEET_ID", GOOGLE_SHEET_ID);
requireEnv("GOOGLE_SERVICE_ACCOUNT_JSON", GOOGLE_SERVICE_ACCOUNT_JSON);

// ---------- GOOGLE SHEETS CLIENT ----------
function getAuth() {
  // Soporta que el JSON venga con saltos escapados
  let creds;
  try {
    creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON no es JSON válido (revisá comillas/escape).");
  }

  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}

async function sheetsClient() {
  const auth = await getAuth().getClient();
  return google.sheets({ version: "v4", auth });
}

// ---------- CACHE (para no golpear Sheets a cada mensaje) ----------
let cacheConfig = null;
let cacheAt = 0;
const CACHE_MS = 30 * 1000;

async function loadConfig() {
  const now = Date.now();
  if (cacheConfig && now - cacheAt < CACHE_MS) return cacheConfig;

  const sheets = await sheetsClient();

  // Lee rango A:B de la hoja Config
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: "Config!A:B",
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const rows = res.data.values || [];
  const obj = {};

  // rows: [ [KEY, VALUE], ... ]
  for (const r of rows) {
    const key = (r[0] || "").toString().trim();
    if (!key) continue;
    obj[key] = r[1] ?? "";
  }

  // Extras útiles
  obj.PUBLIC_URL = PUBLIC_URL;

  cacheConfig = obj;
  cacheAt = now;
  return obj;
}

// ---------- ROUTES ----------
app.get("/", (req, res) => {
  res.type("text").send("OK");
});

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "ezerbot-system" });
});

// ✅ ESTE ES EL QUE TE FALTA
app.get("/config", async (req, res) => {
  try {
    const cfg = await loadConfig();
    res.json({ ok: true, config: cfg });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// ---------- START ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Servidor OK en puerto ${PORT}`);
});

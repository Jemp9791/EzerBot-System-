import fs from "fs";
import path from "path";
import { google } from "googleapis";
import TelegramBot from "node-telegram-bot-api";

/* =========================
   VALIDACIÓN DE ENTORNO
========================= */

function getEnv(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Falta variable de entorno: ${name}`);
  }
  return v.trim();
}

/* =========================
   SERVICE ACCOUNT (BASE64)
========================= */

function loadServiceAccountFromB64() {
  let raw = getEnv("GOOGLE_SERVICE_ACCOUNT_B64");

  // limpieza defensiva TOTAL
  raw = raw
    .replace(/^"+|"+$/g, "")     // comillas externas
    .replace(/\s+/g, "");        // cualquier espacio o salto

  let jsonText;
  try {
    jsonText = Buffer.from(raw, "base64").toString("utf8");
  } catch (e) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_B64 no es base64 válido");
  }

  let creds;
  try {
    creds = JSON.parse(jsonText);
  } catch (e) {
    console.error("Contenido decodificado:", jsonText.slice(0, 200));
    throw new Error("GOOGLE_SERVICE_ACCOUNT_B64 decodifica pero NO es JSON");
  }

  if (!creds.client_email || !creds.private_key) {
    throw new Error("Service Account inválido (faltan campos)");
  }

  return creds;
}

/* =========================
   GOOGLE SHEETS
========================= */

const SERVICE_ACCOUNT = loadServiceAccountFromB64();

const auth = new google.auth.JWT({
  email: SERVICE_ACCOUNT.client_email,
  key: SERVICE_ACCOUNT.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});

const sheets = google.sheets({ version: "v4", auth });

const GOOGLE_SHEET_ID = getEnv("GOOGLE_SHEET_ID");

/* =========================
   TELEGRAM BOT
========================= */

const TELEGRAM_BOT_TOKEN = getEnv("TELEGRAM_BOT_TOKEN");

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
  polling: true,
});

/* =========================
   CONFIG DESDE SHEETS
========================= */

async function readConfig() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: "Config!A:B",
  });

  const rows = res.data.values || [];
  const cfg = {};

  for (const [k, v] of rows) {
    if (k) cfg[k] = v;
  }

  return cfg;
}

/* =========================
   BOT FLOW BÁSICO
========================= */

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

  try {
    const config = await readConfig();

    const text = (msg.text || "").toLowerCase();

    if (text === "/start") {
      await bot.sendMessage(
        chatId,
        config.welcome_message || "Hola 👋 Bienvenido al sistema"
      );
      return;
    }

    if (text.includes("ayuda")) {
      await bot.sendMessage(
        chatId,
        config.help_message || "Escribí *menu* para ver opciones",
        { parse_mode: "Markdown" }
      );
      return;
    }

    await bot.sendMessage(
      chatId,
      "Mensaje recibido ✔️"
    );

  } catch (err) {
    console.error("BOT ERROR:", err.message);
    await bot.sendMessage(
      chatId,
      "⚠️ Error interno. El equipo ya fue notificado."
    );
  }
});

/* =========================
   STARTUP LOG
========================= */

console.log("✅ EzerBot iniciado correctamente");

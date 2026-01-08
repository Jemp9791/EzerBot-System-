
// src/config.js
import { google } from "googleapis";

/*
Variables de entorno necesarias:
- TelegramBotToken  (o TELEGRAM_BOT_TOKEN)
- GOOGLE_SHEET_ID
- GOOGLE_SERVICE_ACCOUNT_B64
- PUBLIC_URL (opcional)
- PORT
*/

export const TelegramBotToken =
  process.env.TelegramBotToken || process.env.TELEGRAM_BOT_TOKEN;

export const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_B64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;

export const PUBLIC_URL = process.env.PUBLIC_URL || "";
export const PORT = Number(process.env.PORT || 10000);

// Validaciones
if (!TelegramBotToken) throw new Error("Falta TelegramBotToken");
if (!GOOGLE_SHEET_ID) throw new Error("Falta GOOGLE_SHEET_ID");
if (!GOOGLE_SERVICE_ACCOUNT_B64)
  throw new Error("Falta GOOGLE_SERVICE_ACCOUNT_B64");

// Decodifica la service account en base64
function decodeServiceAccountB64(b64) {
  const raw = Buffer.from(b64, "base64").toString("utf8").trim();
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_B64 decodifica pero NO es JSON válido."
    );
  }
}

const sa = decodeServiceAccountB64(GOOGLE_SERVICE_ACCOUNT_B64);

// Autenticación con Google Sheets
const auth = new google.auth.JWT({
  email: sa.client_email,
  key: sa.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

// Exporta el cliente de Sheets
export const sheets = google.sheets({ version: "v4", auth });
                                       

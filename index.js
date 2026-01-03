'use strict';

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');

const PORT = process.env.PORT || 10000;

// === ENV ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL; // ej: https://ezerbot-system.onrender.com
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID; // id del sheet
const GOOGLE_SERVICE_ACCOUNT_B64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64; // base64 del JSON (sin saltos)

// === Helpers ===
function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function loadServiceAccountFromB64() {
  if (!GOOGLE_SERVICE_ACCOUNT_B64) {
    throw new Error('FATAL: falta GOOGLE_SERVICE_ACCOUNT_B64');
  }

  // 1) decodifico base64 → string
  const decoded = Buffer.from(GOOGLE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8');

  // 2) parseo JSON
  const obj = safeJsonParse(decoded);
  if (!obj) {
    // debug mínimo (sin ensuciar logs)
    const preview = decoded.slice(0, 50).replace(/\n/g, '\\n');
    throw new Error(`FATAL: GOOGLE_SERVICE_ACCOUNT_B64 decodifica pero NO es JSON. Vista previa: ${preview}`);
  }
  return obj;
}

async function getSheetsClient() {
  const sa = loadServiceAccountFromB64();

  // OJO: si la key viene con \n, está ok. Si viene con saltos reales también.
  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
  });

  await auth.authorize();
  return google.sheets({ version: 'v4', auth });
}

// === Telegram bot ===
if (!TELEGRAM_BOT_TOKEN) {
  throw new Error('FATAL: falta TELEGRAM_BOT_TOKEN');
}
if (!PUBLIC_URL) {
  throw new Error('FATAL: falta PUBLIC_URL');
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { webHook: true });

// === Express ===
const app = express();
app.use(express.json());

// healthcheck
app.get('/', (req, res) => res.status(200).send('OK'));

// webhook endpoint
app.post(`/bot${TELEGRAM_BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// === Bot menu básico (demo) ===
function normalizeText(t) {
  return String(t || '').trim().toLowerCase();
}

bot.onText(/^\/start$/i, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(
    chatId,
    `Hola! Soy EzerBot ✅\nDecime: catálogo / ventas / envío / transferencia / ayuda`
  );
});

bot.onText(/^ayuda$/i, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(
    chatId,
    `Comandos: catálogo, ventas, envío, transferencia.`
  );
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = normalizeText(msg.text);

  // Evito responder doble si ya fue /start o ayuda
  if (!text || text.startsWith('/start') || text === 'ayuda') return;

  if (text === 'catálogo' || text === 'catalogo') {
    await bot.sendMessage(
      chatId,
      `📦 CATÁLOGO\nTodavía está en modo demo.\nDecime qué querés que muestre:\n1) Categorías\n2) Buscar producto\n3) Ver combos`
    );
    return;
  }

  if (text === '1' || text.includes('categor')) {
    await bot.sendMessage(chatId, `✅ Categorías (demo):\n- Fiambres\n- Quesos\n- Panificados\n- Combos`);
    return;
  }

  if (text === '2' || text.includes('buscar')) {
    await bot.sendMessage(chatId, `🔎 Escribime el nombre del producto (demo).`);
    return;
  }

  if (text === '3' || text.includes('combo')) {
    await bot.sendMessage(chatId, `⭐ Combos (demo):\n- Clásico\n- Gold\n- Rústica\n- Monster`);
    return;
  }

  if (text === 'ventas') {
    await bot.sendMessage(chatId, `🧾 Ventas: (demo) todavía sin reporte.`);
    return;
  }

  if (text === 'envío' || text === 'envio') {
    await bot.sendMessage(chatId, `🚚 Envío: (demo) decime tu dirección.`);
    return;
  }

  if (text === 'transferencia') {
    await bot.sendMessage(chatId, `🏦 Transferencia: (demo) te paso los datos de pago.`);
    return;
  }

  // default
  await bot.sendMessage(chatId, `Estoy activo ✅ Escribí /start o 'ayuda'.`);
});

// === Boot ===
async function boot() {
  // Webhook set
  await bot.setWebHook(`${PUBLIC_URL}/bot${TELEGRAM_BOT_TOKEN}`);

  // Pruebo service account (solo log de OK, no rompe si no querés)
  try {
    const sheets = await getSheetsClient();
    const sa = loadServiceAccountFromB64();
    console.log('✅ Service Account OK:', sa.client_email);

    if (GOOGLE_SHEET_ID) {
      // lectura mínima para verificar
      await sheets.spreadsheets.get({ spreadsheetId: GOOGLE_SHEET_ID });
      console.log('✅ Google Sheet accesible:', GOOGLE_SHEET_ID);
    } else {
      console.log('ℹ️ GOOGLE_SHEET_ID no seteado (ok por ahora).');
    }
  } catch (e) {
    console.log('⚠️ Sheets init warning:', e.message);
  }

  app.listen(PORT, () => {
    console.log(`✅ Servidor escuchando en puerto ${PORT}`);
  });
}

boot().catch((e) => {
  console.error('FATAL BOOT:', e);
  process.exit(1);
});

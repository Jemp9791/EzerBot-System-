import express from "express";
import TelegramBot from "node-telegram-bot-api";
import { google } from "googleapis";
import fs from "fs";
import path from "path";

// ================== ENV OBLIGATORIAS ==================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || "";
const PORT = process.env.PORT || 10000;

// ================== VALIDACIONES MINIMAS ==================
if (!TELEGRAM_BOT_TOKEN) throw new Error("Falta TELEGRAM_BOT_TOKEN");
if (!GOOGLE_SHEET_ID) throw new Error("Falta GOOGLE_SHEET_ID");

// ================== GOOGLE AUTH (SIN JSON EN ENV) ==================
// Pone el archivo en el repo: ./credentials/service-account.json
const KEYFILE = process.env.GOOGLE_KEYFILE || "./credentials/service-account.json";

if (!fs.existsSync(KEYFILE)) {
  throw new Error(`No encuentro el archivo de service account en: ${KEYFILE}`);
}

const auth = new google.auth.GoogleAuth({
  keyFile: KEYFILE,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// ================== HELPERS SHEETS ==================
async function getSheetValues(rangeA1) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: rangeA1,
  });
  return res.data.values || [];
}

function toMapFrom2Cols(rows) {
  const out = {};
  for (const r of rows) {
    const k = (r?.[0] || "").toString().trim();
    const v = (r?.[1] || "").toString();
    if (k) out[k] = v;
  }
  return out;
}

async function readConfig() {
  // Config esperada: columna A = key, columna B = value
  // Hoja: Config
  const rows = await getSheetValues("Config!A:B");
  const map = toMapFrom2Cols(rows);
  return {
    brand_name: map.brand_name || "Todo Queso",
    welcome_message:
      map.welcome_message ||
      "¡Hola! 👋 Bienvenid@ a Todo Queso 🧀\nElegí una opción 👇",
    help_message:
      map.help_message ||
      "Si no encontraste algo o querés ayuda, escribinos y te respondemos 😊",
    sellos_message:
      map.sellos_message ||
      "📌 Sellos: pronto vas a poder ver tus sellos acá.",
    card_url: map.card_url || "",
    share_message:
      map.share_message ||
      "🤖 ¿Querés este sistema para tu negocio? Contactanos:\n✉️ Email: ezerbot.assistant@gmail.com\n🔗 Demo: https://t.me/Ezer_IA_Bot",
    contact_email: map.contact_email || "ezerbot.assistant@gmail.com",
    demo_bot: map.demo_bot || "https://t.me/Ezer_IA_Bot",
    contact_whatsapp: map.contact_whatsapp || "",
    contact_telegram: map.contact_telegram || "",
    catalog_per_page: parseInt(map.catalog_per_page || "12", 10),
    currency: map.currency || "$",
    whatsapp_order: map.whatsapp_order || "",
  };
}

async function readCatalog() {
  // Catalogo (tal cual dijiste): Hoja "Catalogo"
  // Columnas recomendadas: codigo | nombre | precio | unidad | categoria | imagen
  const rows = await getSheetValues("Catalogo!A:Z");
  if (!rows.length) return [];
  const headers = rows[0].map((h) => (h || "").toString().trim().toLowerCase());
  const data = rows.slice(1);

  const idx = (name) => headers.indexOf(name);

  const iCodigo = idx("codigo");
  const iNombre = idx("nombre");
  const iPrecio = idx("precio");
  const iUnidad = idx("unidad");
  const iCategoria = idx("categoria");

  return data
    .map((r) => ({
      codigo: (r[iCodigo] || "").toString().trim(),
      nombre: (r[iNombre] || "").toString().trim(),
      precio: (r[iPrecio] || "").toString().trim(),
      unidad: (r[iUnidad] || "").toString().trim(),
      categoria: (r[iCategoria] || "").toString().trim(),
    }))
    .filter((p) => p.nombre || p.codigo);
}

// ================== TELEGRAM BOT ==================
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

function mainKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🛍️ Catálogo" }],
        [{ text: "🎟️ Sellos" }, { text: "📣 Compartir bot" }],
        [{ text: "🆘 Ayuda" }],
      ],
      resize_keyboard: true,
    },
  };
}

function catalogKeyboard() {
  return {
    reply_markup: {
      keyboard: [[{ text: "📚 Categorías" }, { text: "🔙 Menú" }]],
      resize_keyboard: true,
    },
  };
}

async function sendMenu(chatId) {
  const cfg = await readConfig();
  await bot.sendMessage(chatId, cfg.welcome_message, mainKeyboard());
}

bot.onText(/\/start/, async (msg) => {
  await sendMenu(msg.chat.id);
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  if (!text || text.startsWith("/")) return;

  try {
    const cfg = await readConfig();

    if (text === "🔙 Menú") return await sendMenu(chatId);

    if (text === "🛍️ Catálogo") {
      await bot.sendMessage(chatId, "📚 Elegí una opción:", catalogKeyboard());
      return;
    }

    if (text === "📚 Categorías") {
      const items = await readCatalog();
      if (!items.length) {
        await bot.sendMessage(
          chatId,
          "⚠️ El catálogo está vacío o no pude leer la hoja 'Catalogo'.",
          mainKeyboard()
        );
        return;
      }
      const cats = [...new Set(items.map((x) => x.categoria || "Sin categoría"))];
      const buttons = cats.map((c) => [{ text: `📦 ${c}` }]);
      buttons.push([{ text: "📦 Todas" }], [{ text: "🔙 Menú" }]);

      await bot.sendMessage(chatId, "📚 Categorías (elegí una):", {
        reply_markup: { keyboard: buttons, resize_keyboard: true },
      });
      return;
    }

    if (text === "📦 Todas" || text.startsWith("📦 ")) {
      const items = await readCatalog();
      if (!items.length) {
        await bot.sendMessage(chatId, "⚠️ Catálogo vacío.", mainKeyboard());
        return;
      }

      let cat = "";
      if (text.startsWith("📦 ") && text !== "📦 Todas") cat = text.replace("📦 ", "").trim();

      const filtered = cat ? items.filter((x) => (x.categoria || "Sin categoría") === cat) : items;

      const lines = filtered.slice(0, cfg.catalog_per_page).map((p) => {
        const price = p.precio ? `${cfg.currency}${p.precio}` : "";
        const unit = p.unidad ? ` (${p.unidad})` : "";
        const code = p.codigo ? ` [${p.codigo}]` : "";
        return `• ${p.nombre}${unit}${price ? ` — ${price}` : ""}${code}`;
      });

      await bot.sendMessage(
        chatId,
        `🛍️ ${cat ? `Catálogo: ${cat}` : "Catálogo (primeros items)"}\n\n${lines.join("\n")}`,
        mainKeyboard()
      );

      // Punto de compra (si config trae whatsapp_order)
      if (cfg.whatsapp_order) {
        await bot.sendMessage(
          chatId,
          `🧾 Para comprar escribinos por WhatsApp:\n${cfg.whatsapp_order}`,
          mainKeyboard()
        );
      } else {
        await bot.sendMessage(
          chatId,
          "⚠️ Falta configurar el WhatsApp de pedidos en Config (whatsapp_order).",
          mainKeyboard()
        );
      }
      return;
    }

    if (text === "🎟️ Sellos") {
      await bot.sendMessage(chatId, cfg.sellos_message, mainKeyboard());
      if (cfg.card_url) {
        await bot.sendMessage(chatId, `🔗 Abrí tu tarjeta acá:\n${cfg.card_url}`, mainKeyboard());
      }
      return;
    }

    if (text === "📣 Compartir bot") {
      await bot.sendMessage(chatId, cfg.share_message, mainKeyboard());
      return;
    }

    if (text === "🆘 Ayuda") {
      await bot.sendMessage(chatId, cfg.help_message, mainKeyboard());
      // si hay contactos definidos
      const extra = [];
      if (cfg.contact_email) extra.push(`✉️ Email: ${cfg.contact_email}`);
      if (cfg.contact_whatsapp) extra.push(`📞 WhatsApp: ${cfg.contact_whatsapp}`);
      if (cfg.contact_telegram) extra.push(`✈️ Telegram: ${cfg.contact_telegram}`);
      if (cfg.demo_bot) extra.push(`🤖 Demo: ${cfg.demo_bot}`);
      if (extra.length) await bot.sendMessage(chatId, extra.join("\n"), mainKeyboard());
      return;
    }

    // fallback humano
    await bot.sendMessage(
      chatId,
      `Te leo 😊\nSi querés ver productos: tocá 🛍️ Catálogo\nSi necesitás ayuda: 🆘 Ayuda`,
      mainKeyboard()
    );
  } catch (e) {
    await bot.sendMessage(chatId, `⚠️ Error: ${e.message}`, mainKeyboard());
  }
});

// ================== EXPRESS (Render health) ==================
const app = express();
app.get("/", (_, res) => res.status(200).send("OK"));
app.listen(PORT, () => console.log("Server up on", PORT));

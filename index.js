/**
 * TODO_QUESO - SOLO COMPARTIR (WhatsApp) + PROMO por deep-link /start promo
 * - Sin callback_data (evita el bug de botones que no responden)
 * - Webhook: POST /
 *
 * ENV en Render:
 *   TELEGRAM_TOKEN  = <tu token>
 *   BOT_USERNAME    = Ezer_IA_Bot        (sin @)
 *   SHEET_CSV_URL   = (opcional) CSV del sheet "Catalogo"
 *   PROMO_CODE      = TQ01              (opcional, default TQ01)
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_TOKEN || "";
const BOT_USERNAME = (process.env.BOT_USERNAME || "Ezer_IA_Bot").replace(/^@/, "");
const SHEET_CSV_URL = process.env.SHEET_CSV_URL || "";
const PROMO_CODE = (process.env.PROMO_CODE || "TQ01").trim();

if (!TOKEN) console.error("❌ Falta TELEGRAM_TOKEN en ENV");
if (!BOT_USERNAME) console.error("❌ Falta BOT_USERNAME en ENV");

const TG = (method) => `https://api.telegram.org/bot${TOKEN}/${method}`;

async function tgCall(method, payload) {
  const res = await fetch(TG(method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data?.ok) console.error("Telegram API error:", method, data);
  return data;
}

async function sendMessage(chat_id, text, extra = {}) {
  return tgCall("sendMessage", { chat_id, text, ...extra });
}

async function sendPhoto(chat_id, photo, caption, extra = {}) {
  return tgCall("sendPhoto", { chat_id, photo, caption, ...extra });
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function normalizeUrl(u) {
  if (!u) return "";
  // si viene como [url](url)
  const m = u.match(/\((https?:\/\/[^)]+)\)/);
  if (m?.[1]) return m[1].trim();
  return u.replace(/^\[|\]$/g, "").trim();
}

// CSV simple (sirve para Google Sheets CSV)
function parseCSV(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '"' && inQuotes && next === '"') {
      cur += '"';
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (c === "," && !inQuotes) {
      row.push(cur);
      cur = "";
      continue;
    }
    if ((c === "\n" || c === "\r") && !inQuotes) {
      if (cur.length || row.length) {
        row.push(cur);
        rows.push(row);
      }
      cur = "";
      row = [];
      if (c === "\r" && next === "\n") i++;
      continue;
    }
    cur += c;
  }
  if (cur.length || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

let cache = { at: 0, items: [] };

async function loadCatalogIfAny() {
  // si no hay CSV, devolvemos vacío (igual funciona compartir bot + promo hardcode)
  if (!SHEET_CSV_URL) return [];

  const now = Date.now();
  if (cache.items.length && now - cache.at < 60_000) return cache.items; // 1 min cache

  const res = await fetch(SHEET_CSV_URL);
  const csv = await res.text();

  const rows = parseCSV(csv);
  if (!rows.length) return [];

  const headers = rows[0].map((h) => (h || "").trim().toUpperCase());
  const idx = (name) => headers.indexOf(name);

  const I = {
    CODIGO: idx("CODIGO"),
    NOMBRE: idx("NOMBRE"),
    PRECIO: idx("PRECIO"),
    UNIDAD: idx("UNIDAD"),
    DESCRIPCION: idx("DESCRIPCION"),
    IMAGEN: idx("IMAGEN"),
    CATEGORIA: idx("CATEGORIA"),
  };

  const items = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const codigo = (row[I.CODIGO] || "").trim();
    const nombre = (row[I.NOMBRE] || "").trim();
    if (!codigo || !nombre) continue;

    items.push({
      codigo,
      nombre,
      precio: (row[I.PRECIO] || "").trim(),
      unidad: (row[I.UNIDAD] || "").trim(),
      descripcion: (row[I.DESCRIPCION] || "").trim(),
      imagen: normalizeUrl((row[I.IMAGEN] || "").trim()),
      categoria: (row[I.CATEGORIA] || "").trim(),
    });
  }

  cache = { at: now, items };
  return items;
}

function botLinkStart(payload) {
  // deep link oficial
  if (payload) return `https://t.me/${BOT_USERNAME}?start=${encodeURIComponent(payload)}`;
  return `https://t.me/${BOT_USERNAME}`;
}

function waShareLink(text) {
  // WhatsApp share universal
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

function shareMenuKeyboard() {
  const linkBot = botLinkStart(""); // abre chat
  const linkPromo = botLinkStart("promo"); // abre chat + dispara promo

  const msgBot =
    `🧀 Todo Queso — Compras por Telegram\n` +
    `Abrí el bot acá:\n${linkBot}`;

  const msgPromo =
    `🎁 Promo destacada de Todo Queso\n` +
    `Abrila acá y pedila al toque:\n${linkPromo}`;

  return {
    inline_keyboard: [
      [{ text: "📣 Compartir BOT (WhatsApp)", url: waShareLink(msgBot) }],
      [{ text: "🎁 Compartir PROMO (WhatsApp)", url: waShareLink(msgPromo) }],
    ],
  };
}

async function sendPromo(chat_id) {
  // buscamos promo en sheet si existe, si no hardcodeamos TQ01
  let promo = null;
  const items = await loadCatalogIfAny();
  if (items.length) promo = items.find((x) => x.codigo === PROMO_CODE) || null;

  // fallback hardcode (tu ejemplo)
  if (!promo) {
    promo = {
      codigo: "TQ01",
      nombre: "PICADA P/4",
      precio: "30000",
      unidad: "unidad",
      descripcion: "Picada p/personas con 2 latas de cerveza Corona SOLO CON RESERVA PREVIA",
      imagen: "https://i.postimg.cc/26WcGXBd/Copia-de-Orange-Bold-Colorful-Turkey-Sandwich-Instagram-Story-(Video).png",
      categoria: "Promos",
    };
  }

  const caption =
    `🎁 <b>PROMO DESTACADA</b>\n` +
    `🛍️ <b>${escapeHtml(promo.nombre)}</b>\n` +
    `💰 <b>$ ${escapeHtml(promo.precio || "-")}</b> ${promo.unidad ? `(${escapeHtml(promo.unidad)})` : ""}\n` +
    (promo.descripcion ? `📝 ${escapeHtml(promo.descripcion)}\n` : "") +
    `\n✅ Para pedir: escribí <b>QUIERO LA PROMO</b>`;

  const kb = {
    inline_keyboard: [
      [{ text: "🛍️ Abrir bot", url: botLinkStart("") }],
      [{ text: "📣 Compartir esta promo (WhatsApp)", url: waShareLink(`🎁 Promo de Todo Queso:\n${botLinkStart("promo")}`) }],
    ],
  };

  // si hay imagen válida, mandamos foto; si no, texto
  if (promo.imagen && promo.imagen.startsWith("http")) {
    return sendPhoto(chat_id, promo.imagen, caption, { parse_mode: "HTML", reply_markup: kb });
  }
  return sendMessage(chat_id, caption, { parse_mode: "HTML", reply_markup: kb });
}

async function handleStart(chat_id, payload) {
  // payload viene como "/start promo"
  if (payload === "promo") {
    return sendPromo(chat_id);
  }

  // menú simple de compartir
  const text =
    `🧀 <b>Todo Queso</b>\n\n` +
    `✅ Elegí qué querés compartir por WhatsApp:\n` +
    `• El <b>bot</b>\n` +
    `• La <b>promo</b> destacada\n\n` +
    `💡 Tip: si alguien abre la promo, el bot le muestra la oferta y después vos podés captar al cliente con más sugerencias.`;

  return sendMessage(chat_id, text, {
    parse_mode: "HTML",
    reply_markup: shareMenuKeyboard(),
  });
}

// --- Routes ---
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/debug", async (req, res) => {
  res.status(200).json({
    ok: true,
    env: {
      hasToken: Boolean(TOKEN),
      botUsername: BOT_USERNAME,
      hasSheetCsvUrl: Boolean(SHEET_CSV_URL),
      promoCode: PROMO_CODE,
    },
    links: {
      bot: botLinkStart(""),
      promo: botLinkStart("promo"),
    },
  });
});

// webhook root "/"
app.post("/", async (req, res) => {
  res.sendStatus(200);

  const update = req.body || {};
  try {
    if (update.message?.text) {
      const chat_id = update.message.chat.id;
      const text = update.message.text.trim();

      // /start o /start promo
      if (text.startsWith("/start")) {
        const parts = text.split(" ");
        const payload = (parts[1] || "").trim(); // "promo"
        return handleStart(chat_id, payload);
      }

      // cualquier texto → volvemos al menú de compartir (simple)
      return handleStart(chat_id, "");
    }
  } catch (e) {
    console.error("Handler error:", e);
  }
});

app.listen(PORT, () => {
  console.log("✅ Server listo en puerto", PORT);
  console.log("✅ BOT_USERNAME:", BOT_USERNAME);
  console.log("✅ Deep link promo:", `https://t.me/${BOT_USERNAME}?start=promo`);
});

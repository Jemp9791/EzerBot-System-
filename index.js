const express = require("express");
const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;

const TOKEN = process.env.TELEGRAM_TOKEN || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const SHEET_CSV_URL = process.env.SHEET_CSV_URL || "";
const CONFIG_CSV_URL = process.env.CONFIG_CSV_URL || "";
let BOT_USERNAME = (process.env.BOT_USERNAME || "").replace("@", "").trim();

if (!TOKEN) console.error("❌ Falta TELEGRAM_TOKEN");
if (!PUBLIC_URL) console.error("❌ Falta PUBLIC_URL");
if (!SHEET_CSV_URL) console.error("❌ Falta SHEET_CSV_URL");
if (!CONFIG_CSV_URL) console.error("❌ Falta CONFIG_CSV_URL");

const TG = (method) => `https://api.telegram.org/bot${TOKEN}/${method}`;

async function tgCall(method, payload) {
  const r = await fetch(TG(method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!j?.ok) console.error("Telegram API error:", method, j);
  return j;
}

async function sendMessage(chat_id, text, extra = {}) {
  return tgCall("sendMessage", { chat_id, text, ...extra });
}
async function sendPhoto(chat_id, photo, caption, extra = {}) {
  return tgCall("sendPhoto", { chat_id, photo, caption, ...extra });
}
async function editMessageReplyMarkup(chat_id, message_id, reply_markup) {
  return tgCall("editMessageReplyMarkup", { chat_id, message_id, reply_markup });
}
async function editMessageMedia(chat_id, message_id, photo, caption, extra = {}) {
  return tgCall("editMessageMedia", {
    chat_id,
    message_id,
    media: { type: "photo", media: photo, caption, parse_mode: "HTML" },
    ...extra,
  });
}
async function answerCallbackQuery(id) {
  return tgCall("answerCallbackQuery", { callback_query_id: id }).catch(() => {});
}

// ---------------- CSV ----------------
function parseCSV(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];

    if (c === '"' && inQuotes && n === '"') {
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
      if (c === "\r" && n === "\n") i++;
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

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function driveToDirect(url) {
  if (!url) return "";
  const u = String(url).trim();

  let m = u.match(/\/file\/d\/([^/]+)\//);
  if (m?.[1]) return `https://drive.google.com/uc?export=download&id=${m[1]}`;

  m = u.match(/[?&]id=([^&]+)/);
  if (m?.[1]) return `https://drive.google.com/uc?export=download&id=${m[1]}`;

  return u;
}

function normalizeUrl(u) {
  if (!u) return "";
  const s = String(u).trim();
  const m = s.match(/\((https?:\/\/[^)]+)\)/);
  const cleaned = (m?.[1] || s).replace(/^\[|\]$/g, "").trim();
  return driveToDirect(cleaned);
}

// ---------------- Cache ----------------
let configCache = { at: 0, data: {} };
let catalogCache = { at: 0, items: [] };

async function loadConfig() {
  const now = Date.now();
  if (Object.keys(configCache.data).length && now - configCache.at < 30_000) return configCache.data;

  const r = await fetch(CONFIG_CSV_URL);
  const csv = await r.text();
  const rows = parseCSV(csv);
  if (!rows.length) return {};

  const headers = (rows[0] || []).map((h) => String(h || "").trim().toUpperCase());

  let idxKey = headers.indexOf("KEY");
  let idxVal = headers.indexOf("VALUE");
  if (idxKey < 0) idxKey = headers.indexOf("CLAVE");
  if (idxVal < 0) idxVal = headers.indexOf("VALOR");

  if (idxKey < 0) idxKey = 0;
  if (idxVal < 0) idxVal = 1;

  const out = {};
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const k = String(row[idxKey] || "").trim();
    const v = String(row[idxVal] || "").trim();
    if (!k) continue;
    out[k] = v;
  }

  configCache = { at: now, data: out };
  return out;
}

async function loadCatalog() {
  const now = Date.now();
  if (catalogCache.items.length && now - catalogCache.at < 30_000) return catalogCache;

  const r = await fetch(SHEET_CSV_URL);
  const csv = await r.text();
  const rows = parseCSV(csv);
  if (!rows.length) throw new Error("Catálogo CSV vacío");

  const headers = (rows[0] || []).map((h) => String(h || "").trim().toUpperCase());
  const idx = (name) => headers.indexOf(name);

  const I = {
    CODIGO: idx("CODIGO"),
    NOMBRE: idx("NOMBRE"),
    PRECIO: idx("PRECIO"),
    UNIDAD: idx("UNIDAD"),
    DESCRIPCION: idx("DESCRIPCION"),
    IMAGEN: idx("IMAGEN"),
  };

  const items = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const nombre = String(row[I.NOMBRE] || "").trim();
    if (!nombre) continue;
    items.push({
      codigo: String(row[I.CODIGO] || "").trim(),
      nombre,
      precio: String(row[I.PRECIO] || "").trim(),
      unidad: String(row[I.UNIDAD] || "").trim(),
      descripcion: String(row[I.DESCRIPCION] || "").trim(),
      imagen: normalizeUrl(String(row[I.IMAGEN] || "").trim()),
    });
  }

  catalogCache = { at: now, items };
  return catalogCache;
}

// ---------------- Estado UI ----------------
const userState = new Map(); // chatId -> { list, index, messageId, shareOpen }

// ---------------- Teclados ----------------
function mainMenuReply() {
  return {
    keyboard: [
      [{ text: "🛍️ Catálogo" }, { text: "🏷️ Sellos" }],
      [{ text: "📣 Compartir bot" }, { text: "🧾 Carrito" }],
    ],
    resize_keyboard: true,
  };
}

function productCaption(item, pos, total) {
  const unidadTxt = item.unidad ? `(${item.unidad})` : "";
  const desc = item.descripcion ? `\n📝 ${escapeHtml(item.descripcion)}` : "";
  return `🛍️ <b>${escapeHtml(item.nombre)}</b>\n💰 <b>$ ${escapeHtml(item.precio || "-")}</b> ${escapeHtml(
    unidadTxt
  )}\n📌 <i>${pos} de ${total}</i>${desc}\n\n✅ <b>Para pedir:</b> escribí <b>QUIERO</b>`;
}

function productKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "⬅️", callback_data: "P:PREV" },
        { text: "➡️", callback_data: "P:NEXT" },
      ],
      [{ text: "🟢 Quiero este", callback_data: "P:BUY" }],
      [{ text: "📣 Compartir", callback_data: "P:SHARE" }],
      [{ text: "🏠 Menú", callback_data: "HOME" }],
    ],
  };
}

function shareKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📣 WhatsApp", callback_data: "SH:WA" },
        { text: "✈️ Telegram", callback_data: "SH:TG" },
      ],
      [{ text: "✉️ Email", callback_data: "SH:EM" }],
      [{ text: "⬅️ Volver", callback_data: "SH:BACK" }],
    ],
  };
}

// ---------------- Links compartir ----------------
function botLink(payload = "") {
  const p = payload ? `?start=${payload}` : "";
  return `https://t.me/${BOT_USERNAME}${p}`;
}

/**
 * IMPORTANTE:
 * - Telegram NO acepta mailto: como URL de botón inline
 * - Por eso Email se hace con un link HTTPS (Gmail compose)
 */
function shareLinks(text) {
  const t = encodeURIComponent(text);
  return {
    wa: `https://wa.me/?text=${t}`,
    tg: `https://t.me/share/url?url=${t}`,
    // Gmail compose (HTTPS): Telegram lo acepta
    em: `https://mail.google.com/mail/?view=cm&fs=1&tf=1&su=${encodeURIComponent("Todo Queso")}&body=${t}`,
  };
}

function shareTextForProduct(item) {
  const payload = `P_${(item.codigo || "").slice(0, 32)}`;
  const link = botLink(payload);
  return `🧀 Todo Queso — Mirá este producto:\n${item.nombre}\n💰 $ ${item.precio || "-"} ${
    item.unidad ? `(${item.unidad})` : ""
  }\n\nPedilo acá 👉 ${link}`;
}
function shareTextForBot() {
  return `🧀 Todo Queso — Compras por Telegram\nAbrí el bot acá 👉 ${botLink("B")}`;
}

// ---------------- Core ----------------
async function ensureBotUsername() {
  if (BOT_USERNAME) return;
  const me = await tgCall("getMe", {});
  if (me?.ok && me?.result?.username) BOT_USERNAME = me.result.username;
}

async function welcome(chat_id, payload = "") {
  await ensureBotUsername();
  const cfg = await loadConfig();

  const negocio = cfg.BUSINESS_NAME || cfg.NOMBRE_NEGOCIO || "Todo Queso";
  const direccion = cfg.ADDRESS || cfg.DIRECCION || "";
  const horarios = cfg.HOURS || cfg.HORARIOS || "";
  const estado = (cfg.STATUS || cfg.ESTADO || "").toLowerCase();
  const logo = normalizeUrl(cfg.LOGO_URL || cfg.LOGO || "");

  const estadoTxt =
    estado.includes("cerr") || estado.includes("vac")
      ? "🚫 <b>Ahora estamos cerrados</b>"
      : estado.includes("ab")
      ? "✅ <b>Estamos atendiendo</b>"
      : "";

  const text = [
    `👋 <b>¡Hola!</b> Bienvenido/a a <b>${escapeHtml(negocio)}</b> 🧀`,
    `✨ ¿Qué te preparo hoy?`,
    "",
    estadoTxt,
    direccion ? `📍 ${escapeHtml(direccion)}` : "",
    horarios ? `🕒 ${escapeHtml(horarios)}` : "",
    "",
    `👉 Tocá <b>Catálogo</b> para ver productos con foto.`,
    `👉 Mirá <b>Sellos</b> para tus beneficios.`,
    `👉 O <b>Compartí el bot</b> para invitar a alguien 😉`,
  ]
    .filter(Boolean)
    .join("\n");

  if (logo) await sendPhoto(chat_id, logo, text, { parse_mode: "HTML", reply_markup: mainMenuReply() });
  else await sendMessage(chat_id, text, { parse_mode: "HTML", reply_markup: mainMenuReply() });

  if (payload && payload.startsWith("P_")) {
    const code = payload.slice(2);
    return showSharedProduct(chat_id, code);
  }
}

async function showSellos(chat_id) {
  const cfg = await loadConfig();
  const card = normalizeUrl(cfg.CARD_URL || cfg.TARJETA_URL || cfg.TARJETA_VIRTUAL || "");
  const txt =
    `🏷️ <b>Tu tarjeta de sellos</b>\n\n` +
    `✅ Tus sellos se suman con compras.\n` +
    `📣 (Referidos: cuando alguien compra desde un link compartido, suma sello al que compartió.)`;

  if (card) return sendPhoto(chat_id, card, txt, { parse_mode: "HTML", reply_markup: mainMenuReply() });
  return sendMessage(chat_id, txt + `\n\n⚠️ Falta CARD_URL (o no es URL válida) en Config.`, {
    parse_mode: "HTML",
    reply_markup: mainMenuReply(),
  });
}

async function showCatalogFirst(chat_id) {
  const { items } = await loadCatalog();
  if (!items.length) return sendMessage(chat_id, "No hay productos en el catálogo.", { reply_markup: mainMenuReply() });

  const st = { list: items, index: 0, messageId: null, shareOpen: false };
  const item = items[0];
  const caption = productCaption(item, 1, items.length);

  let msg;
  if (item.imagen) {
    msg = await sendPhoto(chat_id, item.imagen, caption, { parse_mode: "HTML", reply_markup: productKeyboard() });
  } else {
    msg = await sendMessage(chat_id, caption + "\n\n⚠️ Sin imagen válida.", { parse_mode: "HTML", reply_markup: productKeyboard() });
  }
  st.messageId = msg?.result?.message_id || null;
  userState.set(chat_id, st);
}

async function updateCarousel(chat_id, dir) {
  const st = userState.get(chat_id);
  if (!st?.list?.length || !st.messageId) return;

  const total = st.list.length;
  if (dir === "NEXT") st.index = (st.index + 1) % total;
  if (dir === "PREV") st.index = (st.index - 1 + total) % total;
  st.shareOpen = false;

  const item = st.list[st.index];
  const caption = productCaption(item, st.index + 1, total);

  if (item.imagen) {
    await editMessageMedia(chat_id, st.messageId, item.imagen, caption, { reply_markup: productKeyboard() });
  } else {
    await sendMessage(chat_id, caption + "\n\n⚠️ Sin imagen válida.", { parse_mode: "HTML", reply_markup: productKeyboard() });
  }
  userState.set(chat_id, st);
}

async function openShare(chat_id) {
  const st = userState.get(chat_id);
  if (!st?.messageId) return;
  st.shareOpen = true;
  userState.set(chat_id, st);
  return editMessageReplyMarkup(chat_id, st.messageId, shareKeyboard());
}

async function closeShare(chat_id) {
  const st = userState.get(chat_id);
  if (!st?.messageId) return;
  st.shareOpen = false;
  userState.set(chat_id, st);
  return editMessageReplyMarkup(chat_id, st.messageId, productKeyboard());
}

async function shareProduct(chat_id, kind) {
  await ensureBotUsername();
  const st = userState.get(chat_id);
  const item = st?.list?.[st?.index];
  if (!item) return;

  const text = shareTextForProduct(item);
  const links = shareLinks(text);

  if (kind === "WA") {
    return sendMessage(chat_id, `📣 Compartir por WhatsApp:\n\n${text}`, {
      reply_markup: { inline_keyboard: [[{ text: "Abrir WhatsApp", url: links.wa }], [{ text: "🧀 Abrir bot", url: botLink() }]] },
    });
  }
  if (kind === "TG") {
    return sendMessage(chat_id, `✈️ Compartir por Telegram:\n\n${text}`, {
      reply_markup: { inline_keyboard: [[{ text: "Compartir en Telegram", url: links.tg }], [{ text: "🧀 Abrir bot", url: botLink() }]] },
    });
  }
  if (kind === "EM") {
    return sendMessage(chat_id, `✉️ Compartir por Email:\n\n${text}`, {
      reply_markup: { inline_keyboard: [[{ text: "Abrir Email", url: links.em }], [{ text: "🧀 Abrir bot", url: botLink() }]] },
    });
  }
}

async function shareBot(chat_id) {
  await ensureBotUsername();
  const text = shareTextForBot();
  const links = shareLinks(text);

  return sendMessage(chat_id, `📣 <b>Compartir el bot</b>\n\n${escapeHtml(text)}`, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📣 WhatsApp", url: links.wa }, { text: "✈️ Telegram", url: links.tg }],
        [{ text: "✉️ Email", url: links.em }],
      ],
    },
  });
}

async function showSharedProduct(chat_id, code) {
  const { items } = await loadCatalog();
  const item = items.find((x) => String(x.codigo || "").toLowerCase() === String(code || "").toLowerCase());

  if (!item) {
    return sendMessage(chat_id, "Te compartieron un producto, pero no lo encontré. Entrá a Catálogo 👇", {
      reply_markup: mainMenuReply(),
    });
  }

  const caption =
    `🎁 <b>Te compartieron este producto</b>\n\n` +
    productCaption(item, 1, 1) +
    `\n\n✅ Si querés pedirlo, escribí <b>QUIERO</b>`;

  if (item.imagen) return sendPhoto(chat_id, item.imagen, caption, { parse_mode: "HTML", reply_markup: mainMenuReply() });
  return sendMessage(chat_id, caption, { parse_mode: "HTML", reply_markup: mainMenuReply() });
}

// ---------------- Routes ----------------
app.get("/", (req, res) => res.status(200).send("OK"));

app.get("/webhook", async (req, res) => {
  const info = await tgCall("getWebhookInfo", {});
  res.json({ ok: true, info });
});

app.post("/telegram", async (req, res) => {
  res.sendStatus(200);
  const u = req.body || {};

  try {
    if (u.callback_query) {
      const cb = u.callback_query;
      await answerCallbackQuery(cb.id);

      const chat_id = cb.message?.chat?.id;
      const data = cb.data || "";
      if (!chat_id) return;

      if (data === "HOME") return welcome(chat_id, "");

      if (data === "P:NEXT") return updateCarousel(chat_id, "NEXT");
      if (data === "P:PREV") return updateCarousel(chat_id, "PREV");

      if (data === "P:BUY") {
        return sendMessage(chat_id, "🟢 Perfecto. Escribí <b>QUIERO</b> y te pregunto cantidad 😉", {
          parse_mode: "HTML",
          reply_markup: mainMenuReply(),
        });
      }

      if (data === "P:SHARE") return openShare(chat_id);
      if (data === "SH:BACK") return closeShare(chat_id);
      if (data === "SH:WA") return shareProduct(chat_id, "WA");
      if (data === "SH:TG") return shareProduct(chat_id, "TG");
      if (data === "SH:EM") return shareProduct(chat_id, "EM");
      return;
    }

    if (u.message) {
      const chat_id = u.message.chat.id;
      const text = (u.message.text || "").trim();

      if (text === "/start") return welcome(chat_id, "");
      if (text.startsWith("/start ")) {
        const payload = text.split(" ")[1] || "";
        return welcome(chat_id, payload);
      }

      if (text === "🛍️ Catálogo") return showCatalogFirst(chat_id);
      if (text === "🏷️ Sellos") return showSellos(chat_id);
      if (text === "📣 Compartir bot") return shareBot(chat_id);

      if (text === "QUIERO") {
        return sendMessage(chat_id, "✅ Dale. Decime cantidad:\n• <b>200g</b> o <b>2</b> (unidades)", {
          parse_mode: "HTML",
          reply_markup: mainMenuReply(),
        });
      }

      return sendMessage(chat_id, "👋 Estoy acá 😊 Tocá <b>Catálogo</b> o <b>Sellos</b> abajo.", {
        parse_mode: "HTML",
        reply_markup: mainMenuReply(),
      });
    }
  } catch (e) {
    console.error("Handler error:", e?.message || e);
  }
});

app.listen(PORT, async () => {
  console.log("✅ Server puerto:", PORT);
  console.log("✅ PUBLIC_URL:", PUBLIC_URL);
  console.log("✅ Webhook endpoint:", `${PUBLIC_URL}/telegram`);

  const me = await tgCall("getMe", {});
  if (me?.ok) {
    BOT_USERNAME = me?.result?.username || BOT_USERNAME;
    console.log("✅ BOT_USERNAME:", BOT_USERNAME);
  }

  const whUrl = `${PUBLIC_URL}/telegram`;
  const wh = await tgCall("setWebhook", { url: whUrl });
  console.log("✅ setWebhook:", wh);

  try {
    const cfg = await loadConfig();
    console.log("✅ CONFIG keys:", Object.keys(cfg).length);
  } catch (e) {
    console.log("❌ CONFIG error:", e?.message || e);
  }
});

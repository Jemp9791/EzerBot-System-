import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_TOKEN || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const SHEET_CSV_URL = process.env.SHEET_CSV_URL || "";
const BOT_USERNAME = (process.env.BOT_USERNAME || "Ezer_IA_Bot").replace(/^@/, "");
const SYSTEM_EMAIL = process.env.SYSTEM_EMAIL || "ezerbot.assistant@gmail.com";

if (!TOKEN) console.error("Falta ENV TELEGRAM_TOKEN");
if (!PUBLIC_URL) console.error("Falta ENV PUBLIC_URL");
if (!SHEET_CSV_URL) console.error("Falta ENV SHEET_CSV_URL");

const TG = (method) => `https://api.telegram.org/bot${TOKEN}/${method}`;

const enc = (s) => encodeURIComponent(String(s ?? ""));
function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
function normalizeUrl(u) {
  if (!u) return "";
  const m = u.match(/\((https?:\/\/[^)]+)\)/);
  if (m?.[1]) return m[1];
  return u.replace(/^\[|\]$/g, "").trim();
}

function stableHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).toUpperCase();
}

function ensureCode(item) {
  if (item.codigo && item.codigo.trim()) return item.codigo.trim();
  const base = `${item.nombre}|${item.precio}|${item.unidad}|${item.categoria}|${item.imagen}|${item.descripcion}`;
  return `AUTO_${stableHash(base)}`;
}

function productDeepLink(code) {
  return `https://t.me/${BOT_USERNAME}?start=prod_${encodeURIComponent(code)}`;
}
function botDeepLink() {
  return `https://t.me/${BOT_USERNAME}?start=ref_share`;
}

function waShareUrl(text, url) {
  return `https://wa.me/?text=${enc(text + "\n" + url)}`;
}
function telegramShareUrl(text, url) {
  return `https://t.me/share/url?url=${enc(url)}&text=${enc(text)}`;
}

// ✅ Email robusto: abre SIEMPRE (porque es HTTPS tuyo)
function emailLandingUrl(subject, body) {
  return `${PUBLIC_URL}/go/email?subject=${enc(subject)}&body=${enc(body)}`;
}

// ---------------- Telegram API ----------------
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
async function editMessageMedia(chat_id, message_id, photo, caption, extra = {}) {
  return tgCall("editMessageMedia", {
    chat_id,
    message_id,
    media: { type: "photo", media: photo, caption, parse_mode: "HTML" },
    ...extra,
  });
}

// ---------------- CSV parse ----------------
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

// ---------------- Catalog cache ----------------
let catalogCache = { at: 0, items: [], categories: [] };

async function loadCatalog() {
  const now = Date.now();
  if (catalogCache.items.length && now - catalogCache.at < 60_000) return catalogCache;

  const res = await fetch(SHEET_CSV_URL, { method: "GET" });
  const csv = await res.text();

  const rows = parseCSV(csv);
  if (!rows.length) throw new Error("CSV vacío");

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
    if (!row || row.length < 2) continue;

    const nombre = (row[I.NOMBRE] || "").trim();
    if (!nombre) continue;

    const item = {
      codigo: (row[I.CODIGO] || "").trim(),
      nombre,
      precio: (row[I.PRECIO] || "").trim(),
      unidad: (row[I.UNIDAD] || "").trim(),
      descripcion: (row[I.DESCRIPCION] || "").trim(),
      imagen: normalizeUrl((row[I.IMAGEN] || "").trim()),
      categoria: (row[I.CATEGORIA] || "").trim() || "Sin categoría",
    };

    item.codigo = ensureCode(item);
    items.push(item);
  }

  const categories = [...new Set(items.map((x) => x.categoria))].sort((a, b) =>
    a.localeCompare(b, "es", { sensitivity: "base" })
  );

  catalogCache = { at: now, items, categories };
  return catalogCache;
}

// ---------------- State ----------------
const userState = new Map(); // chatId -> {list, index, messageId}

// ---------------- UI ----------------
function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🛍️ Catálogo", callback_data: "MENU_CATALOGO" }],
      [{ text: "📣 Compartir BOT", callback_data: "SHARE_BOT_MENU" }],
    ],
  };
}

function categoriesKeyboard(categories) {
  const rows = [];
  for (let i = 0; i < categories.length; i += 2) {
    const a = categories[i];
    const b = categories[i + 1];
    const row = [{ text: a, callback_data: `CAT_${encodeURIComponent(a)}` }];
    if (b) row.push({ text: b, callback_data: `CAT_${encodeURIComponent(b)}` });
    rows.push(row);
  }
  rows.unshift([{ text: "📚 Todas", callback_data: "CAT_ALL" }]);
  rows.push([{ text: "🏠 Menú", callback_data: "MENU_HOME" }]);
  return { inline_keyboard: rows };
}

function productCaption(item, pos, total) {
  const unidadTxt = item.unidad ? `(${item.unidad})` : "";
  const desc = item.descripcion ? `\n📝 ${escapeHtml(item.descripcion)}` : "";
  return `🛍️ <b>${escapeHtml(item.nombre)}</b>\n💰 <b>$ ${escapeHtml(item.precio || "-")}</b> ${escapeHtml(
    unidadTxt
  )}\n📌 <i>${pos} de ${total}</i>${desc}\n\n✅ Para pedir: escribí <b>QUIERO</b>`;
}

function productKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "⬅️ Anterior", callback_data: "PROD_PREV" },
        { text: "➡️ Siguiente", callback_data: "PROD_NEXT" },
      ],
      [{ text: "🟢 Quiero este", callback_data: "PROD_WANT" }],
      [{ text: "📣 Compartir", callback_data: "SHARE_MENU" }],
      [{ text: "📁 Categorías", callback_data: "MENU_CATALOGO" }],
      [{ text: "🏠 Menú", callback_data: "MENU_HOME" }],
    ],
  };
}

function shareMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📣 WhatsApp", callback_data: "SHARE_WA" }],
      [{ text: "✉️ Email", callback_data: "SHARE_EMAIL" }],
      [{ text: "📨 Telegram", callback_data: "SHARE_TG" }],
      [{ text: "⬅️ Volver", callback_data: "SHARE_BACK" }],
    ],
  };
}

function shareBotMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📣 Bot por WhatsApp", callback_data: "SHARE_BOT_WA" }],
      [{ text: "✉️ Bot por Email", callback_data: "SHARE_BOT_EMAIL" }],
      [{ text: "📨 Bot por Telegram", callback_data: "SHARE_BOT_TG" }],
      [{ text: "🏠 Menú", callback_data: "MENU_HOME" }],
    ],
  };
}

// ---------------- Carrusel ----------------
async function showProductCarousel(chat_id, list, index) {
  const total = list.length;
  const item = list[index];
  const caption = productCaption(item, index + 1, total);

  if (!item.imagen || !item.imagen.startsWith("http")) {
    const msg = await sendMessage(chat_id, caption + "\n\n⚠️ (Sin imagen válida)", {
      parse_mode: "HTML",
      reply_markup: productKeyboard(),
    });
    return { messageId: msg?.result?.message_id || null };
  }

  const msg = await sendPhoto(chat_id, item.imagen, caption, {
    parse_mode: "HTML",
    reply_markup: productKeyboard(),
  });
  return { messageId: msg?.result?.message_id || null };
}

async function updateCarousel(chat_id, state) {
  const { list, index, messageId } = state;
  const total = list.length;
  const item = list[index];
  const caption = productCaption(item, index + 1, total);

  if (!messageId) {
    const created = await showProductCarousel(chat_id, list, index);
    state.messageId = created.messageId;
    userState.set(chat_id, state);
    return;
  }

  if (item.imagen && item.imagen.startsWith("http")) {
    await editMessageMedia(chat_id, messageId, item.imagen, caption, { reply_markup: productKeyboard() });
  } else {
    await tgCall("editMessageCaption", {
      chat_id,
      message_id: messageId,
      caption: caption + "\n\n⚠️ (Sin imagen válida)",
      parse_mode: "HTML",
      reply_markup: productKeyboard(),
    });
  }
}

// ---------------- Handlers ----------------
async function handleStart(chat_id, startPayload = "") {
  if (startPayload?.startsWith("prod_")) {
    const code = startPayload.slice(5);
    const { items } = await loadCatalog();
    const item = items.find((x) => String(x.codigo) === String(code));

    if (item) {
      const kb = {
        inline_keyboard: [
          [{ text: "🟢 Quiero este", callback_data: "PROD_WANT_SHARED" }],
          [{ text: "🛍️ Ver Catálogo", callback_data: "MENU_CATALOGO" }],
          [{ text: "📣 Compartir", callback_data: "SHARE_MENU" }],
        ],
      };

      const caption =
        `🎁 <b>PRODUCTO COMPARTIDO</b>\n\n` +
        `🛍️ <b>${escapeHtml(item.nombre)}</b>\n` +
        `💰 <b>$ ${escapeHtml(item.precio || "-")}</b> (${escapeHtml(item.unidad || "unidad")})\n` +
        (item.descripcion ? `📝 ${escapeHtml(item.descripcion)}\n` : "") +
        `\n✅ Para pedir: escribí <b>QUIERO</b>`;

      if (item.imagen && item.imagen.startsWith("http")) {
        await sendPhoto(chat_id, item.imagen, caption, { parse_mode: "HTML", reply_markup: kb });
      } else {
        await sendMessage(chat_id, caption, { parse_mode: "HTML", reply_markup: kb });
      }
      return;
    }

    await sendMessage(chat_id, "⚠️ Este producto ya no está disponible. Te muestro el menú:", {
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  await sendMessage(chat_id, "🧀 <b>Todo Queso</b>\n\nElegí una opción:", {
    parse_mode: "HTML",
    reply_markup: mainMenuKeyboard(),
  });
}

async function handleCatalogMenu(chat_id) {
  const { categories } = await loadCatalog();
  await sendMessage(chat_id, "📚 <b>Categorías</b>\nElegí una para ver productos:", {
    parse_mode: "HTML",
    reply_markup: categoriesKeyboard(categories),
  });
}

async function handleCategory(chat_id, category) {
  const { items } = await loadCatalog();
  let list = items;
  if (category && category !== "__ALL__") list = items.filter((x) => x.categoria === category);

  if (!list.length) {
    await sendMessage(chat_id, "No hay productos en esta categoría.", { reply_markup: mainMenuKeyboard() });
    return;
  }

  const state = { list, index: 0, messageId: null };
  const created = await showProductCarousel(chat_id, list, 0);
  state.messageId = created.messageId;
  userState.set(chat_id, state);
}

function currentItemFromState(chat_id) {
  const state = userState.get(chat_id);
  const item = state?.list?.[state?.index];
  return { state, item };
}

async function handleCallback(cb) {
  const chat_id = cb.message?.chat?.id;
  const data = cb.data || "";
  if (!chat_id) return;

  await tgCall("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});

  if (data === "MENU_HOME") return handleStart(chat_id);
  if (data === "MENU_CATALOGO") return handleCatalogMenu(chat_id);

  if (data === "CAT_ALL") return handleCategory(chat_id, "__ALL__");
  if (data.startsWith("CAT_")) return handleCategory(chat_id, decodeURIComponent(data.slice(4)));

  if (data === "PROD_NEXT" || data === "PROD_PREV") {
    const state = userState.get(chat_id);
    if (!state?.list?.length) return;
    const total = state.list.length;

    if (data === "PROD_NEXT") state.index = (state.index + 1) % total;
    if (data === "PROD_PREV") state.index = (state.index - 1 + total) % total;

    userState.set(chat_id, state);
    return updateCarousel(chat_id, state);
  }

  if (data === "PROD_WANT" || data === "PROD_WANT_SHARED") {
    return sendMessage(chat_id, "✅ Genial. Escribí <b>QUIERO</b> y te tomo el pedido.", { parse_mode: "HTML" });
  }

  if (data === "SHARE_MENU") {
    return sendMessage(chat_id, "📣 <b>Compartir este producto por:</b>", {
      parse_mode: "HTML",
      reply_markup: shareMenuKeyboard(),
    });
  }

  if (data === "SHARE_BACK") {
    return sendMessage(chat_id, "✅ Listo. Seguimos en el producto.", { reply_markup: productKeyboard() });
  }

  // Compartir producto
  if (data === "SHARE_WA" || data === "SHARE_EMAIL" || data === "SHARE_TG") {
    const { item } = currentItemFromState(chat_id);
    if (!item) return;

    const deep = productDeepLink(item.codigo);
    const textShare =
      `🧀 Todo Queso — ${item.nombre}\n` +
      `💰 $${item.precio} (${item.unidad || "unidad"})\n\n` +
      `Abrí y comprá acá:`;

    if (data === "SHARE_WA") {
      const wa = waShareUrl(textShare, deep);
      return sendMessage(chat_id, "📣 Compartir por WhatsApp:", {
        reply_markup: { inline_keyboard: [[{ text: "Abrir WhatsApp", url: wa }]] },
      });
    }

    if (data === "SHARE_TG") {
      const tg = telegramShareUrl(textShare, deep);
      return sendMessage(chat_id, "📨 Compartir por Telegram:", {
        reply_markup: { inline_keyboard: [[{ text: "Elegir chat en Telegram", url: tg }]] },
      });
    }

    // ✅ Email: abre landing page HTTPS (siempre funciona el click)
    if (data === "SHARE_EMAIL") {
      const subject = `Todo Queso: ${item.nombre}`;
      const body = `${textShare}\n${deep}\n\nSi querés este sistema para tu negocio: ${SYSTEM_EMAIL}`;
      const url = emailLandingUrl(subject, body);

      return sendMessage(chat_id, "✉️ Compartir por Email:", {
        reply_markup: { inline_keyboard: [[{ text: "Abrir opciones de Email", url }]] },
      });
    }
  }

  // Compartir BOT
  if (data === "SHARE_BOT_MENU") {
    return sendMessage(chat_id, "📣 <b>Compartir el BOT por:</b>", {
      parse_mode: "HTML",
      reply_markup: shareBotMenuKeyboard(),
    });
  }

  if (data === "SHARE_BOT_WA" || data === "SHARE_BOT_EMAIL" || data === "SHARE_BOT_TG") {
    const deepBot = botDeepLink();
    const text = `🧀 Todo Queso — Compras por Telegram\nAbrí el bot acá:`;

    if (data === "SHARE_BOT_WA") {
      const wa = waShareUrl(text, deepBot);
      return sendMessage(chat_id, "📣 Compartir BOT por WhatsApp:", {
        reply_markup: { inline_keyboard: [[{ text: "Abrir WhatsApp", url: wa }]] },
      });
    }

    if (data === "SHARE_BOT_TG") {
      const tg = telegramShareUrl(text, deepBot);
      return sendMessage(chat_id, "📨 Compartir BOT por Telegram:", {
        reply_markup: { inline_keyboard: [[{ text: "Elegir chat en Telegram", url: tg }]] },
      });
    }

    // ✅ Email BOT: landing page HTTPS
    if (data === "SHARE_BOT_EMAIL") {
      const subject = "Todo Queso — Compras por Telegram";
      const body = `${text}\n${deepBot}\n\nSistema: ${SYSTEM_EMAIL}`;
      const url = emailLandingUrl(subject, body);

      return sendMessage(chat_id, "✉️ Compartir BOT por Email:", {
        reply_markup: { inline_keyboard: [[{ text: "Abrir opciones de Email", url }]] },
      });
    }
  }
}

// ---------------- Routes ----------------
app.get("/", (req, res) => res.status(200).send("OK - EZER_IA_BOT LIVE"));

app.get("/debug", (req, res) => {
  res.status(200).json({
    ok: true,
    env: {
      hasToken: Boolean(TOKEN),
      publicUrl: PUBLIC_URL || null,
      botUsername: BOT_USERNAME || null,
      hasSheetCsvUrl: Boolean(SHEET_CSV_URL),
      systemEmail: SYSTEM_EMAIL || null,
    },
  });
});

// ✅ Landing Email (para que el click siempre funcione)
app.get("/go/email", (req, res) => {
  const subject = String(req.query.subject || "");
  const body = String(req.query.body || "");

  const mailto = `mailto:?subject=${enc(subject)}&body=${enc(body)}`;
  const gmail = `https://mail.google.com/mail/?view=cm&fs=1&to=&su=${enc(subject)}&body=${enc(body)}`;

  // HTML simple, rápido, con 2 botones grandes + texto copiable
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.status(200).send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Compartir por Email</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; padding:18px; max-width:720px; margin:auto;}
    h2{margin:0 0 10px;}
    .btn{display:block; text-decoration:none; padding:14px 16px; border-radius:12px; margin:10px 0; font-weight:700; text-align:center;}
    .a{background:#111; color:#fff;}
    .b{background:#0ea5e9; color:#fff;}
    textarea{width:100%; height:220px; padding:12px; border-radius:12px; border:1px solid #ddd; font-size:14px;}
    .hint{color:#555; font-size:13px; margin-top:8px;}
  </style>
</head>
<body>
  <h2>✉️ Compartir por Email</h2>
  <div class="hint">Si un botón no abre, usá el otro. Si ninguno abre, copiá y pegá el texto.</div>

  <a class="btn a" href="${mailto}">Abrir app de Email (mailto)</a>
  <a class="btn b" href="${gmail}" target="_blank" rel="noopener">Abrir Gmail Web (recomendado)</a>

  <div class="hint">Texto listo para copiar y pegar:</div>
  <textarea readonly>${body.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</textarea>
</body>
</html>
  `);
});

app.post("/", async (req, res) => {
  res.sendStatus(200);
  const update = req.body || {};

  try {
    if (update.message) {
      const chat_id = update.message.chat.id;
      const text = update.message.text || "";

      if (text.startsWith("/start")) {
        const parts = text.split(" ");
        const payload = (parts[1] || "").trim();
        return handleStart(chat_id, payload);
      }

      if ((text || "").toUpperCase().includes("QUIERO")) {
        return sendMessage(chat_id, "✅ Listo. Decime: ¿retiro o envío? (y tu dirección si es envío)");
      }

      return handleStart(chat_id);
    }

    if (update.callback_query) {
      return handleCallback(update.callback_query);
    }
  } catch (e) {
    console.error("Handler error:", e);
  }
});

// ---------------- Start ----------------
app.listen(PORT, () => {
  console.log("✅ Server listo en puerto", PORT);
  console.log("✅ URL:", PUBLIC_URL);
  console.log("✅ BOT_USERNAME:", BOT_USERNAME);
});

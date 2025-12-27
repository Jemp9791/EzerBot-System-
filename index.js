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

// ======= SHARE LINKS =======
function productStartPayload(code, refChatId) {
  // payload compacto: prod_<code>__ref_<id>
  return `prod_${encodeURIComponent(code)}__ref_${encodeURIComponent(refChatId || "")}`;
}
function botStartPayload(refChatId) {
  return `ref_share__ref_${encodeURIComponent(refChatId || "")}`;
}
function deepLink(payload) {
  return `https://t.me/${BOT_USERNAME}?start=${payload}`;
}

function waShareUrl(text, url) {
  return `https://wa.me/?text=${enc(text + "\n" + url)}`;
}
function telegramShareUrl(text, url) {
  return `https://t.me/share/url?url=${enc(url)}&text=${enc(text)}`;
}
function emailLandingUrl(subject, body) {
  return `${PUBLIC_URL}/go/email?subject=${enc(subject)}&body=${enc(body)}`;
}

// ======= Telegram API =======
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

async function editMessageCaption(chat_id, message_id, caption, extra = {}) {
  return tgCall("editMessageCaption", { chat_id, message_id, caption, parse_mode: "HTML", ...extra });
}

// ======= CSV parse =======
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

// ======= Catalog cache =======
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

// ======= Estado =======
const userState = new Map(); // chatId -> { list, index, messageId, lastMode }
const seals = new Map();     // chatId -> number (MEMORIA)

// ======= UI =======
function mainMenuKeyboard(chat_id) {
  // botón “Compartir bot” como URL buttons (cero ruido)
  const payload = botStartPayload(chat_id);
  const url = deepLink(payload);
  const text = `🧀 Todo Queso — Compras por Telegram\nAbrí el bot acá:`;
  const wa = waShareUrl(text, url);
  const tg = telegramShareUrl(text, url);
  const em = emailLandingUrl("Todo Queso — Compras por Telegram", `${text}\n${url}\n\nSistema: ${SYSTEM_EMAIL}`);

  return {
    inline_keyboard: [
      [{ text: "🛍️ Catálogo", callback_data: "MENU_CATALOGO" }],
      [
        { text: "📣 Bot WhatsApp", url: wa },
        { text: "✉️ Bot Email", url: em },
        { text: "📨 Bot Telegram", url: tg },
      ],
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

function productKeyboard(chat_id, item) {
  const payload = productStartPayload(item.codigo, chat_id);
  const url = deepLink(payload);

  const shareText =
    `🧀 Todo Queso — ${item.nombre}\n` +
    `💰 $${item.precio} (${item.unidad || "unidad"})\n\n` +
    `Abrí y comprá acá:`;

  const wa = waShareUrl(shareText, url);
  const tg = telegramShareUrl(shareText, url);
  const em = emailLandingUrl(`Todo Queso: ${item.nombre}`, `${shareText}\n${url}\n\nSistema: ${SYSTEM_EMAIL}`);

  return {
    inline_keyboard: [
      [
        { text: "⬅️", callback_data: "PROD_PREV" },
        { text: "➡️", callback_data: "PROD_NEXT" },
      ],
      [{ text: "🟢 Quiero este", callback_data: "PROD_WANT" }],
      // ✅ compartir limpio: NO callback, NO mensajes extra
      [
        { text: "📣 WhatsApp", url: wa },
        { text: "✉️ Email", url: em },
        { text: "📨 Telegram", url: tg },
      ],
      [{ text: "📁 Categorías", callback_data: "MENU_CATALOGO" }],
      [{ text: "🏠 Menú", callback_data: "MENU_HOME" }],
    ],
  };
}

// ======= Carrusel =======
async function showProductCarousel(chat_id, list, index) {
  const total = list.length;
  const item = list[index];
  const caption = productCaption(item, index + 1, total);
  const kb = productKeyboard(chat_id, item);

  if (!item.imagen || !item.imagen.startsWith("http")) {
    const msg = await sendMessage(chat_id, caption + "\n\n⚠️ (Sin imagen válida)", {
      parse_mode: "HTML",
      reply_markup: kb,
    });
    return { messageId: msg?.result?.message_id || null, isPhoto: false };
  }

  const msg = await sendPhoto(chat_id, item.imagen, caption, { parse_mode: "HTML", reply_markup: kb });
  return { messageId: msg?.result?.message_id || null, isPhoto: true };
}

async function updateCarousel(chat_id, state) {
  const { list, index, messageId } = state;
  const total = list.length;
  const item = list[index];
  const caption = productCaption(item, index + 1, total);
  const kb = productKeyboard(chat_id, item);

  if (!messageId) {
    const created = await showProductCarousel(chat_id, list, index);
    state.messageId = created.messageId;
    userState.set(chat_id, state);
    return;
  }

  if (item.imagen && item.imagen.startsWith("http")) {
    await editMessageMedia(chat_id, messageId, item.imagen, caption, { reply_markup: kb });
  } else {
    await editMessageCaption(chat_id, messageId, caption + "\n\n⚠️ (Sin imagen válida)", { reply_markup: kb });
  }
}

// ======= Sellos (memoria) =======
function addSeal(chatId, n = 1) {
  const cur = seals.get(chatId) || 0;
  seals.set(chatId, cur + n);
  return cur + n;
}

// ======= Handlers =======
async function handleStart(chat_id, startPayloadRaw = "") {
  // Parse payload: prod_<code>__ref_<id> | ref_share__ref_<id>
  const payload = String(startPayloadRaw || "").trim();

  // Si vino con ref, sumamos sello al que compartió
  // (el sello se lo damos al REFERIDOR, no al nuevo)
  const refMatch = payload.match(/__ref_([^]+)$/);
  if (refMatch && refMatch[1]) {
    const refId = decodeURIComponent(refMatch[1]);
    const refChatId = Number(refId);
    if (refChatId && Number.isFinite(refChatId) && refChatId !== chat_id) {
      const total = addSeal(refChatId, 1);
      // avisito al que compartió (sin ruido)
      await sendMessage(refChatId, `✅ ¡Nuevo ingreso desde tu link! +1 sello. Total: ${total}`);
    }
  }

  // Si es producto compartido, mostramos el producto (con foto) + CTA limpio
  if (payload.startsWith("prod_")) {
    const codePart = payload.split("__ref_")[0].slice(5); // prod_<code>
    const code = decodeURIComponent(codePart);

    const { items } = await loadCatalog();
    const item = items.find((x) => String(x.codigo) === String(code));

    if (item) {
      const caption =
        `🎁 <b>PRODUCTO COMPARTIDO</b>\n\n` +
        `🛍️ <b>${escapeHtml(item.nombre)}</b>\n` +
        `💰 <b>$ ${escapeHtml(item.precio || "-")}</b> (${escapeHtml(item.unidad || "unidad")})\n` +
        (item.descripcion ? `📝 ${escapeHtml(item.descripcion)}\n` : "") +
        `\n✅ Para pedir: escribí <b>QUIERO</b>`;

      const kb = {
        inline_keyboard: [
          [{ text: "🟢 Quiero este", callback_data: "PROD_WANT" }],
          [{ text: "🛍️ Ver Catálogo", callback_data: "MENU_CATALOGO" }],
          [{ text: "🏠 Menú", callback_data: "MENU_HOME" }],
        ],
      };

      if (item.imagen && item.imagen.startsWith("http")) {
        await sendPhoto(chat_id, item.imagen, caption, { parse_mode: "HTML", reply_markup: kb });
      } else {
        await sendMessage(chat_id, caption, { parse_mode: "HTML", reply_markup: kb });
      }
      return;
    }
  }

  // Menú limpio
  await sendMessage(chat_id, "🧀 <b>Todo Queso</b>\nElegí una opción:", {
    parse_mode: "HTML",
    reply_markup: mainMenuKeyboard(chat_id),
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
    await sendMessage(chat_id, "No hay productos en esta categoría.", { reply_markup: mainMenuKeyboard(chat_id) });
    return;
  }

  const state = { list, index: 0, messageId: null };
  const created = await showProductCarousel(chat_id, list, 0);
  state.messageId = created.messageId;
  userState.set(chat_id, state);
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

  if (data === "PROD_WANT") {
    return sendMessage(chat_id, "✅ Genial. Escribí <b>QUIERO</b> y te tomo el pedido.", { parse_mode: "HTML" });
  }
}

// ======= Routes =======
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
    seals_in_memory: Object.fromEntries(seals.entries()),
  });
});

// Landing Email (ya lo tenías, lo dejamos igual)
app.get("/go/email", (req, res) => {
  const subject = String(req.query.subject || "");
  const body = String(req.query.body || "");

  const mailto = `mailto:?subject=${enc(subject)}&body=${enc(body)}`;
  const gmail = `https://mail.google.com/mail/?view=cm&fs=1&to=&su=${enc(subject)}&body=${enc(body)}`;

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

    if (update.callback_query) return handleCallback(update.callback_query);
  } catch (e) {
    console.error("Handler error:", e);
  }
});

app.listen(PORT, () => {
  console.log("✅ Server listo en puerto", PORT);
  console.log("✅ URL:", PUBLIC_URL);
  console.log("✅ BOT_USERNAME:", BOT_USERNAME);
});

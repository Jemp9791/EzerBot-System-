/**
 * TODO_Queso — Catálogo con carrusel + botón Compartir (aislado)
 * ENV usados (no cambies en Render):
 * - TELEGRAM_TOKEN
 * - PUBLIC_URL
 * - SHEET_CSV_URL
 * - BOT_USERNAME        (opcional; si no está, usamos getMe)
 * - SYSTEM_EMAIL        (opcional; por defecto ezerbot.assistant@gmail.com)
 *
 * Rutas:
 *  - POST "/"  -> webhook Telegram
 *  - GET  "/debug" -> estado rápido
 */

import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ====== ENV ======
const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_TOKEN || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const SHEET_CSV_URL = process.env.SHEET_CSV_URL || "";
const BOT_USERNAME_ENV = (process.env.BOT_USERNAME || "").replace(/^@/, "");
const SYSTEM_EMAIL = process.env.SYSTEM_EMAIL || "ezerbot.assistant@gmail.com";

if (!TOKEN) console.error("⚠️ Falta TELEGRAM_TOKEN");
if (!PUBLIC_URL) console.error("⚠️ Falta PUBLIC_URL");
if (!SHEET_CSV_URL) console.error("⚠️ Falta SHEET_CSV_URL");

const TG = (m) => `https://api.telegram.org/bot${TOKEN}/${m}`;

// ====== Helpers Telegram ======
async function tg(method, payload) {
  const res = await fetch(TG(method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data?.ok) console.error("Telegram error:", method, data);
  return data;
}
const sendMessage = (chat_id, text, extra = {}) => tg("sendMessage", { chat_id, text, ...extra });
const sendPhoto   = (chat_id, photo, caption, extra = {}) => tg("sendPhoto", { chat_id, photo, caption, ...extra });
const editMedia   = (chat_id, message_id, photo, caption, extra = {}) =>
  tg("editMessageMedia", { chat_id, message_id,
    media: { type: "photo", media: photo, caption, parse_mode: "HTML" }, ...extra });

// ====== Utils ======
const esc = (s) => String(s || "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
const normUrl = (u) => {
  if (!u) return "";
  const m = u.match(/\((https?:\/\/[^)]+)\)/); // limpia formato [texto](url)
  if (m?.[1]) return m[1];
  return u.replace(/^\[|\]$/g,"").trim();
};

// ====== Bot username cache ======
let botUserCache = "";
async function getBotUsername() {
  if (BOT_USERNAME_ENV) return BOT_USERNAME_ENV;
  if (botUserCache) return botUserCache;
  const me = await tg("getMe", {});
  botUserCache = me?.result?.username || "";
  return botUserCache;
}
async function botDeepLink() {
  const u = await getBotUsername();
  return u ? `https://t.me/${u}` : "";
}
async function productDeepLink(code) {
  const u = await getBotUsername();
  return u ? `https://t.me/${u}?start=${encodeURIComponent("prod_"+code)}` : "";
}

// ====== Catálogo (desde CSV) ======
function parseCSV(text) {
  const rows = []; let row = []; let cur = ""; let q = false;
  for (let i=0; i<text.length; i++){
    const c=text[i], n=text[i+1];
    if (c === '"' && q && n === '"'){ cur+='"'; i++; continue; }
    if (c === '"'){ q=!q; continue; }
    if (c === "," && !q){ row.push(cur); cur=""; continue; }
    if ((c === "\n" || c === "\r") && !q){
      if (cur.length || row.length){ row.push(cur); rows.push(row); }
      cur=""; row=[]; if (c==="\r" && n==="\n") i++; continue;
    }
    cur += c;
  }
  if (cur.length || row.length){ row.push(cur); rows.push(row); }
  return rows;
}

let cache = { at:0, items:[], cats:[] };
async function loadCatalog() {
  const now = Date.now();
  if (cache.items.length && now - cache.at < 60_000) return cache;

  const csv = await (await fetch(SHEET_CSV_URL)).text();
  const rows = parseCSV(csv);
  const H = rows[0].map(h => (h||"").trim().toUpperCase());
  const idx = (n)=>H.indexOf(n);

  const I = {
    CODIGO: idx("CODIGO"), NOMBRE: idx("NOMBRE"), PRECIO: idx("PRECIO"),
    UNIDAD: idx("UNIDAD"), DESCRIPCION: idx("DESCRIPCION"),
    IMAGEN: idx("IMAGEN"), CATEGORIA: idx("CATEGORIA"),
  };

  const items = [];
  for (let r=1;r<rows.length;r++){
    const row=rows[r]; const nombre=(row?.[I.NOMBRE]||"").trim(); if(!nombre) continue;
    items.push({
      codigo:(row[I.CODIGO]||"").trim(),
      nombre,
      precio:(row[I.PRECIO]||"").trim(),
      unidad:(row[I.UNIDAD]||"").trim(),
      descripcion:(row[I.DESCRIPCION]||"").trim(),
      imagen:normUrl((row[I.IMAGEN]||"").trim()),
      categoria:(row[I.CATEGORIA]||"").trim() || "Sin categoría",
    });
  }
  const cats = [...new Set(items.map(x=>x.categoria))].sort((a,b)=>a.localeCompare(b,"es",{sensitivity:"base"}));
  cache = { at:now, items, cats }; return cache;
}

// ====== UI ======
const mainKB = () => ({
  inline_keyboard: [
    [{ text:"🛍️ Catálogo", callback_data:"MENU_CATALOGO" }],
    [{ text:"📣 Compartir bot", callback_data:"SHARE_BOT" }],
  ]
});
const catsKB = (cats) => {
  const rows = [[{ text:"📚 Todas", callback_data:"CAT_ALL" }]];
  for (let i=0;i<cats.length;i+=2){
    const a=cats[i], b=cats[i+1];
    const row=[{ text:a, callback_data:`CAT_${encodeURIComponent(a)}`}];
    if (b) row.push({ text:b, callback_data:`CAT_${encodeURIComponent(b)}`});
    rows.push(row);
  }
  rows.push([{ text:"🏠 Menú", callback_data:"MENU_HOME"}]);
  return { inline_keyboard: rows };
};
const caption = (item, i, total) => {
  const u = item.unidad ? `(${esc(item.unidad)})` : "";
  const d = item.descripcion ? `\n📝 ${esc(item.descripcion)}` : "";
  return `🛍️ <b>${esc(item.nombre)}</b>\n💰 <b>$ ${esc(item.precio||"-")}</b> ${u}\n📌 <i>${i} de ${total}</i>${d}`;
};
const navKB = (item) => ({
  inline_keyboard: [
    [{ text:"⬅️ Anterior", callback_data:"PROD_PREV" }, { text:"➡️ Siguiente", callback_data:"PROD_NEXT" }],
    [{ text:"📣 Compartir producto", callback_data:`SHARE_PROD_${encodeURIComponent(item.codigo)}` }],
    [{ text:"📁 Categorías", callback_data:"MENU_CATALOGO" }, { text:"📣 Compartir bot", callback_data:"SHARE_BOT" }],
  ]
});

// ====== Estado por chat (solo para carrusel) ======
const state = new Map(); // chatId -> { list, index, msgId }

async function showCard(chat, list, index){
  const item = list[index], total=list.length;
  const cap = caption(item, index+1, total), kb = navKB(item);

  if (item.imagen?.startsWith("http")) {
    const m = await sendPhoto(chat, item.imagen, cap, { parse_mode:"HTML", reply_markup: kb });
    return m?.result?.message_id || null;
  } else {
    const m = await sendMessage(chat, cap+"\n\n⚠️ (Sin imagen válida)", { parse_mode:"HTML", reply_markup: kb });
    return m?.result?.message_id || null;
  }
}
async function editCard(chat, st){
  const item = st.list[st.index], cap = caption(item, st.index+1, st.list.length), kb = navKB(item);
  if (!st.msgId) { st.msgId = await showCard(chat, st.list, st.index); return; }
  if (item.imagen?.startsWith("http")) {
    await editMedia(chat, st.msgId, item.imagen, cap, { reply_markup: kb });
  } else {
    await tg("editMessageCaption", {
      chat_id: chat, message_id: st.msgId,
      caption: cap+"\n\n⚠️ (Sin imagen válida)", parse_mode:"HTML", reply_markup: kb
    });
  }
}

// ====== Compartir ======
async function onShareBot(chat) {
  const link = await botDeepLink();
  const text = `🧀 Pedí por acá en Todo Queso:\n${link}\n\n¿Querés este sistema para tu negocio?\n${SYSTEM_EMAIL}`;
  const wa = `https://wa.me/?text=${encodeURIComponent(text)}`;
  const tgshare = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Pedí en Todo Queso 🧀")}`;
  const mail = `mailto:?subject=${encodeURIComponent("Bot de Todo Queso")}&body=${encodeURIComponent(text)}`;
  const sys = `mailto:${SYSTEM_EMAIL}?subject=${encodeURIComponent("Quiero el sistema EzerBot")}&body=${encodeURIComponent("Hola! Quiero este sistema para mi negocio.")}`;

  return sendMessage(chat, "📣 Elegí cómo compartir el bot:", {
    reply_markup: { inline_keyboard: [
      [{ text:"💬 WhatsApp", url: wa }],
      [{ text:"✈️ Telegram", url: tgshare }],
      [{ text:"📧 Email", url: mail }],
      [{ text:"💼 Quiero este sistema", url: sys }],
    ] }
  });
}
async function onShareProd(chat, code) {
  const { items } = await loadCatalog();
  const item = items.find(x=>x.codigo===code);
  if (!item) return sendMessage(chat, "No encontré ese producto.");
  const link = await productDeepLink(code);
  const text = `🧀 ${item.nombre}\n💰 $${item.precio} (${item.unidad})\nCompralo acá 👇\n${link}`;
  const wa = `https://wa.me/?text=${encodeURIComponent(text)}`;
  const tgshare = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(item.nombre)}`;
  const mail = `mailto:?subject=${encodeURIComponent("Producto: "+item.nombre)}&body=${encodeURIComponent(text)}`;

  return sendMessage(chat, "📣 Elegí cómo compartir este producto:", {
    reply_markup: { inline_keyboard: [
      [{ text:"💬 WhatsApp", url: wa }],
      [{ text:"✈️ Telegram", url: tgshare }],
      [{ text:"📧 Email", url: mail }],
    ] }
  });
}

// ====== Handlers ======
async function onStart(chat, text) {
  // deep-link de producto: /start prod_CODE
  const m = String(text||"").match(/^\/start\s+(.+)$/i);
  if (m && m[1].startsWith("prod_")) {
    const code = m[1].slice(5);
    const { items } = await loadCatalog();
    const it = items.find(x=>x.codigo===code);
    if (it) {
      // abre su categoría y posiciona el carrusel en ese producto
      await onCatalog(chat);
      const st = state.get(chat);
      if (st?.list?.length){
        const i = st.list.findIndex(x=>x.codigo===code);
        if (i>=0){ st.index=i; state.set(chat, st); await editCard(chat, st); }
      }
    }
  }

  return sendMessage(chat, "🧀 <b>Todo Queso</b>\nElegí una opción:", {
    parse_mode:"HTML", reply_markup: mainKB()
  });
}

async function onCatalog(chat) {
  const { items, cats } = await loadCatalog();
  state.set(chat, null); // resetea carrusel
  await sendMessage(chat, "📚 <b>Categorías</b>:", {
    parse_mode:"HTML", reply_markup: catsKB(cats)
  });
}

async function onCategory(chat, label) {
  const { items } = await loadCatalog();
  const list = label==="__ALL__" ? items : items.filter(x=>x.categoria===label);
  if (!list.length) return sendMessage(chat, "No hay productos en esta categoría.", { reply_markup: mainKB() });
  const msgId = await showCard(chat, list, 0);
  state.set(chat, { list, index:0, msgId });
}

// ====== Webhook ======
app.post("/", async (req, res) => {
  res.sendStatus(200);
  const upd = req.body || {};

  try {
    if (upd.message){
      const chat = upd.message.chat.id;
      const text = upd.message.text || "";
      if (text.startsWith("/start") || text==="start") return onStart(chat, text);
      return sendMessage(chat, "Elegí una opción:", { reply_markup: mainKB() });
    }
    if (upd.callback_query){
      const cb = upd.callback_query;
      const chat = cb.message?.chat?.id;
      const data = cb.data || "";
      await tg("answerCallbackQuery", { callback_query_id: cb.id }).catch(()=>{});

      if (data==="MENU_HOME") return onStart(chat, "/start");
      if (data==="MENU_CATALOGO") return onCatalog(chat);
      if (data==="CAT_ALL") return onCategory(chat, "__ALL__");
      if (data.startsWith("CAT_")) return onCategory(chat, decodeURIComponent(data.slice(4)));
      if (data==="PROD_NEXT" || data==="PROD_PREV"){
        const st = state.get(chat); if (!st?.list?.length) return;
        const len = st.list.length;
        st.index = data==="PROD_NEXT" ? (st.index+1)%len : (st.index-1+len)%len;
        state.set(chat, st);
        return editCard(chat, st);
      }
      if (data==="SHARE_BOT") return onShareBot(chat);
      if (data.startsWith("SHARE_PROD_")) return onShareProd(chat, decodeURIComponent(data.slice("SHARE_PROD_".length)));
    }
  } catch (e) {
    console.error("Handler error:", e);
  }
});

// ====== Debug ======
app.get("/debug", async (_req, res) => {
  const me = await tg("getMe", {});
  res.json({
    ok: true,
    env: {
      hasToken: !!TOKEN,
      hasSheetCsvUrl: !!SHEET_CSV_URL,
      publicUrl: PUBLIC_URL || null,
      botUsername: BOT_USERNAME_ENV || me?.result?.username || null,
      systemEmail: SYSTEM_EMAIL,
    }
  });
});

app.listen(PORT, () => {
  console.log("✅ Server en puerto", PORT);
  console.log("✅ Webhook:", PUBLIC_URL ? `${PUBLIC_URL}/` : "(faltante)");
});

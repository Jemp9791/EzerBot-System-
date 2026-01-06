import express from "express";
import { Telegraf, Markup } from "telegraf";
import { google } from "googleapis";

/* ===================== ENV ===================== */
const TelegramBotToken = process.env.TelegramBotToken || process.env.TELEGRAM_BOT_TOKEN;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_B64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const PORT = process.env.PORT || 10000;

if (!TelegramBotToken) throw new Error("Falta TelegramBotToken");
if (!GOOGLE_SHEET_ID) throw new Error("Falta GOOGLE_SHEET_ID");
if (!GOOGLE_SERVICE_ACCOUNT_B64) throw new Error("Falta GOOGLE_SERVICE_ACCOUNT_B64");

/* ===================== GOOGLE AUTH ===================== */
function decodeServiceAccountB64(b64) {
  const raw = Buffer.from(b64, "base64").toString("utf8").trim();
  return JSON.parse(raw);
}
const sa = decodeServiceAccountB64(GOOGLE_SERVICE_ACCOUNT_B64);
const auth = new google.auth.JWT({
  email: sa.client_email,
  key: sa.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

async function getSheetValues(rangeA1) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range: rangeA1 });
  return res.data.values || [];
}
async function appendRow(sheetName, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `${sheetName}!A:Z`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}
async function listSheets() {
  const res = await sheets.spreadsheets.get({ spreadsheetId: GOOGLE_SHEET_ID });
  return (res.data.sheets || []).map((s) => s.properties.title);
}
async function ensureSheet(sheetName, headers) {
  const existing = await listSheets();
  if (!existing.includes(sheetName)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: GOOGLE_SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${sheetName}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [headers] },
    });
  }
}

/* ===================== HELPERS ===================== */
function kvFromRows(rows) {
  const out = {};
  for (const r of rows) {
    const k = (r[0] || "").toString().trim();
    const v = (r[1] || "").toString().trim();
    if (k) out[k] = v;
  }
  return out;
}
function parseYes(v) { return String(v || "").trim().toLowerCase() === "si"; }
function parseNumber(v, def = 0) {
  const n = Number(String(v || "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : def;
}
function roundARS(n) { return Math.round(Number(n) || 0); }
function money(n, moneda = "ARS") {
  const num = Math.round(Number(n) || 0);
  return `${moneda} ${num.toLocaleString("es-AR")}`;
}
function splitPipes(v) {
  const s = String(v || "").trim();
  if (!s) return [];
  return s.split("|").map(x => x.trim()).filter(Boolean);
}
function pickRandom(arr) { return (!arr || !arr.length) ? "" : arr[Math.floor(Math.random() * arr.length)]; }

function normalizeHeaders(headerRow) {
  const map = {};
  headerRow.forEach((h, i) => {
    const key = String(h || "").trim().toLowerCase().replace(/\s+/g, "");
    if (key) map[key] = i;
  });
  return map;
}
function pick(row, hmap, keys, def = "") {
  for (const k of keys) {
    const idx = hmap[k];
    if (idx !== undefined && row[idx] !== undefined && row[idx] !== "") return row[idx];
  }
  return def;
}
function inferUnit(raw) {
  const u = String(raw || "").trim().toLowerCase();
  if (!u) return "u";
  if (u.includes("kg") || u.includes("kilo")) return "kg";
  if (u.includes("unidad") || u === "u") return "u";
  return "u";
}

/* ===================== CACHE ===================== */
const CACHE = { cfg: { v: null, t: 0 }, cat: { v: null, t: 0 } };
const CFG_TTL = 8000;
const CAT_TTL = 15000;

async function loadConfig() {
  const now = Date.now();
  if (CACHE.cfg.v && now - CACHE.cfg.t < CFG_TTL) return CACHE.cfg.v;
  const rows = await getSheetValues(`Config!A:B`);
  CACHE.cfg.v = kvFromRows(rows);
  CACHE.cfg.t = now;
  return CACHE.cfg.v;
}
async function loadCatalog() {
  const now = Date.now();
  if (CACHE.cat.v && now - CACHE.cat.t < CAT_TTL) return CACHE.cat.v;

  const rows = await getSheetValues(`Catalogo!A1:Z`);
  if (!rows.length) {
    CACHE.cat.v = { items: [], hmap: {} };
    CACHE.cat.t = now;
    return CACHE.cat.v;
  }
  const hmap = normalizeHeaders(rows[0]);
  const data = rows.slice(1).filter(r => r.some(c => String(c || "").trim() !== ""));

  const items = data.map((r, i) => {
    const code = String(pick(r, hmap, ["cod", "codigo", "id", "sku"], "")).trim() || `P${i + 1}`;
    const name = String(pick(r, hmap, ["nombre", "producto"], "Producto")).trim();
    const price = parseNumber(pick(r, hmap, ["precio"], 0), 0);
    const pricePerKg = parseNumber(pick(r, hmap, ["precioporkilo","precioporkg","preciokg","precioporkilo$"], 0), 0);
    const unit = inferUnit(pick(r, hmap, ["unidad"], ""));
    const cat = String(pick(r, hmap, ["categoria","categoría"], "General")).trim() || "General";
    const img = String(pick(r, hmap, ["imagen","imagenurl","foto"], "")).trim();
    return { code, name, price, pricePerKg, unit, cat, img };
  });

  CACHE.cat.v = { items, hmap };
  CACHE.cat.t = now;
  return CACHE.cat.v;
}
function categories(items) {
  const s = new Set(items.map(x => x.cat || "General"));
  return Array.from(s).sort((a,b)=>a.localeCompare(b,"es"));
}

/* ===================== STATE ===================== */
const SESS = new Map();
function getSess(chatId) {
  if (!SESS.has(chatId)) {
    SESS.set(chatId, {
      lastMessageId: null,     // mensaje “editable”
      screen: "MENU",          // MENU|CATS|PROD|CART|DELIVERY|PAY|HELP|SHARE|SELLOS
      page: 0,                 // para hojear
      category: null,
      productIndex: 0,
      productsInView: [],
      waiting: null,

      cart: [],
      checkout: { entrega: null, pago: null, nombre:"", tel:"", dir:"", notas:"" },

      mediaSent: { help:false, share:false, sellos:false },
    });
  }
  return SESS.get(chatId);
}
function setScreen(sess, s) { sess.screen = s; sess.page = 0; }

/* ===================== BASE SHEETS ===================== */
const PEDIDOS = "Pedidos";
const PEDIDOS_HEADERS = [
  "PedidoId","FechaISO","ChatId","Nombre","Usuario","Items","Total",
  "Entrega","Pago","Direccion","Telefono","Notas","Estado"
];
async function ensureBase() {
  await ensureSheet(PEDIDOS, PEDIDOS_HEADERS);
}

/* ===================== SAFE EDIT (clave para NO llenar chat) ===================== */
async function safeEditOrSend(ctx, { text, extra, photo, caption }) {
  const chatId = ctx.chat?.id;
  const sess = chatId ? getSess(chatId) : null;

  if (sess?.lastMessageId) {
    try {
      if (photo) {
        await ctx.telegram.editMessageMedia(
          chatId,
          sess.lastMessageId,
          undefined,
          { type:"photo", media: photo, caption: caption || "", parse_mode:"HTML" },
          extra || {}
        );
        return;
      }
      await ctx.telegram.editMessageText(chatId, sess.lastMessageId, undefined, text || " ", {
        parse_mode:"HTML",
        ...(extra || {})
      });
      return;
    } catch {/* fallback */}
  }

  let msg;
  if (photo) {
    msg = await ctx.replyWithPhoto(photo, { caption: caption || "", parse_mode:"HTML", ...(extra||{}) });
  } else {
    msg = await ctx.reply(text || " ", { parse_mode:"HTML", ...(extra||{}) });
  }
  if (sess && msg?.message_id) sess.lastMessageId = msg.message_id;
}

/* ===================== MEDIA robusto (GIF en Telegram suele ser VIDEO) ===================== */
async function sendMedia(ctx, fileIdOrUrl, caption, keyboard) {
  if (!fileIdOrUrl) {
    await ctx.reply(caption, { parse_mode:"HTML", ...(keyboard||{}) });
    return;
  }
  // 1) animation
  try {
    await ctx.replyWithAnimation(fileIdOrUrl, { caption, parse_mode:"HTML", ...(keyboard||{}) });
    return;
  } catch {}
  // 2) video (TU CASO: mp4)
  try {
    await ctx.replyWithVideo(fileIdOrUrl, { caption, parse_mode:"HTML", ...(keyboard||{}) });
    return;
  } catch {}
  // 3) document
  try {
    await ctx.replyWithDocument(fileIdOrUrl, { caption, parse_mode:"HTML", ...(keyboard||{}) });
    return;
  } catch {}
  // 4) texto
  await ctx.reply(caption, { parse_mode:"HTML", ...(keyboard||{}) });
}

/* ===================== KEYBOARDS ===================== */
function kbMain() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🧀 Catálogo", "MENU_CATALOGO")],
    [Markup.button.callback("🎟️ Sellos", "MENU_SELLOS"), Markup.button.callback("ℹ️ Ayuda", "MENU_AYUDA")],
    [Markup.button.callback("📣 Compartir", "MENU_COMPARTIR")],
  ]);
}
function kbBackMenu() {
  return Markup.inlineKeyboard([[Markup.button.callback("⬅️ Volver", "GO_BACK"), Markup.button.callback("🏠 Menú", "GO_MENU")]]);
}
function kbPager(prefix, page, total) {
  return Markup.inlineKeyboard([
    [
      page>0 ? Markup.button.callback("⬅️", `${prefix}_PREV`) : Markup.button.callback("⛔", "NOOP"),
      Markup.button.callback(`${page+1}/${total}`, "NOOP"),
      page<total-1 ? Markup.button.callback("➡️", `${prefix}_NEXT`) : Markup.button.callback("⛔", "NOOP"),
    ],
    [Markup.button.callback("⬅️ Volver", "GO_BACK"), Markup.button.callback("🏠 Menú", "GO_MENU")]
  ]);
}

/* ===================== CART / TOTAL ===================== */
function cartTotal(cart) {
  return roundARS(cart.reduce((a,it)=>a + (Number(it.subtotal)||0), 0));
}
function fmtQty(it){
  return it.qtyType==="kg" ? `${it.kg} kg` : `${it.qty} u`;
}

/* ===================== SUMA para KG ===================== */
/**
 * TU CATALOGO: unidad=kg y precioporkilo=9000 => 0.5kg => 4500
 * Si querés pack fijo (500g=9000), poné unidad=unidad o ajustá precioporkilo.
 */
function subtotalForItem(p, qtyType, value) {
  if (qtyType==="kg") {
    const kg = Math.max(0.01, parseNumber(value, 0));
    const priceKg = p.pricePerKg > 0 ? p.pricePerKg : p.price; // fallback
    return { kg, qty:0, subtotal: roundARS(kg * priceKg) };
  }
  const qty = Math.max(1, parseNumber(value, 0));
  return { kg:0, qty, subtotal: roundARS(qty * p.price) };
}

/* ===================== SCREENS ===================== */
async function showMenu(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  setScreen(sess,"MENU");

  const nombre = cfg.NegocioNombre || "Todo Queso";
  const caption = `🏠 <b>${nombre}</b>\n\nElegí una opción 👇`;

  await safeEditOrSend(ctx, { text: caption, extra: kbMain() });
}

async function showCategories(ctx) {
  const sess = getSess(ctx.chat.id);
  setScreen(sess,"CATS");

  const { items } = await loadCatalog();
  const cats = categories(items);
  if (!cats.length) {
    await safeEditOrSend(ctx, { text: "🧀 Catálogo vacío.", extra: kbBackMenu() });
    return;
  }

  const rows = [];
  for (let i=0;i<cats.length;i+=2) {
    const r=[];
    r.push(Markup.button.callback(`📁 ${cats[i]}`, `CAT_${encodeURIComponent(cats[i])}`));
    if (cats[i+1]) r.push(Markup.button.callback(`📁 ${cats[i+1]}`, `CAT_${encodeURIComponent(cats[i+1])}`));
    rows.push(r);
  }
  rows.push([Markup.button.callback("⬅️ Volver", "GO_BACK"), Markup.button.callback("🏠 Menú", "GO_MENU")]);

  await safeEditOrSend(ctx, { text:`🧀 <b>Catálogo</b>\n\nElegí categoría 👇`, extra: Markup.inlineKeyboard(rows) });
}

function kbProduct(sess, p, idx, total) {
  const rows = [
    [Markup.button.callback("⬅️", "PROD_PREV"), Markup.button.callback("➡️", "PROD_NEXT")],
    [Markup.button.callback("✅ Quiero éste", `WANT_${p.code}`)]
  ];
  // ✅ “Ver carrito” SOLO si ya compró algo
  if (sess.cart.length > 0) rows.push([Markup.button.callback("🛒 Ver carrito", "VIEW_CART")]);
  rows.push([Markup.button.callback("⬅️ Volver", "GO_BACK"), Markup.button.callback("🏠 Menú", "GO_MENU")]);
  return Markup.inlineKeyboard(rows);
}

async function showProduct(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  const list = sess.productsInView;
  const p = list[sess.productIndex];
  const moneda = cfg.Moneda || "ARS";

  const lines = [];
  lines.push(`<b>${p.name}</b>`);
  if (p.unit==="kg") lines.push(`💰 <b>${money(p.pricePerKg || p.price, moneda)}</b> / kg`);
  else lines.push(`💰 <b>${money(p.price, moneda)}</b>`);
  lines.push(`\n📌 ${p.cat}`);
  lines.push(`\n<code>${sess.productIndex+1}/${list.length}</code>`);
  const caption = lines.join("\n");

  const photo = p.img?.startsWith("http") ? p.img : null;
  if (photo) await safeEditOrSend(ctx, { photo, caption, extra: kbProduct(sess,p,sess.productIndex,list.length) });
  else await safeEditOrSend(ctx, { text: caption, extra: kbProduct(sess,p,sess.productIndex,list.length) });
}

async function showCart(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  setScreen(sess,"CART");

  if (!sess.cart.length) {
    await safeEditOrSend(ctx, { text:`🛒 <b>Carrito</b>\n\nVacío.`, extra: Markup.inlineKeyboard([
      [Markup.button.callback("🧀 Catálogo","MENU_CATALOGO")],
      [Markup.button.callback("🏠 Menú","GO_MENU")]
    ])});
    return;
  }

  const moneda = cfg.Moneda || "ARS";
  const lines = [];
  lines.push(`🛒 <b>Carrito</b>`);
  lines.push(`──────────────────`);
  sess.cart.forEach((it,i)=>{
    lines.push(`${i+1}) <b>${it.name}</b>`);
    lines.push(`   ${fmtQty(it)} · ${money(it.subtotal, moneda)}`);
  });
  lines.push(`──────────────────`);
  lines.push(`🧮 <b>Total:</b> ${money(cartTotal(sess.cart), moneda)}`);

  // ✅ BOTÓN PRINCIPAL CORRECTO
  const hasDelivery = !!sess.checkout.entrega;
  const hasPay = !!sess.checkout.pago;

  const rows = [];
  if (!hasDelivery) rows.push([Markup.button.callback("🚚 Elegir entrega","CHK_DELIVERY")]);
  else if (!hasPay) rows.push([Markup.button.callback("💳 Elegir pago","CHK_PAY")]);
  else rows.push([Markup.button.callback("✅ Finalizar compra","FINALIZE")]);

  rows.push([Markup.button.callback("🧀 Seguir comprando","MENU_CATALOGO")]);
  rows.push([Markup.button.callback("🗑️ Vaciar carrito","CART_CLEAR")]);
  rows.push([Markup.button.callback("⬅️ Volver","GO_BACK"), Markup.button.callback("🏠 Menú","GO_MENU")]);

  await safeEditOrSend(ctx, { text: lines.join("\n"), extra: Markup.inlineKeyboard(rows) });
}

/* ===================== HOJEAR: AYUDA / SHARE / SELLOS (siempre edita el mismo msg) ===================== */
async function showHelp(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  setScreen(sess,"HELP");

  const pages = [
    `ℹ️ <b>Ayuda</b>\n\n1) Entrá a 🧀 Catálogo\n2) Elegí ✅ Quiero éste\n3) Poné kilos o unidades\n4) Terminá con Finalizar compra`,
    `🚚 <b>Entrega</b>\n\n• Envío a domicilio\n• Express\n• Retiro en el local\n\n(Se habilita cuando ya hay productos en carrito)`,
    `💳 <b>Pago</b>\n\n• Transferencia\n• Efectivo\n\nDespués: ✅ Finalizar compra`
  ];
  const total = pages.length;

  const media = pickRandom(splitPipes(cfg.GifAyudaID || cfg.GifAyudaVideoId || cfg.GifAyuda || ""));
  // ✅ si querés media, la mando SOLO 1 vez para no llenar
  if (!sess.mediaSent.help && media) {
    sess.mediaSent.help = true;
    await sendMedia(ctx, media, pages[sess.page], { reply_markup: kbPager("HELP", sess.page, total).reply_markup });
    return;
  }

  await safeEditOrSend(ctx, { text: pages[sess.page], extra: kbPager("HELP", sess.page, total) });
}
async function showShare(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  setScreen(sess,"SHARE");

  const botLink = String(cfg.BotLink || "").trim();
  const email = String(cfg.EmailSistema || "ezerbot.assistant@gmail.com").trim();

  const pages = [
    `📣 <b>Compartir el bot</b>\n\nLink:\n<code>${botLink || "(FALTA BotLink en Config)"}</code>`,
    `🧩 <b>¿Querés un bot igual?</b>\n\nConsultas:\n<b>${email}</b>`
  ];
  const total = pages.length;

  const media = pickRandom(splitPipes(cfg.GifCompartirID || cfg.GifCompartirVideoId || cfg.GifCompartir || ""));
  if (!sess.mediaSent.share && media) {
    sess.mediaSent.share = true;
    await sendMedia(ctx, media, pages[sess.page], { reply_markup: kbPager("SHARE", sess.page, total).reply_markup });
    return;
  }

  await safeEditOrSend(ctx, { text: pages[sess.page], extra: kbPager("SHARE", sess.page, total) });
}
async function showSellos(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  setScreen(sess,"SELLOS");

  const pages = [
    `🎟️ <b>Sellos</b>\n\nAcá va tu explicación de sellos.`,
    `🏅 <b>Niveles</b>\n\nBronce / Plata / Oro / Platino / Diamante`,
    `🎁 <b>Canjes</b>\n\nCómo canjear y vencimientos (si querés lo armamos).`
  ];
  const total = pages.length;

  const media = pickRandom(splitPipes(cfg.GifSellosID || cfg.GifSellosVideoId || cfg.GifSellos || ""));
  if (!sess.mediaSent.sellos && media) {
    sess.mediaSent.sellos = true;
    await sendMedia(ctx, media, pages[sess.page], { reply_markup: kbPager("SELLOS", sess.page, total).reply_markup });
    return;
  }

  await safeEditOrSend(ctx, { text: pages[sess.page], extra: kbPager("SELLOS", sess.page, total) });
}

/* ===================== CHECKOUT básico (mantiene flujo) ===================== */
async function showDelivery(ctx) {
  const sess = getSess(ctx.chat.id);
  setScreen(sess,"DELIVERY");
  await safeEditOrSend(ctx, {
    text: `🚚 <b>Entrega</b>\n\nElegí:`,
    extra: Markup.inlineKeyboard([
      [Markup.button.callback("🚚 Envío","DEL_ENVIO"), Markup.button.callback("⚡ Express","DEL_EXPRESS")],
      [Markup.button.callback("🏪 Retiro","DEL_RETIRO")],
      [Markup.button.callback("⬅️ Volver","GO_BACK"), Markup.button.callback("🏠 Menú","GO_MENU")]
    ])
  });
}
async function showPay(ctx) {
  const sess = getSess(ctx.chat.id);
  setScreen(sess,"PAY");
  await safeEditOrSend(ctx, {
    text: `💳 <b>Pago</b>\n\nElegí:`,
    extra: Markup.inlineKeyboard([
      [Markup.button.callback("🏦 Transferencia","PAY_TRANSF"), Markup.button.callback("💵 Efectivo","PAY_EFEC")],
      [Markup.button.callback("⬅️ Volver","GO_BACK"), Markup.button.callback("🏠 Menú","GO_MENU")]
    ])
  });
}
function buildOrderId() {
  const d = new Date();
  const pad = (n)=>String(n).padStart(2,"0");
  return `TQ-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
async function finalize(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  if (!sess.cart.length) return showCart(ctx);
  if (!sess.checkout.entrega) return showDelivery(ctx);
  if (!sess.checkout.pago) return showPay(ctx);

  const orderId = buildOrderId();
  const nowIso = new Date().toISOString();

  const nombre = sess.checkout.nombre || `${ctx.from.first_name||""} ${ctx.from.last_name||""}`.trim();
  const usuario = ctx.from.username ? `@${ctx.from.username}` : "";

  // ✅ Total final = suma de items (y si después querés agregar envío, lo hacemos 1 sola vez acá)
  const total = cartTotal(sess.cart);

  const itemsTxt = sess.cart.map(it => `${it.name} (${fmtQty(it)})`).join(" | ");

  await appendRow(PEDIDOS, [
    orderId, nowIso, String(ctx.chat.id),
    nombre, usuario, itemsTxt, total,
    sess.checkout.entrega, sess.checkout.pago,
    sess.checkout.dir, sess.checkout.tel, sess.checkout.notas,
    "PENDIENTE"
  ]);

  const moneda = cfg.Moneda || "ARS";
  const lines = [];
  lines.push(`✅ <b>Pedido confirmado</b>`);
  lines.push(`<code>${orderId}</code>`);
  lines.push(`──────────────────`);
  sess.cart.forEach(it=>{
    lines.push(`• <b>${it.name}</b>`);
    lines.push(`  ${fmtQty(it)} · ${money(it.subtotal, moneda)}`);
  });
  lines.push(`──────────────────`);
  lines.push(`🧮 <b>Total:</b> ${money(total, moneda)}`);
  lines.push(`🚚 <b>Entrega:</b> ${sess.checkout.entrega}`);
  lines.push(`💳 <b>Pago:</b> ${sess.checkout.pago}`);

  await safeEditOrSend(ctx, { text: lines.join("\n"), extra: Markup.inlineKeyboard([[Markup.button.callback("🏠 Menú","GO_MENU")]]) });

  // limpiar para próxima compra
  sess.cart = [];
  sess.checkout = { entrega:null, pago:null, nombre:"", tel:"", dir:"", notas:"" };
  sess.waiting = null;
}

/* ===================== BOT ===================== */
const bot = new Telegraf(TelegramBotToken);

bot.start(async (ctx)=>{ await ensureBase(); await showMenu(ctx); });
bot.action("NOOP", async (ctx)=>{ await ctx.answerCbQuery(); });

bot.action("GO_MENU", async (ctx)=>{ await ctx.answerCbQuery(); await showMenu(ctx); });

bot.action("GO_BACK", async (ctx)=>{
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  if (sess.screen==="CATS") return showMenu(ctx);
  if (sess.screen==="PROD") return showCategories(ctx);
  if (sess.screen==="CART") return showCategories(ctx);
  if (sess.screen==="DELIVERY") return showCart(ctx);
  if (sess.screen==="PAY") return showCart(ctx);
  if (sess.screen==="HELP" || sess.screen==="SHARE" || sess.screen==="SELLOS") return showMenu(ctx);
  return showMenu(ctx);
});

/* MENU */
bot.action("MENU_CATALOGO", async (ctx)=>{ await ctx.answerCbQuery(); await showCategories(ctx); });
bot.action("MENU_AYUDA", async (ctx)=>{ await ctx.answerCbQuery(); await showHelp(ctx); });
bot.action("MENU_COMPARTIR", async (ctx)=>{ await ctx.answerCbQuery(); await showShare(ctx); });
bot.action("MENU_SELLOS", async (ctx)=>{ await ctx.answerCbQuery(); await showSellos(ctx); });

/* PAGER */
bot.action("HELP_NEXT", async (ctx)=>{ await ctx.answerCbQuery(); const s=getSess(ctx.chat.id); s.page=Math.min(s.page+1,2); await showHelp(ctx); });
bot.action("HELP_PREV", async (ctx)=>{ await ctx.answerCbQuery(); const s=getSess(ctx.chat.id); s.page=Math.max(s.page-1,0); await showHelp(ctx); });

bot.action("SHARE_NEXT", async (ctx)=>{ await ctx.answerCbQuery(); const s=getSess(ctx.chat.id); s.page=Math.min(s.page+1,1); await showShare(ctx); });
bot.action("SHARE_PREV", async (ctx)=>{ await ctx.answerCbQuery(); const s=getSess(ctx.chat.id); s.page=Math.max(s.page-1,0); await showShare(ctx); });

bot.action("SELLOS_NEXT", async (ctx)=>{ await ctx.answerCbQuery(); const s=getSess(ctx.chat.id); s.page=Math.min(s.page+1,2); await showSellos(ctx); });
bot.action("SELLOS_PREV", async (ctx)=>{ await ctx.answerCbQuery(); const s=getSess(ctx.chat.id); s.page=Math.max(s.page-1,0); await showSellos(ctx); });

/* CATEGORÍAS */
bot.action(/^CAT_(.+)$/i, async (ctx)=>{
  await ctx.answerCbQuery();
  const cat = decodeURIComponent(ctx.match[1]);
  const sess = getSess(ctx.chat.id);
  const { items } = await loadCatalog();
  const prods = items.filter(p => (p.cat||"General")===cat);

  if (!prods.length) return safeEditOrSend(ctx,{ text:`No hay productos en <b>${cat}</b>.`, extra: kbBackMenu() });

  sess.productsInView = prods;
  sess.productIndex = 0;
  setScreen(sess,"PROD");
  await showProduct(ctx);
});

/* PRODUCTO */
bot.action("PROD_NEXT", async (ctx)=>{
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  sess.productIndex = (sess.productIndex + 1) % sess.productsInView.length;
  await showProduct(ctx);
});
bot.action("PROD_PREV", async (ctx)=>{
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  sess.productIndex = (sess.productIndex - 1 + sess.productsInView.length) % sess.productsInView.length;
  await showProduct(ctx);
});

bot.action(/^WANT_(.+)$/i, async (ctx)=>{
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  const code = ctx.match[1];
  const p = sess.productsInView.find(x=>x.code===code);
  if (!p) return;

  // según tu catálogo: kg => pedimos kilos (podés escribir 0.5)
  if (p.unit==="kg") {
    sess.waiting = { type:"QTY_KG", payload:{ code } };
    return safeEditOrSend(ctx,{ text:`✅ <b>${p.name}</b>\n\n¿Cuántos <b>kilos</b> querés?\nEj: <code>0.5</code> (500g) o <code>1</code>`, extra: kbBackMenu() });
  }

  sess.waiting = { type:"QTY_U", payload:{ code } };
  return safeEditOrSend(ctx,{ text:`✅ <b>${p.name}</b>\n\n¿Cuántas <b>unidades</b>?\nEj: <code>1</code> o <code>2</code>`, extra: kbBackMenu() });
});

bot.action("VIEW_CART", async (ctx)=>{ await ctx.answerCbQuery(); await showCart(ctx); });

/* CART */
bot.action("CART_CLEAR", async (ctx)=>{ await ctx.answerCbQuery(); const s=getSess(ctx.chat.id); s.cart=[]; s.checkout={entrega:null,pago:null,nombre:"",tel:"",dir:"",notas:""}; await showCart(ctx); });
bot.action("CHK_DELIVERY", async (ctx)=>{ await ctx.answerCbQuery(); await showDelivery(ctx); });
bot.action("CHK_PAY", async (ctx)=>{ await ctx.answerCbQuery(); await showPay(ctx); });

/* DELIVERY */
bot.action("DEL_ENVIO", async (ctx)=>{ await ctx.answerCbQuery(); const s=getSess(ctx.chat.id); s.checkout.entrega="ENVIO"; await showCart(ctx); });
bot.action("DEL_EXPRESS", async (ctx)=>{ await ctx.answerCbQuery(); const s=getSess(ctx.chat.id); s.checkout.entrega="EXPRESS"; await showCart(ctx); });
bot.action("DEL_RETIRO", async (ctx)=>{ await ctx.answerCbQuery(); const s=getSess(ctx.chat.id); s.checkout.entrega="RETIRO"; await showCart(ctx); });

/* PAY */
bot.action("PAY_TRANSF", async (ctx)=>{ await ctx.answerCbQuery(); const s=getSess(ctx.chat.id); s.checkout.pago="TRANSFERENCIA"; await showCart(ctx); });
bot.action("PAY_EFEC", async (ctx)=>{ await ctx.answerCbQuery(); const s=getSess(ctx.chat.id); s.checkout.pago="EFECTIVO"; await showCart(ctx); });

/* FINALIZE */
bot.action("FINALIZE", async (ctx)=>{ await ctx.answerCbQuery(); await finalize(ctx); });

/* TEXT INPUT (cantidades) */
bot.on("text", async (ctx)=>{
  const sess = getSess(ctx.chat.id);
  if (!sess.waiting) return;

  const text = String(ctx.message.text||"").trim();
  const w = sess.waiting;
  sess.waiting = null;

  const p = sess.productsInView.find(x=>x.code===w.payload?.code);
  if (!p) return;

  if (w.type==="QTY_KG") {
    const n = parseNumber(text,0);
    if (!n || n<=0) { sess.waiting=w; return safeEditOrSend(ctx,{ text:`⚠️ Pasame un número válido. Ej: 0.5`, extra: kbBackMenu() }); }

    const calc = subtotalForItem(p,"kg",n);
    sess.cart.push({ code:p.code, name:p.name, qtyType:"kg", kg: calc.kg, qty:0, subtotal: calc.subtotal });
    return showCart(ctx);
  }

  if (w.type==="QTY_U") {
    const n = parseNumber(text,0);
    if (!n || n<=0) { sess.waiting=w; return safeEditOrSend(ctx,{ text:`⚠️ Pasame un número válido. Ej: 1`, extra: kbBackMenu() }); }

    const calc = subtotalForItem(p,"u",n);
    sess.cart.push({ code:p.code, name:p.name, qtyType:"u", kg:0, qty: calc.qty, subtotal: calc.subtotal });
    return showCart(ctx);
  }
});

/* ===================== SERVER (Render webhook) ===================== */
const app = express();
app.use(express.json());
app.get("/", (req,res)=>res.status(200).send("OK ✅"));

async function start() {
  await ensureBase();

  if (PUBLIC_URL && PUBLIC_URL.startsWith("http")) {
    const hook = `${PUBLIC_URL.replace(/\/$/,"")}/telegram`;
    await bot.telegram.setWebhook(hook);
    app.use(bot.webhookCallback("/telegram"));
    app.listen(PORT, ()=>console.log("Webhook OK:", hook));
  } else {
    bot.launch();
    app.listen(PORT, ()=>console.log("Long polling OK"));
  }
}
start().catch((e)=>{ console.error("FATAL:", e); process.exit(1); });

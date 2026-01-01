/**
 * EZERBot / Todo Queso — Telegram Bot (Render) — ÚNICO SCRIPT (index.js)
 *
 * ✅ Menú fijo: Catálogo / Sellos / Compartir bot / Ayuda  (SIN botón “Carrito”)
 * ✅ Catálogo tipo carrusel con fotos + botones (prev/next/agregar/compartir/finalizar)
 * ✅ Diferencia UNIDAD vs GRAMOS (usa columna UNIDAD y PRECIOPORKILO)
 * ✅ Envío: pregunta domicilio y datos SIEMPRE
 * ✅ Transferencia: NUNCA dice “recibimos” hasta confirmación del vendedor
 * ✅ Sellos:
 *    - Compra confirmada: 1 sello cada MontoPorSello (por total confirmado)
 *    - Referido confirmado: suma BonusSellosShare al referente (sin importar valor)
 * ✅ Página /s/:uid muestra CARD_URL + sellos virtuales con LogoURL
 *
 * ENV (Render) — NO cambies más:
 *   TELEGRAM_TOKEN   (obligatorio)
 *   PUBLIC_URL       (obligatorio) ej https://ezerbot-system.onrender.com   (sin / final)
 *   DATA_API_URL     (obligatorio) tu Apps Script exec (sin query)
 *
 * Requiere que tu Apps Script responda:
 *   GET  DATA_API_URL?type=config
 *   GET  DATA_API_URL?type=catalog
 *   GET  DATA_API_URL?type=cliente&userId=123
 *   POST DATA_API_URL  (JSON) { action:"upsertCliente", cliente:{...} }
 *   POST DATA_API_URL  (JSON) { action:"appendPedido", pedido:{...} }
 *   POST DATA_API_URL  (JSON) { action:"addSellos", userId:"", delta:0, totalConfirmadoDelta:0 }
 *   POST DATA_API_URL  (JSON) { action:"addReferidoBonus", ownerUserId:"", delta:0 }
 *
 * Columnas Sheets (como me pasaste):
 *  Clientes:
 *   UserIdTG | Nombre | Telefono | Sellos | TotalConfirmado | CodigoReferido | ReferidoPor | UltAct
 *  Catalogo:
 *   CODIGO | NOMBRE | PRECIO | UNIDAD | PRECIOPORKILO | CODIGOBARRAS | DESCRIPCION | IMAGEN | CATEGORIA
 *  Referidos:
 *   CodigoReferido | OwnerUserIdTG
 */

import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "4mb" }));

// ===== ENV =====
const TOKEN = (process.env.TELEGRAM_TOKEN || "").trim();
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
const DATA_API_URL = (process.env.DATA_API_URL || "").trim().replace(/\/+$/, "");

if (!TOKEN) console.error("❌ Falta TELEGRAM_TOKEN");
if (!PUBLIC_URL) console.error("❌ Falta PUBLIC_URL");
if (!DATA_API_URL) console.error("❌ Falta DATA_API_URL");

const PORT = process.env.PORT || 10000;
const TG = (m) => `https://api.telegram.org/bot${TOKEN}/${m}`;

// ===== Telegram API =====
async function tgCall(method, payload) {
  const res = await fetch(TG(method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!json?.ok) console.error("TG error:", method, json);
  return json;
}
const sendMessage = (chat_id, text, extra = {}) =>
  tgCall("sendMessage", { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
const sendPhoto = (chat_id, photo, caption, extra = {}) =>
  tgCall("sendPhoto", { chat_id, photo, caption, parse_mode: "HTML", ...extra });
const editMedia = (chat_id, message_id, photo, caption, reply_markup) =>
  tgCall("editMessageMedia", {
    chat_id,
    message_id,
    media: { type: "photo", media: photo, caption, parse_mode: "HTML" },
    reply_markup,
  });
const editCaption = (chat_id, message_id, caption, reply_markup) =>
  tgCall("editMessageCaption", { chat_id, message_id, caption, parse_mode: "HTML", reply_markup });
const answerCb = (id) => tgCall("answerCallbackQuery", { callback_query_id: id });
const setWebhook = (url) => tgCall("setWebhook", { url });

// ===== Utils =====
const esc = (s) =>
  String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const low = (s) => String(s || "").trim().toLowerCase();
const isHttp = (u) => typeof u === "string" && /^https?:\/\//i.test(u.trim());
const num = (v) => {
  const s = String(v ?? "").trim().replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};
const nowISO = () => new Date().toISOString();
const orderId = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const hash16 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 16);
const base36 = (n) => Math.abs(Number(n) || 0).toString(36);
const unbase36 = (s) => parseInt(String(s || "0"), 36) || 0;

// ===== DATA API (Apps Script) =====
async function apiGet(params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${DATA_API_URL}?${qs}`;
  const r = await fetch(url);
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return { ok: false, error: "Respuesta no JSON", raw: t.slice(0, 200) };
  }
}
async function apiPost(body = {}) {
  const r = await fetch(DATA_API_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return { ok: false, error: "Respuesta no JSON", raw: t.slice(0, 200) };
  }
}

// ===== Cache =====
const CACHE = { cfg: null, cat: null, cfgAt: 0, catAt: 0 };
async function getConfig(force = false) {
  if (!force && CACHE.cfg && Date.now() - CACHE.cfgAt < 15000) return CACHE.cfg;
  const j = await apiGet({ type: "config" });
  const cfg = j?.config || j?.data || j || {};
  CACHE.cfg = cfg;
  CACHE.cfgAt = Date.now();
  return cfg;
}
async function getCatalog(force = false) {
  if (!force && CACHE.cat && Date.now() - CACHE.catAt < 15000) return CACHE.cat;
  const j = await apiGet({ type: "catalog" });

  // soporta {items:[]}, o {data:[]}, o array directo
  const arr = Array.isArray(j?.items) ? j.items : Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [];
  const items = arr
    .map((x) => ({
      codigo: String(x.CODIGO ?? x.codigo ?? "").trim(),
      nombre: String(x.NOMBRE ?? x.nombre ?? "").trim(),
      precio: num(x.PRECIO ?? x.precio ?? 0),
      unidad: String(x.UNIDAD ?? x.unidad ?? "").trim(), // "unidad" o "gramos"
      precioPorKilo: num(x.PRECIOPORKILO ?? x.precioPorKilo ?? 0),
      descripcion: String(x.DESCRIPCION ?? x.descripcion ?? "").trim(),
      imagen: String(x.IMAGEN ?? x.imagen ?? "").trim(),
      categoria: String(x.CATEGORIA ?? x.categoria ?? "General").trim(),
    }))
    .filter((x) => x.codigo && x.nombre);

  const categorias = [...new Set(items.map((i) => i.categoria))].sort((a, b) =>
    a.localeCompare(b, "es", { sensitivity: "base" })
  );

  CACHE.cat = { items, categorias };
  CACHE.catAt = Date.now();
  return CACHE.cat;
}

async function getCliente(userId) {
  const j = await apiGet({ type: "cliente", userId: String(userId) });
  return j?.cliente || j?.data || null;
}

async function ensureCliente(userId, nombre, referidoPor = "") {
  const existing = await getCliente(userId);
  if (existing) return existing;

  const codigo = `R-${String(userId).slice(-6)}-${hash16(userId).slice(0, 4)}`.toUpperCase();
  const cliente = {
    UserIdTG: String(userId),
    Nombre: String(nombre || "Cliente").trim(),
    Telefono: "",
    Sellos: 0,
    TotalConfirmado: 0,
    CodigoReferido: codigo,
    ReferidoPor: String(referidoPor || "").trim(),
    UltAct: nowISO(),
  };

  // crea en Clientes y también asegura Referidos (si tu GAS lo hace)
  const r = await apiPost({ action: "upsertCliente", cliente });
  if (!r?.ok) console.error("upsertCliente error", r);
  return (await getCliente(userId)) || cliente;
}

// ===== Menú fijo (SIN Carrito) =====
function mainMenu() {
  return {
    keyboard: [
      [{ text: "🛍️ Catálogo" }],
      [{ text: "🎟️ Sellos" }, { text: "📣 Compartir bot" }],
      [{ text: "🆘 Ayuda" }],
    ],
    resize_keyboard: true,
  };
}

// ===== Sessions =====
const S = new Map(); // userId -> session
function ses(userId) {
  if (!S.has(userId)) S.set(userId, {});
  return S.get(userId);
}
function clearSes(userId) {
  S.delete(userId);
}

// ===== Cart helpers =====
function isPesable(item) {
  const u = low(item?.unidad);
  if (u.includes("gram")) return true;
  if (u === "g" || u === "gramos") return true;
  return false;
}
function parseQty(text) {
  const t = low(text);
  // 200g / 200 / 200 gr
  const m = t.match(/^(\d+)\s*(g|gr|gramos)?$/);
  if (!m) return null;
  const v = Number(m[1]);
  if (!v || v <= 0) return null;
  const isG = !!m[2];
  return { value: v, kind: isG ? "GRAMOS" : "NUM" };
}
function priceForPesable(item, gramos) {
  // Si hay PRECIOPORKILO => usa eso
  if (item.precioPorKilo > 0) return Math.round((item.precioPorKilo * gramos) / 1000);
  // Si NO hay, asumimos PRECIO = por kilo
  return Math.round((item.precio * gramos) / 1000);
}
function cartTotal(cart) {
  return Math.round(
    (cart || []).reduce((a, x) => {
      const sub = Number(x.subtotal || 0);
      return a + (Number.isFinite(sub) ? sub : 0);
    }, 0)
  );
}
function fmtCart(cfg, cart) {
  const moneda = String(cfg?.Moneda || "ARS").trim() || "ARS";
  if (!cart?.length) return "— (vacío)";
  return cart
    .map((x) => {
      if (x.tipo === "GRAMOS") return `• ${x.nombre} (${x.gramos}g) — <b>${esc(moneda)} ${esc(x.subtotal)}</b>`;
      return `• ${x.nombre} (x${x.qty}) — <b>${esc(moneda)} ${esc(x.subtotal)}</b>`;
    })
    .join("\n");
}

// ===== Carrusel =====
function catMenuKeyboard(categorias) {
  const rows = [[{ text: "📚 Todas", callback_data: "CAT:__ALL__" }]];
  for (let i = 0; i < categorias.length; i += 2) {
    const a = categorias[i];
    const b = categorias[i + 1];
    const row = [{ text: a, callback_data: `CAT:${encodeURIComponent(a)}` }];
    if (b) row.push({ text: b, callback_data: `CAT:${encodeURIComponent(b)}` });
    rows.push(row);
  }
  rows.push([{ text: "🏠 Menú", callback_data: "HOME" }]);
  return { inline_keyboard: rows };
}

function productKb() {
  return {
    inline_keyboard: [
      [{ text: "⬅️", callback_data: "P:PREV" }, { text: "➡️", callback_data: "P:NEXT" }],
      [{ text: "🟢 Agregar", callback_data: "P:ADD" }],
      [{ text: "📣 Compartir", callback_data: "P:SHARE" }],
      [{ text: "✅ Finalizar compra", callback_data: "CHECKOUT:START" }],
      [{ text: "📁 Categorías", callback_data: "CAT_MENU" }, { text: "🏠 Menú", callback_data: "HOME" }],
    ],
  };
}

function shareProductKb(shareText, backCb = "P:SHARE_BACK") {
  const wa = `https://wa.me/?text=${encodeURIComponent(shareText)}`;
  const tg = `https://t.me/share/url?url=${encodeURIComponent(" ")}&text=${encodeURIComponent(shareText)}`;
  return {
    inline_keyboard: [
      [{ text: "📣 WhatsApp", url: wa }, { text: "✈️ Telegram", url: tg }],
      [{ text: "⬅️ Volver", callback_data: backCb }],
    ],
  };
}

function startLink(botUsername, payload) {
  if (!botUsername) return "";
  return `https://t.me/${botUsername}?start=${payload}`;
}
function buildPayload(refCode, productCode) {
  // payload corto: R{ref}_P{prod}
  const r = String(refCode || "").trim();
  const p = String(productCode || "").trim();
  return `R${encodeURIComponent(r)}_P${encodeURIComponent(p)}`;
}
function parsePayload(p) {
  const s = String(p || "").trim();
  if (!s) return {};
  if (s.startsWith("R") && s.includes("_P")) {
    const [a, b] = s.split("_P");
    return { refCode: decodeURIComponent(a.slice(1)), productCode: decodeURIComponent(b || "") };
  }
  return {};
}

// ===== Bot username cache =====
let BOT_USERNAME = "";
async function ensureBotUsername() {
  if (BOT_USERNAME) return BOT_USERNAME;
  const me = await tgCall("getMe", {});
  if (me?.ok?.toString() === "true" || me?.ok === true) BOT_USERNAME = me?.result?.username || "";
  return BOT_USERNAME;
}

// ===== Flow: Start / Welcome =====
async function doStart(chatId, user, payloadText = "") {
  const cfg = await getConfig();
  const uName = user?.first_name || user?.username || "Cliente";

  const { refCode, productCode } = parsePayload(payloadText);

  // Si llegó por referido, lo guardamos en sesión y en cliente si es nuevo
  const s = ses(chatId);
  if (refCode) s.refCodeUsed = refCode;

  // crea cliente si no existe (sin romper nada)
  await ensureCliente(chatId, uName, "");

  const negocio = cfg?.NegocioNombre || "Todo Queso";
  const logo = cfg?.LogoURL;
  const desc = String(cfg?.Descripcion || "").trim();
  const dir = String(cfg?.NegocioDireccion || "").trim();
  const hor = String(cfg?.NegocioHorario || "").trim();

  const welcome =
    `🧀 <b>${esc(negocio)}</b>\n\n` +
    (desc ? `${esc(desc)}\n\n` : "") +
    (dir ? `📍 ${esc(dir)}\n` : "") +
    (hor ? `🕒 ${esc(hor)}\n` : "") +
    `\nElegí una opción 👇`;

  if (isHttp(logo)) {
    await sendPhoto(chatId, logo, welcome, { reply_markup: mainMenu() });
  } else {
    await sendMessage(chatId, welcome, { reply_markup: mainMenu() });
  }

  // Si el payload trae producto, abrimos carrusel directo en ese producto
  if (productCode) {
    const { items } = await getCatalog();
    const idx = items.findIndex((x) => low(x.codigo) === low(productCode));
    if (idx >= 0) return showProduct(chatId, items, idx, items[idx].categoria || "General");
  }
}

async function showHelp(chatId) {
  const cfg = await getConfig();
  const wa = String(cfg?.WhatsAppLink || "").trim();
  const ig = String(cfg?.NegocioInstagram || "").trim();
  const dir = String(cfg?.NegocioDireccion || "").trim();
  const hor = String(cfg?.NegocioHorario || "").trim();
  const negocio = String(cfg?.NegocioNombre || "Todo Queso").trim();

  const txt =
    `🆘 <b>Ayuda</b>\n\n` +
    `Si te faltó algo, no encontraste un producto o querés hacer una consulta, escribinos y te ayudamos 😊\n\n` +
    (dir ? `📍 <b>Dirección:</b> ${esc(dir)}\n` : "") +
    (hor ? `⏰ <b>Horario:</b> ${esc(hor)}\n` : "") +
    (wa ? `✅ <b>WhatsApp:</b> ${esc(wa)}\n` : "") +
    (ig ? `📸 <b>Instagram:</b> ${esc(ig)}\n` : "") +
    `\nGracias por elegir <b>${esc(negocio)}</b> 🧀`;

  await sendMessage(chatId, txt, { reply_markup: mainMenu() });
}

async function showShareBot(chatId) {
  const cfg = await getConfig();
  const email = String(cfg?.EmailSistema || "ezerbot.assistant@gmail.com").trim();
  const textoSistema = String(cfg?.TextoSistema || "¿Querés este sistema para tu negocio? Contactános").trim();
  const botLink = String(cfg?.BotLink || "").trim() || (await ensureBotUsername()) ? `https://t.me/${BOT_USERNAME}` : "";

  const msg = `🤖 <b>${esc(textoSistema)}</b>\n\n📩 <b>Email:</b> ${esc(email)}\n🔗 <b>Demo:</b> ${esc(botLink)}`;
  const wa = `https://wa.me/?text=${encodeURIComponent(`${textoSistema}\n\nEmail: ${email}\nDemo: ${botLink}`)}`;
  const tg = `https://t.me/share/url?url=${encodeURIComponent(botLink)}&text=${encodeURIComponent(textoSistema)}`;

  await sendMessage(chatId, msg, {
    reply_markup: { inline_keyboard: [[{ text: "📣 WhatsApp", url: wa }, { text: "✈️ Telegram", url: tg }]] },
  });
}

// ===== Catalogo =====
async function showCatalogMenu(chatId) {
  const { categorias } = await getCatalog();
  await sendMessage(chatId, "📚 <b>Categorías</b>\nElegí una:", { reply_markup: catMenuKeyboard(categorias) });
}

async function showProduct(chatId, list, index, categoriaLabel) {
  const cfg = await getConfig();
  const s = ses(chatId);
  s.cat = { list, index, categoriaLabel, messageId: s.cat?.messageId || null, shareMode: false };
  const item = list[index];

  const moneda = String(cfg?.Moneda || "ARS").trim() || "ARS";
  const u = String(item.unidad || "").trim();
  const uTag = u ? ` (${esc(u)})` : "";

  const caption =
    `🧀 <b>${esc(item.nombre)}</b>\n` +
    `💰 <b>${esc(moneda)} ${esc(item.precio)}</b>${uTag}\n` +
    (item.descripcion ? `\n📝 ${esc(item.descripcion)}\n` : "\n") +
    `📁 <i>${esc(categoriaLabel || item.categoria || "General")}</i>\n` +
    `📌 <i>${index + 1} de ${list.length}</i>\n\n` +
    (isPesable(item) ? `✅ Se pide por <b>gramos</b> (ej: 200g)\n` : `✅ Se pide por <b>unidades</b> (ej: 1)\n`);

  // primera vez: manda foto o texto
  if (!s.cat.messageId) {
    let sent;
    if (isHttp(item.imagen)) sent = await sendPhoto(chatId, item.imagen, caption, { reply_markup: productKb() });
    else sent = await sendMessage(chatId, caption, { reply_markup: productKb() });
    s.cat.messageId = sent?.result?.message_id || null;
    return;
  }

  // update carrusel
  if (isHttp(item.imagen)) {
    const ok = await editMedia(chatId, s.cat.messageId, item.imagen, caption, productKb());
    if (!ok?.ok) {
      s.cat.messageId = null;
      return showProduct(chatId, list, index, categoriaLabel);
    }
  } else {
    const ok = await editCaption(chatId, s.cat.messageId, caption, productKb());
    if (!ok?.ok) {
      s.cat.messageId = null;
      return showProduct(chatId, list, index, categoriaLabel);
    }
  }
}

// ===== Add to cart =====
async function askQty(chatId) {
  const s = ses(chatId);
  const cat = s.cat?.list ? s.cat : null;
  if (!cat) return sendMessage(chatId, "Abrí el Catálogo primero 🛍️", { reply_markup: mainMenu() });

  const item = cat.list[cat.index];
  s.waitQty = { codigo: item.codigo };
  if (!s.cart) s.cart = [];

  if (isPesable(item)) {
    await sendMessage(chatId, `🟢 <b>${esc(item.nombre)}</b>\n\nDecime <b>gramos</b>.\nEj: <b>200g</b>`, { reply_markup: mainMenu() });
  } else {
    await sendMessage(chatId, `🟢 <b>${esc(item.nombre)}</b>\n\nDecime <b>unidades</b>.\nEj: <b>1</b>`, { reply_markup: mainMenu() });
  }
}

async function addCartWithQty(chatId, qtyText) {
  const s = ses(chatId);
  const wait = s.waitQty;
  if (!wait) return;

  const { items } = await getCatalog();
  const item = items.find((x) => x.codigo === wait.codigo);
  if (!item) {
    s.waitQty = null;
    return sendMessage(chatId, "No encontré el producto. Volvé al Catálogo.", { reply_markup: mainMenu() });
  }

  const q = parseQty(qtyText);
  if (!q) {
    return sendMessage(chatId, isPesable(item) ? "Decime gramos válidos. Ej: 200g" : "Decime unidades válidas. Ej: 1", {
      reply_markup: mainMenu(),
    });
  }

  // validar tipo
  if (isPesable(item) && q.kind === "NUM") {
    // para pesable aceptamos igual (ej: "200"), lo interpretamos como gramos
  }
  if (!isPesable(item) && q.kind !== "NUM") {
    return sendMessage(chatId, "Este producto se pide por <b>unidades</b>. Ej: 1", { reply_markup: mainMenu() });
  }

  if (!s.cart) s.cart = [];
  const cfg = await getConfig();

  if (isPesable(item)) {
    const gramos = q.value;
    const subtotal = priceForPesable(item, gramos);
    s.cart.push({ codigo: item.codigo, nombre: item.nombre, tipo: "GRAMOS", gramos, subtotal });
  } else {
    const qty = q.value;
    const subtotal = Math.round(item.precio * qty);
    s.cart.push({ codigo: item.codigo, nombre: item.nombre, tipo: "UNIDAD", qty, subtotal });
  }

  s.waitQty = null;

  const total = cartTotal(s.cart);
  const moneda = String(cfg?.Moneda || "ARS").trim() || "ARS";

  await sendMessage(
    chatId,
    `✅ Agregado.\n\n🛒 <b>Carrito</b>\n${fmtCart(cfg, s.cart)}\n\n<b>Total:</b> ${esc(moneda)} ${esc(total)}`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🛍️ Seguir", callback_data: "CAT_MENU" }],
          [{ text: "✅ Finalizar compra", callback_data: "CHECKOUT:START" }],
        ],
      },
    }
  );
}

// ===== Checkout =====
async function checkoutStart(chatId) {
  const cfg = await getConfig();
  const s = ses(chatId);
  if (!s.cart?.length) return sendMessage(chatId, "Tu carrito está vacío. Entrá a Catálogo 🛍️", { reply_markup: mainMenu() });

  const total = cartTotal(s.cart);
  const moneda = String(cfg?.Moneda || "ARS").trim() || "ARS";

  await sendMessage(
    chatId,
    `🧾 <b>Finalizar compra</b>\n\n${fmtCart(cfg, s.cart)}\n\n<b>Total:</b> ${esc(moneda)} ${esc(total)}\n\nElegí entrega:`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🏠 Retiro en local", callback_data: "ENT:RETIRO" }],
          [{ text: "🚚 Envío a domicilio", callback_data: "ENT:ENVIO" }],
        ],
      },
    }
  );
}

async function askAddress(chatId) {
  const cfg = await getConfig();
  const s = ses(chatId);
  s.step = "ASK_ADDRESS";
  const txt = String(cfg?.TextoEnvíoDomicilio || cfg?.TextoEnvioDomicilio || "Escribí tu dirección completa.").trim();

  await sendMessage(
    chatId,
    `🚚 <b>Envío a domicilio</b>\n\n${esc(txt)}\n\nAhora enviame:\n<b>Nombre + Dirección + Localidad</b>\nEj: Juan, Los Andes 1234, Maschwitz`,
    { reply_markup: mainMenu() }
  );
}

async function askPayment(chatId) {
  const cfg = await getConfig();
  const s = ses(chatId);
  const total = cartTotal(s.cart);
  const moneda = String(cfg?.Moneda || "ARS").trim() || "ARS";
  const envio = s.entregaTipo === "ENVIO";
  const costoEnvio = envio ? num(cfg?.CostoEnvio || 0) : 0;
  const totalFinal = total + costoEnvio;

  s.totalFinal = totalFinal;

  await sendMessage(
    chatId,
    `💳 <b>Pago</b>\n\n<b>Total a pagar:</b> ${esc(moneda)} ${esc(totalFinal)}\nElegí opción:`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💵 Efectivo", callback_data: "PAY:EFECTIVO" }],
          [{ text: "🏦 Transferencia", callback_data: "PAY:TRANSFER" }],
        ],
      },
    }
  );
}

async function showTransferInstructions(chatId) {
  const cfg = await getConfig();
  const s = ses(chatId);

  const alias = String(cfg?.AliasTransferencia || "").trim();
  const cbu = String(cfg?.CBUPago || "").trim();
  const moneda = String(cfg?.Moneda || "ARS").trim() || "ARS";

  s.step = "WAIT_PROOF";

  await sendMessage(
    chatId,
    `🏦 <b>Transferencia</b>\n\n<b>Total:</b> ${esc(moneda)} ${esc(s.totalFinal || 0)}\n` +
      (alias ? `🔑 <b>Alias:</b> ${esc(alias)}\n` : "") +
      (cbu ? `🏷️ <b>CBU:</b> ${esc(cbu)}\n` : "") +
      `\n📎 Ahora enviá el <b>comprobante</b> (foto o archivo) por este chat.\n` +
      `Cuando el negocio lo confirme, te avisamos por acá ✅`,
    { reply_markup: mainMenu() }
  );
}

// ===== Pedido + Vendedor confirmación =====
async function createPedidoAndNotifyVendor(chatId, userName) {
  const cfg = await getConfig();
  const s = ses(chatId);

  const pedidoId = orderId();
  const detalle = fmtCart(cfg, s.cart);
  const entrega = s.entregaTipo === "ENVIO" ? "Envío a domicilio" : "Retiro en local";
  const entregaDatos = s.entregaTipo === "ENVIO" ? (s.domicilio || "") : String(cfg?.NegocioDireccion || "");
  const pago = s.pagoTipo === "TRANSFER" ? "Transferencia (pendiente confirmación)" : "Efectivo";

  const pedido = {
    OrderId: pedidoId,
    Fecha: nowISO(),
    UserIdTG: String(chatId),
    Nombre: String(userName || "Cliente"),
    Detalle: detalle,
    Total: Number(s.totalFinal || 0),
    EntregaTipo: entrega,
    EntregaDatos: entregaDatos,
    PagoTipo: s.pagoTipo === "TRANSFER" ? "TRANSFERENCIA" : "EFECTIVO",
    PagoEstado: "PENDIENTE_CONFIRMACION",
    ComprobanteFileId: s.comprobanteFileId || "",
    Estado: "PENDIENTE_CONFIRMACION",
    ReferidoCodigoUsado: s.refCodeUsed || "",
  };

  const r = await apiPost({ action: "appendPedido", pedido });
  if (!r?.ok) console.error("appendPedido error", r);

  const vendorChatId = String(cfg?.ChatIdVendedor || cfg?.VendedorChatId || "").trim();
  if (vendorChatId) {
    const txtV =
      `🧾 <b>PEDIDO</b>\n` +
      `🆔 <b>ID:</b> ${esc(pedidoId)}\n\n` +
      `👤 <b>Cliente:</b> ${esc(userName)} (${esc(chatId)})\n\n` +
      `🛒 <b>Detalle</b>\n${detalle}\n\n` +
      `📦 <b>Entrega</b>\n${esc(entrega)}\n📍 ${esc(entregaDatos)}\n\n` +
      `💳 <b>Pago</b>\n${esc(pago)}\n\n` +
      `💰 <b>Total:</b> ${esc(String(cfg?.Moneda || "ARS"))} ${esc(s.totalFinal || 0)}\n\n` +
      `${esc(String(cfg?.TextoAvisoVendedor || "Tenés un pago/pedido pendiente de confirmación ✅"))}\n\n` +
      `¿Confirmás este pedido?`;

    await sendMessage(vendorChatId, txtV, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Confirmar", callback_data: `VCONF:${pedidoId}:${chatId}` }],
          [{ text: "❌ Rechazar", callback_data: `VRECH:${pedidoId}:${chatId}` }],
        ],
      },
    });

    // Si hay comprobante, forward al vendedor
    if (s.comprobanteMsgId) {
      await tgCall("forwardMessage", { chat_id: vendorChatId, from_chat_id: chatId, message_id: s.comprobanteMsgId });
    }
  }

  // Cliente (NO confirma pago)
  await sendMessage(
    chatId,
    `✅ <b>Pedido enviado</b>\n\n🆔 <b>ID:</b> ${esc(pedidoId)}\nEstado: <b>Pendiente</b> hasta confirmación del negocio.`,
    { reply_markup: mainMenu() }
  );

  // dejamos el session para confirmar luego (pero limpiamos el carrito recién cuando confirmen)
  s.pedidoId = pedidoId;
}

// ===== Sellos (aplicar al confirmar) =====
function sellosPorCompra(total, montoPorSello) {
  const t = Math.max(0, Number(total || 0));
  const m = Math.max(1, Number(montoPorSello || 10000));
  return Math.floor(t / m);
}

async function onVendedorConfirm(pedidoId, clienteId) {
  const cfg = await getConfig();
  const montoPorSello = num(cfg?.MontoPorSello || 10000);
  const bonusRef = num(cfg?.BonusSellosShare || 0);

  // Buscar pedido y total desde tu GAS (si lo tenés). Si no, usamos totalFinal guardado en pedido.
  // Para evitar romper, pedimos al GAS:
  const p = await apiGet({ type: "pedido", orderId: String(pedidoId) });
  const pedido = p?.pedido || p?.data || null;
  const totalFinal = pedido ? num(pedido.Total || 0) : 0;
  const refCodeUsed = pedido ? String(pedido.ReferidoCodigoUsado || "").trim() : "";

  // 1) sellos por compra
  const sellosCompra = sellosPorCompra(totalFinal, montoPorSello);
  if (sellosCompra > 0) {
    const r = await apiPost({
      action: "addSellos",
      userId: String(clienteId),
      delta: sellosCompra,
      totalConfirmadoDelta: totalFinal,
      motivo: `Compra confirmada ${pedidoId}`,
    });
    if (!r?.ok) console.error("addSellos error", r);
  } else {
    // igual sumamos TotalConfirmado
    const r = await apiPost({
      action: "addSellos",
      userId: String(clienteId),
      delta: 0,
      totalConfirmadoDelta: totalFinal,
      motivo: `Compra confirmada ${pedidoId}`,
    });
    if (!r?.ok) console.error("addSellos (0) error", r);
  }

  // 2) referido bonus (si hubo ref code usado)
  if (refCodeUsed && bonusRef > 0) {
    const rr = await apiPost({ action: "addReferidoBonus", refCode: refCodeUsed, delta: bonusRef, pedidoId: String(pedidoId) });
    if (!rr?.ok) console.error("addReferidoBonus error", rr);
  }

  // 3) mensaje al cliente
  const msgOk = String(cfg?.TextoConfirmacionPedido || "Gracias. Tu compra fue confirmada y está en preparación ✅").trim();
  await sendMessage(
    clienteId,
    `✅ <b>${esc(msgOk)}</b>\n\n🆔 <b>ID:</b> ${esc(pedidoId)}`,
    { reply_markup: mainMenu() }
  );

  // 4) limpiar carrito local (session)
  const s = ses(clienteId);
  s.cart = [];
  s.step = "";
  s.waitQty = null;
  s.pedidoId = null;
  s.totalFinal = 0;
  s.entregaTipo = "";
  s.domicilio = "";
  s.pagoTipo = "";
  s.comprobanteFileId = "";
  s.comprobanteMsgId = null;
}

// ===== Sellos view + Web =====
async function showSellos(chatId) {
  const cfg = await getConfig();
  await ensureCliente(chatId, "Cliente", "");
  const url = `${PUBLIC_URL}/s/${encodeURIComponent(String(chatId))}`;
  await sendMessage(chatId, `🎟️ <b>Tus sellos</b>\n\nAbrí tu tarjeta acá:\n${esc(url)}`, { reply_markup: mainMenu() });
}

app.get("/s/:uid", async (req, res) => {
  try {
    const userId = String(req.params.uid || "").trim();
    const cfg = await getConfig();
    const cli = await getCliente(userId);

    const negocio = String(cfg?.NegocioNombre || "Todo Queso").trim();
    const logo = String(cfg?.LogoURL || "").trim();
    const cardUrl = String(cfg?.CARD_URL || "").trim();

    const sellos = cli ? num(cli.Sellos || 0) : 0;
    const nombre = cli ? String(cli.Nombre || "Cliente").trim() : "Cliente";

    // niveles
    const usaNiveles = low(cfg?.UsaNiveles || "") === "si";
    const nombres = String(cfg?.NombresNiveles || "")
      .split("|")
      .map((x) => x.trim())
      .filter(Boolean);
    const reqs = String(cfg?.SellosPorNivel || "")
      .split("|")
      .map((x) => num(x))
      .filter((n) => n > 0);
    const bens = String(cfg?.BeneficiosPorNivel || "")
      .split("|")
      .map((x) => x.trim());

    let meta = 10;
    let proximoTxt = "";
    if (usaNiveles && reqs.length) {
      let next = reqs.find((r) => sellos < r);
      if (!next) next = reqs[reqs.length - 1];
      meta = next || 10;
      const idx = reqs.indexOf(next);
      const faltan = Math.max(0, next - sellos);
      proximoTxt =
        `<div class="muted">Próximo: <b>${esc(nombres[idx] || `Nivel ${idx + 1}`)}</b><br/>Te faltan <b>${faltan}</b> sello(s).<br/>` +
        (bens[idx] ? `Beneficio: <b>${esc(bens[idx])}</b>` : "") +
        `</div>`;
    } else {
      meta = Math.max(10, Math.min(50, Math.ceil((sellos + 1) / 10) * 10));
    }

    const filled = Math.min(sellos, meta);
    const stamp = (on) => `
      <div class="stamp ${on ? "on" : ""}">
        ${isHttp(logo) ? `<img src="${logo}" alt="logo"/>` : ""}
      </div>`;

    const grid = Array.from({ length: meta }).map((_, i) => stamp(i < filled)).join("");

    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(negocio)} — Sellos</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;margin:0;background:#0b1220;color:#fff;}
.wrap{max-width:900px;margin:0 auto;padding:18px;}
.card{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:16px;box-shadow:0 10px 30px rgba(0,0,0,.25);}
.top{display:flex;gap:12px;align-items:center;margin-bottom:12px;}
.top img{width:54px;height:54px;border-radius:12px;object-fit:cover;}
h1{font-size:18px;margin:0;}
.sub{opacity:.9;font-size:14px;}
.row{display:flex;gap:12px;flex-wrap:wrap;}
.col{flex:1;min-width:280px;}
.imgCard{width:100%;border-radius:14px;border:1px solid rgba(255,255,255,.12);background:#000;overflow:hidden;}
.imgCard img{width:100%;display:block;}
.grid{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-top:12px;}
.stamp{aspect-ratio:1/1;border-radius:14px;border:1px dashed rgba(255,255,255,.25);background:rgba(255,255,255,.04);display:flex;align-items:center;justify-content:center;overflow:hidden;}
.stamp img{width:80%;height:80%;object-fit:contain;opacity:.18;filter:grayscale(1);}
.stamp.on{border-style:solid;background:rgba(255,255,255,.10);}
.stamp.on img{opacity:1;filter:none;}
.pill{display:inline-block;padding:6px 10px;border-radius:999px;background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.14);font-size:13px;}
.muted{opacity:.9;font-size:14px;line-height:1.35;margin-top:10px;}
.big{font-size:28px;font-weight:800;margin:8px 0;}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="top">
      ${isHttp(logo) ? `<img src="${logo}" alt="logo"/>` : ""}
      <div>
        <h1>${esc(negocio)}</h1>
        <div class="sub">Hola ${esc(nombre)} 😊</div>
      </div>
    </div>

    <div class="row">
      <div class="col">
        <div class="pill">🎟️ Sellos acumulados</div>
        <div class="big">${sellos}</div>
        ${proximoTxt}
        <div class="grid">${grid}</div>
      </div>
      <div class="col">
        <div class="pill">🪪 Tu tarjeta</div>
        <div class="imgCard" style="margin-top:10px;">
          ${isHttp(cardUrl) ? `<img src="${cardUrl}" alt="tarjeta"/>` : `<div style="padding:14px;">No hay CARD_URL válida</div>`}
        </div>
      </div>
    </div>
  </div>
</div>
</body>
</html>`);
  } catch (e) {
    console.error(e);
    res.status(500).send("Error");
  }
});

// ===== Handlers =====
async function handleText(chatId, user, text) {
  const t = String(text || "").trim();
  const s = ses(chatId);

  // si espera domicilio
  if (s.step === "ASK_ADDRESS") {
    s.domicilio = t;
    s.step = "";
    return askPayment(chatId);
  }

  // si espera cantidad
  if (s.waitQty) return addCartWithQty(chatId, t);

  // si espera comprobante (foto/archivo entra por handleMedia)
  if (t === "/start") return doStart(chatId, user, "");
  if (t.startsWith("/start ")) return doStart(chatId, user, t.split(" ").slice(1).join(" ").trim());

  if (t === "🛍️ Catálogo") return showCatalogMenu(chatId);
  if (t === "🎟️ Sellos") return showSellos(chatId);
  if (t === "📣 Compartir bot") return showShareBot(chatId);
  if (t === "🆘 Ayuda") return showHelp(chatId);

  return sendMessage(chatId, "Elegí una opción del menú 👇", { reply_markup: mainMenu() });
}

async function handleMedia(chatId, user, msg) {
  const s = ses(chatId);
  if (s.step !== "WAIT_PROOF") return;

  let fileId = "";
  if (msg.document?.file_id) fileId = msg.document.file_id;
  if (!fileId && msg.photo?.length) fileId = msg.photo[msg.photo.length - 1].file_id;

  if (!fileId) return sendMessage(chatId, "Enviá el comprobante como foto o archivo.", { reply_markup: mainMenu() });

  s.comprobanteFileId = fileId;
  s.comprobanteMsgId = msg.message_id;
  s.step = "";

  // crear pedido y avisar vendedor (pendiente confirmación)
  const userName = user?.first_name || user?.username || "Cliente";
  await createPedidoAndNotifyVendor(chatId, userName);
  // NO limpiamos carrito aquí (se limpia al confirmar)
}

// ===== Callback buttons =====
async function handleCallback(cb) {
  const chatId = cb.message?.chat?.id;
  const userId = cb.from?.id;
  const data = cb.data || "";
  if (!chatId) return;

  await answerCb(cb.id);

  if (data === "HOME") return sendMessage(chatId, "🏠 Menú", { reply_markup: mainMenu() });
  if (data === "CAT_MENU") return showCatalogMenu(chatId);

  if (data.startsWith("CAT:")) {
    const raw = data.slice(4);
    const cat = decodeURIComponent(raw);
    const { items } = await getCatalog();
    const list = cat === "__ALL__" ? items : items.filter((x) => x.categoria === cat);
    if (!list.length) return sendMessage(chatId, "No hay productos en esta categoría.", { reply_markup: mainMenu() });
    return showProduct(chatId, list, 0, cat === "__ALL__" ? "Todas" : cat);
  }

  // carrusel prev/next
  if (data === "P:NEXT" || data === "P:PREV") {
    const s = ses(chatId);
    const cat = s.cat;
    if (!cat?.list?.length) return;
    const total = cat.list.length;
    cat.index = data === "P:NEXT" ? (cat.index + 1) % total : (cat.index - 1 + total) % total;
    return showProduct(chatId, cat.list, cat.index, cat.categoriaLabel);
  }

  if (data === "P:ADD") return askQty(chatId);

  if (data === "P:SHARE") {
    const cfg = await getConfig();
    const botUser = await ensureBotUsername();

    const s = ses(chatId);
    const cat = s.cat;
    if (!cat?.list?.length) return;
    const item = cat.list[cat.index];

    const cliente = await ensureCliente(chatId, cb.from?.first_name || "Cliente", "");
    const refCode = String(cliente.CodigoReferido || "").trim();

    const payload = buildPayload(refCode, item.codigo);
    const link = startLink(botUser, payload);

    const msg =
      `🧀 ${String(cfg?.NegocioNombre || "Todo Queso").trim()} — Mirá este producto:\n` +
      `${item.nombre}\n` +
      `💰 ${String(cfg?.Moneda || "ARS")} ${item.precio} ${item.unidad ? `(${item.unidad})` : ""}\n\n` +
      `Pedilo acá 👉 ${link}`;

    // edit markup del carrusel (si existe messageId)
    if (s.cat?.messageId) {
      return tgCall("editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: s.cat.messageId,
        reply_markup: shareProductKb(msg, "P:SHARE_BACK"),
      });
    }
    return sendMessage(chatId, "Compartí:", { reply_markup: shareProductKb(msg, "P:SHARE_BACK") });
  }

  if (data === "P:SHARE_BACK") {
    const s = ses(chatId);
    if (s.cat?.messageId) {
      return tgCall("editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: s.cat.messageId,
        reply_markup: productKb(),
      });
    }
    return;
  }

  // checkout
  if (data === "CHECKOUT:START") return checkoutStart(chatId);
  if (data === "ENT:RETIRO") {
    const s = ses(chatId);
    s.entregaTipo = "RETIRO";
    return askPayment(chatId);
  }
  if (data === "ENT:ENVIO") {
    const s = ses(chatId);
    s.entregaTipo = "ENVIO";
    return askAddress(chatId);
  }

  if (data === "PAY:EFECTIVO") {
    const s = ses(chatId);
    s.pagoTipo = "EFECTIVO";
    const userName = cb.from?.first_name || cb.from?.username || "Cliente";
    await createPedidoAndNotifyVendor(chatId, userName);
    return;
  }

  if (data === "PAY:TRANSFER") {
    const s = ses(chatId);
    s.pagoTipo = "TRANSFER";
    return showTransferInstructions(chatId);
  }

  // vendedor confirma/rechaza
  if (data.startsWith("VCONF:")) {
    const [, pedidoId, clienteId] = data.split(":");
    await onVendedorConfirm(pedidoId, clienteId);
    return sendMessage(chatId, "✅ Confirmado. Avisé al cliente y apliqué sellos.", { reply_markup: mainMenu() });
  }

  if (data.startsWith("VRECH:")) {
    const [, pedidoId, clienteId] = data.split(":");
    const cfg = await getConfig();
    await apiPost({ action: "setPedidoEstado", orderId: String(pedidoId), estado: "RECHAZADO" }).catch(() => {});
    await sendMessage(
      clienteId,
      `❌ Tu pedido <b>${esc(pedidoId)}</b> fue rechazado. Si querés, escribinos por Ayuda.`,
      { reply_markup: mainMenu() }
    );
    return sendMessage(chatId, "❌ Rechazado. Avisé al cliente.", { reply_markup: mainMenu() });
  }
}

// ===== Webhook endpoint =====
app.post("/telegram", async (req, res) => {
  res.sendStatus(200);
  const upd = req.body || {};
  try {
    if (upd.callback_query) return handleCallback(upd.callback_query);

    if (upd.message) {
      const m = upd.message;
      const chatId = m.chat?.id;
      const user = m.from;

      if (!chatId) return;

      // /start con payload
      if (m.text && m.text.startsWith("/start")) {
        const payload = m.text.split(" ").slice(1).join(" ").trim();
        return doStart(chatId, user, payload);
      }

      // comprobante
      const s = ses(chatId);
      if (s.step === "WAIT_PROOF" && (m.photo || m.document)) return handleMedia(chatId, user, m);

      // texto normal
      if (m.text) return handleText(chatId, user, m.text);

      // fallback
      return sendMessage(chatId, "Elegí una opción del menú 👇", { reply_markup: mainMenu() });
    }
  } catch (e) {
    console.error("Webhook handler error:", e);
  }
});

// ===== Root + Debug =====
app.get("/", (_req, res) => res.status(200).send("OK - EZERBot live"));
app.get("/debug", async (_req, res) => {
  try {
    const cfg = await getConfig(true);
    const cat = await getCatalog(true);
    res.json({
      ok: true,
      env: { hasToken: !!TOKEN, publicUrl: PUBLIC_URL, dataApiUrl: DATA_API_URL },
      cfgKeys: Object.keys(cfg).slice(0, 120),
      catalogSample: cat.items.slice(0, 3),
      categorias: cat.categorias,
    });
  } catch (e) {
    res.json({ ok: false, error: String(e?.message || e) });
  }
});

// ===== Boot =====
async function boot() {
  const hook = `${PUBLIC_URL}/telegram`;
  const wh = await setWebhook(hook);
  console.log("Webhook:", hook, wh?.ok ? "OK" : "FAIL");

  await ensureBotUsername();
  console.log("BOT_USERNAME:", BOT_USERNAME);

  // warm cache
  try {
    await getConfig(true);
    await getCatalog(true);
  } catch (e) {
    console.error("Warm cache error:", e);
  }
}

app.listen(PORT, () => {
  console.log("Server on", PORT);
  boot().catch(console.error);
});

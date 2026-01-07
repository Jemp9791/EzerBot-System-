import express from "express";
import { Telegraf, Markup } from "telegraf";
import { google } from "googleapis";

/* =========================================================
   ENV (NO CAMBIAR NOMBRES)
   - TelegramBotToken (Render Env)
   - GOOGLE_SHEET_ID
   - GOOGLE_SERVICE_ACCOUNT_B64
   - PUBLIC_URL (opcional)
   - PORT (Render)
========================================================= */
const TelegramBotToken =
  process.env.TelegramBotToken || process.env.TELEGRAM_BOT_TOKEN; // fallback sin romper
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_B64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const PORT = process.env.PORT || 10000;

if (!TelegramBotToken) throw new Error("Falta TelegramBotToken");
if (!GOOGLE_SHEET_ID) throw new Error("Falta GOOGLE_SHEET_ID");
if (!GOOGLE_SERVICE_ACCOUNT_B64)
  throw new Error("Falta GOOGLE_SERVICE_ACCOUNT_B64");

/* =========================================================
   GOOGLE AUTH
========================================================= */
function decodeServiceAccountB64(b64) {
  const raw = Buffer.from(b64, "base64").toString("utf8").trim();
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_B64 decodifica pero NO es JSON válido.");
  }
  return obj;
}

const sa = decodeServiceAccountB64(GOOGLE_SERVICE_ACCOUNT_B64);

const auth = new google.auth.JWT({
  email: sa.client_email,
  key: sa.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

/* =========================================================
   SHEETS HELPERS
========================================================= */
async function getSheetValues(rangeA1) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: rangeA1,
  });
  return res.data.values || [];
}

async function setSheetValues(rangeA1, values) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: rangeA1,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
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
    await setSheetValues(`${sheetName}!A1`, [headers]);
  } else {
    const firstRow = await getSheetValues(`${sheetName}!A1:Z1`);
    if (!firstRow.length || firstRow[0].join("").trim() === "") {
      await setSheetValues(`${sheetName}!A1`, [headers]);
    }
  }
}

/* =========================================================
   CONFIG HELPERS
========================================================= */
function kvFromRows(rows) {
  const out = {};
  for (const r of rows) {
    const k = (r[0] || "").toString().trim();
    const v = (r[1] || "").toString().trim();
    if (k) out[k] = v;
  }
  return out;
}

function parseYes(v) {
  return String(v || "").trim().toLowerCase() === "si";
}

function parseNumber(v, def = 0) {
  const n = Number(String(v || "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : def;
}

function money(n, moneda = "ARS") {
  const num = Math.round(Number(n) || 0);
  return `${moneda} ${num.toLocaleString("es-AR")}`;
}

function splitPipes(v) {
  const s = String(v || "").trim();
  if (!s) return [];
  return s
    .split("|")
    .map((x) => x.trim())
    .filter(Boolean);
}

function pickRandom(arr) {
  if (!arr || !arr.length) return "";
  return arr[Math.floor(Math.random() * arr.length)];
}

function roundARS(n) {
  return Math.round(Number(n) || 0);
}

/* =========================================================
   CATALOGO HELPERS
========================================================= */
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
  if (u.includes("gr") || u === "g" || u.includes("gram")) return "g";
  if (u.includes("kg") || u.includes("kilo")) return "g"; // pedimos gramos igual
  if (u.includes("unidad") || u === "u" || u.includes("unid")) return "u";
  if (u.includes("pack")) return "u";
  return "u";
}

/* =========================================================
   CACHE (B) - evita demoras / “no responde”
========================================================= */
const CACHE = {
  cfg: { value: null, ts: 0, inflight: null },
  cat: { value: null, ts: 0, inflight: null },
};
const CFG_TTL_MS = 10_000; // 10s
const CAT_TTL_MS = 20_000; // 20s

async function loadConfigRaw() {
  const rows = await getSheetValues(`Config!A:B`);
  return kvFromRows(rows);
}
async function loadCatalogRaw() {
  const rows = await getSheetValues(`Catalogo!A1:Z`);
  if (!rows.length) return { items: [], headers: {} };
  const headerRow = rows[0];
  const hmap = normalizeHeaders(headerRow);
  const data = rows.slice(1).filter((r) => r.some((c) => String(c || "").trim() !== ""));

  const items = data.map((r, i) => {
    const code = String(pick(r, hmap, ["codigo", "codigoproducto", "id", "sku"], "")).trim() || `P${i + 1}`;
    const name = String(pick(r, hmap, ["nombre", "producto", "name"], "Producto")).trim();
    const price = parseNumber(pick(r, hmap, ["precio", "price"], 0), 0);
    const pricePerKg = parseNumber(pick(r, hmap, ["precioporkg", "preciokg", "precio_kg"], 0), 0);
    const unitRaw = pick(r, hmap, ["unidad", "unit", "tipo", "medida"], "");
    const unit = inferUnit(unitRaw);
    const cat = String(pick(r, hmap, ["categoria", "categoría", "rubro"], "General")).trim() || "General";
    const img = String(pick(r, hmap, ["imagenurl", "imagen", "foto", "urlimagen"], "")).trim();
    const desc = String(pick(r, hmap, ["descripcion", "descripción", "detalle"], "")).trim();
    const isCombo = String(pick(r, hmap, ["combo", "escombo"], "")).trim();
    return { code, name, price, pricePerKg, unit, cat, img, desc, isCombo };
  });

  return { items, headers: hmap };
}

async function loadConfig() {
  const now = Date.now();
  if (CACHE.cfg.value && now - CACHE.cfg.ts < CFG_TTL_MS) return CACHE.cfg.value;
  if (CACHE.cfg.inflight) return CACHE.cfg.inflight;

  CACHE.cfg.inflight = (async () => {
    const v = await loadConfigRaw();
    CACHE.cfg.value = v;
    CACHE.cfg.ts = Date.now();
    CACHE.cfg.inflight = null;
    return v;
  })().catch((e) => {
    CACHE.cfg.inflight = null;
    throw e;
  });

  return CACHE.cfg.inflight;
}

async function loadCatalog() {
  const now = Date.now();
  if (CACHE.cat.value && now - CACHE.cat.ts < CAT_TTL_MS) return CACHE.cat.value;
  if (CACHE.cat.inflight) return CACHE.cat.inflight;

  CACHE.cat.inflight = (async () => {
    const v = await loadCatalogRaw();
    CACHE.cat.value = v;
    CACHE.cat.ts = Date.now();
    CACHE.cat.inflight = null;
    return v;
  })().catch((e) => {
    CACHE.cat.inflight = null;
    throw e;
  });

  return CACHE.cat.inflight;
}

function categoriesFromItems(items) {
  const set = new Set();
  for (const it of items) set.add(it.cat || "General");
  return Array.from(set).sort((a, b) => a.localeCompare(b, "es"));
}

/* =========================================================
   STATE (chat limpio + flujo) + NAV (A)
========================================================= */
const SESS = new Map(); // chatId -> state
const ORDER_TIMERS = new Map(); // orderId -> timeout

function getSess(chatId) {
  if (!SESS.has(chatId)) {
    SESS.set(chatId, {
      mode: "MENU",
      category: null,
      productIndex: 0,
      productsInView: [],
      cart: [],
      refBy: null,
      lastMessageId: null,

      checkout: {
        entregaTipo: null,
        pagoTipo: null,
        nombre: "",
        telefono: "",
        direccion: "",
        notas: "",
      },

      waiting: null,
      jumpProdCode: null,

      // (A) Back / menú consistente
      lastScreen: "MENU", // MENU | CATS | PROD | CART | DELIVERY | PAY | TICKET | SELLOS | HELP | SHARE
      lastScreenData: {}, // e.g. {cat}
    });
  }
  return SESS.get(chatId);
}

function setScreen(sess, screen, data = {}) {
  sess.lastScreen = screen;
  sess.lastScreenData = data || {};
}

/* =========================================================
   SHEETS MODELO
========================================================= */
const CLIENTES_SHEET = "Clientes";
const PEDIDOS_SHEET = "Pedidos";

const CLIENTES_HEADERS = [
  "ChatId",
  "Nombre",
  "Usuario",
  "Sellos",
  "TotalComprado",
  "UltimaCompraISO",
  "ReferidoPor",
  "ReferidosGanados",
];

const PEDIDOS_HEADERS = [
  "PedidoId",
  "FechaISO",
  "ExpiraISO",
  "ChatIdCliente",
  "NombreCliente",
  "UsuarioCliente",
  "Items",
  "Total",
  "EntregaTipo",
  "PagoTipo",
  "Direccion",
  "Telefono",
  "Notas",
  "Estado",
  "RefBy",
];

async function ensureBaseSheets() {
  await ensureSheet(CLIENTES_SHEET, CLIENTES_HEADERS);
  await ensureSheet(PEDIDOS_SHEET, PEDIDOS_HEADERS);
}

async function upsertCliente({ chatId, nombre, usuario, addSellos = 0, addTotal = 0, refBy = "" }) {
  const rows = await getSheetValues(`${CLIENTES_SHEET}!A2:H`);
  const idx = rows.findIndex((r) => String(r[0] || "") === String(chatId));
  const now = new Date().toISOString();

  if (idx === -1) {
    await appendRow(CLIENTES_SHEET, [
      String(chatId),
      nombre || "",
      usuario || "",
      addSellos,
      addTotal,
      now,
      refBy || "",
      0,
    ]);
    return { sellos: addSellos, total: addTotal };
  }

  const row = rows[idx];
  const currentSellos = parseNumber(row[3], 0);
  const currentTotal = parseNumber(row[4], 0);
  const currentRefGanados = parseNumber(row[7], 0);

  const newSellos = currentSellos + addSellos;
  const newTotal = currentTotal + addTotal;

  const rowNumber = idx + 2;
  await setSheetValues(`${CLIENTES_SHEET}!A${rowNumber}:H${rowNumber}`, [[
    String(chatId),
    nombre || row[1] || "",
    usuario || row[2] || "",
    newSellos,
    newTotal,
    now,
    row[6] || refBy || "",
    currentRefGanados,
  ]]);

  return { sellos: newSellos, total: newTotal };
}

async function addSelloReferido(chatIdReferente) {
  const rows = await getSheetValues(`${CLIENTES_SHEET}!A2:H`);
  const idx = rows.findIndex((r) => String(r[0] || "") === String(chatIdReferente));
  if (idx === -1) return;

  const row = rows[idx];
  const currentSellos = parseNumber(row[3], 0);
  const currentRefGanados = parseNumber(row[7], 0);
  const rowNumber = idx + 2;

  await setSheetValues(`${CLIENTES_SHEET}!A${rowNumber}:H${rowNumber}`, [[
    row[0] || "",
    row[1] || "",
    row[2] || "",
    currentSellos + 1,
    row[4] || 0,
    new Date().toISOString(),
    row[6] || "",
    currentRefGanados + 1,
  ]]);
}

async function findPedidoRow(orderId) {
  const rows = await getSheetValues(`${PEDIDOS_SHEET}!A2:O`);
  const idx = rows.findIndex((r) => String(r[0] || "") === String(orderId));
  if (idx === -1) return null;
  return { idx, row: rows[idx], rowNumber: idx + 2 };
}

async function setPedidoEstado(orderId, newEstado) {
  const found = await findPedidoRow(orderId);
  if (!found) return null;
  const { row, rowNumber } = found;
  row[13] = newEstado;
  await setSheetValues(`${PEDIDOS_SHEET}!A${rowNumber}:O${rowNumber}`, [row]);
  return row;
}

async function expireOldPending() {
  const rows = await getSheetValues(`${PEDIDOS_SHEET}!A2:O`);
  const now = Date.now();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const expIso = r[2];
    const estado = String(r[13] || "").toUpperCase();
    if (!expIso || estado !== "PENDIENTE") continue;
    const exp = Date.parse(expIso);
    if (Number.isFinite(exp) && exp <= now) {
      const rowNumber = i + 2;
      r[13] = "VENCIDO";
      await setSheetValues(`${PEDIDOS_SHEET}!A${rowNumber}:O${rowNumber}`, [r]);
    }
  }
}

/* =========================================================
   UI HELPERS (editar mensaje) -> SOLO para catálogo/compra
========================================================= */
async function safeEditOrSend(ctx, payload) {
  const chatId = ctx.chat?.id;
  const sess = chatId ? getSess(chatId) : null;
  const canEdit = !!(sess?.lastMessageId);

  try {
    if (canEdit) {
      if (payload.animation) throw new Error("forceSend"); // no edit animations
      if (payload.photo) {
        await ctx.telegram.editMessageMedia(
          chatId,
          sess.lastMessageId,
          undefined,
          {
            type: "photo",
            media: payload.photo,
            caption: payload.caption || "",
            parse_mode: "HTML",
          },
          payload.extra || {}
        );
        return;
      } else {
        await ctx.telegram.editMessageText(
          chatId,
          sess.lastMessageId,
          undefined,
          payload.text || " ",
          { parse_mode: "HTML", ...(payload.extra || {}) }
        );
        return;
      }
    }
  } catch {
    // fallback send new
  }

  let msg;
  if (payload.photo) {
    msg = await ctx.replyWithPhoto(payload.photo, {
      caption: payload.caption || "",
      parse_mode: "HTML",
      ...(payload.extra || {}),
    });
  } else {
    msg = await ctx.reply(payload.text || " ", {
      parse_mode: "HTML",
      ...(payload.extra || {}),
    });
  }

  if (sess && msg?.message_id) sess.lastMessageId = msg.message_id;
}

/* =========================================================
   KEYBOARDS (A) Menú + Volver + Menú
========================================================= */
function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🧀 Catálogo", "MENU_CATALOGO")],
    [Markup.button.callback("🎟️ Sellos", "MENU_SELLOS"), Markup.button.callback("ℹ️ Ayuda", "MENU_AYUDA")],
    [Markup.button.callback("📣 Compartir", "MENU_COMPARTIR")],
  ]);
}

function goMenuRow() {
  return [Markup.button.callback("🏠 Menú", "GO_MENU")];
}

function backMenuRows() {
  return [
    [Markup.button.callback("⬅️ Volver", "GO_BACK")],
    goMenuRow(),
  ];
}

/* =========================================================
   PRODUCT UI
========================================================= */
function productCaption(cfg, p, index, total) {
  const moneda = cfg.Moneda || "ARS";
  const showPrice = parseYes(cfg.CatalogoMostrarPrecios || "SI");
  const lines = [];
  lines.push(`<b>${p.name}</b>`);

  if (showPrice) {
    if (p.unit === "g" && p.pricePerKg > 0) lines.push(`💰 <b>${money(p.pricePerKg, moneda)}</b> / kg`);
    else lines.push(`💰 <b>${money(p.price, moneda)}</b>`);
  }

  if (p.desc) lines.push(`\n${p.desc}`);
  lines.push(`\n📌 ${p.cat}`);
  lines.push(`\n<code>${index + 1}/${total}</code>`);
  return lines.join("\n");
}

function productKeyboard(p) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⬅️", "PROD_PREV"), Markup.button.callback("➡️", "PROD_NEXT")],
    [Markup.button.callback("✅ Quiero éste", `WANT_${p.code}`), Markup.button.callback("🔗 Compartir", `SHARE_PROD_${p.code}`)],
    ...backMenuRows(),
  ]);
}

/* =========================================================
   CART + TICKETS
========================================================= */
function cartTotal(cart) {
  return roundARS(cart.reduce((acc, it) => acc + (Number(it.subtotal) || 0), 0));
}

function fmtQty(it) {
  if (it.qtyType === "g") return `${it.grams} g`;
  return `${it.qty} u`;
}

function ticketPOS(cfg, { orderId, items, total, entregaTipo, pagoTipo, nombre, telefono, direccion, notas, estado, costoEnvio = 0 }) {
  const moneda = cfg.Moneda || "ARS";
  const lines = [];
  lines.push(`🧾 <b>TICKET</b>`);
  lines.push(`<code>${orderId}</code>`);
  lines.push(`──────────────────`);
  for (const it of items) {
    const sub = roundARS(it.subtotal || 0);
    lines.push(`• <b>${it.name}</b>`);
    lines.push(`  ${fmtQty(it)}  ·  ${money(sub, moneda)}`);
  }

  if ((entregaTipo === "ENVIO" || entregaTipo === "EXPRESS") && roundARS(costoEnvio) > 0) {
    lines.push(`• <b>Envío</b>`);
    lines.push(`  ${money(roundARS(costoEnvio), moneda)}`);
  }

  lines.push(`──────────────────`);
  lines.push(`🧮 <b>Total:</b> ${money(roundARS(total), moneda)}`);
  lines.push(`🚚 <b>Entrega:</b> ${entregaTipo}`);
  lines.push(`💳 <b>Pago:</b> ${pagoTipo}`);
  if (nombre) lines.push(`👤 <b>Nombre:</b> ${nombre}`);
  if (telefono) lines.push(`📞 <b>Tel:</b> ${telefono}`);
  if (direccion) lines.push(`📍 <b>Dirección:</b> ${direccion}`);
  if (notas) lines.push(`📝 <b>Notas:</b> ${notas}`);
  if (estado) lines.push(`📌 <b>Estado:</b> ${estado}`);
  return lines.join("\n");
}

function buildShareLinks({ botLink, text }) {
  const url = encodeURIComponent(botLink);
  const t = encodeURIComponent(text);
  return {
    wa: `https://wa.me/?text=${t}%0A${url}`,
    tg: `https://t.me/share/url?url=${url}&text=${t}`,
  };
}

function shareKeyboard(links) {
  return Markup.inlineKeyboard([
    [Markup.button.url("📲 WhatsApp", links.wa), Markup.button.url("✈️ Telegram", links.tg)],
    ...backMenuRows(),
  ]);
}

/* =========================================================
   SELLOS UI
========================================================= */
function sellosTextShort(cfg, sellos) {
  const montoPorSello = parseNumber(cfg.MontoPorSello || "10000", 10000);
  const moneda = cfg.Moneda || "ARS";
  const tip = `✨ Tip: si alguien entra por tu link y compra, ganás <b>${parseNumber(cfg.BonusSellosShare || "1", 1)}</b> sello(s).`;
  return [
    `🎟️ <b>Sellos</b>`,
    `Tenés <b>${sellos}</b> sellos acumulados.`,
    `Cada <b>${money(montoPorSello, moneda)}</b> = <b>1 sello</b>.`,
    ``,
    tip,
  ].join("\n");
}

function sellosTextLevels(cfg) {
  const sellosPorNivel = String(cfg.SellosPorNivel || "").trim();
  const beneficios = String(cfg.BeneficiosPorNivel || "").trim();
  const nombres = String(cfg.NombresNiveles || "").trim();

  const lines = [];
  lines.push(`🏅 <b>Niveles</b>`);
  if (nombres) lines.push(nombres);
  if (sellosPorNivel) lines.push(sellosPorNivel);
  if (beneficios) {
    lines.push(`\n🎁 <b>Beneficios</b>`);
    lines.push(beneficios);
  }
  return lines.join("\n");
}

/* =========================================================
   FLOW SCREENS (C + GIFs por file_id desde Config)
   - GIFs (start/ayuda/compartir): QUEDAN FIJOS en el chat (no editar)
   - Catálogo + compra: se edita con safeEditOrSend (chat limpio)
========================================================= */
async function showMenu(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  setScreen(sess, "MENU");

  const nombre = cfg.NegocioNombre || "Tu Negocio";
  const dire = cfg.NegocioDireccion || "";
  const hora = cfg.NegocioHorario || "";
  const estado = cfg.Estado || "";
  const desc = String(cfg.Descripcion || "").trim();

  // ✅ GIF por file_id (Telegram) desde Config
  const gifId = pickRandom(splitPipes(cfg.GifBienvenidaID || cfg.GifBienvenidaFileId || ""));
  const gifUrl = pickRandom(splitPipes(cfg.GifBienvenidaURL || "")); // opcional fallback
  const logo = String(cfg.LogoURL || "").trim();

  const header = [];
  header.push(`🏠 <b>${nombre}</b>`);
  if (estado) header.push(`🟢 <b>${estado}</b>`);
  if (dire) header.push(`📍 ${dire}`);
  if (hora) header.push(`🕒 ${hora}`);

  const caption = `${header.join("\n")}\n\n${desc}\n\nElegí una opción 👇`;

  // FIJO (no editar): primero file_id, luego URL
  if (gifId) {
    await ctx.replyWithAnimation(gifId, {
      caption,
      parse_mode: "HTML",
      reply_markup: mainMenuKeyboard().reply_markup,
    });
    return;
  }

  if (gifUrl && gifUrl.startsWith("http")) {
    await ctx.replyWithAnimation(gifUrl, {
      caption,
      parse_mode: "HTML",
      reply_markup: mainMenuKeyboard().reply_markup,
    });
    return;
  }

  if (logo && logo.startsWith("http")) {
    await ctx.replyWithPhoto(logo, {
      caption,
      parse_mode: "HTML",
      reply_markup: mainMenuKeyboard().reply_markup,
    });
    return;
  }

  await ctx.reply(caption, { parse_mode: "HTML", reply_markup: mainMenuKeyboard().reply_markup });
}

async function showCategories(ctx) {
  const sess = getSess(ctx.chat.id);
  setScreen(sess, "CATS");

  const { items } = await loadCatalog();
  const cats = categoriesFromItems(items);

  if (!cats.length) {
    await safeEditOrSend(ctx, {
      text: "🧀 Catálogo vacío. Cargá productos en la hoja <b>Catalogo</b>.",
      extra: Markup.inlineKeyboard(backMenuRows()),
    });
    return;
  }

  const buttons = [];
  for (let i = 0; i < cats.length; i += 2) {
    const row = [];
    row.push(Markup.button.callback(`📁 ${cats[i]}`, `CAT_${encodeURIComponent(cats[i])}`));
    if (cats[i + 1]) row.push(Markup.button.callback(`📁 ${cats[i + 1]}`, `CAT_${encodeURIComponent(cats[i + 1])}`));
    buttons.push(row);
  }

  buttons.push(...backMenuRows());

  await safeEditOrSend(ctx, {
    text: `🧀 <b>Catálogo</b>\n\nElegí una <b>categoría</b> 👇`,
    extra: Markup.inlineKeyboard(buttons),
  });
}

async function showProductCarousel(ctx, cat) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);

  const { items } = await loadCatalog();
  const prods = items.filter((p) => (p.cat || "General") === cat);

  if (!prods.length) {
    setScreen(sess, "CATS");
    await safeEditOrSend(ctx, {
      text: `No hay productos en <b>${cat}</b>.`,
      extra: Markup.inlineKeyboard(backMenuRows()),
    });
    return;
  }

  sess.mode = "CATALOGO";
  sess.category = cat;
  sess.productsInView = prods;
  sess.productIndex = 0;

  setScreen(sess, "PROD", { cat });

  const p = prods[0];
  const caption = productCaption(cfg, p, 0, prods.length);
  const photo = p.img && p.img.startsWith("http") ? p.img : undefined;

  if (photo) await safeEditOrSend(ctx, { photo, caption, extra: productKeyboard(p) });
  else await safeEditOrSend(ctx, { text: caption, extra: productKeyboard(p) });
}

async function showSellos(ctx, showLevels = false) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  setScreen(sess, "SELLOS", { showLevels });

  const rows = await getSheetValues(`${CLIENTES_SHEET}!A2:H`);
  const me = rows.find((r) => String(r[0] || "") === String(ctx.chat.id));
  const sellos = me ? parseNumber(me[3], 0) : 0;

  const cardUrl = String(cfg.CARD_URL || cfg.CardURL || cfg.SelloURL || "").trim();
  const caption = showLevels
    ? `${sellosTextShort(cfg, sellos)}\n\n${sellosTextLevels(cfg)}`
    : sellosTextShort(cfg, sellos);

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback(showLevels ? "⬅️ Volver" : "🏅 Ver niveles", showLevels ? "SELLOS_BACK" : "SELLOS_LEVELS")],
    [Markup.button.callback("🧀 Catálogo", "MENU_CATALOGO")],
    ...backMenuRows(),
  ]);

  if (cardUrl && cardUrl.startsWith("http")) {
    await safeEditOrSend(ctx, { photo: cardUrl, caption, extra: kb });
  } else {
    await safeEditOrSend(ctx, { text: caption, extra: kb });
  }
}

async function showHelp(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  setScreen(sess, "HELP");

  const gifId = pickRandom(splitPipes(cfg.GifAyudaID || cfg.GifAyudaFileId || ""));
  const gifUrl = pickRandom(splitPipes(cfg.GifAyudaURL || ""));

  const nombre = cfg.NegocioNombre || "Todo Queso";
  const text = [
    `ℹ️ <b>Ayuda - ${nombre}</b>\n`,
    `• Tocá 🧀 <b>Catálogo</b> y elegí productos.`,
    `• Tocá ✅ <b>Quiero éste</b> y escribí gramos o unidades.`,
    `• En cualquier pantalla tenés <b>Volver</b> y <b>Menú</b>.`,
    `• Si pagás por transferencia: enviás comprobante por WhatsApp y el vendedor confirma.`,
  ].join("\n");

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("✉️ Hablar con vendedor", "HELP_CONTACT")],
    ...backMenuRows(),
  ]);

  await safeEditOrSend(ctx, {
  animation: gifId || gifUrl,
  text,            // ✅ CORRECTO
  extra: kb,
});     }
   
async function showShareBot(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  setScreen(sess, "SHARE");

  const gifId = pickRandom(splitPipes(cfg.GifCompartirID || cfg.GifCompartirFileId || ""));
  const gifUrl = pickRandom(splitPipes(cfg.GifCompartirURL || ""));
  const botLink = String(cfg.BotLink || "").trim();

  const textShare =
    String(cfg.TextoCompartirBot || "").trim() ||
    `🧀 Mirá el bot de ${cfg.NegocioNombre || "Todo Queso"} y pedí en 1 minuto.`;

  if (!botLink) {
    await ctx.reply("Falta <b>BotLink</b> en Config para compartir.", { parse_mode: "HTML" });
    return;
  }

  const links = buildShareLinks({ botLink, text: textShare });
  const caption = `📣 <b>Compartir</b>\n\nElegí dónde compartir 👇`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.url("📲 WhatsApp", links.wa), Markup.button.url("✈️ Telegram", links.tg)],
    ...backMenuRows(),
  ]);

  await safeEditOrSend(ctx, {
    animation: gifId || gifUrl,
    text: caption,
    extra: kb,
  });
       } 

  // FIJO: no editar

    await ctx.replyWithAnimation(gifId, {
      caption,
      parse_mode: "HTML",
      reply_markup: kb.reply_markup,
    });
  else if (gifUrl && gifUrl.startsWith("http")) {
    await ctx.replyWithAnimation(gifUrl, {
      caption,
      parse_mode: "HTML",
      reply_markup: kb.reply_markup,
    });
  } else {
    await ctx.reply(caption, { parse_mode: "HTML", reply_markup: kb.reply_markup });
  }


/* =========================================================
   PRODUCT -> QUIERO ESTE -> CANTIDAD
========================================================= */
function qtyPromptText(cfg, p) {
  if (p.unit === "g") {
    return `✅ <b>${p.name}</b>\n\n¿Cuántos <b>gramos</b> querés?\nEj: <code>250</code> o <code>1000</code>`;
  }
  return `✅ <b>${p.name}</b>\n\n¿Cuántas <b>unidades</b> querés?\nEj: <code>1</code> o <code>2</code>`;
}

function computeSubtotal(p, qtyType, value) {
  if (qtyType === "g") {
    const grams = Math.max(1, parseNumber(value, 0));
    const perKg = p.pricePerKg > 0 ? p.pricePerKg : p.price; // si no hay precio/kg, asumimos price es por kg
    const subtotal = roundARS((grams / 1000) * perKg);
    return { grams, qty: 0, subtotal };
  }
  const qty = Math.max(1, parseNumber(value, 0));
  const subtotal = roundARS(qty * p.price);
  return { grams: 0, qty, subtotal };
}

// ✅ (C) CORREGIDO: sumar bien por producto sin inflar
function addToCart(sess, p, qtyType, value) {
  const calc = computeSubtotal(p, qtyType, value);
  const existing = sess.cart.find((x) => x.code === p.code && x.qtyType === qtyType);

  if (existing) {
    existing.subtotal = roundARS((existing.subtotal || 0) + calc.subtotal);
    if (qtyType === "g") existing.grams = (existing.grams || 0) + calc.grams;
    else existing.qty = (existing.qty || 0) + calc.qty;
  } else {
    sess.cart.push({
      code: p.code,
      name: p.name,
      cat: p.cat,
      img: p.img,
      desc: p.desc,
      unit: p.unit,
      price: p.price,
      pricePerKg: p.pricePerKg,
      qtyType,
      qty: calc.qty,
      grams: calc.grams,
      subtotal: calc.subtotal,
    });
  }
}

async function showCheckoutTicketPreview(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  setScreen(sess, "TICKET", { preview: true });

  const entrega = sess.checkout.entregaTipo || "-";
  const pago = sess.checkout.pagoTipo || "-";

  const costoEnvio = parseNumber(cfg.CostoEnvio || "0", 0);
  let total = cartTotal(sess.cart);
  if (entrega === "ENVIO" || entrega === "EXPRESS") total = roundARS(total + costoEnvio);

  const t = ticketPOS(cfg, {
    orderId: "—",
    items: sess.cart,
    total,
    entregaTipo: entrega,
    pagoTipo: pago,
    nombre: sess.checkout.nombre,
    telefono: sess.checkout.telefono,
    direccion: sess.checkout.direccion,
    notas: sess.checkout.notas,
    estado: "Pendiente de confirmación",
    costoEnvio,
  });

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("✅ Finalizar compra", "FINALIZE_ORDER")],
    [Markup.button.callback("❌ Cancelar compra", "CANCEL_FLOW")],
    ...backMenuRows(),
  ]);

  await safeEditOrSend(ctx, { text: t, extra: kb });
}

/* =========================================================
   ENTREGA + DATOS
========================================================= */
function deliveryKeyboard(cfg) {
  const rows = [];
  if (parseYes(cfg.UsaEnvíoDomicilio || cfg.UsaEnvioDomicilio || "SI"))
    rows.push([Markup.button.callback("🚚 Envío a domicilio", "DELIVERY_ENVIO")]);
  if (parseYes(cfg.EnvioExpress || "SI"))
    rows.push([Markup.button.callback("⚡ Envío express", "DELIVERY_EXPRESS")]);
  if (parseYes(cfg.UsaRetiroLocal || "SI"))
    rows.push([Markup.button.callback("🏪 Retiro en el local", "DELIVERY_RETIRO")]);

  rows.push(...backMenuRows());
  return Markup.inlineKeyboard(rows);
}

function payKeyboard(cfg) {
  const rows = [];
  if (parseYes(cfg.PermitirPagoOnline || cfg.PermitePagoOnline || "SI")) {
    const tipo = (cfg.TipoPagoOnline || "TRANSFERENCIA").toUpperCase();
    rows.push([Markup.button.callback(`💳 ${tipo}`, `PAY_${tipo}`)]);
  }
  rows.push([Markup.button.callback("💵 Efectivo", "PAY_EFECTIVO")]);
  rows.push(...backMenuRows());
  return Markup.inlineKeyboard(rows);
}

async function showCart(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  setScreen(sess, "CART");

  if (!sess.cart.length) {
    await safeEditOrSend(ctx, {
      text: `🛒 <b>Carrito</b>\n\nTu carrito está vacío.\nVolvé al catálogo para elegir productos.`,
      extra: Markup.inlineKeyboard([
        [Markup.button.callback("🧀 Catálogo", "MENU_CATALOGO")],
        ...backMenuRows(),
      ]),
    });
    return;
  }

  const moneda = cfg.Moneda || "ARS";
  const lines = [];
  lines.push(`🛒 <b>Carrito</b>`);
  lines.push(`──────────────────`);
  sess.cart.forEach((it, i) => {
    lines.push(`${i + 1}) <b>${it.name}</b>`);
    lines.push(`   ${fmtQty(it)} · ${money(roundARS(it.subtotal || 0), moneda)}`);
  });
  lines.push(`──────────────────`);
  lines.push(`🧮 <b>Total:</b> ${money(cartTotal(sess.cart), moneda)}`);

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("✅ Finalizar compra", "CHK_DELIVERY")],
    [Markup.button.callback("🧀 Seguir comprando", "MENU_CATALOGO")],
    [Markup.button.callback("🗑️ Vaciar carrito", "CART_CLEAR")],
    ...backMenuRows(),
  ]);

  await safeEditOrSend(ctx, { text: lines.join("\n"), extra: kb });
}

async function showDelivery(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  setScreen(sess, "DELIVERY");

  await safeEditOrSend(ctx, {
    text: `🚚 <b>Entrega</b>\n\nElegí cómo querés recibir tu pedido 👇`,
    extra: deliveryKeyboard(cfg),
  });
}

async function showPayment(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  setScreen(sess, "PAY");

  const entregaTipo = sess.checkout.entregaTipo || "";
  const moneda = cfg.Moneda || "ARS";
  const costoEnvio = parseNumber(cfg.CostoEnvio || "0", 0);

  let extraText = "";
  if (entregaTipo === "ENVIO" || entregaTipo === "EXPRESS") {
    extraText = `\n\n🚚 Costo de envío: <b>${money(costoEnvio, moneda)}</b>\n${String(cfg.TextoEnvíoDomicilio || cfg.TextoEnvioDomicilio || "").trim()}`;
  } else {
    extraText = `\n\n🏪 ${String(cfg.TextoRetiroLocal || "").trim()}`;
  }

  await safeEditOrSend(ctx, {
    text: `💳 <b>Pago</b>\n\nElegí cómo vas a pagar 👇${extraText}`,
    extra: payKeyboard(cfg),
  });
}

/* =========================================================
   FINALIZAR PEDIDO + VENDEDOR CONFIRMA
========================================================= */
function buildOrderId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `TQ-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function buildTransferDataText(cfg) {
  const alias = String(cfg.AliasTransferencia || "").trim();
  const cbu = String(cfg.CBUPago || "").trim();
  const msg = String(cfg.MensajeTransferencia || "").trim();

  const lines = [];
  lines.push(`💳 <b>Transferencia</b>`);
  if (alias) lines.push(`• <b>Alias:</b> <code>${alias}</code>`);
  if (cbu) lines.push(`• <b>CBU:</b> <code>${cbu}</code>`);
  if (msg) lines.push(`\n${msg}`);
  return lines.join("\n");
}

function getWhatsappOrderLink(cfg, orderId) {
  const link = String(cfg.WhatsAppLink || "").trim();
  const telRaw = String(cfg.NegocioTelefono || "").trim();
  const tel = telRaw.replace(/[^\d]/g, "");
  const waBase = link || (tel ? `https://wa.me/${tel}` : "");
  if (!waBase) return "";

  const text = encodeURIComponent(`Hola! Te envío el comprobante de transferencia del pedido ${orderId}.`);
  if (waBase.includes("?text=")) return waBase;
  return waBase.includes("?") ? `${waBase}&text=${text}` : `${waBase}?text=${text}`;
}

function scheduleExpire(orderId, expMs, onExpire) {
  if (ORDER_TIMERS.has(orderId)) clearTimeout(ORDER_TIMERS.get(orderId));
  const t = setTimeout(onExpire, expMs);
  ORDER_TIMERS.set(orderId, t);
}

async function finalizeOrderCreate(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);

  if (!sess.cart.length) {
    await safeEditOrSend(ctx, { text: "Tu carrito está vacío.", extra: mainMenuKeyboard() });
    return;
  }

  const entregaTipo = sess.checkout.entregaTipo || "RETIRO";
  const pagoTipo = sess.checkout.pagoTipo || "EFECTIVO";

  const costoEnvio = parseNumber(cfg.CostoEnvio || "0", 0);

  // ✅ TOTAL CORRECTO (cart + envío una sola vez)
  let total = cartTotal(sess.cart);
  if (entregaTipo === "ENVIO" || entregaTipo === "EXPRESS") total = roundARS(total + costoEnvio);

  // sellos por compra
  const usaSellos = parseYes(cfg.UsaSellos || "SI");
  const montoPorSello = parseNumber(cfg.MontoPorSello || "10000", 10000);
  const sellosGanados = usaSellos ? Math.floor(total / montoPorSello) : 0;

  // datos cliente
  const nombre = sess.checkout.nombre || `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim();
  const usuario = ctx.from.username ? `@${ctx.from.username}` : "";
  const telefono = sess.checkout.telefono || "";
  const direccion = sess.checkout.direccion || "";
  const notas = sess.checkout.notas || "";

  // persist cliente (sumar sellos ahora)
  await upsertCliente({
    chatId: ctx.chat.id,
    nombre,
    usuario,
    addSellos: sellosGanados,
    addTotal: total,
    refBy: sess.refBy ? String(sess.refBy) : "",
  });

  // referido bonus al referente por compra
  const bonusShare = parseNumber(cfg.BonusSellosShare || "1", 1);
  if (sess.refBy) {
    for (let i = 0; i < bonusShare; i++) await addSelloReferido(sess.refBy);
  }

  // pedido
  const orderId = buildOrderId();
  const now = new Date();
  const expMs = 60 * 60 * 1000; // 1 hora
  const expIso = new Date(now.getTime() + expMs).toISOString();

  const itemsText = sess.cart.map((it) => `${it.name} (${fmtQty(it)})`).join(" | ");

  await appendRow(PEDIDOS_SHEET, [
    orderId,
    now.toISOString(),
    expIso,
    String(ctx.chat.id),
    nombre,
    usuario,
    itemsText,
    total,
    entregaTipo,
    pagoTipo,
    direccion,
    telefono,
    notas,
    "PENDIENTE",
    sess.refBy ? String(sess.refBy) : "",
  ]);

  // avisar vendedor por Telegram (Config: VendedorChatId)
  const vendedorIdReal = String(cfg.VendedorChatId || "").trim();
  const vendedor = vendedorIdReal ? Number(vendedorIdReal) : null;

  const ticketVendedor = ticketPOS(cfg, {
    orderId,
    items: sess.cart,
    total,
    entregaTipo,
    pagoTipo,
    nombre,
    telefono,
    direccion,
    notas,
    estado: "PENDIENTE (espera comprobante)",
    costoEnvio,
  });

  if (vendedor && Number.isFinite(vendedor)) {
    const kbVend = Markup.inlineKeyboard([
      [Markup.button.callback("✅ Confirmar pago", `V_CONFIRM_${orderId}`)],
      [Markup.button.callback("❌ Rechazar", `V_REJECT_${orderId}`)],
    ]);
    await bot.telegram.sendMessage(vendedor, ticketVendedor, {
      parse_mode: "HTML",
      reply_markup: kbVend.reply_markup,
    });
  }

  // cliente: ticket + transferencia + 1h
  const ticketCliente = ticketPOS(cfg, {
    orderId,
    items: sess.cart,
    total,
    entregaTipo,
    pagoTipo,
    nombre,
    telefono,
    direccion,
    notas,
    estado: "PENDIENTE",
    costoEnvio,
  });

  const waOrder = getWhatsappOrderLink(cfg, orderId);

  const extra = [];
  extra.push(`⏳ Este pedido queda <b>pendiente</b> hasta que el vendedor confirme el pago.`);
  extra.push(`🕐 Si no se confirma en <b>1 hora</b>, se cancela automáticamente.`);
  if (String(pagoTipo).toUpperCase().includes("TRANSF")) {
    extra.push("");
    extra.push(buildTransferDataText(cfg));
    extra.push("");
    extra.push(`📲 Enviá el <b>comprobante</b> por WhatsApp para que lo confirmen.`);
  }

  const kbClienteRows = [];
  if (waOrder) kbClienteRows.push([Markup.button.url("📲 Enviar comprobante por WhatsApp", waOrder)]);
  kbClienteRows.push([Markup.button.callback("❌ Cancelar pedido", `CANCEL_${orderId}`)]);
  kbClienteRows.push(...backMenuRows());

  await safeEditOrSend(ctx, {
    text: `${ticketCliente}\n\n${extra.join("\n")}`,
    extra: Markup.inlineKeyboard(kbClienteRows),
  });

  // programar vencimiento
  scheduleExpire(orderId, expMs, async () => {
    const row = await setPedidoEstado(orderId, "VENCIDO");
    if (!row) return;
    const chatIdCliente = Number(row[3]);
    if (Number.isFinite(chatIdCliente)) {
      await bot.telegram.sendMessage(
        chatIdCliente,
        `⏳ Tu pedido <b>${orderId}</b> venció por falta de confirmación y fue cancelado automáticamente.`,
        { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard(backMenuRows()).reply_markup }
      );
    }
  });

  // limpiar estado compra
  sess.cart = [];
  sess.checkout = { entregaTipo: null, pagoTipo: null, nombre: "", telefono: "", direccion: "", notas: "" };
  sess.waiting = null;
}

/* =========================================================
   HELP CONTACT (manda mensaje al vendedor)
========================================================= */
async function forwardToVendedor(cfg, fromCtx, text) {
  const vendedorId = String(cfg.VendedorChatId || "").trim();
  const vendedor = vendedorId ? Number(vendedorId) : null;
  if (!vendedor || !Number.isFinite(vendedor)) return false;

  const nombre = `${fromCtx.from.first_name || ""} ${fromCtx.from.last_name || ""}`.trim();
  const usuario = fromCtx.from.username ? `@${fromCtx.from.username}` : "";
  const msg = [
    `📩 <b>Mensaje de cliente</b>`,
    `👤 ${nombre} ${usuario ? `(${usuario})` : ""}`,
    `🆔 <code>${fromCtx.chat.id}</code>`,
    `──────────────────`,
    `${text}`,
  ].join("\n");

  await bot.telegram.sendMessage(vendedor, msg, { parse_mode: "HTML" });
  return true;
}

/* =========================================================
   TELEGRAM BOT
========================================================= */
const bot = new Telegraf(TelegramBotToken);

/* START */
bot.start(async (ctx) => {
  await ensureBaseSheets();
  await expireOldPending();

  const sess = getSess(ctx.chat.id);

  const payload = (ctx.startPayload || "").trim();
  if (payload) {
    const mRef = payload.match(/ref_(\d+)/);
    if (mRef) sess.refBy = Number(mRef[1]);
    const mProd = payload.match(/prod_([^_]+)/);
    if (mProd) sess.jumpProdCode = decodeURIComponent(mProd[1]);
  }

  await showMenu(ctx);

  // salto a producto si viene por link
  if (sess.jumpProdCode) {
    const code = sess.jumpProdCode;
    sess.jumpProdCode = null;

    const { items } = await loadCatalog();
    const p = items.find((x) => x.code === code);
    if (p) {
      await showProductCarousel(ctx, p.cat || "General");
      const sess2 = getSess(ctx.chat.id);
      const idx = sess2.productsInView.findIndex((x) => x.code === code);
      if (idx >= 0) {
        sess2.productIndex = idx;
        const cfg = await loadConfig();
        const p2 = sess2.productsInView[idx];
        const caption = productCaption(cfg, p2, idx, sess2.productsInView.length);
        const photo = p2.img && p2.img.startsWith("http") ? p2.img : undefined;
        if (photo) await safeEditOrSend(ctx, { photo, caption, extra: productKeyboard(p2) });
        else await safeEditOrSend(ctx, { text: caption, extra: productKeyboard(p2) });
      }
    }
  }
});

/* =========================================================
   (A) VOLVER UNIVERSAL
========================================================= */
bot.action("GO_BACK", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  const s = sess.lastScreen;

  // “Volver” va a la pantalla lógica anterior del flujo
  if (s === "PROD") {
    await showCategories(ctx);
    return;
  }
  if (s === "CART") {
    // si venías de producto, volvemos a producto; si no, a categorías
    const cat = sess.category || sess.lastScreenData?.cat;
    if (cat && sess.productsInView?.length) {
      const cfg = await loadConfig();
      const p = sess.productsInView[sess.productIndex] || sess.productsInView[0];
      const idx = sess.productIndex || 0;
      const caption = productCaption(cfg, p, idx, sess.productsInView.length);
      const photo = p.img && p.img.startsWith("http") ? p.img : undefined;
      setScreen(sess, "PROD", { cat });
      if (photo) await safeEditOrSend(ctx, { photo, caption, extra: productKeyboard(p) });
      else await safeEditOrSend(ctx, { text: caption, extra: productKeyboard(p) });
      return;
    }
    await showCategories(ctx);
    return;
  }
  if (s === "DELIVERY") {
    await showCart(ctx);
    return;
  }
  if (s === "PAY" || s === "TICKET") {
    await showDelivery(ctx);
    return;
  }
  if (s === "SELLOS" || s === "HELP" || s === "SHARE" || s === "CATS") {
    await showMenu(ctx);
    return;
  }

  await showMenu(ctx);
});

/* MENÚ */
bot.action("GO_MENU", async (ctx) => { await ctx.answerCbQuery(); await showMenu(ctx); });

bot.action("MENU_CATALOGO", async (ctx) => { await ctx.answerCbQuery(); await showCategories(ctx); });
bot.action("MENU_SELLOS", async (ctx) => { await ctx.answerCbQuery(); await showSellos(ctx, false); });
bot.action("SELLOS_LEVELS", async (ctx) => { await ctx.answerCbQuery(); await showSellos(ctx, true); });
bot.action("SELLOS_BACK", async (ctx) => { await ctx.answerCbQuery(); await showSellos(ctx, false); });
bot.action("MENU_AYUDA", async (ctx) => { await ctx.answerCbQuery(); await showHelp(ctx); });
bot.action("MENU_COMPARTIR", async (ctx) => { await ctx.answerCbQuery(); await showShareBot(ctx); });

/* CATEGORÍAS */
bot.action(/^CAT_(.+)$/i, async (ctx) => {
  await ctx.answerCbQuery();
  const cat = decodeURIComponent(ctx.match[1]);
  await showProductCarousel(ctx, cat);
});

/* PRODUCT CAROUSEL */
bot.action("PROD_NEXT", async (ctx) => {
  await ctx.answerCbQuery();
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  if (!sess.productsInView.length) return;
  sess.productIndex = (sess.productIndex + 1) % sess.productsInView.length;
  const p = sess.productsInView[sess.productIndex];
  setScreen(sess, "PROD", { cat: sess.category || p.cat || "General" });

  const caption = productCaption(cfg, p, sess.productIndex, sess.productsInView.length);
  const photo = p.img && p.img.startsWith("http") ? p.img : undefined;
  if (photo) await safeEditOrSend(ctx, { photo, caption, extra: productKeyboard(p) });
  else await safeEditOrSend(ctx, { text: caption, extra: productKeyboard(p) });
});

bot.action("PROD_PREV", async (ctx) => {
  await ctx.answerCbQuery();
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  if (!sess.productsInView.length) return;
  sess.productIndex = (sess.productIndex - 1 + sess.productsInView.length) % sess.productsInView.length;
  const p = sess.productsInView[sess.productIndex];
  setScreen(sess, "PROD", { cat: sess.category || p.cat || "General" });

  const caption = productCaption(cfg, p, sess.productIndex, sess.productsInView.length);
  const photo = p.img && p.img.startsWith("http") ? p.img : undefined;
  if (photo) await safeEditOrSend(ctx, { photo, caption, extra: productKeyboard(p) });
  else await safeEditOrSend(ctx, { text: caption, extra: productKeyboard(p) });
});

/* VER CARRITO */
bot.action("VIEW_CART", async (ctx) => { await ctx.answerCbQuery(); await showCart(ctx); });

/* QUIERO ESTE -> PREGUNTAR CANTIDAD */
bot.action(/^WANT_(.+)$/i, async (ctx) => {
  await ctx.answerCbQuery();
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  const code = ctx.match[1];

  const p = sess.productsInView.find((x) => x.code === code);
  if (!p) return;

  const qtyType = p.unit === "g" ? "g" : "u";
  sess.waiting = { type: "QTY", payload: { code, qtyType } };

  await safeEditOrSend(ctx, {
    text: qtyPromptText(cfg, p),
    extra: Markup.inlineKeyboard(backMenuRows()),
  });
});

/* COMPARTIR PRODUCTO */
bot.action(/^SHARE_PROD_(.+)$/i, async (ctx) => {
  await ctx.answerCbQuery();
  const cfg = await loadConfig();
  const { items } = await loadCatalog();

  const productCode = ctx.match[1];
  const p = items.find((x) => x.code === productCode);
  const botLink = String(cfg.BotLink || "").trim();
  if (!p || !botLink) {
    await safeEditOrSend(ctx, {
      text: "No pude preparar el link de compartir (falta BotLink o producto).",
      extra: Markup.inlineKeyboard(backMenuRows()),
    });
    return;
  }

  const ref = ctx.chat.id;
  const deepLink = botLink.includes("?start=")
    ? botLink
    : `${botLink}${botLink.includes("?") ? "&" : "?"}start=ref_${ref}__prod_${encodeURIComponent(p.code)}`;

  const moneda = cfg.Moneda || "ARS";
  const priceTxt = p.unit === "g" && p.pricePerKg > 0 ? `${money(p.pricePerKg, moneda)} / kg` : money(p.price, moneda);
  const text = `🧀 ${cfg.NegocioNombre || "Todo Queso"}\n\nPromo: ${p.name} — ${priceTxt}\nTocá el link para ver y comprar 👇`;
  const links = buildShareLinks({ botLink: deepLink, text });

  await safeEditOrSend(ctx, {
    text: `🔗 <b>Compartir producto</b>\n\n${p.name}\n\nElegí dónde compartir 👇`,
    extra: shareKeyboard(links),
  });
});

/* CART / CHECKOUT */
bot.action("CHK_DELIVERY", async (ctx) => { await ctx.answerCbQuery(); await showDelivery(ctx); });

bot.action("DELIVERY_ENVIO", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  sess.checkout.entregaTipo = "ENVIO";
  sess.waiting = { type: "NAME", payload: {} };
  await safeEditOrSend(ctx, {
    text: `🚚 <b>Envío a domicilio</b>\n\nDecime tu <b>nombre</b> (solo texto):`,
    extra: Markup.inlineKeyboard(backMenuRows()),
  });
});

bot.action("DELIVERY_EXPRESS", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  sess.checkout.entregaTipo = "EXPRESS";
  sess.waiting = { type: "NAME", payload: {} };
  await safeEditOrSend(ctx, {
    text: `⚡ <b>Envío express</b>\n\nDecime tu <b>nombre</b> (solo texto):`,
    extra: Markup.inlineKeyboard(backMenuRows()),
  });
});

bot.action("DELIVERY_RETIRO", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  sess.checkout.entregaTipo = "RETIRO";
  sess.waiting = { type: "NAME", payload: { retiro: true } };
  await safeEditOrSend(ctx, {
    text: `🏪 <b>Retiro en el local</b>\n\nDecime tu <b>nombre</b> (solo texto):`,
    extra: Markup.inlineKeyboard(backMenuRows()),
  });
});

bot.action(/^PAY_(.+)$/i, async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  const pago = (ctx.match[1] || "TRANSFERENCIA").toUpperCase();
  sess.checkout.pagoTipo = pago;
  await showCheckoutTicketPreview(ctx);
});

bot.action("PAY_EFECTIVO", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  sess.checkout.pagoTipo = "EFECTIVO";
  await showCheckoutTicketPreview(ctx);
});

bot.action("FINALIZE_ORDER", async (ctx) => {
  await ctx.answerCbQuery();
  await finalizeOrderCreate(ctx);
});

bot.action("CANCEL_FLOW", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  sess.cart = [];
  sess.checkout = { entregaTipo: null, pagoTipo: null, nombre: "", telefono: "", direccion: "", notas: "" };
  sess.waiting = null;
  await safeEditOrSend(ctx, { text: `❌ Compra cancelada.\n\nSi querés, volvés al catálogo cuando quieras.`, extra: mainMenuKeyboard() });
});

bot.action(/^CANCEL_(TQ-.+)$/i, async (ctx) => {
  await ctx.answerCbQuery();
  const orderId = ctx.match[1];
  const row = await setPedidoEstado(orderId, "CANCELADO");
  if (!row) {
    await safeEditOrSend(ctx, { text: "No pude cancelar ese pedido (no lo encontré).", extra: mainMenuKeyboard() });
    return;
  }
  await safeEditOrSend(ctx, { text: `❌ Pedido <b>${orderId}</b> cancelado.`, extra: mainMenuKeyboard() });
});

/* VENDEDOR CONFIRMA/RECHAZA */
bot.action(/^V_CONFIRM_(TQ-.+)$/i, async (ctx) => {
  await ctx.answerCbQuery("Confirmado ✅");
  const cfg = await loadConfig();
  const orderId = ctx.match[1];
  const row = await setPedidoEstado(orderId, "APROBADO");
  if (!row) return;

  const chatIdCliente = Number(row[3]);
  const entregaTipo = row[8] || "";
  const pagoTipo = row[9] || "";
  const nombre = row[4] || "";
  const usuario = row[5] || "";
  const itemsText = row[6] || "";
  const total = parseNumber(row[7], 0);
  const direccion = row[10] || "";
  const telefono = row[11] || "";
  const notas = row[12] || "";

  const msgConfirm = String(cfg.TextoConfirmacionPedido || "").trim() || "✅ Pago confirmado. Ya estamos preparando tu pedido.";
  const extraEntrega =
    entregaTipo === "RETIRO"
      ? `🏪 Podés retirarlo dentro del horario del local.\n${String(cfg.NegocioHorario || "").trim()}`
      : entregaTipo === "EXPRESS"
      ? `⚡ Envío express: lo enviamos lo antes posible.`
      : `🚚 Envío a domicilio: coordinamos la entrega según el horario.\n${String(cfg.TextoEnvíoDomicilio || cfg.TextoEnvioDomicilio || "").trim()}`;

  const t = [
    `✅ <b>Pedido confirmado</b>`,
    `<code>${orderId}</code>`,
    `──────────────────`,
    `👤 ${nombre} ${usuario ? `(${usuario})` : ""}`,
    `📦 ${itemsText}`,
    `🧮 <b>Total:</b> ${money(total, cfg.Moneda || "ARS")}`,
    `🚚 <b>Entrega:</b> ${entregaTipo}`,
    `💳 <b>Pago:</b> ${pagoTipo}`,
    direccion ? `📍 <b>Dirección:</b> ${direccion}` : "",
    telefono ? `📞 <b>Tel:</b> ${telefono}` : "",
    notas ? `📝 <b>Notas:</b> ${notas}` : "",
    `──────────────────`,
    msgConfirm,
    extraEntrega,
  ].filter(Boolean).join("\n");

  if (Number.isFinite(chatIdCliente)) {
    await bot.telegram.sendMessage(chatIdCliente, t, {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard(backMenuRows()).reply_markup,
    });
  }

  await ctx.editMessageText(`${t}\n\n✅ <b>Estado:</b> APROBADO`, { parse_mode: "HTML" });
});

bot.action(/^V_REJECT_(TQ-.+)$/i, async (ctx) => {
  await ctx.answerCbQuery("Rechazado ❌");
  const orderId = ctx.match[1];
  const row = await setPedidoEstado(orderId, "RECHAZADO");
  if (!row) return;
  const chatIdCliente = Number(row[3]);
  if (Number.isFinite(chatIdCliente)) {
    await bot.telegram.sendMessage(chatIdCliente, `❌ El pedido <b>${orderId}</b> fue rechazado.\nSi querés, podés hacer uno nuevo desde el menú.`, {
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard(backMenuRows()).reply_markup,
    });
  }
  await ctx.editMessageText(`❌ Pedido <b>${orderId}</b> RECHAZADO.`, { parse_mode: "HTML" });
});

/* HELP CONTACT */
bot.action("HELP_CONTACT", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  sess.waiting = { type: "HELP_MSG", payload: {} };
  await safeEditOrSend(ctx, {
    text: `📝 Escribime tu mensaje y se lo paso al vendedor (1 solo mensaje).`,
    extra: Markup.inlineKeyboard(backMenuRows()),
  });
});

/* CART CLEAR */
bot.action("CART_CLEAR", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  sess.cart = [];
  await showCart(ctx);
});

/* =========================================================
   TEXT HANDLER (cantidad + datos + ayuda)
========================================================= */
bot.on("text", async (ctx) => {
  await ensureBaseSheets();

  const sess = getSess(ctx.chat.id);
  const cfg = await loadConfig();
  const text = String(ctx.message.text || "").trim();

  if (!sess.waiting) return;

  const w = sess.waiting;
  sess.waiting = null;

  if (w.type === "HELP_MSG") {
    const ok = await forwardToVendedor(cfg, ctx, text);
    if (ok) await safeEditOrSend(ctx, { text: `✅ Listo. Ya le mandé tu mensaje al vendedor.`, extra: mainMenuKeyboard() });
    else await safeEditOrSend(ctx, { text: `Falta <b>VendedorChatId</b> en Config para enviar el mensaje.`, extra: mainMenuKeyboard() });
    return;
  }

  if (w.type === "QTY") {
    const { code, qtyType } = w.payload || {};
    const p = sess.productsInView.find((x) => x.code === code);
    if (!p) {
      await safeEditOrSend(ctx, { text: "No encontré el producto. Volvé al catálogo.", extra: mainMenuKeyboard() });
      return;
    }

    const n = parseNumber(text, 0);
    if (!n || n <= 0) {
      sess.waiting = { type: "QTY", payload: { code, qtyType } };
      await safeEditOrSend(ctx, {
        text: `⚠️ Pasame un número válido.\n\n${qtyPromptText(cfg, p)}`,
        extra: Markup.inlineKeyboard(backMenuRows()),
      });
      return;
    }

    addToCart(sess, p, qtyType, n);
    await showCart(ctx);
    return;
  }

  if (w.type === "NAME") {
    sess.checkout.nombre = text.slice(0, 60);
    sess.waiting = { type: "PHONE", payload: w.payload || {} };
    await safeEditOrSend(ctx, {
      text: `📞 Perfecto, ${sess.checkout.nombre}.\n\nAhora tu <b>teléfono</b> (solo números):`,
      extra: Markup.inlineKeyboard(backMenuRows()),
    });
    return;
  }

  if (w.type === "PHONE") {
    const tel = text.replace(/[^\d+]/g, "").slice(0, 25);
    sess.checkout.telefono = tel;
    const isRetiro = !!(w.payload && w.payload.retiro);

    if (isRetiro) {
      await safeEditOrSend(ctx, { text: `✅ Listo.\n\nAhora elegí el método de pago 👇`, extra: payKeyboard(cfg) });
      return;
    }

    sess.waiting = { type: "ADDR", payload: {} };
    await safeEditOrSend(ctx, {
      text: `📍 Ahora la <b>dirección</b> completa (calle + altura + localidad):`,
      extra: Markup.inlineKeyboard(backMenuRows()),
    });
    return;
  }

  if (w.type === "ADDR") {
    sess.checkout.direccion = text.slice(0, 140);
    sess.waiting = { type: "NOTES", payload: {} };
    await safeEditOrSend(ctx, {
      text: `📝 ¿Alguna nota? (timbre / piso / entre calles). Si no, escribí <code>NO</code>.`,
      extra: Markup.inlineKeyboard(backMenuRows()),
    });
    return;
  }

  if (w.type === "NOTES") {
    const t = text.toLowerCase();
    sess.checkout.notas = (t === "no" || t === "n" || t === "0") ? "" : text.slice(0, 140);
    await safeEditOrSend(ctx, { text: `✅ Datos listos.\n\nAhora elegí el método de pago 👇`, extra: payKeyboard(cfg) });
    return;
  }
});

/* =========================================================
   WEB SERVER (Render)
========================================================= */
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.status(200).send("EzerBot OK ✅"));

async function start() {
  await ensureBaseSheets();
  await expireOldPending();

  // (B) limpiar pendientes cada 5 minutos (no en cada click)
  setInterval(() => {
    expireOldPending().catch(() => {});
  }, 5 * 60 * 1000);

  if (PUBLIC_URL && PUBLIC_URL.startsWith("http")) {
    const hook = `${PUBLIC_URL.replace(/\/$/, "")}/telegram`;
    await bot.telegram.setWebhook(hook);
    app.use(bot.webhookCallback("/telegram")); // POST /telegram
    app.listen(PORT, () => console.log(`✅ Webhook activo: ${hook} | Puerto ${PORT}`));
  } else {
    bot.launch();
    app.listen(PORT, () => console.log(`✅ Long-polling activo | Puerto ${PORT}`));
  }
}

start().catch((e) => {
  console.error("FATAL:", e?.message || e);
  process.exit(1);
});

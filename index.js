import express from "express";
import { Telegraf, Markup } from "telegraf";
import { google } from "googleapis";

/* ===== ENV (NO CAMBIO NOMBRES) ===== */
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_B64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim();
const BOT_LINK_ENV = (process.env.BOT_LINK || "").trim();

if (!TELEGRAM_BOT_TOKEN) throw new Error("Falta TELEGRAM_BOT_TOKEN");
if (!GOOGLE_SHEET_ID) throw new Error("Falta GOOGLE_SHEET_ID");
if (!GOOGLE_SERVICE_ACCOUNT_B64) throw new Error("Falta GOOGLE_SERVICE_ACCOUNT_B64");

/* ===== GOOGLE AUTH ===== */
function decodeServiceAccountB64(b64) {
  const raw = Buffer.from(String(b64 || ""), "base64").toString("utf8").trim();
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

/* ===== SHEETS HELPERS ===== */
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

/* ===== UTIL ===== */
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
  const num = Math.round(Number(n || 0));
  return `${moneda} ${num.toLocaleString("es-AR")}`;
}
function normalizeHeaders(headerRow) {
  const map = {};
  headerRow.forEach((h, i) => {
    const key = String(h || "")
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, "");
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
function nowISO() {
  return new Date().toISOString();
}
function buildOrderId(prefix = "TQ") {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${prefix}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function safeUpper(x) {
  return String(x || "").trim().toUpperCase();
}

/* ===== BASE SHEETS ===== */
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
  "ChatId",
  "Nombre",
  "Usuario",
  "Items",
  "Total",
  "EntregaTipo",
  "PagoTipo",
  "Estado",
  "RefBy",
  "VenceISO",
  "ComprobanteEnviado",
];

async function ensureBaseSheets() {
  await ensureSheet(CLIENTES_SHEET, CLIENTES_HEADERS);
  await ensureSheet(PEDIDOS_SHEET, PEDIDOS_HEADERS);
}

/* ===== CONFIG + CATALOGO ===== */
async function loadConfig() {
  const rows = await getSheetValues(`Config!A:B`);
  return kvFromRows(rows);
}

function normalizeUnit(u) {
  const s = String(u || "").trim().toLowerCase();
  if (!s) return "";
  if (s.includes("kg") || s.includes("kilo") || s.includes("gram")) return "KG";
  if (s.includes("uni") || s.includes("unidad") || s === "u") return "UN";
  return s.toUpperCase();
}

async function loadCatalog() {
  const rows = await getSheetValues(`Catalogo!A1:Z`);
  if (!rows.length) return { items: [], headers: {} };
  const headerRow = rows[0];
  const hmap = normalizeHeaders(headerRow);
  const data = rows.slice(1).filter((r) => r.some((c) => String(c || "").trim() !== ""));

  const items = data.map((r, i) => {
    const code = String(pick(r, hmap, ["codigo", "codigoproducto", "id", "sku"], "")).trim() || `P${i + 1}`;
    const name = String(pick(r, hmap, ["nombre", "producto", "name"], "Producto")).trim();
    const cat = String(pick(r, hmap, ["categoria", "rubro"], "General")).trim() || "General";
    const img = String(pick(r, hmap, ["imagenurl", "imagen", "foto", "urlimagen"], "")).trim();
    const desc = String(pick(r, hmap, ["descripcion", "detalle"], "")).trim();

    // precios:
    // - para UN: precio unitario (Precio/PrecioUnitario)
    // - para KG: precio por kg (PrecioPorKg/PrecioKg) si existe, si no usa Precio como por kg
    const precio = parseNumber(pick(r, hmap, ["precio", "preciounitario", "price"], 0), 0);
    const precioKg = parseNumber(pick(r, hmap, ["precioporkg", "preciokg", "precioxkg"], 0), 0);

    const unitRaw = pick(r, hmap, ["unidad", "unit", "tipo", "medida"], "");
    const unit = normalizeUnit(unitRaw);

    const isCombo = String(pick(r, hmap, ["combo", "escombo"], "")).trim();
    return { code, name, cat, img, desc, precio, precioKg, unit, isCombo };
  });

  return { items, headers: hmap };
}

function categoriesFromItems(items) {
  const set = new Set();
  for (const it of items) set.add(it.cat || "General");
  return Array.from(set).sort((a, b) => a.localeCompare(b, "es"));
}

/* ===== SESSION (chat limpio) ===== */
const SESS = new Map(); // chatId -> state
const ORDER_TIMERS = new Map(); // pedidoId -> timeout

function getSess(chatId) {
  if (!SESS.has(chatId)) {
    SESS.set(chatId, {
      mode: "MENU",
      category: null,
      productsInView: [],
      productIndex: 0,
      cart: [], // {code,name,unit,priceUnit,qty,qtyType,grams,units,subtotal}
      refBy: null,
      lastMessageId: null,
      awaitingQty: null, // {code}
      _entrega: null,
      _pago: null,
      _jumpProd: null,
      _pendingCancel: false,
    });
  }
  return SESS.get(chatId);
}

/* ===== CLIENTES ===== */
async function upsertCliente({ chatId, nombre, usuario, addSellos = 0, addTotal = 0, refBy = "" }) {
  const rows = await getSheetValues(`${CLIENTES_SHEET}!A2:H`);
  const idx = rows.findIndex((r) => String(r[0] || "") === String(chatId));

  if (idx === -1) {
    await appendRow(CLIENTES_SHEET, [
      String(chatId),
      nombre || "",
      usuario || "",
      addSellos,
      addTotal,
      nowISO(),
      refBy || "",
      0,
    ]);
    return { sellos: addSellos, referidosGanados: 0 };
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
    nowISO(),
    row[6] || refBy || "",
    currentRefGanados,
  ]]);

  return { sellos: newSellos, referidosGanados: currentRefGanados };
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
    nowISO(),
    row[6] || "",
    currentRefGanados + 1,
  ]]);
}

/* ===== PEDIDOS ===== */
async function findPedidoRow(pedidoId) {
  const rows = await getSheetValues(`${PEDIDOS_SHEET}!A2:M`);
  const idx = rows.findIndex((r) => String(r[0] || "") === String(pedidoId));
  if (idx === -1) return null;
  return { idx, rowNumber: idx + 2, row: rows[idx] };
}
async function setPedidoEstado(pedidoId, estado) {
  const found = await findPedidoRow(pedidoId);
  if (!found) return null;
  const { rowNumber, row } = found;
  row[9] = estado; // Estado (col J -> index 9)
  await setSheetValues(`${PEDIDOS_SHEET}!A${rowNumber}:M${rowNumber}`, [row]);
  return row;
}

/* ===== UI: EDITAR O ENVIAR ===== */
async function safeEditOrSend(ctx, payload) {
  const chatId = ctx.chat?.id;
  const sess = chatId ? getSess(chatId) : null;
  const canEdit = !!(sess?.lastMessageId);

  try {
    if (canEdit) {
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
  } catch {}

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

/* ===== SHARE ===== */
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
    [Markup.button.url("📲 WhatsApp", links.wa)],
    [Markup.button.url("✈️ Telegram", links.tg)],
    [Markup.button.callback("🏠 Menú", "GO_MENU")],
  ]);
}

/* ===== MENUS ===== */
function mainMenuKeyboard(cfg) {
  const rows = [];
  rows.push([Markup.button.callback("🧀 Catálogo", "MENU_CATALOGO")]);
  rows.push([Markup.button.callback("🎟️ Sellos", "MENU_SELLOS"), Markup.button.callback("ℹ️ Ayuda", "MENU_AYUDA")]);

  if (parseYes(cfg.CompartirBotActivo || "SI")) rows.push([Markup.button.callback("📣 Compartir", "MENU_COMPARTIR")]);
  else rows.push([Markup.button.callback("📣 Compartir", "MENU_COMPARTIR")]);

  return Markup.inlineKeyboard(rows);
}
function backMenuKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback("🏠 Menú", "GO_MENU")]]);
}

/* ===== TEXT BUILDERS ===== */
function greetingCaption(cfg) {
  const nombre = cfg.NegocioNombre || "Tu Negocio";
  const dire = cfg.NegocioDireccion || "";
  const hora = cfg.NegocioHorario || "";
  const estado = cfg.Estado || "";
  const desc = cfg.Descripcion || "";

  const lines = [];
  lines.push(`🏠 <b>${nombre}</b>`);
  if (estado) lines.push(`🟢 <b>${estado}</b>`);
  if (dire) lines.push(`📍 ${dire}`);
  if (hora) lines.push(`🕒 ${hora}`);
  if (desc) lines.push(`\n${desc}`);
  lines.push(`\nElegí una opción 👇`);
  return lines.join("\n");
}

function productCaption(cfg, p, index, total) {
  const moneda = cfg.Moneda || "ARS";
  const showPrice = parseYes(cfg.CatalogoMostrarPrecios || "SI");

  const unit = p.unit || "";
  let priceLine = "";
  if (showPrice) {
    if (unit === "KG") {
      const perKg = p.precioKg > 0 ? p.precioKg : p.precio;
      priceLine = `💰 <b>${money(perKg, moneda)}</b> <i>/ kg</i>`;
    } else {
      priceLine = `💰 <b>${money(p.precio, moneda)}</b> <i>/ unidad</i>`;
    }
  }

  const lines = [];
  lines.push(`<b>${p.name}</b>`);
  if (priceLine) lines.push(priceLine);
  if (p.desc) lines.push(`\n${p.desc}`);
  lines.push(`\n📌 ${p.cat}`);
  lines.push(`\n<code>${index + 1}/${total}</code>`);
  return lines.join("\n");
}

function productKeyboard(p) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⬅️", "PROD_PREV"), Markup.button.callback("➡️", "PROD_NEXT")],
    [Markup.button.callback("⚡ Quiero éste", `BUY_${p.code}`), Markup.button.callback("🔗 Compartir", `SHARE_PROD_${p.code}`)],
    [Markup.button.callback("🏠 Menú", "GO_MENU")],
  ]);
}

function cartText(cfg, cart) {
  const moneda = cfg.Moneda || "ARS";
  if (!cart.length) return `🛒 <b>Carrito</b>\n\nTu carrito está vacío.\n\nUsá <b>Catálogo</b> para elegir un producto.`;

  let total = 0;
  const lines = [];
  lines.push(`🧾 <b>Resumen de tu pedido</b>\n`);
  cart.forEach((it, i) => {
    total += it.subtotal;
    const qtyLabel = it.qtyType === "KG" ? `${it.grams} g` : `${it.units} u`;
    lines.push(`${i + 1}) <b>${it.name}</b>\n   ${qtyLabel} — <b>${money(it.subtotal, moneda)}</b>`);
  });
  lines.push(`\n<b>Total parcial:</b> ${money(total, moneda)}`);
  return lines.join("\n");
}

function cartKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Finalizar compra", "CHK_DELIVERY")],
    [Markup.button.callback("❌ Cancelar compra", "CANCEL_START")],
    [Markup.button.callback("🏠 Menú", "GO_MENU")],
  ]);
}

function deliveryKeyboard(cfg) {
  const rows = [];
  if (parseYes(cfg.UsaEnvíoDomicilio || cfg.UsaEnvioDomicilio || "SI")) rows.push([Markup.button.callback("🚚 Envío a domicilio", "DELIVERY_ENVIO")]);
  if (parseYes(cfg.EnvioExpress || "SI")) rows.push([Markup.button.callback("⚡ Envío express", "DELIVERY_EXPRESS")]);
  if (parseYes(cfg.UsaRetiroLocal || "SI")) rows.push([Markup.button.callback("🏪 Retiro en el local", "DELIVERY_RETIRO")]);
  rows.push([Markup.button.callback("⬅️ Volver", "GO_CART")]);
  return Markup.inlineKeyboard(rows);
}

function payKeyboard(cfg) {
  const rows = [];
  if (parseYes(cfg.PermitirPagoOnline || cfg.PermitePagoOnline || "SI")) {
    const tipo = safeUpper(cfg.TipoPagoOnline || "TRANSFERENCIA");
    rows.push([Markup.button.callback(`💳 ${tipo}`, `PAY_${tipo}`)]);
  }
  rows.push([Markup.button.callback("💵 Efectivo", "PAY_EFECTIVO")]);
  rows.push([Markup.button.callback("⬅️ Volver", "CHK_DELIVERY")]);
  return Markup.inlineKeyboard(rows);
}

function transferText(cfg) {
  const alias = (cfg.AliasTransferencia || "").trim();
  const cbu = (cfg.CBUPago || "").trim();
  const msg = (cfg.MensajeTransferencia || "").trim();

  const lines = [];
  lines.push(`💳 <b>Transferencia</b>`);
  if (alias) lines.push(`\n<b>Alias:</b> <code>${alias}</code>`);
  if (cbu) lines.push(`\n<b>CBU:</b> <code>${cbu}</code>`);
  if (msg) lines.push(`\n\n${msg}`);
  lines.push(`\n\n📎 Cuando transfieras, tocá <b>Enviar comprobante</b>.`);
  return lines.join("\n");
}

function sellosText(cfg, sellos) {
  const moneda = cfg.Moneda || "ARS";
  const montoPorSello = parseNumber(cfg.MontoPorSello || "10000", 10000);

  const usaNiveles = parseYes(cfg.UsaNiveles || "SI");
  const nombres = String(cfg.NombresNiveles || "").trim();
  const sellosPorNivel = String(cfg.SellosPorNivel || "").trim();
  const beneficios = String(cfg.BeneficiosPorNivel || "").trim();

  const lines = [];
  lines.push(`🎟️ <b>Sellos</b>\n`);
  lines.push(`Tenés <b>${sellos}</b> sello(s) acumulados.`);
  lines.push(`\n📌 Cada <b>${money(montoPorSello, moneda)}</b> = <b>1 sello</b>.`);

  const bonusShare = parseNumber(cfg.BonusSellosShare || "1", 1);
  lines.push(`\n🔗 Por compra desde un link que compartiste, ganás <b>${bonusShare}</b> sello(s) extra (si está activo).`);
  lines.push(`\n👥 Si alguien compra con tu link, vos ganás <b>1 sello</b> aunque compre poco.`);

  if (usaNiveles) {
    if (sellosPorNivel) lines.push(`\n🏅 <b>Sellos por nivel</b>\n${sellosPorNivel}`);
    if (beneficios) lines.push(`\n🎁 <b>Beneficios</b>\n${beneficios}`);
    if (nombres) lines.push(`\n✨ <b>Niveles</b>\n${nombres}`);
  }

  return lines.join("\n");
}

function helpText(cfg) {
  const nombre = cfg.NegocioNombre || "Todo Queso";
  const ig = (cfg.NegocioInstagram || "").trim();
  const tel = (cfg.NegocioTelefono || "").replace(/[^\d]/g, "");
  const waLink = (cfg.WhatsAppLink || (tel ? `https://wa.me/${tel}` : "")).trim();

  const lines = [];
  lines.push(`ℹ️ <b>Ayuda - ${nombre}</b>\n`);
  lines.push(`• ¿No encontrás un producto? Decime qué buscás y lo agregamos 🙌`);
  lines.push(`• ¿Querés sugerir algo o hacer un comentario? Te leo.`);
  lines.push(`• Si preferís hablar con un vendedor, tocá <b>Contactar</b>.`);

  const keyboard = Markup.inlineKeyboard([
    ...(waLink ? [[Markup.button.url("📲 Contactar por WhatsApp", waLink)]] : []),
    ...(ig ? [[Markup.button.url("📸 Instagram", ig.startsWith("http") ? ig : `https://instagram.com/${ig.replace("@", "")}`)]] : []),
    [Markup.button.callback("🏠 Menú", "GO_MENU")],
  ]);

  return { text: lines.join("\n"), keyboard };
}

/* ===== QTY CALC ===== */
function calcSubtotalForProduct(cfg, p, qtyType, qtyValue) {
  const moneda = cfg.Moneda || "ARS";
  if (qtyType === "KG") {
    const grams = Math.max(1, parseInt(qtyValue, 10) || 0);
    const perKg = p.precioKg > 0 ? p.precioKg : p.precio;
    const subtotal = (perKg * grams) / 1000;
    return { grams, units: 0, subtotal, label: `${grams} g`, perKg, moneda };
  } else {
    const units = Math.max(1, parseInt(qtyValue, 10) || 0);
    const subtotal = p.precio * units;
    return { grams: 0, units, subtotal, label: `${units} u`, perKg: 0, moneda };
  }
}

/* ===== CORE SCREENS ===== */
async function showMenu(ctx) {
  const cfg = await loadConfig();
  const logo = (cfg.LogoURL || "").trim();
  const caption = greetingCaption(cfg);

  if (logo && logo.startsWith("http")) {
    await safeEditOrSend(ctx, { photo: logo, caption, extra: mainMenuKeyboard(cfg) });
  } else {
    await safeEditOrSend(ctx, { text: caption, extra: mainMenuKeyboard(cfg) });
  }
}

async function showCategories(ctx) {
  const cfg = await loadConfig();
  const { items } = await loadCatalog();

  if (!parseYes(cfg.CatalogoActivo || "SI")) {
    await safeEditOrSend(ctx, { text: "🧀 El catálogo está momentáneamente desactivado.", extra: backMenuKeyboard() });
    return;
  }

  const cats = categoriesFromItems(items);
  if (!cats.length) {
    await safeEditOrSend(ctx, { text: "🧀 Catálogo vacío. Cargá productos en la hoja <b>Catalogo</b>.", extra: backMenuKeyboard() });
    return;
  }

  const buttons = [];
  for (let i = 0; i < cats.length; i += 2) {
    const row = [];
    row.push(Markup.button.callback(`📁 ${cats[i]}`, `CAT_${encodeURIComponent(cats[i])}`));
    if (cats[i + 1]) row.push(Markup.button.callback(`📁 ${cats[i + 1]}`, `CAT_${encodeURIComponent(cats[i + 1])}`));
    buttons.push(row);
  }
  buttons.push([Markup.button.callback("🏠 Menú", "GO_MENU")]);

  await safeEditOrSend(ctx, {
    text: `🧀 <b>Catálogo</b>\n\nElegí una <b>categoría</b> 👇`,
    extra: Markup.inlineKeyboard(buttons),
  });
}

async function showProductCarousel(ctx, cat) {
  const cfg = await loadConfig();
  const chatId = ctx.chat.id;
  const sess = getSess(chatId);

  const { items } = await loadCatalog();
  const prods = items.filter((p) => (p.cat || "General") === cat);

  if (!prods.length) {
    await safeEditOrSend(ctx, { text: `No hay productos en <b>${cat}</b>.`, extra: backMenuKeyboard() });
    return;
  }

  sess.mode = "CATALOGO";
  sess.category = cat;
  sess.productsInView = prods;
  sess.productIndex = 0;

  const p = prods[0];
  const caption = productCaption(cfg, p, 0, prods.length);

  const photo = p.img && p.img.startsWith("http") ? p.img : undefined;
  if (photo) await safeEditOrSend(ctx, { photo, caption, extra: productKeyboard(p) });
  else await safeEditOrSend(ctx, { text: caption, extra: productKeyboard(p) });
}

async function showCart(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  await safeEditOrSend(ctx, {
    text: cartText(cfg, sess.cart),
    extra: cartKeyboard(),
  });
}

async function showDelivery(ctx) {
  const cfg = await loadConfig();
  await safeEditOrSend(ctx, {
    text: `🚚 <b>Entrega</b>\n\nElegí cómo querés recibir tu pedido 👇`,
    extra: deliveryKeyboard(cfg),
  });
}

async function showPayment(ctx, entregaTipo) {
  const cfg = await loadConfig();
  const moneda = cfg.Moneda || "ARS";
  const costoEnvio = parseNumber(cfg.CostoEnvio || "0", 0);

  let extraText = "";
  if (entregaTipo === "ENVIO") {
    extraText = `\n\n🚚 Costo de envío: <b>${money(costoEnvio, moneda)}</b>\n${(cfg.TextoEnvíoDomicilio || cfg.TextoEnvioDomicilio || "").trim()}`;
  } else if (entregaTipo === "EXPRESS") {
    extraText = `\n\n⚡ Envío express: se entrega lo más pronto posible.\n${(cfg.TextoEnvíoDomicilio || cfg.TextoEnvioDomicilio || "").trim()}`;
  } else {
    extraText = `\n\n🏪 ${(cfg.TextoRetiroLocal || "").trim()}`;
  }

  await safeEditOrSend(ctx, {
    text: `💳 <b>Pago</b>\n\nElegí cómo vas a pagar 👇${extraText}`,
    extra: payKeyboard(cfg),
  });
}

function buildPOSTicket(cfg, pedidoId, sess, entregaTipo, pagoTipo, totalFinal) {
  const moneda = cfg.Moneda || "ARS";
  const nombre = cfg.NegocioNombre || "Todo Queso";
  const dire = (cfg.NegocioDireccion || "").trim();
  const hora = (cfg.NegocioHorario || "").trim();

  const lines = [];
  lines.push(`🧾 <b>${nombre}</b>`);
  if (dire) lines.push(`📍 ${dire}`);
  if (hora) lines.push(`🕒 ${hora}`);
  lines.push(`\n<b>Pedido:</b> <code>${pedidoId}</code>`);
  lines.push(`\n<b>Detalle</b>`);
  sess.cart.forEach((it) => {
    const qtyLabel = it.qtyType === "KG" ? `${it.grams} g` : `${it.units} u`;
    lines.push(`• ${it.name} — ${qtyLabel} — <b>${money(it.subtotal, moneda)}</b>`);
  });

  lines.push(`\n<b>Entrega:</b> ${entregaTipo}`);
  lines.push(`<b>Pago:</b> ${pagoTipo}`);
  lines.push(`\n<b>Total:</b> <b>${money(totalFinal, moneda)}</b>`);
  return lines.join("\n");
}

/* ===== CANCEL FLOW ===== */
async function cancelStart(ctx) {
  const sess = getSess(ctx.chat.id);
  sess._pendingCancel = true;
  await safeEditOrSend(ctx, {
    text: `❌ <b>Cancelar compra</b>\n\n¿Confirmás que querés cancelar?\n\n(Se vacía tu carrito)`,
    extra: Markup.inlineKeyboard([
      [Markup.button.callback("✅ Confirmar cancelación", "CANCEL_CONFIRM")],
      [Markup.button.callback("⬅️ Volver", "GO_CART")],
      [Markup.button.callback("🏠 Menú", "GO_MENU")],
    ]),
  });
}

async function cancelConfirm(ctx) {
  const sess = getSess(ctx.chat.id);
  sess.cart = [];
  sess._pendingCancel = false;
  sess._entrega = null;
  sess._pago = null;
  await safeEditOrSend(ctx, {
    text: `Listo ✅ Cancelé tu compra y vacié el carrito.`,
    extra: Markup.inlineKeyboard([
      [Markup.button.callback("🧀 Volver al Catálogo", "MENU_CATALOGO")],
      [Markup.button.callback("🏠 Menú", "GO_MENU")],
    ]),
  });
}

/* ===== FINALIZE ORDER ===== */
async function scheduleAutoCancel(bot, pedidoId, clientChatId, venceISO) {
  const ms = Math.max(0, new Date(venceISO).getTime() - Date.now());
  if (ORDER_TIMERS.has(pedidoId)) clearTimeout(ORDER_TIMERS.get(pedidoId));

  const t = setTimeout(async () => {
    const found = await findPedidoRow(pedidoId);
    if (!found) return;
    const estado = String(found.row[9] || "").trim();
    if (estado !== "PENDIENTE_PAGO") return;

    await setPedidoEstado(pedidoId, "CANCELADO_AUTO");

    try {
      await bot.telegram.sendMessage(
        Number(clientChatId),
        `⏳ Tu pedido <code>${pedidoId}</code> venció (no se confirmó el pago dentro de 1 hora) y fue cancelado.\n\nSi querés, podés volver a comprar desde el catálogo.`,
        { parse_mode: "HTML", reply_markup: mainMenuKeyboard(await loadConfig()).reply_markup }
      );
    } catch {}

  }, ms);

  ORDER_TIMERS.set(pedidoId, t);
}

async function finalizeOrder(ctx, { entregaTipo, pagoTipo }) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);

  if (!sess.cart.length) {
    await safeEditOrSend(ctx, { text: "Tu carrito está vacío.", extra: backMenuKeyboard() });
    return;
  }

  const moneda = cfg.Moneda || "ARS";
  const costoEnvio = parseNumber(cfg.CostoEnvio || "0", 0);
  let total = 0;
  const itemsText = sess.cart
    .map((it) => {
      total += it.subtotal;
      const qtyLabel = it.qtyType === "KG" ? `${it.grams}g` : `${it.units}u`;
      return `${it.name} ${qtyLabel} (${money(it.subtotal, moneda)})`;
    })
    .join(" | ");

  if (entregaTipo === "ENVIO" || entregaTipo === "EXPRESS") total += costoEnvio;

  const usaSellos = parseYes(cfg.UsaSellos || "SI");
  const montoPorSello = parseNumber(cfg.MontoPorSello || "10000", 10000);
  const sellosGanados = usaSellos ? Math.floor(total / montoPorSello) : 0;

  const nombre = `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim();
  const usuario = ctx.from.username ? `@${ctx.from.username}` : "";

  await upsertCliente({
    chatId: ctx.chat.id,
    nombre,
    usuario,
    addSellos: sellosGanados,
    addTotal: total,
    refBy: sess.refBy ? String(sess.refBy) : "",
  });

  const pedidoId = buildOrderId(cfg.PrefijoCodigoCanje || "TQ");
  const vence = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hora

  await appendRow(PEDIDOS_SHEET, [
    pedidoId,
    nowISO(),
    String(ctx.chat.id),
    nombre,
    usuario,
    itemsText,
    total,
    entregaTipo,
    pagoTipo,
    "PENDIENTE_PAGO",
    sess.refBy ? String(sess.refBy) : "",
    vence,
    "NO",
  ]);

  if (sess.refBy) {
    await addSelloReferido(sess.refBy);
  }

  const ticket = buildPOSTicket(cfg, pedidoId, sess, entregaTipo, pagoTipo, total);

  const alias = (cfg.AliasTransferencia || "").trim();
  const tel = (cfg.NegocioTelefono || "").replace(/[^\d]/g, "");
  const wa = (cfg.WhatsAppLink || (tel ? `https://wa.me/${tel}` : "")).trim();

  const enviarCompText = cfg.MensajeTransferencia && cfg.MensajeTransferencia.trim()
    ? cfg.MensajeTransferencia.trim()
    : "Enviá el comprobante y el vendedor confirmará el pago para preparar tu pedido.";

  const buttons = [];

  if (safeUpper(pagoTipo).includes("TRANS")) {
    const waText = encodeURIComponent(
      `Hola! Envío comprobante del pedido ${pedidoId}.\n\n${ticket.replace(/<[^>]+>/g, "")}`
    );
    const waSend = wa
      ? (wa.includes("wa.me") ? `${wa}${wa.includes("?") ? "&" : "?"}text=${waText}` : `https://wa.me/?text=${waText}`)
      : `https://wa.me/?text=${waText}`;

    buttons.push([Markup.button.url("📎 Enviar comprobante por WhatsApp", waSend)]);
  }

  buttons.push([Markup.button.callback("🏠 Menú", "GO_MENU")]);

  const msg = [
    ticket,
    `\n\n⏳ <b>Importante:</b> tu pedido queda <b>pendiente de preparación</b> hasta que el vendedor confirme el pago.`,
    `\n🕐 Se guarda por <b>1 hora</b>. Si no se confirma, se cancela automáticamente.`,
    ...(safeUpper(pagoTipo).includes("TRANS") ? [`\n\n${transferText(cfg)}`] : []),
    ...(sellosGanados > 0 ? [`\n🎟️ Sumaste <b>${sellosGanados}</b> sello(s).`] : []),
    ...(sess.refBy ? [`\n🎁 Compra por referido: tu referente gana <b>1 sello</b>.`] : []),
    `\n\n${enviarCompText}`,
  ].join("\n");

  await safeEditOrSend(ctx, { text: msg, extra: Markup.inlineKeyboard(buttons) });

  // aviso al vendedor por el bot (con botones confirmar/cancelar)
  const vendedorId = parseNumber(cfg.VendedorChatId || cfg.ChatIdVendedor || "", 0);
  const textoAviso = (cfg.TextoAvisoVendedor || "").trim();
  if (vendedorId) {
    const vendorMsg = [
      `🧾 <b>NUEVO PEDIDO</b>`,
      `\n<b>ID:</b> <code>${pedidoId}</code>`,
      `\n<b>Cliente:</b> ${nombre} ${usuario ? `(${usuario})` : ""}`,
      `\n<b>Entrega:</b> ${entregaTipo}`,
      `\n<b>Pago:</b> ${pagoTipo}`,
      `\n<b>Total:</b> <b>${money(total, cfg.Moneda || "ARS")}</b>`,
      `\n\n<b>Detalle:</b>\n${itemsText}`,
      textoAviso ? `\n\n${textoAviso}` : "",
      `\n\n⏳ Vence: ${vence}`,
    ].join("");

    try {
      await bot.telegram.sendMessage(vendedorId, vendorMsg, {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("✅ Confirmar pago", `VCONF_${pedidoId}_${ctx.chat.id}`)],
          [Markup.button.callback("❌ Cancelar", `VCAN_${pedidoId}_${ctx.chat.id}`)],
        ]).reply_markup,
      });
    } catch {}
  }

  // auto-cancel 1h si no confirma
  await scheduleAutoCancel(bot, pedidoId, ctx.chat.id, vence);

  // limpiar carrito (para que no quede eterno)
  sess.cart = [];
  sess._entrega = null;
  sess._pago = null;
  sess.mode = "MENU";
}

/* ===== SELL0S / HELP / SHARE ===== */
async function showSellos(ctx) {
  const cfg = await loadConfig();
  const rows = await getSheetValues(`${CLIENTES_SHEET}!A2:H`);
  const me = rows.find((r) => String(r[0] || "") === String(ctx.chat.id));
  const sellos = me ? parseNumber(me[3], 0) : 0;

  const img = (cfg.CARD_URL || cfg.CARD_URL || cfg.SelloURL || cfg.SelloURL || "").trim();
  const caption = sellosText(cfg, sellos);

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("🧀 Catálogo", "MENU_CATALOGO")],
    [Markup.button.callback("🏠 Menú", "GO_MENU")],
  ]);

  if (img && img.startsWith("http")) {
    await safeEditOrSend(ctx, { photo: img, caption, extra: keyboard });
  } else {
    await safeEditOrSend(ctx, { text: caption, extra: keyboard });
  }
}

async function showHelp(ctx) {
  const cfg = await loadConfig();
  const h = helpText(cfg);
  await safeEditOrSend(ctx, { text: h.text, extra: h.keyboard });
}

async function showShareBot(ctx) {
  const cfg = await loadConfig();
  const botLink = BOT_LINK_ENV || cfg.BotLink || "";
  if (!botLink) {
    await safeEditOrSend(ctx, { text: "Falta <b>BotLink</b> en Config para compartir.", extra: backMenuKeyboard() });
    return;
  }
  const txt = (cfg.TextoCompartirBot || "").trim() || `🧀 Comprá en ${cfg.NegocioNombre || "Todo Queso"} desde este bot:`;
  const links = buildShareLinks({ botLink, text: txt });

  const email = (cfg.EmailSistema || "").trim();
  const textoSistema = (cfg.TextoSistema || "").trim();
  const extra = (email || textoSistema)
    ? `\n\n💡 ¿Querés un sistema igual?\n${textoSistema || ""}\n📩 ${email || ""}`.trim()
    : "";

  await safeEditOrSend(ctx, {
    text: `📣 <b>Compartir bot</b>\n\nElegí dónde compartir 👇${extra ? `\n${extra}` : ""}`,
    extra: shareKeyboard(links),
  });
}

async function showShareProduct(ctx, productCode) {
  const cfg = await loadConfig();
  const botLink = BOT_LINK_ENV || cfg.BotLink || "";
  const { items } = await loadCatalog();
  const p = items.find((x) => x.code === productCode);
  if (!p) {
    await safeEditOrSend(ctx, { text: "No encontré ese producto.", extra: backMenuKeyboard() });
    return;
  }
  if (!botLink) {
    await safeEditOrSend(ctx, { text: "Falta <b>BotLink</b> en Config para compartir.", extra: backMenuKeyboard() });
    return;
  }

  const ref = ctx.chat.id;
  const deepLink = `${botLink}${botLink.includes("?") ? "&" : "?"}start=ref_${ref}__prod_${encodeURIComponent(p.code)}`;

  const moneda = cfg.Moneda || "ARS";
  const priceTxt = p.unit === "KG"
    ? `${money(p.precioKg > 0 ? p.precioKg : p.precio, moneda)} / kg`
    : `${money(p.precio, moneda)} / unidad`;

  const txt = `🧀 ${cfg.NegocioNombre || "Todo Queso"}\n⚡ ${p.name}\n💰 ${priceTxt}\n\nTocá el link para verlo y comprar 👇`;
  const links = buildShareLinks({ botLink: deepLink, text: txt });

  await safeEditOrSend(ctx, {
    text: `🔗 <b>Compartir producto</b>\n\nElegí dónde compartir 👇`,
    extra: shareKeyboard(links),
  });
}

/* ===== QTY ASK ===== */
async function askQuantity(ctx, p) {
  const sess = getSess(ctx.chat.id);
  sess.awaitingQty = { code: p.code };

  if (p.unit === "KG") {
    await safeEditOrSend(ctx, {
      text: `⚡ <b>${p.name}</b>\n\n¿Cuántos <b>gramos</b> querés?\nEj: 100, 250, 500`,
      extra: Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Volver", "MENU_CATALOGO")],
        [Markup.button.callback("🏠 Menú", "GO_MENU")],
      ]),
    });
  } else {
    await safeEditOrSend(ctx, {
      text: `⚡ <b>${p.name}</b>\n\n¿Cuántas <b>unidades</b> querés?\nEj: 1, 2, 3`,
      extra: Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Volver", "MENU_CATALOGO")],
        [Markup.button.callback("🏠 Menú", "GO_MENU")],
      ]),
    });
  }
}

/* ===== BOT ===== */
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

bot.start(async (ctx) => {
  await ensureBaseSheets();
  const sess = getSess(ctx.chat.id);

  const payload = (ctx.startPayload || "").trim();
  if (payload) {
    const mRef = payload.match(/ref_(\d+)/);
    if (mRef) sess.refBy = Number(mRef[1]);
    const mProd = payload.match(/prod_([^_]+)/);
    if (mProd) sess._jumpProd = decodeURIComponent(mProd[1]);
  }

  await showMenu(ctx);

  if (sess._jumpProd) {
    const code = sess._jumpProd;
    delete sess._jumpProd;

    const { items } = await loadCatalog();
    const p = items.find((x) => x.code === code);
    if (p) {
      await showProductCarousel(ctx, p.cat || "General");
      const s2 = getSess(ctx.chat.id);
      const idx = s2.productsInView.findIndex((x) => x.code === code);
      if (idx >= 0) {
        s2.productIndex = idx;
        const cfg = await loadConfig();
        const caption = productCaption(cfg, s2.productsInView[idx], idx, s2.productsInView.length);
        const photo = s2.productsInView[idx].img && s2.productsInView[idx].img.startsWith("http") ? s2.productsInView[idx].img : undefined;
        if (photo) await safeEditOrSend(ctx, { photo, caption, extra: productKeyboard(s2.productsInView[idx]) });
        else await safeEditOrSend(ctx, { text: caption, extra: productKeyboard(s2.productsInView[idx]) });
      }
    }
  }
});

/* Quick hears */
bot.hears(/^(menu|menú)$/i, showMenu);
bot.hears(/^cat[aá]logo$/i, showCategories);
bot.hears(/^sellos$/i, showSellos);
bot.hears(/^ayuda$/i, showHelp);

/* Actions */
bot.action("GO_MENU", async (ctx) => { await ctx.answerCbQuery(); await showMenu(ctx); });
bot.action("MENU_CATALOGO", async (ctx) => { await ctx.answerCbQuery(); await showCategories(ctx); });
bot.action("MENU_SELLOS", async (ctx) => { await ctx.answerCbQuery(); await showSellos(ctx); });
bot.action("MENU_AYUDA", async (ctx) => { await ctx.answerCbQuery(); await showHelp(ctx); });
bot.action("MENU_COMPARTIR", async (ctx) => { await ctx.answerCbQuery(); await showShareBot(ctx); });

bot.action(/^CAT_(.+)$/i, async (ctx) => {
  await ctx.answerCbQuery();
  const cat = decodeURIComponent(ctx.match[1]);
  await showProductCarousel(ctx, cat);
});

bot.action("PROD_NEXT", async (ctx) => {
  await ctx.answerCbQuery();
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  if (!sess.productsInView.length) return;

  sess.productIndex = (sess.productIndex + 1) % sess.productsInView.length;
  const p = sess.productsInView[sess.productIndex];

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

  const caption = productCaption(cfg, p, sess.productIndex, sess.productsInView.length);
  const photo = p.img && p.img.startsWith("http") ? p.img : undefined;
  if (photo) await safeEditOrSend(ctx, { photo, caption, extra: productKeyboard(p) });
  else await safeEditOrSend(ctx, { text: caption, extra: productKeyboard(p) });
});

bot.action(/^BUY_(.+)$/i, async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  const code = ctx.match[1];
  const p = sess.productsInView.find((x) => x.code === code);
  if (!p) return;
  await askQuantity(ctx, p);
});

bot.action(/^SHARE_PROD_(.+)$/i, async (ctx) => {
  await ctx.answerCbQuery();
  const code = ctx.match[1];
  await showShareProduct(ctx, code);
});

bot.action("GO_CART", async (ctx) => {
  await ctx.answerCbQuery();
  await showCart(ctx);
});

/* Cancel buttons */
bot.action("CANCEL_START", async (ctx) => { await ctx.answerCbQuery(); await cancelStart(ctx); });
bot.action("CANCEL_CONFIRM", async (ctx) => { await ctx.answerCbQuery(); await cancelConfirm(ctx); });

/* Delivery / Payment */
bot.action("CHK_DELIVERY", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  if (!sess.cart.length) return showCart(ctx);
  await showDelivery(ctx);
});
bot.action("DELIVERY_ENVIO", async (ctx) => { await ctx.answerCbQuery(); const sess = getSess(ctx.chat.id); sess._entrega = "ENVIO"; await showPayment(ctx, "ENVIO"); });
bot.action("DELIVERY_RETIRO", async (ctx) => { await ctx.answerCbQuery(); const sess = getSess(ctx.chat.id); sess._entrega = "RETIRO"; await showPayment(ctx, "RETIRO"); });
bot.action("DELIVERY_EXPRESS", async (ctx) => { await ctx.answerCbQuery(); const sess = getSess(ctx.chat.id); sess._entrega = "EXPRESS"; await showPayment(ctx, "EXPRESS"); });

bot.action(/^PAY_(.+)$/i, async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  const pagoTipo = ctx.match[1] || "TRANSFERENCIA";
  const entregaTipo = sess._entrega || "RETIRO";
  await finalizeOrder(ctx, { entregaTipo, pagoTipo });
});
bot.action("PAY_EFECTIVO", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  const entregaTipo = sess._entrega || "RETIRO";
  await finalizeOrder(ctx, { entregaTipo, pagoTipo: "EFECTIVO" });
});

/* Vendor confirms */
bot.action(/^VCONF_(.+)_(.+)$/i, async (ctx) => {
  await ctx.answerCbQuery("Confirmado ✅");
  const pedidoId = ctx.match[1];
  const clientChatId = ctx.match[2];

  const cfg = await loadConfig();
  const row = await setPedidoEstado(pedidoId, "CONFIRMADO");
  if (!row) return;

  const texto = (cfg.TextoConfirmacionPedido || "").trim() || "✅ Pago confirmado. Ya estamos preparando tu pedido.";
  try {
    await bot.telegram.sendMessage(Number(clientChatId), `${texto}\n\n🧾 Pedido: <code>${pedidoId}</code>`, { parse_mode: "HTML" });
  } catch {}

  // cancelar timer
  if (ORDER_TIMERS.has(pedidoId)) {
    clearTimeout(ORDER_TIMERS.get(pedidoId));
    ORDER_TIMERS.delete(pedidoId);
  }
});

bot.action(/^VCAN_(.+)_(.+)$/i, async (ctx) => {
  await ctx.answerCbQuery("Cancelado ❌");
  const pedidoId = ctx.match[1];
  const clientChatId = ctx.match[2];

  await setPedidoEstado(pedidoId, "CANCELADO_VENDEDOR");
  try {
    await bot.telegram.sendMessage(Number(clientChatId), `❌ El pedido <code>${pedidoId}</code> fue cancelado por el vendedor.\n\nPodés volver a comprar desde el catálogo.`, { parse_mode: "HTML" });
  } catch {}

  if (ORDER_TIMERS.has(pedidoId)) {
    clearTimeout(ORDER_TIMERS.get(pedidoId));
    ORDER_TIMERS.delete(pedidoId);
  }
});

/* Qty input (grams / units) */
bot.on("text", async (ctx) => {
  const sess = getSess(ctx.chat.id);
  if (!sess.awaitingQty) return;

  const qtyRaw = String(ctx.message.text || "").trim();
  const qty = parseInt(qtyRaw.replace(/[^\d]/g, ""), 10);
  if (!qty || qty <= 0) {
    await ctx.reply("Poné un número válido 🙂");
    return;
  }

  const cfg = await loadConfig();
  const { items } = await loadCatalog();
  const p = items.find((x) => x.code === sess.awaitingQty.code);

  if (!p) {
    sess.awaitingQty = null;
    await ctx.reply("No encontré ese producto. Volvé al catálogo.");
    return;
  }

  const qtyType = p.unit === "KG" ? "KG" : "UN";
  const calc = calcSubtotalForProduct(cfg, p, qtyType, qty);

  const cartItem = {
    code: p.code,
    name: p.name,
    qtyType,
    grams: calc.grams,
    units: calc.units,
    subtotal: calc.subtotal,
  };
  sess.cart = [cartItem]; // “Quiero éste” => compra directa de ese producto
  sess.awaitingQty = null;

  await showCart(ctx);
});

/* ===== WEB SERVER (Render) ===== */
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.status(200).send("EzerBot OK ✅"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

const PORT = process.env.PORT || 10000;

async function start() {
  await ensureBaseSheets();

  if (PUBLIC_URL && PUBLIC_URL.startsWith("http")) {
    const hook = `${PUBLIC_URL.replace(/\/$/, "")}/telegram`;
    await bot.telegram.setWebhook(hook);
    app.use(bot.webhookCallback("/telegram"));
    app.listen(PORT, () => console.log(`✅ Webhook activo: ${hook} | Puerto ${PORT}`));
  } else {
    bot.launch();
    app.listen(PORT, () => console.log(`✅ Long-polling | Puerto ${PORT}`));
  }
}

start().catch((e) => {
  console.error("FATAL:", e?.message || e);
  process.exit(1);
});

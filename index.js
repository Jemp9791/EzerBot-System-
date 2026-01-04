import express from "express";
import { Telegraf, Markup } from "telegraf";
import { google } from "googleapis";

/* =========================
   ENV (NO CAMBIAR NOMBRES)
========================= */
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN; // fallback sin romperte
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_B64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
const PUBLIC_URL = process.env.PUBLIC_URL || ""; // opcional
const PORT = process.env.PORT || 10000;

if (!BOT_TOKEN) throw new Error("Falta ENV BOT_TOKEN");
if (!GOOGLE_SHEET_ID) throw new Error("Falta ENV GOOGLE_SHEET_ID");
if (!GOOGLE_SERVICE_ACCOUNT_B64) throw new Error("Falta ENV GOOGLE_SERVICE_ACCOUNT_B64");

/* =========================
   GOOGLE AUTH
========================= */
function decodeServiceAccountB64(b64) {
  const raw = Buffer.from(b64, "base64").toString("utf8").trim();
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_B64 decodifica pero NO es JSON válido.");
  }
}
const sa = decodeServiceAccountB64(GOOGLE_SERVICE_ACCOUNT_B64);

const auth = new google.auth.JWT({
  email: sa.client_email,
  key: sa.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

/* =========================
   SHEETS HELPERS
========================= */
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

/* =========================
   UTIL
========================= */
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

function nowISO() {
  return new Date().toISOString();
}

function splitVariants(str) {
  const parts = String(str || "")
    .split("||")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts;
}

/** template simple {VAR} */
function applyTpl(text, vars = {}) {
  let out = String(text || "");
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{${k}}`, String(v ?? ""));
  }
  return out;
}

/* =========================
   CONFIG (TUS KEYS)
========================= */
async function loadConfig() {
  const rows = await getSheetValues(`Config!A:B`);
  return kvFromRows(rows);
}

/* =========================
   CATALOGO
   Recomendación: en hoja Catalogo tener:
   - codigo, nombre, precio, categoria, imagenURL, descripcion
   - unidad (ej: "UNIDAD" o "PESO_KG" o "PESO_100G" o "por peso")
   - precioporkg (opcional si querés exacto)
========================= */
function normalizeHeaders(headerRow) {
  const map = {};
  headerRow.forEach((h, i) => {
    const key = String(h || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/á/g, "a")
      .replace(/é/g, "e")
      .replace(/í/g, "i")
      .replace(/ó/g, "o")
      .replace(/ú/g, "u")
      .replace(/ü/g, "u")
      .replace(/ñ/g, "n");
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

function detectUnitType(uRaw) {
  const u = String(uRaw || "").trim().toUpperCase();
  if (!u) return "UNIDAD";
  if (u.includes("PESO_100G")) return "PESO_100G";
  if (u.includes("PESO_KG")) return "PESO_KG";
  if (u.includes("PESO")) return "PESO_KG"; // default seguro
  if (u.includes("GRAM")) return "PESO_KG";
  if (u.includes("KG")) return "PESO_KG";
  return "UNIDAD";
}

async function loadCatalog() {
  const rows = await getSheetValues(`Catalogo!A1:Z`);
  if (!rows.length) return { items: [], headers: {} };
  const hmap = normalizeHeaders(rows[0]);
  const data = rows.slice(1).filter((r) => r.some((c) => String(c || "").trim() !== ""));

  const items = data.map((r, i) => {
    let code = String(pick(r, hmap, ["codigo", "codigoproducto", "id", "sku"], "")).trim();
    const name = String(pick(r, hmap, ["nombre", "producto", "name"], "Producto")).trim();
    const price = parseNumber(pick(r, hmap, ["precio", "price"], 0), 0);
    const cat = String(pick(r, hmap, ["categoria", "categoria", "rubro"], "General")).trim() || "General";
    const img = String(pick(r, hmap, ["imagenurl", "imagen", "foto", "urlimagen"], "")).trim();
    const desc = String(pick(r, hmap, ["descripcion", "descripcion", "detalle"], "")).trim();
    const unidadRaw = pick(r, hmap, ["unidad", "tipounidad", "tipo", "unidadventa"], "");
    const unitType = detectUnitType(unidadRaw);

    // precio por kg:
    // - si hay columna "precioporkg" -> úsala
    // - si no, si PESO_100G -> precio*10
    // - si no, PESO_KG -> precio (asumimos precio por kg)
    const pricePerKgCol = parseNumber(pick(r, hmap, ["precioporkg", "precioxkg", "precio_kg"], 0), 0);
    let pricePerKg = 0;
    if (pricePerKgCol > 0) pricePerKg = pricePerKgCol;
    else {
      if (unitType === "PESO_100G") pricePerKg = price * 10;
      else if (unitType === "PESO_KG") pricePerKg = price;
      else pricePerKg = 0;
    }

    if (!code) code = `P${i + 1}`;
    return { code, name, price, pricePerKg, cat, img, desc, unitType, unidadRaw: String(unidadRaw || "") };
  });

  return { items, headers: hmap };
}

function categoriesFromItems(items) {
  const set = new Set();
  for (const it of items) set.add(it.cat || "General");
  return Array.from(set).sort((a, b) => a.localeCompare(b, "es"));
}

/* =========================
   SHEETS BASE
========================= */
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
  "CanalComprobante",
];

async function ensureBaseSheets() {
  await ensureSheet(CLIENTES_SHEET, CLIENTES_HEADERS);
  await ensureSheet(PEDIDOS_SHEET, PEDIDOS_HEADERS);
}

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

/* =========================
   STATE (chat limpio)
========================= */
const SESS = new Map(); // chatId -> state

function getSess(chatId) {
  if (!SESS.has(chatId)) {
    SESS.set(chatId, {
      mode: "MENU",
      category: null,
      productIndex: 0,
      productsInView: [],
      cart: [], // items
      refBy: null,
      lastMessageId: null,

      waitingQty: false,
      waitingForCode: null,
      waitingAction: null, // "ADD" | "BUY"
      entregaTipo: null,
      pagoTipo: null,

      pendingConfirm: null, // { entregaTipo, pagoTipo, total, itemsText, sellosGanados }
      _jumpProd: null,
    });
  }
  return SESS.get(chatId);
}

function cartTTLms() {
  return 60 * 60 * 1000; // 1 hora
}
function touchCart(sess) {
  sess.cartUpdatedAt = Date.now();
}
function isCartExpired(sess) {
  if (!sess.cartUpdatedAt) return false;
  return Date.now() - sess.cartUpdatedAt > cartTTLms();
}
function clearCart(sess) {
  sess.cart = [];
  sess.entregaTipo = null;
  sess.pagoTipo = null;
  sess.pendingConfirm = null;
  sess.waitingQty = false;
  sess.waitingForCode = null;
  sess.waitingAction = null;
  touchCart(sess);
}

/* =========================
   UI: editar o enviar 1 solo mensaje
========================= */
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
  } catch {
    // si falla, manda nuevo
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

/* =========================
   MENUS
========================= */
function mainMenuKeyboard(cfg) {
  const rows = [
    [Markup.button.callback("🧀 Catálogo", "MENU_CATALOGO")],
    [Markup.button.callback("🎟️ Sellos", "MENU_SELLOS"), Markup.button.callback("ℹ️ Ayuda", "MENU_AYUDA")],
  ];
  if (parseYes(cfg.CompartirBotActivo || "SI")) rows.push([Markup.button.callback("📣 Compartir", "MENU_COMPARTIR")]);
  return Markup.inlineKeyboard(rows);
}

function backMenuKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback("🏠 Menú", "GO_MENU")]]);
}

/* =========================
   PRODUCT UI
========================= */
function productCaption(cfg, p, index, total) {
  const moneda = cfg.Moneda || "ARS";
  const showPrice = parseYes(cfg.CatalogoMostrarPrecios || "SI");

  const unitLine =
    p.unitType === "UNIDAD"
      ? "Unidad: por unidad"
      : "Unidad: por peso (gramos/kg)";

  const lines = [];
  lines.push(`<b>${p.name}</b>`);
  if (showPrice) {
    if (p.unitType === "UNIDAD") lines.push(`💰 <b>${money(p.price, moneda)}</b>`);
    else {
      const kgPrice = p.pricePerKg > 0 ? p.pricePerKg : p.price;
      lines.push(`💰 <b>${money(kgPrice, moneda)}</b> <i>(por kg)</i>`);
    }
  }
  lines.push(`📦 ${unitLine}`);
  if (p.desc) lines.push(`\n${p.desc}`);
  lines.push(`\n📌 ${p.cat}`);
  lines.push(`\n<code>${index + 1} / ${total}</code>`);
  return lines.join("\n");
}

/** Orden de botones como pediste */
function productKeyboard(p) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⬅️", "PROD_PREV"), Markup.button.callback("➡️", "PROD_NEXT")],
    [Markup.button.callback("🛒 Agregar", `ASK_ADD_${p.code}`), Markup.button.callback("✅ Quiero éste", `ASK_BUY_${p.code}`)],
    [Markup.button.callback("🔗 Compartir", `SHARE_PROD_${p.code}`)],
    [Markup.button.callback("🏠 Menú", "GO_MENU")],
  ]);
}

/* =========================
   CART + CHECKOUT
========================= */
function cartText(cfg, sess) {
  const moneda = cfg.Moneda || "ARS";
  if (isCartExpired(sess)) {
    clearCart(sess);
  }

  if (!sess.cart.length) {
    return `🛒 <b>Carrito</b>\n\nTu carrito está vacío.\n\nVolvé al <b>Catálogo</b> para elegir productos.`;
  }

  let total = 0;
  const lines = [];
  lines.push(`🛒 <b>Carrito</b>\n`);

  sess.cart.forEach((it, i) => {
    total += it.subtotal;
    const qtyLine =
      it.unitType === "UNIDAD"
        ? `${it.qty} u`
        : `${it.grams} g`;
    lines.push(`${i + 1}) <b>${it.name}</b>\n   ${qtyLine} — ${money(it.subtotal, moneda)}`);
  });

  lines.push(`\n<b>Total:</b> ${money(total, moneda)}`);
  lines.push(`\n✍️ Si querés cambiar cantidad/peso, tocá <b>Editar item</b>.`);
  return lines.join("\n");
}

function cartKeyboard(sess) {
  const rows = [];
  if (sess.cart.length) {
    rows.push([Markup.button.callback("✍️ Editar item", "CART_EDIT_LAST"), Markup.button.callback("🗑️ Vaciar", "CART_CLEAR")]);
    rows.push([Markup.button.callback("✅ Finalizar compra", "CHK_START")]);
  }
  rows.push([Markup.button.callback("🧀 Seguir en Catálogo", "MENU_CATALOGO")]);
  rows.push([Markup.button.callback("🏠 Menú", "GO_MENU")]);
  return Markup.inlineKeyboard(rows);
}

function deliveryKeyboard(cfg) {
  const rows = [];
  if (parseYes(cfg["UsaEnvíoDomicilio"] || "SI")) rows.push([Markup.button.callback("🚚 Envío a domicilio", "DELIVERY_ENVIO")]);
  if (parseYes(cfg.UsaRetiroLocal || "SI")) rows.push([Markup.button.callback("🏪 Retiro en el local", "DELIVERY_RETIRO")]);

  // Express lo mostramos siempre (sin key nueva) porque a vos te gusta
  rows.push([Markup.button.callback("⚡ Envío express", "DELIVERY_EXPRESS")]);

  rows.push([Markup.button.callback("⬅️ Volver", "GO_CART")]);
  return Markup.inlineKeyboard(rows);
}

function payKeyboard(cfg) {
  const rows = [];
  if (parseYes(cfg.PermitirPagoOnline || "SI")) {
    const tipo = String(cfg.TipoPagoOnline || "TRANSFERENCIA").toUpperCase();
    rows.push([Markup.button.callback(`💳 ${tipo}`, `PAY_${tipo}`)]);
  }
  rows.push([Markup.button.callback("💵 Efectivo", "PAY_EFECTIVO")]);
  rows.push([Markup.button.callback("⬅️ Volver", "CHK_START")]);
  return Markup.inlineKeyboard(rows);
}

function buildOrderId(prefix = "TQ") {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${prefix}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function computeTotal(cfg, sess, entregaTipo) {
  const moneda = cfg.Moneda || "ARS";
  let total = sess.cart.reduce((a, it) => a + (Number(it.subtotal) || 0), 0);

  const costoEnvio = parseNumber(cfg.CostoEnvio || "0", 0);
  if (entregaTipo === "ENVIO" || entregaTipo === "EXPRESS") total += costoEnvio;

  return { total, moneda, costoEnvio };
}

function buildItemsText(cfg, sess) {
  const moneda = cfg.Moneda || "ARS";
  return sess.cart
    .map((it) => {
      const qty = it.unitType === "UNIDAD" ? `${it.qty}u` : `${it.grams}g`;
      return `${it.name} (${qty}) ${money(it.subtotal, moneda)}`;
    })
    .join(" | ");
}

function buildTicketText(cfg, ctx, sess, entregaTipo, pagoTipo) {
  const nombre = `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim();
  const usuario = ctx.from.username ? `@${ctx.from.username}` : "";
  const { total, moneda, costoEnvio } = computeTotal(cfg, sess, entregaTipo);

  const lines = [];
  lines.push(`🧾 <b>Resumen final</b>`);
  lines.push(`\n👤 <b>Cliente:</b> ${nombre}${usuario ? ` (${usuario})` : ""}`);
  lines.push(`\n🛍️ <b>Pedido:</b>`);
  sess.cart.forEach((it) => {
    const qty = it.unitType === "UNIDAD" ? `${it.qty} u` : `${it.grams} g`;
    lines.push(`• ${it.name} — ${qty} — ${money(it.subtotal, moneda)}`);
  });

  if (entregaTipo === "ENVIO") lines.push(`\n🚚 <b>Entrega:</b> Envío a domicilio`);
  if (entregaTipo === "EXPRESS") lines.push(`\n⚡ <b>Entrega:</b> Envío express`);
  if (entregaTipo === "RETIRO") lines.push(`\n🏪 <b>Entrega:</b> Retiro en el local`);

  if (entregaTipo === "ENVIO" || entregaTipo === "EXPRESS") {
    if (costoEnvio > 0) lines.push(`\n📦 <b>Costo envío:</b> ${money(costoEnvio, moneda)}`);
  }

  lines.push(`\n💳 <b>Pago:</b> ${pagoTipo}`);
  lines.push(`\n<b>Total:</b> ${money(total, moneda)}`);

  return { text: lines.join("\n"), total };
}

function confirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Confirmar pedido", "CONFIRM_ORDER")],
    [Markup.button.callback("❌ Cancelar compra", "CANCEL_ORDER")],
    [Markup.button.callback("🏠 Menú", "GO_MENU")],
  ]);
}

/* =========================
   SHARE
========================= */
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

/* =========================
   SELL0S
========================= */
function sellosText(cfg, sellos) {
  const montoPorSello = parseNumber(cfg.MontoPorSello || "10000", 10000);
  const moneda = cfg.Moneda || "ARS";

  const lines = [];
  lines.push(`🎟️ <b>Sellos</b>\n`);
  lines.push(`Tenés <b>${sellos}</b> sellos acumulados.`);
  lines.push(`\n📌 Cada <b>${money(montoPorSello, moneda)}</b> = <b>1 sello</b>.`);

  if (parseYes(cfg.UsaNiveles || "SI")) {
    const niveles = String(cfg.SellosPorNivel || "").trim();
    const beneficios = String(cfg.BeneficiosPorNivel || "").trim();
    if (niveles) lines.push(`\n🏅 <b>Niveles</b>\n${niveles}`);
    if (beneficios) lines.push(`\n🎁 <b>Beneficios</b>\n${beneficios}`);
  }

  return lines.join("\n");
}

/* =========================
   FLOWS
========================= */
async function showMenu(ctx) {
  const cfg = await loadConfig();
  const nombre = cfg.NegocioNombre || "Todo Queso";
  const dire = cfg.NegocioDireccion || "";
  const hora = cfg.NegocioHorario || "";
  const estado = cfg.Estado || "";
  const desc = cfg.Descripcion || "";

  const header = [];
  header.push(`🏠 <b>${nombre}</b>`);
  if (estado) header.push(`🟢 <b>${estado}</b>`);
  if (dire) header.push(`📍 ${dire}`);
  if (hora) header.push(`🕒 ${hora}`);

  await safeEditOrSend(ctx, {
    text: `${header.join("\n")}\n\n${desc}\n\nElegí una opción 👇`,
    extra: mainMenuKeyboard(cfg),
  });
}

async function showCategories(ctx) {
  const cfg = await loadConfig();
  const { items } = await loadCatalog();
  const cats = categoriesFromItems(items);

  if (!cats.length) {
    await safeEditOrSend(ctx, {
      text: "🧀 Catálogo vacío. Cargá productos en la hoja <b>Catalogo</b>.",
      extra: backMenuKeyboard(),
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
  buttons.push([Markup.button.callback("🏠 Menú", "GO_MENU")]);

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

async function renderCurrentProduct(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  if (!sess.productsInView.length) return;

  const p = sess.productsInView[sess.productIndex];
  const caption = productCaption(cfg, p, sess.productIndex, sess.productsInView.length);
  const photo = p.img && p.img.startsWith("http") ? p.img : undefined;

  if (photo) await safeEditOrSend(ctx, { photo, caption, extra: productKeyboard(p) });
  else await safeEditOrSend(ctx, { text: caption, extra: productKeyboard(p) });
}

function calcSubtotalForInput(product, inputRaw) {
  // inputRaw: string user typed
  const raw = String(inputRaw || "").trim().replace(",", ".");
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: "Ingresá un número válido (ej: 250 o 0.25)." };

  if (product.unitType === "UNIDAD") {
    const qty = Math.round(n);
    if (qty <= 0) return { ok: false, error: "Ingresá una cantidad válida (ej: 1, 2, 3)." };
    const subtotal = qty * (Number(product.price) || 0);
    return { ok: true, unitType: "UNIDAD", qty, grams: 0, subtotal };
  }

  // peso: si n < 10 lo tomo como kg (0.25), si n >= 10 lo tomo como gramos (250)
  let grams = 0;
  if (n < 10) grams = Math.round(n * 1000);
  else grams = Math.round(n);

  const kg = grams / 1000;
  const pricePerKg = Number(product.pricePerKg) > 0 ? Number(product.pricePerKg) : Number(product.price) || 0;
  const subtotal = kg * pricePerKg;

  return { ok: true, unitType: product.unitType, qty: 0, grams, subtotal };
}

function upsertCartItem(sess, product, calc) {
  const found = sess.cart.find((x) => x.code === product.code);
  const base = {
    code: product.code,
    name: product.name,
    unitType: product.unitType === "UNIDAD" ? "UNIDAD" : "PESO",
  };

  if (!found) {
    sess.cart.push({
      ...base,
      qty: calc.qty || 0,
      grams: calc.grams || 0,
      subtotal: Number(calc.subtotal) || 0,
    });
  } else {
    // reemplazo (más claro para fiambres)
    found.qty = calc.qty || 0;
    found.grams = calc.grams || 0;
    found.subtotal = Number(calc.subtotal) || 0;
    found.unitType = base.unitType;
  }

  touchCart(sess);
}

async function showCart(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  await safeEditOrSend(ctx, {
    text: cartText(cfg, sess),
    extra: cartKeyboard(sess),
  });
}

async function showSellos(ctx) {
  const cfg = await loadConfig();
  const rows = await getSheetValues(`${CLIENTES_SHEET}!A2:H`);
  const me = rows.find((r) => String(r[0] || "") === String(ctx.chat.id));
  const sellos = me ? parseNumber(me[3], 0) : 0;

  const cardUrl = (cfg.CARD_URL || cfg.CARD_URL || "").trim(); // tu key ya existe
  const caption = sellosText(cfg, sellos);

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("🧀 Catálogo", "MENU_CATALOGO")],
    [Markup.button.callback("🏠 Menú", "GO_MENU")],
  ]);

  // Si querés imagen de sellos, usá CARD_URL o SelloURL (ya la tenés)
  const selloImg = (cfg.SelloURL || "").trim();
  const img = (selloImg && selloImg.startsWith("http")) ? selloImg : ((cardUrl && cardUrl.startsWith("http")) ? cardUrl : "");
  if (img) await safeEditOrSend(ctx, { photo: img, caption, extra: keyboard });
  else await safeEditOrSend(ctx, { text: caption, extra: keyboard });
}

async function showHelp(ctx) {
  const cfg = await loadConfig();
  const nombre = cfg.NegocioNombre || "Todo Queso";
  const wa = (cfg.WhatsAppLink || "").trim();

  const text = [
    `ℹ️ <b>Ayuda - ${nombre}</b>\n`,
    `• Si no encontraste algo en el catálogo, puedo avisar a un vendedor.`,
    `• Si te falta algún producto, decime cuál y lo agregamos.`,
    `• Si querés sugerir una promo o consulta, también.`,
    ``,
    `👉 Botones:`,
    `• 🛒 <b>Agregar</b>: te pide cantidad/peso y lo suma al carrito.`,
    `• ✅ <b>Quiero éste</b>: te pide cantidad/peso y te lleva directo al carrito.`,
    `• ✅ <b>Finalizar compra</b>: elegís entrega → pago → confirmás.`,
  ].join("\n");

  const rows = [
    [Markup.button.callback("🧀 Catálogo", "MENU_CATALOGO")],
  ];
  if (wa) rows.push([Markup.button.url("💬 Contactar vendedor", wa)]);
  rows.push([Markup.button.callback("🏠 Menú", "GO_MENU")]);

  await safeEditOrSend(ctx, { text, extra: Markup.inlineKeyboard(rows) });
}

async function showShareBot(ctx) {
  const cfg = await loadConfig();
  const botLink = (cfg.BotLink || "").trim();
  if (!botLink) {
    await safeEditOrSend(ctx, { text: "Falta <b>BotLink</b> en Config para compartir.", extra: backMenuKeyboard() });
    return;
  }

  const text = (cfg.TextoCompartirBot || `🧀 Mirá el bot de ${cfg.NegocioNombre || "Todo Queso"} y elegí tu pedido:`).trim();
  const links = buildShareLinks({ botLink, text });

  await safeEditOrSend(ctx, {
    text: `📣 <b>Compartir bot</b>\n\nElegí dónde compartir 👇`,
    extra: shareKeyboard(links),
  });
}

async function showShareProduct(ctx, productCode) {
  const cfg = await loadConfig();
  const botLink = (cfg.BotLink || "").trim();
  if (!botLink) {
    await safeEditOrSend(ctx, { text: "Falta <b>BotLink</b> en Config para compartir.", extra: backMenuKeyboard() });
    return;
  }

  const { items } = await loadCatalog();
  const p = items.find((x) => x.code === productCode);
  if (!p) {
    await safeEditOrSend(ctx, { text: "No encontré ese producto.", extra: backMenuKeyboard() });
    return;
  }

  // deep link con referido + producto
  const ref = ctx.chat.id;
  const deepLink = botLink.includes("?start=")
    ? botLink
    : `${botLink}${botLink.includes("?") ? "&" : "?"}start=ref_${ref}__prod_${encodeURIComponent(p.code)}`;

  const moneda = cfg.Moneda || "ARS";
  const priceText =
    p.unitType === "UNIDAD"
      ? money(p.price, moneda)
      : `${money((p.pricePerKg || p.price), moneda)} (por kg)`;

  // mensaje sugerente al referido
  const text = `🧀 ${cfg.NegocioNombre || "Todo Queso"} — Promo: ${p.name} — ${priceText}\nEntrá acá y te queda listo para comprar 👇`;
  const links = buildShareLinks({ botLink: deepLink, text });

  // Si querés mandar imagen al compartir: Telegram/WhatsApp comparten link+texto,
  // pero la preview se genera si la URL del bot tiene OpenGraph (eso depende del front).
  await safeEditOrSend(ctx, {
    text: `🔗 <b>Compartir producto</b>\n\n<b>${p.name}</b>\nElegí dónde compartir 👇`,
    extra: shareKeyboard(links),
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
  const variants = splitVariants(cfg["TextoEnvíoDomicilio"] || "");
  const normalTxt = variants[0] || String(cfg["TextoEnvíoDomicilio"] || "").trim();
  const expressTxt = variants[1] || "⚡ Express: lo entregamos lo antes posible.";

  const retiroTxt = String(cfg.TextoRetiroLocal || "").trim();

  let extraTxt = "";
  if (entregaTipo === "ENVIO") extraTxt = normalTxt ? `\n\n${normalTxt}` : "";
  if (entregaTipo === "EXPRESS") extraTxt = expressTxt ? `\n\n${expressTxt}` : "";
  if (entregaTipo === "RETIRO") extraTxt = retiroTxt ? `\n\n${retiroTxt}` : "";

  await safeEditOrSend(ctx, {
    text: `💳 <b>Pago</b>\n\nElegí cómo vas a pagar 👇${extraTxt}`,
    extra: payKeyboard(cfg),
  });
}

async function showFinalConfirm(ctx, entregaTipo, pagoTipo) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);

  const ticket = buildTicketText(cfg, ctx, sess, entregaTipo, pagoTipo);
  sess.pendingConfirm = {
    entregaTipo,
    pagoTipo,
    total: ticket.total,
    itemsText: buildItemsText(cfg, sess),
  };

  await safeEditOrSend(ctx, {
    text: `${ticket.text}\n\n¿Confirmás la compra?`,
    extra: confirmKeyboard(),
  });
}

async function confirmOrder(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);

  if (!sess.pendingConfirm || !sess.cart.length) {
    await safeEditOrSend(ctx, { text: "No hay una compra pendiente para confirmar.", extra: backMenuKeyboard() });
    return;
  }

  const entregaTipo = sess.pendingConfirm.entregaTipo;
  const pagoTipo = sess.pendingConfirm.pagoTipo;
  const { total, moneda } = computeTotal(cfg, sess, entregaTipo);

  // sellos
  const usaSellos = parseYes(cfg.UsaSellos || "SI");
  const montoPorSello = parseNumber(cfg.MontoPorSello || "10000", 10000);
  const sellosGanados = usaSellos ? Math.floor(total / montoPorSello) : 0;

  // cliente
  const nombre = `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim();
  const usuario = ctx.from.username ? `@${ctx.from.username}` : "";

  // guardar cliente
  await upsertCliente({
    chatId: ctx.chat.id,
    nombre,
    usuario,
    addSellos: sellosGanados,
    addTotal: total,
    refBy: sess.refBy ? String(sess.refBy) : "",
  });

  // pedido sheet
  const pedidoId = buildOrderId("TQ");
  const itemsText = buildItemsText(cfg, sess);

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
    "PENDIENTE",
    sess.refBy ? String(sess.refBy) : "",
    "WHATSAPP",
  ]);

  // referido sello
  if (sess.refBy) await addSelloReferido(sess.refBy);

  // Mensaje transferencia (Punto 1 con ||)
  const msgTransVariants = splitVariants(cfg.MensajeTransferencia || "");
  const msgTransfer = msgTransVariants[0] || String(cfg.MensajeTransferencia || "").trim();
  const msgCash = msgTransVariants[1] || "Pagás en efectivo al recibir/retirar.";

  const alias = String(cfg.AliasTransferencia || "").trim();
  const cbu = String(cfg.CBUPago || "").trim();
  const waLink = String(cfg.WhatsAppLink || "").trim() || (String(cfg.NegocioTelefono || "").trim() ? `https://wa.me/${String(cfg.NegocioTelefono).replace(/[^\d]/g, "")}` : "");

  const payInfo = (String(pagoTipo).toUpperCase().includes("TRANSFER") || String(pagoTipo).toUpperCase().includes("CBU"))
    ? applyTpl(msgTransfer, { ALIAS: alias, CBU: cbu, WHATSAPP: waLink })
    : applyTpl(msgCash, { WHATSAPP: waLink });

  // Confirmación cliente (Punto 3 con ||)
  const confirmVariants = splitVariants(cfg.TextoConfirmacionPedido || "");
  const confirmENVIO = confirmVariants[0] || "✅ Pedido confirmado. Estamos preparando tu pedido.";
  const confirmEXPRESS = confirmVariants[1] || "✅ Pedido confirmado. Lo preparamos y sale express.";
  const confirmRETIRO = confirmVariants[2] || "✅ Pedido confirmado. Lo preparamos para retiro dentro del horario.";

  const baseConfirm =
    entregaTipo === "ENVIO" ? confirmENVIO :
    entregaTipo === "EXPRESS" ? confirmEXPRESS :
    confirmRETIRO;

  const clientMsg = [
    applyTpl(baseConfirm, { PEDIDO_ID: pedidoId, TOTAL: money(total, moneda) }),
    "",
    `🧾 <b>Tu ticket</b>`,
    ...sess.cart.map((it) => {
      const qty = it.unitType === "UNIDAD" ? `${it.qty} u` : `${it.grams} g`;
      return `• ${it.name} — ${qty}`;
    }),
    ``,
    `<b>Total:</b> ${money(total, moneda)}`,
    `<b>Entrega:</b> ${entregaTipo}`,
    `<b>Pago:</b> ${pagoTipo}`,
    sellosGanados > 0 ? `🎟️ Sumaste <b>${sellosGanados}</b> sello(s).` : "",
    payInfo ? `\n<b>Pago / Comprobante</b>\n${payInfo}` : "",
  ].filter(Boolean).join("\n");

  // Aviso vendedor (Punto 3 con ||)
  const vendorVariants = splitVariants(cfg.TextoAvisoVendedor || "");
  const vendorENVIO = vendorVariants[0] || "🧾 Nuevo pedido (ENVÍO)";
  const vendorEXPRESS = vendorVariants[1] || "🧾 Nuevo pedido (EXPRESS)";
  const vendorRETIRO = vendorVariants[2] || "🧾 Nuevo pedido (RETIRO)";

  const vendorTitle =
    entregaTipo === "ENVIO" ? vendorENVIO :
    entregaTipo === "EXPRESS" ? vendorEXPRESS :
    vendorRETIRO;

  const vendorMsg = [
    applyTpl(vendorTitle, { PEDIDO_ID: pedidoId }),
    ``,
    `👤 ${nombre} ${usuario ? `(${usuario})` : ""}`,
    `🆔 ChatId: ${ctx.chat.id}`,
    ``,
    `🛍️ Items:`,
    ...sess.cart.map((it) => {
      const qty = it.unitType === "UNIDAD" ? `${it.qty} u` : `${it.grams} g`;
      return `• ${it.name} — ${qty}`;
    }),
    ``,
    `💳 Pago: ${pagoTipo}`,
    `🚚 Entrega: ${entregaTipo}`,
    `💰 Total: ${money(total, moneda)}`,
    ``,
    (String(pagoTipo).toUpperCase().includes("TRANSFER") ? `Alias: ${alias}\nCBU: ${cbu}` : ""),
    (waLink ? `📲 WhatsApp: ${waLink}` : ""),
  ].filter(Boolean).join("\n");

  const vendorChatId = String(cfg.VendedorChatId || cfg.ChatIdVendedor || "").trim();
  if (vendorChatId) {
    try {
      await ctx.telegram.sendMessage(Number(vendorChatId), vendorMsg);
    } catch (e) {
      // no rompemos
    }
  }

  // limpiar carrito y pending
  clearCart(sess);
  sess.mode = "MENU";

  await safeEditOrSend(ctx, {
    text: clientMsg,
    extra: Markup.inlineKeyboard([
      [Markup.button.callback("🧀 Ver catálogo", "MENU_CATALOGO")],
      [Markup.button.callback("🏠 Menú", "GO_MENU")],
    ]),
  });
}

/* =========================
   TELEGRAM BOT
========================= */
const bot = new Telegraf(BOT_TOKEN);

/* /start con referido + producto */
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
    sess._jumpProd = null;

    const { items } = await loadCatalog();
    const p = items.find((x) => x.code === code);
    if (p) {
      await showProductCarousel(ctx, p.cat || "General");
      const s2 = getSess(ctx.chat.id);
      const idx = s2.productsInView.findIndex((x) => x.code === code);
      if (idx >= 0) {
        s2.productIndex = idx;
        await renderCurrentProduct(ctx);
      }
    }
  }
});

/* captura textos cuando estamos esperando cantidad/peso */
bot.on("text", async (ctx) => {
  const sess = getSess(ctx.chat.id);
  if (!sess.waitingQty || !sess.waitingForCode) return;

  const { items } = await loadCatalog();
  const product = items.find((x) => x.code === sess.waitingForCode);
  if (!product) {
    sess.waitingQty = false;
    sess.waitingForCode = null;
    sess.waitingAction = null;
    await safeEditOrSend(ctx, { text: "No encontré el producto.", extra: backMenuKeyboard() });
    return;
  }

  const calc = calcSubtotalForInput(product, ctx.message.text);
  if (!calc.ok) {
    await ctx.reply(`⚠️ ${calc.error}`);
    return;
  }

  upsertCartItem(sess, product, calc);
  sess.waitingQty = false;
  sess.waitingForCode = null;

  if (sess.waitingAction === "BUY") {
    sess.waitingAction = null;
    await showCart(ctx);
  } else {
    sess.waitingAction = null;
    await renderCurrentProduct(ctx);
  }
});

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
  const sess = getSess(ctx.chat.id);
  if (!sess.productsInView.length) return;
  sess.productIndex = (sess.productIndex + 1) % sess.productsInView.length;
  await renderCurrentProduct(ctx);
});

bot.action("PROD_PREV", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  if (!sess.productsInView.length) return;
  sess.productIndex = (sess.productIndex - 1 + sess.productsInView.length) % sess.productsInView.length;
  await renderCurrentProduct(ctx);
});

/* Preguntar cantidad/peso antes de agregar o comprar */
async function askQty(ctx, code, action) {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  const { items } = await loadCatalog();
  const p = items.find((x) => x.code === code);
  if (!p) return;

  sess.waitingQty = true;
  sess.waitingForCode = code;
  sess.waitingAction = action;

  const prompt =
    p.unitType === "UNIDAD"
      ? `⚖️ <b>${p.name}</b>\n\nIngresá cantidad (ej: 1, 2, 3).`
      : `⚖️ <b>${p.name}</b>\n\nIngresá el peso en gramos (ej: 250) o en kg (ej: 0.25).`;

  await safeEditOrSend(ctx, {
    text: prompt,
    extra: Markup.inlineKeyboard([[Markup.button.callback("❌ Cancelar", "QTY_CANCEL")]]),
  });
}

bot.action(/^ASK_ADD_(.+)$/i, async (ctx) => {
  const code = ctx.match[1];
  await askQty(ctx, code, "ADD");
});

bot.action(/^ASK_BUY_(.+)$/i, async (ctx) => {
  const code = ctx.match[1];
  await askQty(ctx, code, "BUY");
});

bot.action("QTY_CANCEL", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  sess.waitingQty = false;
  sess.waitingForCode = null;
  sess.waitingAction = null;
  await renderCurrentProduct(ctx);
});

/* Compartir producto */
bot.action(/^SHARE_PROD_(.+)$/i, async (ctx) => {
  await ctx.answerCbQuery();
  const code = ctx.match[1];
  await showShareProduct(ctx, code);
});

/* Carrito */
bot.action("GO_CART", async (ctx) => { await ctx.answerCbQuery(); await showCart(ctx); });

bot.action("CART_CLEAR", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  clearCart(sess);
  await showCart(ctx);
});

bot.action("CART_EDIT_LAST", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  if (!sess.cart.length) return;

  const last = sess.cart[sess.cart.length - 1];
  // Reusar askQty: pedimos de nuevo para el mismo producto
  await askQty(ctx, last.code, "BUY"); // después de editar, lo mando al carrito
});

/* Checkout */
bot.action("CHK_START", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  if (!sess.cart.length) return;
  await showDelivery(ctx);
});

bot.action("DELIVERY_ENVIO", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  sess.entregaTipo = "ENVIO";
  await showPayment(ctx, "ENVIO");
});

bot.action("DELIVERY_EXPRESS", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  sess.entregaTipo = "EXPRESS";
  await showPayment(ctx, "EXPRESS");
});

bot.action("DELIVERY_RETIRO", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  sess.entregaTipo = "RETIRO";
  await showPayment(ctx, "RETIRO");
});

bot.action(/^PAY_(.+)$/i, async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  const pagoTipo = (ctx.match[1] || "TRANSFERENCIA").toUpperCase();
  const entregaTipo = sess.entregaTipo || "RETIRO";
  sess.pagoTipo = pagoTipo;
  await showFinalConfirm(ctx, entregaTipo, pagoTipo);
});

bot.action("PAY_EFECTIVO", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  const entregaTipo = sess.entregaTipo || "RETIRO";
  sess.pagoTipo = "EFECTIVO";
  await showFinalConfirm(ctx, entregaTipo, "EFECTIVO");
});

bot.action("CONFIRM_ORDER", async (ctx) => {
  await ctx.answerCbQuery();
  await confirmOrder(ctx);
});

bot.action("CANCEL_ORDER", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  clearCart(sess);
  await safeEditOrSend(ctx, {
    text: "❌ Compra cancelada. Si querés, podés volver al catálogo y seguir eligiendo.",
    extra: Markup.inlineKeyboard([
      [Markup.button.callback("🧀 Ver catálogo", "MENU_CATALOGO")],
      [Markup.button.callback("🏠 Menú", "GO_MENU")],
    ]),
  });
});

/* =========================
   WEB SERVER (Render)
========================= */
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.status(200).send("EzerBot OK ✅"));

async function start() {
  await ensureBaseSheets();

  if (PUBLIC_URL && PUBLIC_URL.startsWith("http")) {
    const hook = `${PUBLIC_URL.replace(/\/$/, "")}/telegram`;
    await bot.telegram.setWebhook(hook);
    app.use(bot.webhookCallback("/telegram"));
    app.listen(PORT, () => console.log(`✅ Webhook activo: ${hook} | Puerto ${PORT}`));
  } else {
    bot.launch();
    app.listen(PORT, () => console.log(`✅ Bot long-polling | Puerto ${PORT}`));
  }
}

start().catch((e) => {
  console.error("FATAL:", e?.message || e);
  process.exit(1);
});

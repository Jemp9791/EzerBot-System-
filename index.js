import express from "express";
import { Telegraf, Markup } from "telegraf";
import { google } from "googleapis";

/* =========================
   ENV (NO CAMBIO NOMBRES)
========================= */
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_B64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const BOT_LINK_ENV = process.env.BOT_LINK || "";

if (!TELEGRAM_BOT_TOKEN) throw new Error("Falta TELEGRAM_BOT_TOKEN");
if (!GOOGLE_SHEET_ID) throw new Error("Falta GOOGLE_SHEET_ID");
if (!GOOGLE_SERVICE_ACCOUNT_B64) throw new Error("Falta GOOGLE_SERVICE_ACCOUNT_B64");

/* =========================
   GOOGLE AUTH
========================= */
function decodeServiceAccountB64(b64) {
  const raw = Buffer.from(b64, "base64").toString("utf8").trim();
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_B64 decodifica pero NO es JSON.");
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
   CONFIG
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

/* =========================
   CATALOGO
========================= */
function normalizeHeaders(headerRow) {
  const map = {};
  headerRow.forEach((h, i) => {
    const key = String(h || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/[áàäâ]/g, "a")
      .replace(/[éèëê]/g, "e")
      .replace(/[íìïî]/g, "i")
      .replace(/[óòöô]/g, "o")
      .replace(/[úùüû]/g, "u")
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

function normUnitType(v) {
  const s = String(v || "").trim().toLowerCase();
  if (!s) return ""; // desconocido
  if (s.includes("peso") || s.includes("gram") || s.includes("kg")) return "PESO";
  if (s.includes("unidad") || s.includes("unid") || s.includes("u.")) return "UNIDAD";
  return s.toUpperCase();
}

/* =========================
   IN-MEMORY STATE (chat limpio)
========================= */
const SESS = new Map(); // chatId -> state
const CART_TTL_MS = 60 * 60 * 1000; // 1 hora

function getSess(chatId) {
  if (!SESS.has(chatId)) {
    SESS.set(chatId, {
      mode: "MENU",
      category: null,
      productIndex: 0,
      productsInView: [],
      cart: [], // {code,name,unitType,price,pricePerKg, qtyUnits, grams, subtotal}
      cartExpiresAt: 0,
      refBy: null,
      lastMessageId: null,
      awaiting: null, // {type:'PESO'|'UNIDAD', productCode}
      checkout: null, // {entregaTipo, pagoTipo, pending:false}
    });
  }
  return SESS.get(chatId);
}

function ensureCartValid(sess) {
  const now = Date.now();
  if (sess.cartExpiresAt && now > sess.cartExpiresAt) {
    sess.cart = [];
    sess.cartExpiresAt = 0;
    sess.checkout = null;
    sess.awaiting = null;
    return false;
  }
  return true;
}

function touchCart(sess) {
  sess.cartExpiresAt = Date.now() + CART_TTL_MS;
}

/* =========================
   CLIENTES + PEDIDOS
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
];

async function ensureBaseSheets() {
  await ensureSheet(CLIENTES_SHEET, CLIENTES_HEADERS);
  await ensureSheet(PEDIDOS_SHEET, PEDIDOS_HEADERS);
}

async function upsertCliente({ chatId, nombre, usuario, addSellos = 0, addTotal = 0, refBy = "" }) {
  const rows = await getSheetValues(`${CLIENTES_SHEET}!A2:Z`);
  const idx = rows.findIndex((r) => String(r[0] || "") === String(chatId));
  if (idx === -1) {
    const now = new Date().toISOString();
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
    return { sellos: addSellos, referidosGanados: 0 };
  }

  const row = rows[idx];
  const currentSellos = parseNumber(row[3], 0);
  const currentTotal = parseNumber(row[4], 0);
  const currentRefGanados = parseNumber(row[7], 0);

  const newSellos = currentSellos + addSellos;
  const newTotal = currentTotal + addTotal;
  const now = new Date().toISOString();

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
    new Date().toISOString(),
    row[6] || "",
    currentRefGanados + 1,
  ]]);
}

/* =========================
   UI HELPERS (editar mensaje)
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
    // fallback a nuevo
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
   MENUS / KEYBOARDS
========================= */
function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🧀 Catálogo", "MENU_CATALOGO")],
    [Markup.button.callback("🎟️ Sellos", "MENU_SELLOS"), Markup.button.callback("ℹ️ Ayuda", "MENU_AYUDA")],
    [Markup.button.callback("📣 Compartir", "MENU_COMPARTIR")],
  ]);
}

function backMenuKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback("🏠 Menú", "GO_MENU")]]);
}

/* ========= PRODUCT KEYBOARD (ORDEN EXACTO QUE PEDISTE) =========
   - Fila 1: prev / next
   - Fila 2: Quiero éste / Compartir
   - Fila 3: Menú
   (Agregar se hace desde "Quiero éste" (compra rápida) o desde carrito/categoría)
*/
function productKeyboardOrdered(p) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⬅️", "PROD_PREV"), Markup.button.callback("➡️", "PROD_NEXT")],
    [Markup.button.callback("⚡ Quiero éste", `WANT_${p.code}`), Markup.button.callback("🔗 Compartir", `SHARE_PROD_${p.code}`)],
    [Markup.button.callback("🏠 Menú", "GO_MENU")],
  ]);
}

/* =========================
   LOAD CONFIG + CATALOG
========================= */
async function loadConfig() {
  const rows = await getSheetValues(`Config!A:B`);
  return kvFromRows(rows);
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
    const price = parseNumber(pick(r, hmap, ["precio", "price"], 0), 0);
    const pricePerKg = parseNumber(pick(r, hmap, ["precioporkg", "precioxkg", "precio_kg"], ""), 0);
    const cat = String(pick(r, hmap, ["categoria", "categoria", "rubro"], "General")).trim() || "General";
    const img = String(pick(r, hmap, ["imagenurl", "imagen", "foto", "urlimagen"], "")).trim();
    const desc = String(pick(r, hmap, ["descripcion", "descripcion", "detalle"], "")).trim();
    const unitType = normUnitType(pick(r, hmap, ["unidad", "unidadtipo", "tipo", "venta"], "")); // PESO / UNIDAD
    return { code, name, price, pricePerKg, cat, img, desc, unitType };
  });

  return { items, headers: hmap };
}

function categoriesFromItems(items) {
  const set = new Set();
  for (const it of items) set.add(it.cat || "General");
  return Array.from(set).sort((a, b) => a.localeCompare(b, "es"));
}

function productCaption(cfg, p, index, total) {
  const moneda = cfg.Moneda || "ARS";
  const showPrice = parseYes(cfg.CatalogoMostrarPrecios || "SI");
  const lines = [];
  lines.push(`<b>${p.name}</b>`);

  if (showPrice) {
    if (p.unitType === "PESO") {
      const perKg = p.pricePerKg > 0 ? p.pricePerKg : p.price; // default: precio = por kg
      lines.push(`💰 <b>${money(perKg, moneda)}</b> <i>(por kg)</i>`);
      lines.push(`📦 Unidad: <b>por peso</b> (gramos/kg)`);
    } else if (p.unitType === "UNIDAD") {
      lines.push(`💰 <b>${money(p.price, moneda)}</b> <i>(por unidad)</i>`);
      lines.push(`📦 Unidad: <b>por unidad</b>`);
    } else {
      lines.push(`💰 <b>${money(p.price, moneda)}</b>`);
    }
  }

  if (p.desc) lines.push(`\n${p.desc}`);
  lines.push(`\n📌 ${p.cat}`);
  lines.push(`\n<code>${index + 1}/${total}</code>`);
  return lines.join("\n");
}

/* =========================
   CART + CHECKOUT
========================= */
function calcWeightSubtotal(cfg, perKg, gramsOrKg) {
  // Si el usuario manda 0.25 => kg | si manda 250 => gramos
  const val = Number(gramsOrKg);
  if (!Number.isFinite(val) || val <= 0) return { grams: 0, subtotal: 0 };

  let grams = 0;
  if (val <= 10) grams = Math.round(val * 1000); // kg
  else grams = Math.round(val); // gramos

  const kg = grams / 1000;
  const subtotal = perKg * kg;
  return { grams, subtotal };
}

function cartText(cfg, cart) {
  const moneda = cfg.Moneda || "ARS";
  if (!cart.length) return `🛒 <b>Carrito</b>\n\nTu carrito está vacío.\n\nUsá <b>Catálogo</b> para elegir un producto.`;

  let total = 0;
  const lines = [];
  lines.push(`🛒 <b>Carrito</b>\n`);

  cart.forEach((it, i) => {
    total += it.subtotal;
    const qtyLine =
      it.unitType === "PESO"
        ? `${it.grams} g`
        : `${it.qtyUnits} u`;
    lines.push(`${i + 1}) <b>${it.name}</b>\n   ${qtyLine} — ${money(it.subtotal, moneda)}`);
  });

  lines.push(`\n<b>Total:</b> ${money(total, moneda)}`);
  lines.push(`\n✍️ Si querés cambiar cantidad/peso, tocá “Editar item”.`);
  return lines.join("\n");
}

function cartKeyboard(cart) {
  const rows = [];
  if (cart.length) {
    rows.push([Markup.button.callback("✍️ Editar item", "CART_EDIT")]);
    rows.push([Markup.button.callback("🗑️ Vaciar", "CART_CLEAR")]);
    // ✅ ACÁ EL CAMBIO CLAVE: antes decía Entrega, ahora Finalizar compra
    rows.push([Markup.button.callback("✅ Finalizar compra", "CHK_FINAL")]);
  }
  rows.push([Markup.button.callback("🧀 Seguir en Catálogo", "MENU_CATALOGO")]);
  rows.push([Markup.button.callback("🏠 Menú", "GO_MENU")]);
  return Markup.inlineKeyboard(rows);
}

function deliveryKeyboard(cfg) {
  const rows = [];
  if (parseYes(cfg.UsaEnvioDomicilio || "SI")) rows.push([Markup.button.callback("🚚 Envío a domicilio", "DELIVERY_ENVIO")]);
  if (parseYes(cfg.UsaRetiroLocal || "SI")) rows.push([Markup.button.callback("🏪 Retiro en el local", "DELIVERY_RETIRO")]);
  if (parseYes(cfg.EnvioExpress || "SI")) rows.push([Markup.button.callback("⚡ Envío express", "DELIVERY_EXPRESS")]);
  rows.push([Markup.button.callback("⬅️ Volver", "GO_CART")]);
  return Markup.inlineKeyboard(rows);
}

function payKeyboard(cfg) {
  const rows = [];
  if (parseYes(cfg.PermitePagoOnline || "SI")) {
    const tipo = (cfg.TipoPagoOnline || "TRANSFERENCIA").toUpperCase();
    rows.push([Markup.button.callback(`💳 ${tipo}`, `PAY_${tipo}`)]);
  }
  rows.push([Markup.button.callback("💵 Efectivo", "PAY_EFECTIVO")]);
  rows.push([Markup.button.callback("⬅️ Volver", "CHK_FINAL")]);
  return Markup.inlineKeyboard(rows);
}

function buildOrderId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `TQ-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function showMenu(ctx) {
  const cfg = await loadConfig();
  const nombre = cfg.NegocioNombre || "Todo Queso";
  const dire = cfg.NegocioDireccion || "";
  const hora = cfg.NegocioHorario || "";
  const estado = cfg.Estado || "";

  const header = [];
  header.push(`🏠 <b>${nombre}</b>`);
  if (estado) header.push(`🟢 <b>${estado}</b>`);
  if (dire) header.push(`📍 ${dire}`);
  if (hora) header.push(`🕒 ${hora}`);

  const desc = cfg.Descripcion || "";
  const txt = `${header.join("\n")}\n\n${desc}\n\nElegí una opción 👇`;

  await safeEditOrSend(ctx, { text: txt, extra: mainMenuKeyboard() });
}

async function showCategories(ctx) {
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
  const chatId = ctx.chat.id;
  const sess = getSess(chatId);

  ensureCartValid(sess);

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
  if (photo) await safeEditOrSend(ctx, { photo, caption, extra: productKeyboardOrdered(p) });
  else await safeEditOrSend(ctx, { text: caption, extra: productKeyboardOrdered(p) });
}

async function showCart(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  const ok = ensureCartValid(sess);
  if (!ok) {
    await safeEditOrSend(ctx, {
      text: "🕒 Tu carrito venció (1 hora). Lo vacié para que arranques de nuevo ✅",
      extra: mainMenuKeyboard(),
    });
    return;
  }

  await safeEditOrSend(ctx, {
    text: cartText(cfg, sess.cart),
    extra: cartKeyboard(sess.cart),
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
  if (entregaTipo === "ENVIO") extraText = `\n\n💡 Costo de envío: <b>${money(costoEnvio, moneda)}</b>\n${cfg.TextoEnvioDomicilio || ""}`;
  if (entregaTipo === "EXPRESS") extraText = `\n\n⚡ Envío express.\n${cfg.TextoEnvioDomicilio || ""}`;
  if (entregaTipo === "RETIRO") extraText = `\n\n🏪 ${cfg.TextoRetiroLocal || ""}`;

  await safeEditOrSend(ctx, {
    text: `💳 <b>Pago</b>\n\nElegí cómo vas a pagar 👇${extraText}`,
    extra: payKeyboard(cfg),
  });
}

function buildCheckoutTicket(cfg, sess, entregaTipo, pagoTipo) {
  const moneda = cfg.Moneda || "ARS";
  const costoEnvio = parseNumber(cfg.CostoEnvio || "0", 0);

  let total = 0;
  const lines = [];
  lines.push(`🧾 <b>Resumen final</b>\n`);
  sess.cart.forEach((it) => {
    total += it.subtotal;
    const qtyLine = it.unitType === "PESO" ? `${it.grams} g` : `${it.qtyUnits} u`;
    lines.push(`• <b>${it.name}</b> — ${qtyLine} — ${money(it.subtotal, moneda)}`);
  });

  if (entregaTipo === "ENVIO" || entregaTipo === "EXPRESS") {
    total += costoEnvio;
    if (costoEnvio > 0) lines.push(`\n🚚 Envío: ${money(costoEnvio, moneda)}`);
  }

  lines.push(`\n<b>Total:</b> ${money(total, moneda)}`);
  lines.push(`\n<b>Entrega:</b> ${entregaTipo}`);
  lines.push(`\n<b>Pago:</b> ${pagoTipo}`);

  // texto sugerente configurable (opcional)
  const ahorroTxt = (cfg.TextoAhorroComparativa || "").trim();
  if (ahorroTxt) lines.push(`\n✨ ${ahorroTxt}`);

  lines.push(`\n\n¿Confirmás la compra?`);
  return { text: lines.join("\n"), total };
}

async function finalizeOrderPersist(ctx, { entregaTipo, pagoTipo, totalFinal }) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);

  const usaSellos = parseYes(cfg.UsaSellos || "SI");
  const montoPorSello = parseNumber(cfg.MontoPorSello || "10000", 10000);
  const sellosGanados = usaSellos ? Math.floor(totalFinal / montoPorSello) : 0;

  const nombre = `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim();
  const usuario = ctx.from.username ? `@${ctx.from.username}` : "";

  await upsertCliente({
    chatId: ctx.chat.id,
    nombre,
    usuario,
    addSellos: sellosGanados,
    addTotal: totalFinal,
    refBy: sess.refBy ? String(sess.refBy) : "",
  });

  const itemsText = sess.cart
    .map((it) => {
      const qtyLine = it.unitType === "PESO" ? `${it.grams}g` : `${it.qtyUnits}u`;
      return `${it.name} ${qtyLine} (${money(it.subtotal, cfg.Moneda || "ARS")})`;
    })
    .join(" | ");

  const pedidoId = buildOrderId();
  await appendRow(PEDIDOS_SHEET, [
    pedidoId,
    new Date().toISOString(),
    String(ctx.chat.id),
    nombre,
    usuario,
    itemsText,
    totalFinal,
    entregaTipo,
    pagoTipo,
    "PENDIENTE",
    sess.refBy ? String(sess.refBy) : "",
  ]);

  if (sess.refBy) await addSelloReferido(sess.refBy);

  // mensaje final al cliente
  const moneda = cfg.Moneda || "ARS";
  const wa = (cfg.NegocioTelefono || "").replace(/[^\d]/g, "");
  const waLink = wa ? `https://wa.me/${wa}` : (cfg.WhatsAppLink || "");

  const msg = [];
  msg.push(`✅ <b>Perfecto</b>`);
  msg.push(`\nAnoté tu pedido:`);
  sess.cart.forEach((it) => {
    const qtyLine = it.unitType === "PESO" ? `${it.grams} g` : `${it.qtyUnits} u`;
    msg.push(`• ${it.name} — ${qtyLine}`);
  });
  msg.push(`\n<b>Total:</b> ${money(totalFinal, moneda)}`);
  msg.push(`\n<b>Entrega:</b> ${entregaTipo}`);
  msg.push(`\n<b>Pago:</b> ${pagoTipo}`);

  if (sellosGanados > 0) msg.push(`\n🎟️ Sumaste <b>${sellosGanados}</b> sello(s).`);
  if (sess.refBy) msg.push(`\n🎁 Compra por referido: el referente gana <b>1 sello</b>.`);

  if (waLink) {
    msg.push(`\n📲 Ahora falta la confirmación del vendedor. Si querés, avisá por WhatsApp:\n${waLink}`);
  }

  // limpiar carrito
  sess.cart = [];
  sess.cartExpiresAt = 0;
  sess.checkout = null;
  sess.awaiting = null;

  await safeEditOrSend(ctx, {
    text: msg.join("\n"),
    extra: Markup.inlineKeyboard([
      [Markup.button.callback("🧀 Ir al Menú", "GO_MENU")],
    ]),
  });
}

/* =========================
   SELL0S / AYUDA / SHARE
========================= */
function sellosText(cfg, sellos) {
  const montoPorSello = parseNumber(cfg.MontoPorSello || "10000", 10000);
  const beneficios = (cfg.BeneficiosPorNivel || "").trim();
  const sellosPorNivel = (cfg.SellosPorNivel || "").trim();

  const lines = [];
  lines.push(`🎟️ <b>Sellos</b>\n`);
  lines.push(`Tenés <b>${sellos}</b> sellos acumulados.`);
  lines.push(`\n📌 Cada <b>${money(montoPorSello, cfg.Moneda || "ARS")}</b> = <b>1 sello</b>.`);

  if (sellosPorNivel) {
    lines.push(`\n🏅 <b>Niveles</b>\n${sellosPorNivel}`);
  }
  if (beneficios) {
    lines.push(`\n🎁 <b>Beneficios</b>\n${beneficios}`);
  }

  lines.push(`\n✨ Tip: si alguien compra desde tu link, ganás <b>1 sello</b>.`);
  return lines.join("\n");
}

async function showSellos(ctx) {
  const cfg = await loadConfig();
  const rows = await getSheetValues(`${CLIENTES_SHEET}!A2:H`);
  const me = rows.find((r) => String(r[0] || "") === String(ctx.chat.id));
  const sellos = me ? parseNumber(me[3], 0) : 0;

  const caption = sellosText(cfg, sellos);
  await safeEditOrSend(ctx, {
    text: caption,
    extra: Markup.inlineKeyboard([
      [Markup.button.callback("🧀 Catálogo", "MENU_CATALOGO")],
      [Markup.button.callback("🏠 Menú", "GO_MENU")],
    ]),
  });
}

async function showHelp(ctx) {
  const cfg = await loadConfig();
  const nombre = cfg.NegocioNombre || "Todo Queso";

  const vendedor = (cfg.NegocioTelefono || "").trim();
  const sugerencia = (cfg.TextoAyudaSugerente || "¿No encontraste algo? Puedo pasarte con un vendedor, tomar tu sugerencia o ayudarte a elegir.").trim();

  const text = [
    `ℹ️ <b>Ayuda - ${nombre}</b>\n`,
    `• Tocá 🧀 <b>Catálogo</b> y elegí una categoría.`,
    `• Ojeás productos con ⬅️➡️ sin llenar el chat.`,
    `• Tocá ⚡ <b>Quiero éste</b> para comprar rápido (te pide peso/unidades).`,
    `• En 🛒 <b>Carrito</b> tocás ✅ <b>Finalizar compra</b> para elegir entrega y pago.`,
    `\n💬 ${sugerencia}`,
  ].join("\n");

  const rows = [
    [Markup.button.callback("🧀 Catálogo", "MENU_CATALOGO")],
  ];

  if (vendedor) rows.push([Markup.button.url("👨‍🍳 Hablar con vendedor (WhatsApp)", `https://wa.me/${vendedor.replace(/[^\d]/g, "")}`)]);
  rows.push([Markup.button.callback("🏠 Menú", "GO_MENU")]);

  await safeEditOrSend(ctx, { text, extra: Markup.inlineKeyboard(rows) });
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
    [Markup.button.callback("🏠 Menú", "GO_MENU")],
  ]);
}

async function showShareBot(ctx) {
  const cfg = await loadConfig();
  const botLink = BOT_LINK_ENV || cfg.BotLink || cfg.Botlink || "";
  if (!botLink) {
    await safeEditOrSend(ctx, { text: "Falta <b>BotLink</b> en Config para compartir.", extra: backMenuKeyboard() });
    return;
  }
  const text = `🧀 Estoy comprando en ${cfg.NegocioNombre || "Todo Queso"}.\nEntrá acá para ver el catálogo y comprar 👇`;
  const links = buildShareLinks({ botLink, text });
  await safeEditOrSend(ctx, {
    text: `📣 <b>Compartir bot</b>\n\nElegí dónde compartir 👇`,
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
  const deepLink = botLink.includes("?start=")
    ? botLink
    : `${botLink}${botLink.includes("?") ? "&" : "?"}start=ref_${ref}__prod_${encodeURIComponent(p.code)}`;

  const moneda = cfg.Moneda || "ARS";
  const priceTxt =
    p.unitType === "PESO"
      ? `${money((p.pricePerKg > 0 ? p.pricePerKg : p.price), moneda)} por kg`
      : `${money(p.price, moneda)} por unidad`;

  const text = `🧀 Promo en ${cfg.NegocioNombre || "Todo Queso"}: ${p.name}\n💰 ${priceTxt}\nTocá el link para ver y comprar 👇`;
  const links = buildShareLinks({ botLink: deepLink, text });

  // si querés que mande imagen, Telegram no permite “adjuntar imagen” en link-sharing,
  // pero acá al menos queda el mensaje listo con el link.
  await safeEditOrSend(ctx, {
    text: `🔗 <b>Compartir producto</b>\n\n${p.name}\n\nElegí dónde compartir 👇`,
    extra: shareKeyboard(links),
  });
}

/* =========================
   TELEGRAM BOT
========================= */
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

/* Start + referrals + deep product */
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
      const prods = getSess(ctx.chat.id).productsInView;
      const idx = prods.findIndex((x) => x.code === code);
      if (idx >= 0) {
        getSess(ctx.chat.id).productIndex = idx;
        const cfg = await loadConfig();
        const caption = productCaption(cfg, prods[idx], idx, prods.length);
        const photo = prods[idx].img && prods[idx].img.startsWith("http") ? prods[idx].img : undefined;
        if (photo) await safeEditOrSend(ctx, { photo, caption, extra: productKeyboardOrdered(prods[idx]) });
        else await safeEditOrSend(ctx, { text: caption, extra: productKeyboardOrdered(prods[idx]) });
      }
    }
  }
});

/* Quick text */
bot.hears(/^(menu|menú)$/i, (ctx) => showMenu(ctx));
bot.hears(/^cat[aá]logo$/i, (ctx) => showCategories(ctx));
bot.hears(/^sellos$/i, (ctx) => showSellos(ctx));
bot.hears(/^ayuda$/i, (ctx) => showHelp(ctx));

/* =========================
   ACTIONS (MENÚ)
========================= */
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

/* =========================
   CAROUSEL NAV
========================= */
bot.action("PROD_NEXT", async (ctx) => {
  await ctx.answerCbQuery();
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  if (!sess.productsInView.length) return;

  sess.productIndex = (sess.productIndex + 1) % sess.productsInView.length;
  const p = sess.productsInView[sess.productIndex];
  const caption = productCaption(cfg, p, sess.productIndex, sess.productsInView.length);

  const photo = p.img && p.img.startsWith("http") ? p.img : undefined;
  if (photo) await safeEditOrSend(ctx, { photo, caption, extra: productKeyboardOrdered(p) });
  else await safeEditOrSend(ctx, { text: caption, extra: productKeyboardOrdered(p) });
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
  if (photo) await safeEditOrSend(ctx, { photo, caption, extra: productKeyboardOrdered(p) });
  else await safeEditOrSend(ctx, { text: caption, extra: productKeyboardOrdered(p) });
});

/* =========================
   WANT THIS (pide peso/unidades)
========================= */
bot.action(/^WANT_(.+)$/i, async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  ensureCartValid(sess);

  const code = ctx.match[1];
  const p = sess.productsInView.find((x) => x.code === code);
  if (!p) return;

  // set awaiting input
  const unitType = p.unitType === "PESO" ? "PESO" : "UNIDAD";
  sess.awaiting = { type: unitType, productCode: p.code };
  sess._awaitProductName = p.name;

  if (unitType === "PESO") {
    await safeEditOrSend(ctx, {
      text: `⚖️ <b>${p.name}</b>\n\nIngresá el peso en gramos (ej: <b>250</b>) o en kg (ej: <b>0.25</b>).`,
      extra: Markup.inlineKeyboard([[Markup.button.callback("❌ Cancelar", "CANCEL_AWAIT")]]),
    });
  } else {
    await safeEditOrSend(ctx, {
      text: `🧾 <b>${p.name}</b>\n\nIngresá la cantidad de unidades (ej: <b>2</b>).`,
      extra: Markup.inlineKeyboard([[Markup.button.callback("❌ Cancelar", "CANCEL_AWAIT")]]),
    });
  }
});

bot.action("CANCEL_AWAIT", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  sess.awaiting = null;
  await showCart(ctx);
});

/* =========================
   CART ACTIONS
========================= */
bot.action("GO_CART", async (ctx) => { await ctx.answerCbQuery(); await showCart(ctx); });

bot.action("CART_CLEAR", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  sess.cart = [];
  sess.cartExpiresAt = 0;
  sess.checkout = null;
  await showCart(ctx);
});

bot.action("CART_EDIT", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  if (!sess.cart.length) return showCart(ctx);

  // edita el último item (simple y rápido)
  const last = sess.cart[sess.cart.length - 1];
  sess.awaiting = { type: last.unitType, productCode: last.code, editMode: true };

  const prompt =
    last.unitType === "PESO"
      ? `⚖️ <b>${last.name}</b>\n\nIngresá el nuevo peso en gramos (ej: <b>250</b>) o en kg (ej: <b>0.25</b>).`
      : `🧾 <b>${last.name}</b>\n\nIngresá la nueva cantidad de unidades (ej: <b>2</b>).`;

  await safeEditOrSend(ctx, {
    text: prompt,
    extra: Markup.inlineKeyboard([[Markup.button.callback("❌ Cancelar", "CANCEL_AWAIT")]]),
  });
});

/* =========================
   CHECKOUT (Finalizar compra -> Entrega -> Pago -> Confirmar/Cancelar)
========================= */
bot.action("CHK_FINAL", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  const ok = ensureCartValid(sess);
  if (!ok || !sess.cart.length) return showCart(ctx);
  await showDelivery(ctx);
});

bot.action("DELIVERY_ENVIO", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  sess.checkout = { entregaTipo: "ENVIO", pagoTipo: null, preview: null };
  await showPayment(ctx, "ENVIO");
});

bot.action("DELIVERY_RETIRO", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  sess.checkout = { entregaTipo: "RETIRO", pagoTipo: null, preview: null };
  await showPayment(ctx, "RETIRO");
});

bot.action("DELIVERY_EXPRESS", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  sess.checkout = { entregaTipo: "EXPRESS", pagoTipo: null, preview: null };
  await showPayment(ctx, "EXPRESS");
});

bot.action(/^PAY_(.+)$/i, async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  if (!sess.checkout?.entregaTipo) return showCart(ctx);

  const pagoTipo = (ctx.match[1] || "TRANSFERENCIA").toUpperCase();
  sess.checkout.pagoTipo = pagoTipo;

  const cfg = await loadConfig();
  const { text, total } = buildCheckoutTicket(cfg, sess, sess.checkout.entregaTipo, pagoTipo);
  sess.checkout.preview = { total };

  // ÚLTIMO PASO PROFESIONAL
  await safeEditOrSend(ctx, {
    text,
    extra: Markup.inlineKeyboard([
      [Markup.button.callback("✅ Confirmar compra", "CONFIRM_BUY")],
      [Markup.button.callback("❌ Cancelar compra", "CANCEL_BUY")],
      [Markup.button.callback("🏠 Menú", "GO_MENU")],
    ]),
  });
});

bot.action("PAY_EFECTIVO", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  if (!sess.checkout?.entregaTipo) return showCart(ctx);

  sess.checkout.pagoTipo = "EFECTIVO";

  const cfg = await loadConfig();
  const { text, total } = buildCheckoutTicket(cfg, sess, sess.checkout.entregaTipo, "EFECTIVO");
  sess.checkout.preview = { total };

  await safeEditOrSend(ctx, {
    text,
    extra: Markup.inlineKeyboard([
      [Markup.button.callback("✅ Confirmar compra", "CONFIRM_BUY")],
      [Markup.button.callback("❌ Cancelar compra", "CANCEL_BUY")],
      [Markup.button.callback("🏠 Menú", "GO_MENU")],
    ]),
  });
});

bot.action("CANCEL_BUY", async (ctx) => {
  await ctx.answerCbQuery();
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);

  // mensaje “pena desaprovechar” configurable
  const pena = (cfg.TextoCancelacionSugerente || "😅 ¡Qué pena! Estabas por aprovechar una oferta. Si querés, mirá otras promos o consultá con un vendedor.").trim();

  sess.checkout = null;
  await safeEditOrSend(ctx, {
    text: `${pena}\n\nVolvemos al carrito 👇`,
    extra: cartKeyboard(sess.cart),
  });
});

bot.action("CONFIRM_BUY", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  const ok = ensureCartValid(sess);
  if (!ok) return showCart(ctx);
  if (!sess.checkout?.entregaTipo || !sess.checkout?.pagoTipo) return showCart(ctx);

  const totalFinal = Number(sess.checkout.preview?.total || 0);
  await finalizeOrderPersist(ctx, {
    entregaTipo: sess.checkout.entregaTipo,
    pagoTipo: sess.checkout.pagoTipo,
    totalFinal,
  });
});

/* =========================
   SHARE PRODUCT
========================= */
bot.action(/^SHARE_PROD_(.+)$/i, async (ctx) => {
  await ctx.answerCbQuery();
  const code = ctx.match[1];
  await showShareProduct(ctx, code);
});

/* =========================
   TEXT INPUT HANDLER (peso/unidades)
========================= */
bot.on("text", async (ctx) => {
  const sess = getSess(ctx.chat.id);
  if (!sess.awaiting) return;

  const cfg = await loadConfig();
  const { items } = await loadCatalog();
  const p = items.find((x) => x.code === sess.awaiting.productCode);
  if (!p) {
    sess.awaiting = null;
    return showCart(ctx);
  }

  const input = String(ctx.message.text || "").trim().replace(",", ".");
  const n = Number(input);

  if (!Number.isFinite(n) || n <= 0) {
    const msg = sess.awaiting.type === "PESO"
      ? "❗ Ingresá un número válido. Ej: 250 o 0.25"
      : "❗ Ingresá un número válido. Ej: 2";
    await ctx.reply(msg);
    return;
  }

  // si edita, reemplaza último item del mismo producto
  const isEdit = !!sess.awaiting.editMode;

  if (sess.awaiting.type === "PESO") {
    const perKg = p.pricePerKg > 0 ? p.pricePerKg : p.price;
    const { grams, subtotal } = calcWeightSubtotal(cfg, perKg, n);
    if (!grams || !subtotal) {
      await ctx.reply("❗ Ingresá un peso válido. Ej: 250 o 0.25");
      return;
    }

    if (isEdit) {
      const idx = sess.cart.findIndex((x) => x.code === p.code);
      if (idx >= 0) {
        sess.cart[idx] = { code: p.code, name: p.name, unitType: "PESO", price: p.price, pricePerKg: perKg, qtyUnits: 0, grams, subtotal };
      }
    } else {
      sess.cart.push({ code: p.code, name: p.name, unitType: "PESO", price: p.price, pricePerKg: perKg, qtyUnits: 0, grams, subtotal });
    }
  } else {
    const qtyUnits = Math.round(n);
    const subtotal = (p.price || 0) * qtyUnits;

    if (isEdit) {
      const idx = sess.cart.findIndex((x) => x.code === p.code);
      if (idx >= 0) {
        sess.cart[idx] = { code: p.code, name: p.name, unitType: "UNIDAD", price: p.price, pricePerKg: 0, qtyUnits, grams: 0, subtotal };
      }
    } else {
      sess.cart.push({ code: p.code, name: p.name, unitType: "UNIDAD", price: p.price, pricePerKg: 0, qtyUnits, grams: 0, subtotal });
    }
  }

  touchCart(sess);
  sess.awaiting = null;

  // borramos el mensaje que el usuario envió (opcional: Telegram no deja borrar siempre)
  // y mostramos carrito
  await showCart(ctx);
});

/* =========================
   WEB SERVER (Render)
========================= */
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.status(200).send("EzerBot OK ✅"));

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
    app.listen(PORT, () => console.log(`✅ Bot en long-polling | Puerto ${PORT}`));
  }
}

start().catch((e) => {
  console.error("FATAL:", e?.message || e);
  process.exit(1);
});

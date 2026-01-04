import express from "express";
import { Telegraf, Markup } from "telegraf";
import { google } from "googleapis";

/* =========================
   ENV (NO CAMBIAR NOMBRES: ACEPTA VARIOS)
========================= */
function pickEnv(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

// Tokens (acepta ambos)
const TELEGRAM_BOT_TOKEN = pickEnv("BOT_TOKEN", "TELEGRAM_BOT_TOKEN");

// Google
const GOOGLE_SHEET_ID = pickEnv("GOOGLE_SHEET_ID", "SHEET_ID");
const GOOGLE_SERVICE_ACCOUNT_B64 = pickEnv("GOOGLE_SERVICE_ACCOUNT_B64", "GOOGLE_SERVICE_ACCOUNT", "SERVICE_ACCOUNT_B64");

// Webhook / URL pública (opcional)
const PUBLIC_URL = pickEnv("PUBLIC_URL", "RENDER_EXTERNAL_URL", "APP_URL");

// Bot link para compartir (opcional)
const BOT_LINK_ENV = pickEnv("BOT_LINK", "BOTLINK", "BOT_URL");

// Validaciones mínimas (solo lo imprescindible)
if (!TELEGRAM_BOT_TOKEN) throw new Error("Falta ENV: BOT_TOKEN o TELEGRAM_BOT_TOKEN");
if (!GOOGLE_SHEET_ID) throw new Error("Falta ENV: GOOGLE_SHEET_ID");
if (!GOOGLE_SERVICE_ACCOUNT_B64) throw new Error("Falta ENV: GOOGLE_SERVICE_ACCOUNT_B64");

/* =========================
   GOOGLE AUTH
========================= */
function decodeServiceAccountB64(b64) {
  const raw = Buffer.from(b64, "base64").toString("utf8").trim();
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_B64 decodifica pero NO es JSON.");
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
  const num = Math.round(n);
  return `${moneda} ${num.toLocaleString("es-AR")}`;
}

/* =========================
   CATALOGO
========================= */
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

/* =========================
   IN-MEMORY STATE
========================= */
const SESS = new Map();
function getSess(chatId) {
  if (!SESS.has(chatId)) {
    SESS.set(chatId, {
      mode: "MENU",
      category: null,
      productIndex: 0,
      productsInView: [],
      cart: [], // {code,name,price,qty,unit,qtyText}
      refBy: null,
      lastMessageId: null,
      _entrega: null,
    });
  }
  return SESS.get(chatId);
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
   UI (EDIT OR SEND)
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
        const text = payload.text && String(payload.text).trim() ? payload.text : " ";
        await ctx.telegram.editMessageText(
          chatId,
          sess.lastMessageId,
          undefined,
          text,
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
    const text = payload.text && String(payload.text).trim() ? payload.text : " ";
    msg = await ctx.reply(text, { parse_mode: "HTML", ...(payload.extra || {}) });
  }
  if (sess && msg?.message_id) sess.lastMessageId = msg.message_id;
}

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

/* =========================
   LOAD CONFIG / CATALOGO
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
    const code = String(pick(r, hmap, ["codigo","codigoproducto","id","sku"], "")).trim() || `P${i + 1}`;
    const name = String(pick(r, hmap, ["nombre","producto","name"], "Producto")).trim();
    const price = parseNumber(pick(r, hmap, ["precio","price"], 0), 0);
    const cat = String(pick(r, hmap, ["categoria","categoría","rubro"], "General")).trim() || "General";
    const img = String(pick(r, hmap, ["imagenurl","imagen","foto","urlimagen"], "")).trim();
    const desc = String(pick(r, hmap, ["descripcion","descripción","detalle"], "")).trim();

    // Unidad: "kg" o "unidad" o "u" (si no existe, asume unidad)
    const unidadRaw = String(pick(r, hmap, ["unidad","unit","tipo"], "unidad")).trim().toLowerCase();
    const unit = (unidadRaw.includes("kg") || unidadRaw.includes("kilo") || unidadRaw.includes("gram")) ? "kg" : "unidad";

    return { code, name, price, cat, img, desc, unit };
  });

  return { items, headers: hmap };
}

function categoriesFromItems(items) {
  return Array.from(new Set(items.map((it) => it.cat || "General"))).sort((a,b)=>a.localeCompare(b,"es"));
}

function productCaption(cfg, p, index, total) {
  const moneda = cfg.Moneda || "ARS";
  const showPrice = parseYes(cfg.CatalogoMostrarPrecios || "SI");
  const lines = [];
  lines.push(`<b>${p.name}</b>`);
  if (showPrice) lines.push(`💰 <b>${money(p.price, moneda)}</b>`);
  lines.push(`📦 Unidad: <b>${p.unit === "kg" ? "por peso (gramos/kg)" : "por unidad"}</b>`);
  if (p.desc) lines.push(`\n${p.desc}`);
  lines.push(`\n📌 ${p.cat}`);
  lines.push(`\n<code>${index + 1}/${total}</code>`);
  return lines.join("\n");
}

function productKeyboard(p) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⬅️", "PROD_PREV"), Markup.button.callback("➡️", "PROD_NEXT")],
    [Markup.button.callback("🛒 Agregar", `ADD_${p.code}`), Markup.button.callback("✅ Comprar", "GO_CART")],
    [Markup.button.callback("🔗 Compartir", `SHARE_PROD_${p.code}`)],
    [Markup.button.callback("🏠 Menú", "GO_MENU")],
  ]);
}

function cartText(cfg, cart) {
  const moneda = cfg.Moneda || "ARS";
  if (!cart.length) return `🛒 <b>Carrito</b>\n\nTu carrito está vacío.\n\nUsá <b>Catálogo</b> para agregar productos.`;

  let total = 0;
  const lines = [];
  lines.push(`🛒 <b>Carrito</b>\n`);
  cart.forEach((it, i) => {
    const sub = it.price * it.qty;
    total += sub;
    const qtyLabel = it.unit === "kg" ? `${it.qtyText || (it.qty + " kg")}` : `x${it.qty}`;
    lines.push(`${i + 1}) <b>${it.name}</b>\n   ${qtyLabel} — ${money(sub, moneda)}`);
  });
  lines.push(`\n<b>Total:</b> ${money(total, moneda)}`);
  lines.push(`\n✍️ Si querés cambiar cantidad/peso, tocá “Editar item”.`);
  return lines.join("\n");
}

function cartKeyboard(cart) {
  const rows = [];
  if (cart.length) {
    rows.push([Markup.button.callback("✍️ Editar item", "CART_EDIT")]);
    rows.push([Markup.button.callback("🗑️ Vaciar", "CART_CLEAR"), Markup.button.callback("🚚 Entrega", "CHK_DELIVERY")]);
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
  rows.push([Markup.button.callback("⬅️ Volver", "CHK_DELIVERY")]);
  return Markup.inlineKeyboard(rows);
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
   SCREENS
========================= */
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
    await safeEditOrSend(ctx, { text: "🧀 Catálogo vacío. Cargá productos en la hoja <b>Catalogo</b>.", extra: backMenuKeyboard() });
    return;
  }

  const buttons = [];
  for (let i = 0; i < cats.length; i += 2) {
    const row = [Markup.button.callback(`📁 ${cats[i]}`, `CAT_${encodeURIComponent(cats[i])}`)];
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

function adjustCart(sess, product) {
  const found = sess.cart.find((x) => x.code === product.code);
  if (!found) {
    // default: si es kg, pedimos luego el peso. si es unidad, default 1.
    sess.cart.push({ code: product.code, name: product.name, price: product.price, qty: product.unit === "kg" ? 0 : 1, unit: product.unit, qtyText: "" });
  } else {
    if (found.unit === "kg") {
      // no sumamos qty sin pedir peso
    } else {
      found.qty += 1;
    }
  }
}

async function showCart(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  await safeEditOrSend(ctx, { text: cartText(cfg, sess.cart), extra: cartKeyboard(sess.cart) });
}

async function showDelivery(ctx) {
  const cfg = await loadConfig();
  await safeEditOrSend(ctx, { text: `🚚 <b>Entrega</b>\n\nElegí cómo querés recibir tu pedido 👇`, extra: deliveryKeyboard(cfg) });
}

async function showPayment(ctx, entregaTipo) {
  const cfg = await loadConfig();
  const moneda = cfg.Moneda || "ARS";
  const costoEnvio = parseNumber(cfg.CostoEnvio || "0", 0);

  const extraText =
    entregaTipo === "ENVIO" || entregaTipo === "EXPRESS"
      ? `\n\n💡 Costo de envío: <b>${money(costoEnvio, moneda)}</b>\n${cfg.TextoEnvioDomicilio || ""}`
      : `\n\n🏪 ${cfg.TextoRetiroLocal || ""}`;

  await safeEditOrSend(ctx, { text: `💳 <b>Pago</b>\n\nElegí cómo vas a pagar 👇${extraText}`, extra: payKeyboard(cfg) });
}

function buildOrderId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `TQ-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function finalizeOrder(ctx, { entregaTipo, pagoTipo }) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);

  if (!sess.cart.length) {
    await safeEditOrSend(ctx, { text: "Tu carrito está vacío.", extra: backMenuKeyboard() });
    return;
  }

  // Validar que si hay items por kg tengan qty
  const pendingKg = sess.cart.find((it) => it.unit === "kg" && (!it.qty || it.qty <= 0));
  if (pendingKg) {
    sess._editingCode = pendingKg.code;
    await safeEditOrSend(ctx, {
      text: `⚖️ <b>${pendingKg.name}</b>\n\nIngresá el peso en gramos (ej: 250) o en kg (ej: 0.25).\n\n✍️ Escribilo ahora en el chat.`,
      extra: Markup.inlineKeyboard([[Markup.button.callback("❌ Cancelar", "GO_CART")]]),
    });
    return;
  }

  const moneda = cfg.Moneda || "ARS";
  const costoEnvio = parseNumber(cfg.CostoEnvio || "0", 0);

  let total = 0;
  const itemsText = sess.cart
    .map((it) => {
      const sub = it.price * it.qty;
      total += sub;
      const qtyLabel = it.unit === "kg" ? `${it.qtyText || (it.qty + " kg")}` : `x${it.qty}`;
      return `${it.name} ${qtyLabel} (${money(sub, moneda)})`;
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

  const pedidoId = buildOrderId();
  await appendRow(PEDIDOS_SHEET, [
    pedidoId,
    new Date().toISOString(),
    String(ctx.chat.id),
    nombre,
    usuario,
    itemsText,
    total,
    entregaTipo,
    pagoTipo,
    "PENDIENTE",
    sess.refBy ? String(sess.refBy) : "",
  ]);

  if (sess.refBy) await addSelloReferido(sess.refBy);

  const waNum = (cfg.NegocioTelefono || "").replace(/[^\d]/g, "");
  const waLink = waNum ? `https://wa.me/${waNum}` : (cfg.WhatsAppLink || "");

  const msgCliente = [
    `✅ <b>Perfecto</b>`,
    `\nAnoté tu pedido:`,
    ...sess.cart.map((it) => {
      const qtyLabel = it.unit === "kg" ? `${it.qtyText || (it.qty + " kg")}` : `x${it.qty}`;
      return `• ${it.name} ${qtyLabel}`;
    }),
    `\n<b>Total:</b> ${money(total, moneda)}`,
    `\n<b>Entrega:</b> ${entregaTipo}`,
    `\n<b>Pago:</b> ${pagoTipo}`,
  ];

  if (sellosGanados > 0) msgCliente.push(`\n🎟️ Sumaste <b>${sellosGanados}</b> sello(s).`);
  if (sess.refBy) msgCliente.push(`\n🎁 Compra por referido: el referente gana <b>1 sello</b>.`);

  if (waLink) msgCliente.push(`\n📲 Si querés, confirmalo por WhatsApp:\n${waLink}`);

  // limpiar carrito
  sess.cart = [];
  sess.mode = "MENU";

  await safeEditOrSend(ctx, {
    text: msgCliente.join("\n"),
    extra: Markup.inlineKeyboard([
      [Markup.button.callback("🧀 Seguir en Catálogo", "MENU_CATALOGO")],
      [Markup.button.callback("🏠 Menú", "GO_MENU")],
    ]),
  });
}

async function showSellos(ctx) {
  const cfg = await loadConfig();
  const rows = await getSheetValues(`${CLIENTES_SHEET}!A2:H`);
  const me = rows.find((r) => String(r[0] || "") === String(ctx.chat.id));
  const sellos = me ? parseNumber(me[3], 0) : 0;

  const montoPorSello = parseNumber(cfg.MontoPorSello || "10000", 10000);
  const caption = [
    `🎟️ <b>Sellos</b>\n`,
    `Tenés <b>${sellos}</b> sellos acumulados.`,
    `\n📌 Cada <b>${money(montoPorSello, cfg.Moneda || "ARS")}</b> = <b>1 sello</b>.`,
    `\n✨ Si venís por link de referido y comprás, tu referente gana <b>1 sello</b>.`,
  ].join("\n");

  await safeEditOrSend(ctx, { text: caption, extra: mainMenuKeyboard() });
}

async function showHelp(ctx) {
  const cfg = await loadConfig();
  const nombre = cfg.NegocioNombre || "Todo Queso";
  const waNum = (cfg.NegocioTelefono || "").replace(/[^\d]/g, "");
  const waLink = waNum ? `https://wa.me/${waNum}` : "";

  const text = [
    `ℹ️ <b>Ayuda - ${nombre}</b>\n`,
    `• ¿No encontraste algo? Decime qué buscás y te ayudo.`,
    `• ¿Querés sugerir un producto o combo? Contame.`,
    `• Si necesitás hablar con un vendedor, tocá el botón 👇`,
  ].join("\n");

  const kb = Markup.inlineKeyboard([
    ...(waLink ? [[Markup.button.url("📲 Contactar vendedor (WhatsApp)", waLink)]] : []),
    [Markup.button.callback("🏠 Menú", "GO_MENU")],
  ]);

  await safeEditOrSend(ctx, { text, extra: kb });
}

async function showShareBot(ctx) {
  const cfg = await loadConfig();
  const botLink = BOT_LINK_ENV || cfg.BotLink || cfg.Botlink || "";
  const text = `🧀 Mirá el bot de ${cfg.NegocioNombre || "Todo Queso"} y elegí tu pedido:`;
  if (!botLink) {
    await safeEditOrSend(ctx, { text: "Falta <b>BotLink</b> en Config para compartir.", extra: backMenuKeyboard() });
    return;
  }
  const links = buildShareLinks({ botLink, text });
  await safeEditOrSend(ctx, { text: `📣 <b>Compartir bot</b>\n\nElegí dónde compartir 👇`, extra: shareKeyboard(links) });
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
  const text = `🧀 ${cfg.NegocioNombre || "Todo Queso"} — ${p.name} (${money(p.price, moneda)})\nEntrá acá para verlo y comprar 👇`;
  const links = buildShareLinks({ botLink: deepLink, text });

  await safeEditOrSend(ctx, {
    text: `🔗 <b>Compartir producto</b>\n\nElegí dónde compartir 👇`,
    extra: shareKeyboard(links),
  });
}

/* =========================
   TELEGRAM BOT
========================= */
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
        const prod = s2.productsInView[idx];
        const caption = productCaption(cfg, prod, idx, s2.productsInView.length);
        const photo = prod.img && prod.img.startsWith("http") ? prod.img : undefined;
        if (photo) await safeEditOrSend(ctx, { photo, caption, extra: productKeyboard(prod) });
        else await safeEditOrSend(ctx, { text: caption, extra: productKeyboard(prod) });
      }
    }
  }
});

bot.hears(/^(menu|menú)$/i, showMenu);
bot.hears(/^cat[aá]logo$/i, showCategories);
bot.hears(/^sellos$/i, showSellos);
bot.hears(/^ayuda$/i, showHelp);

// Si está editando peso, captura texto
bot.on("text", async (ctx) => {
  const sess = getSess(ctx.chat.id);
  if (!sess._editingCode) return;

  const raw = String(ctx.message.text || "").trim().replace(",", ".");
  const num = parseFloat(raw);
  if (!Number.isFinite(num) || num <= 0) {
    await ctx.reply("Ingresá un número válido (ej: 250 o 0.25).");
    return;
  }

  // si ingresa > 10 asumimos gramos; si <= 10 asumimos kg
  const kg = num > 10 ? (num / 1000) : num;

  const item = sess.cart.find((x) => x.code === sess._editingCode);
  if (item) {
    item.qty = kg;
    item.qtyText = num > 10 ? `${Math.round(num)} g` : `${kg} kg`;
  }
  sess._editingCode = null;

  await showCart(ctx);
});

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

bot.action(/^ADD_(.+)$/i, async (ctx) => {
  await ctx.answerCbQuery("Agregado ✅");
  const sess = getSess(ctx.chat.id);
  const code = ctx.match[1];
  const p = sess.productsInView.find((x) => x.code === code);
  if (!p) return;
  adjustCart(sess, p);

  // si es por kg, pedimos el peso inmediatamente
  if (p.unit === "kg") {
    sess._editingCode = p.code;
    await safeEditOrSend(ctx, {
      text: `⚖️ <b>${p.name}</b>\n\nIngresá el peso en gramos (ej: 250) o en kg (ej: 0.25).`,
      extra: Markup.inlineKeyboard([[Markup.button.callback("❌ Cancelar", "GO_CART")]]),
    });
    return;
  }
});

bot.action("GO_CART", async (ctx) => { await ctx.answerCbQuery(); await showCart(ctx); });

bot.action("CART_CLEAR", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  sess.cart = [];
  sess._editingCode = null;
  await showCart(ctx);
});

bot.action("CART_EDIT", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  if (!sess.cart.length) return;

  // edita el último item para hacerlo simple
  const last = sess.cart[sess.cart.length - 1];
  sess._editingCode = last.code;

  if (last.unit === "kg") {
    await safeEditOrSend(ctx, {
      text: `⚖️ <b>${last.name}</b>\n\nIngresá el peso en gramos (ej: 250) o en kg (ej: 0.25).`,
      extra: Markup.inlineKeyboard([[Markup.button.callback("❌ Cancelar", "GO_CART")]]),
    });
  } else {
    await safeEditOrSend(ctx, {
      text: `🔢 <b>${last.name}</b>\n\nIngresá cantidad (ej: 2).`,
      extra: Markup.inlineKeyboard([[Markup.button.callback("❌ Cancelar", "GO_CART")]]),
    });
  }
});

bot.action("CHK_DELIVERY", async (ctx) => { await ctx.answerCbQuery(); await showDelivery(ctx); });

bot.action("DELIVERY_ENVIO", async (ctx) => { await ctx.answerCbQuery(); getSess(ctx.chat.id)._entrega = "ENVIO"; await showPayment(ctx, "ENVIO"); });
bot.action("DELIVERY_RETIRO", async (ctx) => { await ctx.answerCbQuery(); getSess(ctx.chat.id)._entrega = "RETIRO"; await showPayment(ctx, "RETIRO"); });
bot.action("DELIVERY_EXPRESS", async (ctx) => { await ctx.answerCbQuery(); getSess(ctx.chat.id)._entrega = "EXPRESS"; await showPayment(ctx, "EXPRESS"); });

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

bot.action(/^SHARE_PROD_(.+)$/i, async (ctx) => {
  await ctx.answerCbQuery();
  const code = ctx.match[1];
  await showShareProduct(ctx, code);
});

/* =========================
   WEB SERVER (Render)
========================= */
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.status(200).send("EzerBot OK ✅"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

const PORT = process.env.PORT || 10000;

async function start() {
  await ensureBaseSheets();

  // Webhook si hay PUBLIC_URL, si no long polling
  if (PUBLIC_URL && PUBLIC_URL.startsWith("http")) {
    const hook = `${PUBLIC_URL.replace(/\/$/, "")}/telegram`;
    await bot.telegram.setWebhook(hook);
    app.use(bot.webhookCallback("/telegram"));
    app.listen(PORT, () => console.log(`✅ Webhook: ${hook} | Puerto ${PORT}`));
  } else {
    bot.launch();
    app.listen(PORT, () => console.log(`✅ Long-polling | Puerto ${PORT}`));
  }
}

start().catch((e) => {
  console.error("FATAL:", e?.message || e);
  process.exit(1);
});

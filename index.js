import express from "express";
import { Telegraf, Markup } from "telegraf";
import { google } from "googleapis";

/* =========================
   ENV
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
      requestBody: {
        requests: [{ addSheet: { properties: { title: sheetName } } }],
      },
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
    const key = String(h || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/[^\wáéíóúüñ]/g, "");
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

async function loadCatalog() {
  const rows = await getSheetValues(`Catalogo!A1:Z`);
  if (!rows.length) return { items: [] };
  const headerRow = rows[0];
  const hmap = normalizeHeaders(headerRow);
  const data = rows.slice(1).filter((r) => r.some((c) => String(c || "").trim() !== ""));

  const items = data.map((r, i) => {
    const code = String(pick(r, hmap, ["codigo", "codigoproducto", "sku", "id"], "")).trim() || `P${i + 1}`;
    const name = String(pick(r, hmap, ["nombre", "producto", "name"], "Producto")).trim();
    const price = parseNumber(pick(r, hmap, ["precio", "price"], 0), 0);
    const cat = String(pick(r, hmap, ["categoria", "categoría", "rubro"], "General")).trim() || "General";
    const img = String(pick(r, hmap, ["imagenurl", "imagen", "foto", "urlimagen"], "")).trim();
    const desc = String(pick(r, hmap, ["descripcion", "descripción", "detalle"], "")).trim();
    const activo = String(pick(r, hmap, ["activo", "habilitado"], "SI")).trim();
    return { code, name, price, cat, img, desc, activo };
  }).filter(p => String(p.activo).toLowerCase() !== "no");

  return { items };
}

function categoriesFromItems(items) {
  const set = new Set();
  for (const it of items) set.add(it.cat || "General");
  return Array.from(set).sort((a, b) => a.localeCompare(b, "es"));
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
      cart: [], // {code,name,price,qty}
      refBy: null, // chatId del referente (si llega por start)
      lastMessageId: null, // para editar
      checkout: { entrega: null, pago: null },
      pendingHelpTopic: null, // "NO_ENCONTRE" | "SUGERENCIA" | "COMENTARIO"
    });
  }
  return SESS.get(chatId);
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
            caption: payload.caption || " ",
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
    // si falla editar, manda nuevo
  }

  let msg;
  if (payload.photo) {
    msg = await ctx.replyWithPhoto(payload.photo, {
      caption: payload.caption || " ",
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

function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🧀 Catálogo", "MENU_CATALOGO")],
    [Markup.button.callback("🎟️ Sellos", "MENU_SELLOS"), Markup.button.callback("🤝 Ayuda", "MENU_AYUDA")],
    [Markup.button.callback("📣 Compartir", "MENU_COMPARTIR")],
  ]);
}

function backMenuKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback("🏠 Menú", "GO_MENU")]]);
}

/* =========================
   DEEPLINK (ref + producto)
   - BotLink debe ser del estilo: https://t.me/NOMBRE_DEL_BOT
========================= */
function buildTelegramDeepLink(botLink, payload) {
  // soporta https://t.me/botuser o t.me/botuser
  const clean = String(botLink || "").trim();
  const m = clean.match(/t\.me\/([A-Za-z0-9_]+)/);
  if (!m) return ""; // no se puede armar deeplink
  const username = m[1];
  return `https://t.me/${username}?start=${encodeURIComponent(payload)}`;
}

function buildShareLinks({ deepLink, text }) {
  const url = encodeURIComponent(deepLink);
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
async function loadConfig() {
  const rows = await getSheetValues(`Config!A:B`);
  return kvFromRows(rows);
}

function productCaption(cfg, p, index, total) {
  const moneda = cfg.Moneda || "ARS";
  const showPrice = parseYes(cfg.CatalogoMostrarPrecios || "SI");
  const lines = [];
  lines.push(`<b>${p.name}</b>`);
  if (showPrice) lines.push(`💰 <b>${money(p.price, moneda)}</b>`);
  if (p.desc) lines.push(`\n${p.desc}`);
  lines.push(`\n📌 ${p.cat}`);
  lines.push(`\n<code>${index + 1}/${total}</code>`);
  return lines.join("\n");
}

function productKeyboard(p) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⬅️", "PROD_PREV"), Markup.button.callback("➡️", "PROD_NEXT")],
    [Markup.button.callback("🛒 Agregar", `ADD_${p.code}`), Markup.button.callback("✅ Comprar", "GO_CART")],
    [Markup.button.callback("🔗 Compartir este producto", `SHARE_PROD_${p.code}`)],
    [Markup.button.callback("🏠 Menú", "GO_MENU")],
  ]);
}

function cartText(cfg, cart) {
  const moneda = cfg.Moneda || "ARS";
  if (!cart.length) return `🛒 <b>Carrito</b>\n\nTu carrito está vacío.\n\nVolvé al <b>Catálogo</b> para agregar productos.`;
  const lines = [];
  lines.push(`🛒 <b>Carrito</b>\n`);
  let total = 0;
  cart.forEach((it, i) => {
    const sub = it.price * it.qty;
    total += sub;
    lines.push(`${i + 1}) <b>${it.name}</b>\n   x${it.qty} — ${money(sub, moneda)}`);
  });
  lines.push(`\n<b>Total:</b> ${money(total, moneda)}`);
  return lines.join("\n");
}

function cartKeyboard(cart) {
  const rows = [];
  if (cart.length) {
    rows.push([Markup.button.callback("➖ Quitar 1", "CART_DEC"), Markup.button.callback("🗑️ Vaciar", "CART_CLEAR")]);
    rows.push([Markup.button.callback("✅ Finalizar compra", "CHK_DELIVERY")]);
  }
  rows.push([Markup.button.callback("🧀 Seguir mirando", "MENU_CATALOGO")]);
  rows.push([Markup.button.callback("🏠 Menú", "GO_MENU")]);
  return Markup.inlineKeyboard(rows);
}

function deliveryKeyboard(cfg) {
  const rows = [];
  if (parseYes(cfg.UsaEnvioDomicilio || "SI")) rows.push([Markup.button.callback("🚚 Envío a domicilio", "DELIVERY_ENVIO")]);
  if (parseYes(cfg.UsaRetiroLocal || "SI")) rows.push([Markup.button.callback("🏪 Retiro en el local", "DELIVERY_RETIRO")]);
  if (parseYes(cfg.EnvioExpress || "NO")) rows.push([Markup.button.callback("⚡ Envío express", "DELIVERY_EXPRESS")]);
  rows.push([Markup.button.callback("⬅️ Volver al carrito", "GO_CART")]);
  return Markup.inlineKeyboard(rows);
}

function payKeyboard(cfg) {
  const rows = [];
  // Transferencia (si está habilitado)
  if (parseYes(cfg.PermitePagoOnline || "SI")) {
    const tipo = (cfg.TipoPagoOnline || "TRANSFERENCIA").toUpperCase();
    rows.push([Markup.button.callback(`💳 ${tipo}`, `PAY_${tipo}`)]);
  }
  rows.push([Markup.button.callback("💵 Efectivo", "PAY_EFECTIVO")]);
  rows.push([Markup.button.callback("⬅️ Volver", "CHK_DELIVERY")]);
  return Markup.inlineKeyboard(rows);
}

function sellosText(cfg, sellos) {
  const montoPorSello = parseNumber(cfg.MontoPorSello || "10000", 10000);
  const beneficios = (cfg.BeneficiosPorNivel || "").trim();
  const sellosPorNivel = (cfg.SellosPorNivel || "").trim();
  const moneda = cfg.Moneda || "ARS";

  const lines = [];
  lines.push(`🎟️ <b>Sellos</b>\n`);
  lines.push(`Tenés <b>${sellos}</b> sellos acumulados.`);
  lines.push(`\n📌 Cada <b>${money(montoPorSello, moneda)}</b> = <b>1 sello</b>.`);

  if (sellosPorNivel) {
    lines.push(`\n🏅 <b>Escalones</b>`);
    lines.push(`${sellosPorNivel}`);
  }
  if (beneficios) {
    lines.push(`\n🎁 <b>Beneficios</b>`);
    lines.push(`${beneficios}`);
  }

  lines.push(`\n🤝 Por referido: si alguien entra por tu link y compra, ganás <b>1 sello</b> (sin importar el valor).`);
  return lines.join("\n");
}

/* =========================
   FLOWS
========================= */
async function showMenu(ctx) {
  const cfg = await loadConfig();

  const nombre = cfg.NegocioNombre || "Tu Negocio";
  const dire = cfg.NegocioDireccion || "";
  const hora = cfg.NegocioHorario || "";
  const estado = cfg.Estado || ""; // Abierto/Cerrado/Vacaciones

  const header = [];
  header.push(`🏠 <b>${nombre}</b>`);
  if (estado) header.push(`🟢 <b>${estado}</b>`);
  if (dire) header.push(`📍 ${dire}`);
  if (hora) header.push(`🕒 ${hora}`);

  const desc = cfg.Descripcion || "";
  const txt = `${header.join("\n")}\n\n${desc}\n\n¿Qué querés hacer? 👇`;

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

async function showProductCarousel(ctx, cat, jumpToCode = null) {
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

  let idx = 0;
  if (jumpToCode) {
    const found = prods.findIndex((x) => x.code === jumpToCode);
    if (found >= 0) idx = found;
  }
  sess.productIndex = idx;

  const p = prods[idx];
  const caption = productCaption(cfg, p, idx, prods.length);

  const photo = p.img && p.img.startsWith("http") ? p.img : undefined;
  if (photo) await safeEditOrSend(ctx, { photo, caption, extra: productKeyboard(p) });
  else await safeEditOrSend(ctx, { text: caption, extra: productKeyboard(p) });
}

function adjustCart(sess, product, delta = 1) {
  const found = sess.cart.find((x) => x.code === product.code);
  if (!found) {
    sess.cart.push({ code: product.code, name: product.name, price: product.price, qty: Math.max(1, delta) });
  } else {
    found.qty += delta;
    if (found.qty <= 0) {
      sess.cart = sess.cart.filter((x) => x.code !== product.code);
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
  await safeEditOrSend(ctx, {
    text: `🚚 <b>Entrega</b>\n\n¿Cómo querés recibir tu pedido? 👇`,
    extra: deliveryKeyboard(cfg),
  });
}

async function showPayment(ctx, entregaTipo) {
  const cfg = await loadConfig();
  const moneda = cfg.Moneda || "ARS";
  const costoEnvio = parseNumber(cfg.CostoEnvio || "0", 0);

  let extraText = "";
  if (entregaTipo === "ENVIO" || entregaTipo === "EXPRESS") {
    extraText = `\n\n💡 Costo de envío: <b>${money(costoEnvio, moneda)}</b>\n${cfg.TextoEnvioDomicilio || ""}`;
  } else {
    extraText = `\n\n🏪 ${cfg.TextoRetiroLocal || ""}`;
  }

  await safeEditOrSend(ctx, {
    text: `💳 <b>Pago</b>\n\nElegí cómo vas a pagar 👇${extraText}`,
    extra: payKeyboard(cfg),
  });
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

  // Totales
  const moneda = cfg.Moneda || "ARS";
  const costoEnvio = parseNumber(cfg.CostoEnvio || "0", 0);

  let subtotal = 0;
  const itemsText = sess.cart.map((it) => {
    const sub = it.price * it.qty;
    subtotal += sub;
    return `${it.name} x${it.qty} (${money(sub, moneda)})`;
  }).join(" | ");

  let total = subtotal;
  if (entregaTipo === "ENVIO" || entregaTipo === "EXPRESS") total += costoEnvio;

  // Sellos por compra
  const usaSellos = parseYes(cfg.UsaSellos || "SI");
  const montoPorSello = parseNumber(cfg.MontoPorSello || "10000", 10000);
  const sellosGanados = usaSellos ? Math.floor(total / montoPorSello) : 0;

  // Guardar cliente + sumar sellos
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

  // Registrar pedido
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

  // Referido: 1 sello al referente si existía (SIN importar valor)
  if (sess.refBy) {
    await addSelloReferido(sess.refBy);
  }

  // Link WhatsApp negocio
  const wa = (cfg.NegocioTelefono || "").replace(/[^\d]/g, "");
  const waLink = wa ? `https://wa.me/${wa}` : (cfg.WhatsAppLink || "");

  const msg = [];
  msg.push(`✅ <b>Pedido registrado</b>`);
  msg.push(`\n<b>Detalle:</b>`);
  sess.cart.forEach((it) => msg.push(`• ${it.name} x${it.qty}`));
  msg.push(`\n<b>Subtotal:</b> ${money(subtotal, moneda)}`);
  if (entregaTipo === "ENVIO" || entregaTipo === "EXPRESS") msg.push(`<b>Envío:</b> ${money(costoEnvio, moneda)}`);
  msg.push(`<b>Total:</b> ${money(total, moneda)}`);
  msg.push(`\n<b>Entrega:</b> ${entregaTipo}`);
  msg.push(`<b>Pago:</b> ${pagoTipo}`);

  if (usaSellos) msg.push(`\n🎟️ Sellos ganados: <b>${sellosGanados}</b>`);
  if (sess.refBy) msg.push(`🤝 Compra por referido: tu referente gana <b>1 sello</b>.`);

  if (waLink) msg.push(`\n📲 Confirmalo por WhatsApp:\n${waLink}`);

  // limpiar carrito
  sess.cart = [];
  sess.checkout = { entrega: null, pago: null };

  await safeEditOrSend(ctx, {
    text: msg.join("\n"),
    extra: Markup.inlineKeyboard([
      [Markup.button.callback("🎟️ Ver mis sellos", "MENU_SELLOS")],
      [Markup.button.callback("🧀 Seguir comprando", "MENU_CATALOGO")],
      [Markup.button.callback("🏠 Menú", "GO_MENU")],
    ]),
  });
}

async function showSellos(ctx) {
  const cfg = await loadConfig();
  const rows = await getSheetValues(`${CLIENTES_SHEET}!A2:H`);
  const me = rows.find((r) => String(r[0] || "") === String(ctx.chat.id));
  const sellos = me ? parseNumber(me[3], 0) : 0;

  const cardUrl = (cfg.CARD_URL || cfg.CardURL || cfg.CARDURL || "").trim();

  const caption = sellosText(cfg, sellos);
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("🧀 Catálogo", "MENU_CATALOGO")],
    [Markup.button.callback("🏠 Menú", "GO_MENU")],
  ]);

  if (cardUrl && cardUrl.startsWith("http")) {
    await safeEditOrSend(ctx, { photo: cardUrl, caption, extra: keyboard });
  } else {
    await safeEditOrSend(ctx, { text: caption, extra: keyboard });
  }
}

/* ====== AYUDA “ASISTENTE REAL” ====== */
function helpKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔎 No encontré un producto", "HELP_NO_ENCONTRE")],
    [Markup.button.callback("💡 Sugerencia", "HELP_SUGERENCIA")],
    [Markup.button.callback("💬 Comentario", "HELP_COMENTARIO")],
    [Markup.button.callback("🏠 Menú", "GO_MENU")],
  ]);
}

async function showHelp(ctx) {
  const cfg = await loadConfig();
  const nombre = cfg.NegocioNombre || "Todo Queso";
  const text = [
    `🤝 <b>Ayuda - ${nombre}</b>\n`,
    `Estoy acá para ayudarte a comprar rápido 🙂`,
    `\n¿Te faltó algo? ¿No encontraste un producto?`,
    `¿Querés sugerir una promo o hacer un comentario?`,
    `\nElegí una opción 👇`,
  ].join("\n");

  await safeEditOrSend(ctx, { text, extra: helpKeyboard() });
}

function buildWhatsAppToNegocio(cfg, message) {
  const wa = (cfg.NegocioTelefono || "").replace(/[^\d]/g, "");
  if (!wa) return "";
  const txt = encodeURIComponent(message);
  return `https://wa.me/${wa}?text=${txt}`;
}

async function promptHelpText(ctx, topic) {
  const sess = getSess(ctx.chat.id);
  sess.mode = "HELP_TEXT";
  sess.pendingHelpTopic = topic;

  let title = "Ayuda";
  if (topic === "NO_ENCONTRE") title = "No encontré un producto";
  if (topic === "SUGERENCIA") title = "Sugerencia";
  if (topic === "COMENTARIO") title = "Comentario";

  const text = [
    `📝 <b>${title}</b>\n`,
    `Escribime en un mensaje (corto) qué necesitás.`,
    `\nDespués te doy el botón para mandarlo por WhatsApp al local ✅`,
  ].join("\n");

  await safeEditOrSend(ctx, {
    text,
    extra: Markup.inlineKeyboard([[Markup.button.callback("⬅️ Volver", "MENU_AYUDA")]]),
  });
}

/* ====== COMPARTIR BOT (con mail de Config) ====== */
async function showShareBot(ctx) {
  const cfg = await loadConfig();
  const botLink = BOT_LINK_ENV || cfg.BotLink || cfg.Botlink || "";
  const email = cfg.EmailSistema || cfg.Email || cfg.EmailDelSistema || "";

  if (!botLink) {
    await safeEditOrSend(ctx, { text: "Falta <b>BotLink</b> en Config para compartir.", extra: backMenuKeyboard() });
    return;
  }

  const textShare = [
    `🧀 Mirá el bot de ${cfg.NegocioNombre || "Todo Queso"} y elegí tu pedido.`,
    email ? `\n¿Querés un sistema igual para tu negocio? Escribinos: ${email}` : ``,
  ].filter(Boolean).join("\n");

  const links = buildShareLinks({ deepLink: botLink, text: textShare });

  await safeEditOrSend(ctx, {
    text: `📣 <b>Compartir bot</b>\n\nElegí dónde compartir 👇`,
    extra: shareKeyboard(links),
  });
}

/* ====== COMPARTIR PRODUCTO (ref + producto directo) ====== */
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

  // payload: ref_<chatId>__prod_<codigo>
  const payload = `ref_${ctx.chat.id}__prod_${p.code}`;
  const deep = buildTelegramDeepLink(botLink, payload) || botLink;

  const moneda = cfg.Moneda || "ARS";
  const textShare = `🧀 Promo: ${p.name} — ${money(p.price, moneda)}\nAbrí el link para verlo y comprarlo 👇`;

  const links = buildShareLinks({ deepLink: deep, text: textShare });

  await safeEditOrSend(ctx, {
    text: `🔗 <b>Compartir producto</b>\n\n${p.name}\n\nElegí dónde compartir 👇`,
    extra: shareKeyboard(links),
  });
}

/* =========================
   TELEGRAM BOT
========================= */
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

/* Start + parse referrals */
bot.start(async (ctx) => {
  await ensureBaseSheets();

  const sess = getSess(ctx.chat.id);

  // Parse /start payload: ref_123__prod_P1
  const payload = (ctx.startPayload || "").trim();
  let jumpProd = null;
  if (payload) {
    const mRef = payload.match(/ref_(\d+)/);
    if (mRef) sess.refBy = Number(mRef[1]);
    const mProd = payload.match(/prod_([^_]+)/);
    if (mProd) jumpProd = decodeURIComponent(mProd[1]);
  }

  await showMenu(ctx);

  // Si llegó por producto, lo mostramos listo para comprar
  if (jumpProd) {
    const { items } = await loadCatalog();
    const p = items.find((x) => x.code === jumpProd);
    if (p) await showProductCarousel(ctx, p.cat || "General", p.code);
  }
});

/* Text fallbacks */
bot.hears(/^(menu|menú)$/i, showMenu);
bot.hears(/^cat[aá]logo$/i, showCategories);
bot.hears(/^sellos$/i, showSellos);
bot.hears(/^ayuda$/i, showHelp);

/* Captura texto de ayuda (asistente) */
bot.on("text", async (ctx) => {
  const sess = getSess(ctx.chat.id);
  if (sess.mode !== "HELP_TEXT") return; // no intercepta lo demás

  const cfg = await loadConfig();
  const topic = sess.pendingHelpTopic || "AYUDA";
  const userText = String(ctx.message.text || "").trim().slice(0, 800);

  let prefix = "Ayuda";
  if (topic === "NO_ENCONTRE") prefix = "No encontré";
  if (topic === "SUGERENCIA") prefix = "Sugerencia";
  if (topic === "COMENTARIO") prefix = "Comentario";

  const msg = `Hola! ${prefix}: ${userText}`;
  const waLink = buildWhatsAppToNegocio(cfg, msg);

  sess.mode = "MENU";
  sess.pendingHelpTopic = null;

  if (waLink) {
    await safeEditOrSend(ctx, {
      text: `✅ Perfecto. ¿Querés enviarlo al local por WhatsApp?\n\n<b>${prefix}:</b> ${userText}`,
      extra: Markup.inlineKeyboard([
        [Markup.button.url("📲 Enviar por WhatsApp", waLink)],
        [Markup.button.callback("🏠 Menú", "GO_MENU")],
      ]),
    });
  } else {
    await safeEditOrSend(ctx, {
      text: `✅ Guardado.\n\n<b>${prefix}:</b> ${userText}\n\n(No tengo teléfono en Config para armar WhatsApp.)`,
      extra: backMenuKeyboard(),
    });
  }
});

/* Inline actions */
bot.action("GO_MENU", async (ctx) => { await ctx.answerCbQuery(); await showMenu(ctx); });
bot.action("MENU_CATALOGO", async (ctx) => { await ctx.answerCbQuery(); await showCategories(ctx); });
bot.action("MENU_SELLOS", async (ctx) => { await ctx.answerCbQuery(); await showSellos(ctx); });
bot.action("MENU_AYUDA", async (ctx) => { await ctx.answerCbQuery(); await showHelp(ctx); });
bot.action("MENU_COMPARTIR", async (ctx) => { await ctx.answerCbQuery(); await showShareBot(ctx); });

bot.action("HELP_NO_ENCONTRE", async (ctx) => { await ctx.answerCbQuery(); await promptHelpText(ctx, "NO_ENCONTRE"); });
bot.action("HELP_SUGERENCIA", async (ctx) => { await ctx.answerCbQuery(); await promptHelpText(ctx, "SUGERENCIA"); });
bot.action("HELP_COMENTARIO", async (ctx) => { await ctx.answerCbQuery(); await promptHelpText(ctx, "COMENTARIO"); });

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
  adjustCart(sess, p, 1);
});

bot.action("GO_CART", async (ctx) => {
  await ctx.answerCbQuery();
  await showCart(ctx);
});

bot.action("CART_CLEAR", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  sess.cart = [];
  await showCart(ctx);
});

bot.action("CART_DEC", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  if (!sess.cart.length) return;
  const last = sess.cart[sess.cart.length - 1];
  last.qty -= 1;
  if (last.qty <= 0) sess.cart.pop();
  await showCart(ctx);
});

bot.action("CHK_DELIVERY", async (ctx) => {
  await ctx.answerCbQuery();
  await showDelivery(ctx);
});

bot.action("DELIVERY_ENVIO", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  sess.checkout.entrega = "ENVIO";
  await showPayment(ctx, "ENVIO");
});

bot.action("DELIVERY_RETIRO", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  sess.checkout.entrega = "RETIRO";
  await showPayment(ctx, "RETIRO");
});

bot.action("DELIVERY_EXPRESS", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  sess.checkout.entrega = "EXPRESS";
  await showPayment(ctx, "EXPRESS");
});

bot.action(/^PAY_(.+)$/i, async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  const pagoTipo = ctx.match[1] || "TRANSFERENCIA";
  const entregaTipo = sess.checkout.entrega || "RETIRO";
  await finalizeOrder(ctx, { entregaTipo, pagoTipo });
});

bot.action("PAY_EFECTIVO", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  const entregaTipo = sess.checkout.entrega || "RETIRO";
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

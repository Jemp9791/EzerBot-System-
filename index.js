// index.js  (ESM)
// ✅ Mantiene tu UI “ojo/carrusel” (edita el mismo mensaje)
// ✅ NO cambia más nombres de ENV: usa BOT_TOKEN, GOOGLE_SERVICE_ACCOUNT, GOOGLE_SHEET_ID, PUBLIC_URL
// ✅ Soporta GOOGLE_SERVICE_ACCOUNT en Base64 o JSON directo
// ✅ Incluye endpoint /config (para que NO exista “Cannot GET /config” si alguien lo pide)

import express from "express";
import { Telegraf, Markup } from "telegraf";
import { google } from "googleapis";

/* =========================
   ENV (FIJAS)
========================= */
const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;

// Acepta ambos nombres por compatibilidad, pero NO te obliga a crear otro:
const GOOGLE_SERVICE_ACCOUNT_RAW =
  process.env.GOOGLE_SERVICE_ACCOUNT_B64 || process.env.GOOGLE_SERVICE_ACCOUNT;

const PUBLIC_URL = process.env.PUBLIC_URL || "";
const BOT_LINK_ENV = process.env.BOT_LINK || ""; // opcional, si lo usás

if (!TELEGRAM_BOT_TOKEN) throw new Error("Falta ENV BOT_TOKEN");
if (!GOOGLE_SHEET_ID) throw new Error("Falta ENV GOOGLE_SHEET_ID");
if (!GOOGLE_SERVICE_ACCOUNT_RAW)
  throw new Error("Falta ENV GOOGLE_SERVICE_ACCOUNT (o GOOGLE_SERVICE_ACCOUNT_B64)");

/* =========================
   GOOGLE AUTH
========================= */
function parseServiceAccount(raw) {
  const s = String(raw || "").trim();
  // Si parece JSON, úsalo directo
  if (s.startsWith("{") && s.endsWith("}")) {
    try {
      return JSON.parse(s);
    } catch {
      throw new Error("GOOGLE_SERVICE_ACCOUNT parece JSON pero no parsea.");
    }
  }
  // Si no, asumimos Base64
  try {
    const decoded = Buffer.from(s, "base64").toString("utf8").trim();
    return JSON.parse(decoded);
  } catch {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT no es JSON y tampoco Base64 JSON válido."
    );
  }
}

const sa = parseServiceAccount(GOOGLE_SERVICE_ACCOUNT_RAW);

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
      .replace(/\s+/g, "");
    if (key) map[key] = i;
  });
  return map;
}

function pick(row, hmap, keys, def = "") {
  for (const k of keys) {
    const idx = hmap[k];
    if (idx !== undefined && row[idx] !== undefined && row[idx] !== "")
      return row[idx];
  }
  return def;
}

/* =========================
   IN-MEMORY STATE (chat limpio)
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
      refBy: null, // chatId del referente
      lastMessageId: null, // para editar
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

async function upsertCliente({
  chatId,
  nombre,
  usuario,
  addSellos = 0,
  addTotal = 0,
  refBy = "",
}) {
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

  const rowNumber = idx + 2; // arranca en A2
  await setSheetValues(`${CLIENTES_SHEET}!A${rowNumber}:H${rowNumber}`, [
    [
      String(chatId),
      nombre || row[1] || "",
      usuario || row[2] || "",
      newSellos,
      newTotal,
      now,
      row[6] || refBy || "",
      currentRefGanados,
    ],
  ]);

  return { sellos: newSellos, referidosGanados: currentRefGanados };
}

async function addSelloReferido(chatIdReferente) {
  const rows = await getSheetValues(`${CLIENTES_SHEET}!A2:H`);
  const idx = rows.findIndex(
    (r) => String(r[0] || "") === String(chatIdReferente)
  );
  if (idx === -1) return;

  const row = rows[idx];
  const currentSellos = parseNumber(row[3], 0);
  const currentRefGanados = parseNumber(row[7], 0);
  const rowNumber = idx + 2;

  await setSheetValues(`${CLIENTES_SHEET}!A${rowNumber}:H${rowNumber}`, [
    [
      row[0] || "",
      row[1] || "",
      row[2] || "",
      currentSellos + 1,
      row[4] || 0,
      new Date().toISOString(),
      row[6] || "",
      currentRefGanados + 1,
    ],
  ]);
}

/* =========================
   UI HELPERS (editar mensaje)
========================= */
async function safeEditOrSend(ctx, payload) {
  const chatId = ctx.chat?.id;
  const sess = chatId ? getSess(chatId) : null;

  const canEdit = !!sess?.lastMessageId;

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
    // si falla editar, enviamos nuevo
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
   KEYBOARDS
========================= */
function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🧀 Catálogo", "MENU_CATALOGO")],
    [
      Markup.button.callback("🎟️ Sellos", "MENU_SELLOS"),
      Markup.button.callback("ℹ️ Ayuda", "MENU_AYUDA"),
    ],
    [Markup.button.callback("📣 Compartir", "MENU_COMPARTIR")],
  ]);
}

function backMenuKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback("🏠 Menú", "GO_MENU")]]);
}

/* =========================
   DATA LOADERS
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
  const data = rows
    .slice(1)
    .filter((r) => r.some((c) => String(c || "").trim() !== ""));

  const items = data.map((r) => {
    const code = String(
      pick(r, hmap, ["codigo", "codigoproducto", "id", "sku"], "")
    ).trim();
    const name = String(pick(r, hmap, ["nombre", "producto", "name"], "Producto")).trim();
    const price = parseNumber(pick(r, hmap, ["precio", "price"], 0), 0);
    const cat = String(pick(r, hmap, ["categoria", "categoría", "rubro"], "General")).trim() || "General";
    const img = String(pick(r, hmap, ["imagenurl", "imagen", "foto", "urlimagen"], "")).trim();
    const desc = String(pick(r, hmap, ["descripcion", "descripción", "detalle"], "")).trim();
    const isCombo = String(pick(r, hmap, ["combo", "escombo"], "")).trim();

    return { code, name, price, cat, img, desc, isCombo };
  });

  items.forEach((it, i) => {
    if (!it.code) it.code = `P${i + 1}`;
  });

  return { items, headers: hmap };
}

function categoriesFromItems(items) {
  const set = new Set();
  for (const it of items) set.add(it.cat || "General");
  return Array.from(set).sort((a, b) => a.localeCompare(b, "es"));
}

/* =========================
   UI BUILDERS
========================= */
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
    [
      Markup.button.callback("⬅️", "PROD_PREV"),
      Markup.button.callback("➡️", "PROD_NEXT"),
    ],
    [
      Markup.button.callback("🛒 Agregar", `ADD_${p.code}`),
      Markup.button.callback("✅ Comprar", "GO_CART"),
    ],
    [Markup.button.callback("🔗 Compartir", `SHARE_PROD_${p.code}`)],
    [Markup.button.callback("🏠 Menú", "GO_MENU")],
  ]);
}

function cartText(cfg, cart) {
  const moneda = cfg.Moneda || "ARS";
  if (!cart.length)
    return `🛒 <b>Carrito</b>\n\nTu carrito está vacío.\n\nUsá <b>Catálogo</b> para agregar productos.`;

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
    rows.push([
      Markup.button.callback("➖ Quitar 1", "CART_DEC"),
      Markup.button.callback("🗑️ Vaciar", "CART_CLEAR"),
    ]);
    rows.push([Markup.button.callback("🚚 Entrega", "CHK_DELIVERY")]);
  }
  rows.push([Markup.button.callback("🧀 Seguir en Catálogo", "MENU_CATALOGO")]);
  rows.push([Markup.button.callback("🏠 Menú", "GO_MENU")]);
  return Markup.inlineKeyboard(rows);
}

function deliveryKeyboard(cfg) {
  const rows = [];
  if (parseYes(cfg.UsaEnvioDomicilio || "SI"))
    rows.push([Markup.button.callback("🚚 Envío a domicilio", "DELIVERY_ENVIO")]);
  if (parseYes(cfg.UsaRetiroLocal || "SI"))
    rows.push([Markup.button.callback("🏪 Retiro en el local", "DELIVERY_RETIRO")]);
  if (parseYes(cfg.EnvioExpress || "SI"))
    rows.push([Markup.button.callback("⚡ Envío express", "DELIVERY_EXPRESS")]);

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
    [Markup.button.url("📲 Compartir en WhatsApp", links.wa)],
    [Markup.button.url("✈️ Compartir en Telegram", links.tg)],
    [Markup.button.callback("🏠 Menú", "GO_MENU")],
  ]);
}

function sellosText(cfg, sellos) {
  const montoPorSello = parseNumber(cfg.MontoPorSello || "10000", 10000);
  const beneficios = (cfg.BeneficiosPorNivel || "").trim();
  const sellosPorNivel = (cfg.SellosPorNivel || "").trim();

  const lines = [];
  lines.push(`🎟️ <b>Sellos</b>\n`);
  lines.push(`Tenés <b>${sellos}</b> sellos acumulados.`);
  lines.push(`\n📌 Cada <b>${money(montoPorSello, cfg.Moneda || "ARS")}</b> = <b>1 sello</b>.`);

  if (sellosPorNivel) {
    lines.push(`\n🏅 <b>Niveles</b>`);
    lines.push(`${sellosPorNivel}`);
  }
  if (beneficios) {
    lines.push(`\n🎁 <b>Beneficios</b>`);
    lines.push(`${beneficios}`);
  }

  lines.push(`\n✨ Tip: Si alguien compra desde tu link, ganás <b>1 sello</b>.`);
  return lines.join("\n");
}

/* =========================
   SCREENS
========================= */
async function showMenu(ctx) {
  const cfg = await loadConfig();

  const nombre = cfg.NegocioNombre || "Tu Negocio";
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
    row.push(
      Markup.button.callback(`📁 ${cats[i]}`, `CAT_${encodeURIComponent(cats[i])}`)
    );
    if (cats[i + 1])
      row.push(
        Markup.button.callback(`📁 ${cats[i + 1]}`, `CAT_${encodeURIComponent(cats[i + 1])}`)
      );
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
    await safeEditOrSend(ctx, {
      text: `No hay productos en <b>${cat}</b>.`,
      extra: backMenuKeyboard(),
    });
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

function adjustCart(sess, product, delta = 1) {
  const found = sess.cart.find((x) => x.code === product.code);
  if (!found) {
    sess.cart.push({
      code: product.code,
      name: product.name,
      price: product.price,
      qty: Math.max(1, delta),
    });
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
  await safeEditOrSend(ctx, {
    text: `🚚 <b>Entrega</b>\n\nElegí cómo querés recibir tu pedido 👇`,
    extra: deliveryKeyboard(await loadConfig()),
  });
}

async function showPayment(ctx, entregaTipo) {
  const cfg = await loadConfig();
  const extraText =
    entregaTipo === "ENVIO"
      ? `\n\n💡 Costo de envío: <b>${money(parseNumber(cfg.CostoEnvio || "0", 0), cfg.Moneda || "ARS")}</b>\n${cfg.TextoEnvioDomicilio || ""}`
      : entregaTipo === "EXPRESS"
      ? `\n\n⚡ Envío express activo.\n${cfg.TextoEnvioDomicilio || ""}`
      : `\n\n🏪 ${cfg.TextoRetiroLocal || ""}`;

  await safeEditOrSend(ctx, {
    text: `💳 <b>Pago</b>\n\nElegí cómo vas a pagar 👇${extraText}`,
    extra: payKeyboard(cfg),
  });
}

function buildOrderId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `TQ-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours()
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
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
      const sub = it.price * it.qty;
      total += sub;
      return `${it.name} x${it.qty} (${money(sub, moneda)})`;
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
    ...sess.cart.map((it) => `• ${it.name} x${it.qty}`),
    `\n<b>Total:</b> ${money(total, moneda)}`,
    `\n<b>Entrega:</b> ${entregaTipo}`,
    `\n<b>Pago:</b> ${pagoTipo}`,
  ];

  if (sellosGanados > 0) msgCliente.push(`\n🎟️ Sumaste <b>${sellosGanados}</b> sello(s).`);
  if (sess.refBy) msgCliente.push(`\n🎁 Compra por referido: el referente gana <b>1 sello</b>.`);
  if (waLink) msgCliente.push(`\n📲 Si querés, confirmalo por WhatsApp:\n${waLink}`);

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

  const cardUrl = (cfg.CARD_URL || cfg.CardURL || "").trim();
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

async function showHelp(ctx) {
  const cfg = await loadConfig();
  const nombre = cfg.NegocioNombre || "Todo Queso";
  const text = [
    `ℹ️ <b>Ayuda - ${nombre}</b>\n`,
    `• Tocá 🧀 <b>Catálogo</b> y elegí una categoría.`,
    `• Usá ⬅️➡️ para ojeear productos sin llenar el chat.`,
    `• Tocá 🛒 <b>Agregar</b> para armar tu carrito.`,
    `• Tocá ✅ <b>Comprar</b> para elegir entrega y pago.`,
    `• 🎟️ <b>Sellos</b>: se suman automáticamente según Config.`,
    `• 📣 <b>Compartir</b>: podés enviar el bot o un producto por WhatsApp/Telegram.`,
  ].join("\n");

  await safeEditOrSend(ctx, { text, extra: mainMenuKeyboard() });
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
  const text = `🧀 Promo: ${p.name} — ${money(p.price, moneda)}\nTocá el link para ver y comprar 👇`;
  const links = buildShareLinks({ botLink: deepLink, text });

  await safeEditOrSend(ctx, {
    text: `🔗 <b>Compartir producto</b>\n\n${p.name}\n\nElegí dónde compartir 👇`,
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

  // jump directo a producto compartido
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
        const photo =
          prods[idx].img && prods[idx].img.startsWith("http") ? prods[idx].img : undefined;

        if (photo) await safeEditOrSend(ctx, { photo, caption, extra: productKeyboard(prods[idx]) });
        else await safeEditOrSend(ctx, { text: caption, extra: productKeyboard(prods[idx]) });
      }
    }
  }
});

bot.hears(/^(menu|menú)$/i, showMenu);
bot.hears(/^cat[aá]logo$/i, showCategories);
bot.hears(/^sellos$/i, showSellos);
bot.hears(/^ayuda$/i, showHelp);

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
  adjustCart(sess, p, 1);
});

bot.action("GO_CART", async (ctx) => { await ctx.answerCbQuery(); await showCart(ctx); });

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

bot.action("CHK_DELIVERY", async (ctx) => { await ctx.answerCbQuery(); await showDelivery(ctx); });

bot.action("DELIVERY_ENVIO", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  sess._entrega = "ENVIO";
  await showPayment(ctx, "ENVIO");
});

bot.action("DELIVERY_RETIRO", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  sess._entrega = "RETIRO";
  await showPayment(ctx, "RETIRO");
});

bot.action("DELIVERY_EXPRESS", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  sess._entrega = "EXPRESS";
  await showPayment(ctx, "EXPRESS");
});

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

// ✅ /config existe (sin secretos)
app.get("/config", async (req, res) => {
  try {
    const cfg = await loadConfig();
    const safe = {
      NegocioNombre: cfg.NegocioNombre || "",
      Estado: cfg.Estado || "",
      Descripcion: cfg.Descripcion || "",
      Moneda: cfg.Moneda || "ARS",
      BotLink: cfg.BotLink || cfg.Botlink || "",
    };
    res.json({ ok: true, config: safe });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

const PORT = process.env.PORT || 10000;

async function start() {
  await ensureBaseSheets();

  // Webhook si hay PUBLIC_URL
  if (PUBLIC_URL && PUBLIC_URL.startsWith("http")) {
    const hook = `${PUBLIC_URL.replace(/\/$/, "")}/telegram`;
    await bot.telegram.setWebhook(hook);
    app.use(bot.webhookCallback("/telegram"));
    app.listen(PORT, () =>
      console.log(`✅ Webhook activo: ${hook} | Puerto ${PORT}`)
    );
  } else {
    // fallback long polling
    await bot.launch();
    app.listen(PORT, () =>
      console.log(`✅ Bot en long-polling | Puerto ${PORT}`)
    );
  }
}

start().catch((e) => {
  console.error("FATAL:", e?.message || e);
  process.exit(1);
});
```0

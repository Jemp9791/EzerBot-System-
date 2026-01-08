import express from "express";
import { Telegraf, Markup } from "telegraf";
import { google } from "googleapis";

/* =========================================================
   ENV (NO CAMBIAR NOMBRES)
========================================================= */
const TelegramBotToken =
  process.env.TelegramBotToken || process.env.TELEGRAM_BOT_TOKEN;
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
    throw new Error("GOOGLE_SERVICE_ACCOUNT_B64 no es JSON válido");
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
  return s.split("|").map((x) => x.trim()).filter(Boolean);
}

function pickRandom(arr) {
  if (!arr || !arr.length) return "";
  return arr[Math.floor(Math.random() * arr.length)];
}

function roundARS(n) {
  return Math.round(Number(n) || 0);
}

/* =========================================================
   STATE
========================================================= */
const SESS = new Map();
const ORDER_TIMERS = new Map();

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
      lastScreen: "MENU",
      lastScreenData: {},
    });
  }
  return SESS.get(chatId);
}

function setScreen(sess, screen, data = {}) {
  sess.lastScreen = screen;
  sess.lastScreenData = data || {};
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
    if (idx !== undefined && row[idx] !== undefined && row[idx] !== "") {
      return row[idx];
    }
  }
  return def;
}

function inferUnit(raw) {
  const u = String(raw || "").trim().toLowerCase();
  if (!u) return "u";
  if (u.includes("gr") || u === "g" || u.includes("gram")) return "g";
  if (u.includes("kg") || u.includes("kilo")) return "g";
  if (u.includes("unidad") || u === "u" || u.includes("unid")) return "u";
  if (u.includes("pack")) return "u";
  return "u";
}

/* =========================================================
   CACHE (Config + Catalogo)
========================================================= */
const CACHE = {
  cfg: { value: null, ts: 0, inflight: null },
  cat: { value: null, ts: 0, inflight: null },
};

const CFG_TTL_MS = 10_000;
const CAT_TTL_MS = 20_000;

async function loadConfigRaw() {
  const rows = await getSheetValues(`Config!A:B`);
  return kvFromRows(rows);
}

async function loadCatalogRaw() {
  const rows = await getSheetValues(`Catalogo!A1:Z`);
  if (!rows.length) return { items: [], headers: {} };

  const headerRow = rows[0];
  const hmap = normalizeHeaders(headerRow);
  const data = rows
    .slice(1)
    .filter((r) => r.some((c) => String(c || "").trim() !== ""));

  const items = data.map((r, i) => {
    const code =
      String(
        pick(r, hmap, ["codigo", "codigoproducto", "id", "sku"], "")
      ).trim() || `P${i + 1}`;

    const name = String(
      pick(r, hmap, ["nombre", "producto", "name"], "Producto")
    ).trim();

    const price = parseNumber(
      pick(r, hmap, ["precio", "price"], 0),
      0
    );

    const pricePerKg = parseNumber(
      pick(r, hmap, ["precioporkg", "preciokg", "precio_kg"], 0),
      0
    );

    const unitRaw = pick(r, hmap, ["unidad", "unit", "tipo", "medida"], "");
    const unit = inferUnit(unitRaw);

    const cat = String(
      pick(r, hmap, ["categoria", "categoría", "rubro"], "General")
    ).trim() || "General";

    const img = String(
      pick(r, hmap, ["imagenurl", "imagen", "foto", "urlimagen"], "")
    ).trim();

    const desc = String(
      pick(r, hmap, ["descripcion", "descripción", "detalle"], "")
    ).trim();

    return {
      code,
      name,
      price,
      pricePerKg,
      unit,
      cat,
      img,
      desc,
    };
  });

  return { items, headers: hmap };
}

async function loadConfig() {
  const now = Date.now();
  if (CACHE.cfg.value && now - CACHE.cfg.ts < CFG_TTL_MS)
    return CACHE.cfg.value;
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
  if (CACHE.cat.value && now - CACHE.cat.ts < CAT_TTL_MS)
    return CACHE.cat.value;
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
   UI HELPERS (editar mensaje)
========================================================= */
async function safeEditOrSend(ctx, payload) {
  const chatId = ctx.chat?.id;
  const sess = chatId ? getSess(chatId) : null;
  const canEdit = !!(sess?.lastMessageId);

  try {
    if (canEdit) {
      if (payload.animation) throw new Error("forceSend");
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

/* =========================================================
   KEYBOARDS
========================================================= */
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
   MENÚ PRINCIPAL
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

  const header = [];
  header.push(`🏠 <b>${nombre}</b>`);
  if (estado) header.push(`🟢 <b>${estado}</b>`);
  if (dire) header.push(`📍 ${dire}`);
  if (hora) header.push(`🕒 ${hora}`);

  const caption = `${header.join("\n")}\n\n${desc}\n\nElegí una opción 👇`;

  await ctx.reply(caption, {
    parse_mode: "HTML",
    reply_markup: mainMenuKeyboard().reply_markup,
  });
}

/* =========================================================
   CATEGORÍAS
========================================================= */
async function showCategories(ctx) {
  const sess = getSess(ctx.chat.id);
  setScreen(sess, "CATS");

  const { items } = await loadCatalog();
  const cats = categoriesFromItems(items);

  if (!cats.length) {
    await safeEditOrSend(ctx, {
      text: "🧀 Catálogo vacío.",
      extra: Markup.inlineKeyboard(backMenuRows()),
    });
    return;
  }

  const buttons = [];
  for (let i = 0; i < cats.length; i += 2) {
    const row = [];
    row.push(
      Markup.button.callback(
        `📁 ${cats[i]}`,
        `CAT_${encodeURIComponent(cats[i])}`
      )
    );
    if (cats[i + 1]) {
      row.push(
        Markup.button.callback(
          `📁 ${cats[i + 1]}`,
          `CAT_${encodeURIComponent(cats[i + 1])}`
        )
      );
    }
    buttons.push(row);
  }

  buttons.push(...backMenuRows());

  await safeEditOrSend(ctx, {
    text: `🧀 <b>Catálogo</b>\n\nElegí una categoría 👇`,
    extra: Markup.inlineKeyboard(buttons),
  });
}

/* =========================================================
   PRODUCTOS (CARRUSEL)
========================================================= */
function productCaption(cfg, p, index, total) {
  const moneda = cfg.Moneda || "ARS";
  const showPrice = parseYes(cfg.CatalogoMostrarPrecios || "SI");

  const lines = [];
  lines.push(`<b>${p.name}</b>`);

  if (showPrice) {
    if (p.unit === "g" && p.pricePerKg > 0)
      lines.push(`💰 <b>${money(p.pricePerKg, moneda)}</b> / kg`);
    else lines.push(`💰 <b>${money(p.price, moneda)}</b>`);
  }

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
      Markup.button.callback("✅ Quiero éste", `WANT_${p.code}`),
      Markup.button.callback("🔗 Compartir", `SHARE_PROD_${p.code}`),
    ],
    ...backMenuRows(),
  ]);
}

async function showProductCarousel(ctx, cat) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);

  const { items } = await loadCatalog();
  const prods = items.filter((p) => (p.cat || "General") === cat);

  if (!prods.length) {
    await safeEditOrSend(ctx, {
      text: `No hay productos en <b>${cat}</b>.`,
      extra: Markup.inlineKeyboard(backMenuRows()),
    });
    return;
  }

  sess.category = cat;
  sess.productsInView = prods;
  sess.productIndex = 0;
  setScreen(sess, "PROD", { cat });

  const p = prods[0];
  const caption = productCaption(cfg, p, 0, prods.length);

  if (p.img && p.img.startsWith("http")) {
    await safeEditOrSend(ctx, {
      photo: p.img,
      caption,
      extra: productKeyboard(p),
    });
  } else {
    await safeEditOrSend(ctx, {
      text: caption,
      extra: productKeyboard(p),
    });
  }
}
/* =========================================================
   CANTIDAD / CARRITO
========================================================= */
function qtyPromptText(cfg, p) {
  if (p.unit === "g") {
    return `✅ <b>${p.name}</b>\n\n¿Cuántos <b>gramos</b> querés?\nEj: <code>250</code>`;
  }
  return `✅ <b>${p.name}</b>\n\n¿Cuántas <b>unidades</b> querés?\nEj: <code>1</code>`;
}

function computeSubtotal(p, qtyType, value) {
  if (qtyType === "g") {
    const grams = Math.max(1, parseNumber(value, 0));
    const perKg = p.pricePerKg > 0 ? p.pricePerKg : p.price;
    const subtotal = roundARS((grams / 1000) * perKg);
    return { grams, qty: 0, subtotal };
  }
  const qty = Math.max(1, parseNumber(value, 0));
  const subtotal = roundARS(qty * p.price);
  return { grams: 0, qty, subtotal };
}

function addToCart(sess, p, qtyType, value) {
  const calc = computeSubtotal(p, qtyType, value);
  const existing = sess.cart.find(
    (x) => x.code === p.code && x.qtyType === qtyType
  );

  if (existing) {
    existing.subtotal = roundARS(
      (existing.subtotal || 0) + calc.subtotal
    );
    if (qtyType === "g") existing.grams += calc.grams;
    else existing.qty += calc.qty;
  } else {
    sess.cart.push({
      code: p.code,
      name: p.name,
      qtyType,
      qty: calc.qty,
      grams: calc.grams,
      subtotal: calc.subtotal,
    });
  }
}

function cartTotal(cart) {
  return roundARS(cart.reduce((a, it) => a + (it.subtotal || 0), 0));
}

function fmtQty(it) {
  return it.qtyType === "g" ? `${it.grams} g` : `${it.qty} u`;
}

async function showCart(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  setScreen(sess, "CART");

  if (!sess.cart.length) {
    await safeEditOrSend(ctx, {
      text: `🛒 <b>Carrito</b>\n\nTu carrito está vacío.`,
      extra: Markup.inlineKeyboard([
        [Markup.button.callback("🧀 Catálogo", "MENU_CATALOGO")],
        ...backMenuRows(),
      ]),
    });
    return;
  }

  const lines = [];
  lines.push(`🛒 <b>Carrito</b>`);
  lines.push(`──────────────────`);
  sess.cart.forEach((it, i) => {
    lines.push(`${i + 1}) <b>${it.name}</b>`);
    lines.push(
      `   ${fmtQty(it)} · ${money(it.subtotal, cfg.Moneda || "ARS")}`
    );
  });
  lines.push(`──────────────────`);
  lines.push(
    `🧮 <b>Total:</b> ${money(
      cartTotal(sess.cart),
      cfg.Moneda || "ARS"
    )}`
  );

  await safeEditOrSend(ctx, {
    text: lines.join("\n"),
    extra: Markup.inlineKeyboard([
      [Markup.button.callback("✅ Finalizar compra", "CHK_DELIVERY")],
      [Markup.button.callback("🧀 Seguir comprando", "MENU_CATALOGO")],
      [Markup.button.callback("🗑️ Vaciar carrito", "CART_CLEAR")],
      ...backMenuRows(),
    ]),
  });
}

/* =========================================================
   ENTREGA / PAGO
========================================================= */
function deliveryKeyboard(cfg) {
  const rows = [];
  if (parseYes(cfg.UsaEnvioDomicilio || "SI"))
    rows.push([
      Markup.button.callback("🚚 Envío a domicilio", "DELIVERY_ENVIO"),
    ]);
  if (parseYes(cfg.EnvioExpress || "SI"))
    rows.push([
      Markup.button.callback("⚡ Envío express", "DELIVERY_EXPRESS"),
    ]);
  if (parseYes(cfg.UsaRetiroLocal || "SI"))
    rows.push([
      Markup.button.callback("🏪 Retiro en el local", "DELIVERY_RETIRO"),
    ]);
  rows.push(...backMenuRows());
  return Markup.inlineKeyboard(rows);
}

function payKeyboard(cfg) {
  const rows = [];
  if (parseYes(cfg.PermitirPagoOnline || "SI")) {
    const tipo = (cfg.TipoPagoOnline || "TRANSFERENCIA").toUpperCase();
    rows.push([
      Markup.button.callback(`💳 ${tipo}`, `PAY_${tipo}`),
    ]);
  }
  rows.push([Markup.button.callback("💵 Efectivo", "PAY_EFECTIVO")]);
  rows.push(...backMenuRows());
  return Markup.inlineKeyboard(rows);
}

async function showDelivery(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  setScreen(sess, "DELIVERY");

  await safeEditOrSend(ctx, {
    text: `🚚 <b>Entrega</b>\n\nElegí cómo recibir tu pedido 👇`,
    extra: deliveryKeyboard(cfg),
  });
}
/* =========================================================
   TICKET / PREVIEW
========================================================= */
function ticketPOS(cfg, data) {
  const m = cfg.Moneda || "ARS";
  const l = [];
  l.push(`🧾 <b>TICKET</b>`);
  l.push(`<code>${data.orderId || "—"}</code>`);
  l.push(`──────────────────`);
  for (const it of data.items) {
    l.push(`• <b>${it.name}</b>`);
    l.push(`  ${fmtQty(it)} · ${money(it.subtotal, m)}`);
  }
  if (data.costoEnvio > 0) {
    l.push(`• <b>Envío</b>`);
    l.push(`  ${money(data.costoEnvio, m)}`);
  }
  l.push(`──────────────────`);
  l.push(`🧮 <b>Total:</b> ${money(data.total, m)}`);
  if (data.entregaTipo) l.push(`🚚 <b>Entrega:</b> ${data.entregaTipo}`);
  if (data.pagoTipo) l.push(`💳 <b>Pago:</b> ${data.pagoTipo}`);
  if (data.nombre) l.push(`👤 <b>Nombre:</b> ${data.nombre}`);
  if (data.telefono) l.push(`📞 <b>Tel:</b> ${data.telefono}`);
  if (data.direccion) l.push(`📍 <b>Dirección:</b> ${data.direccion}`);
  if (data.notas) l.push(`📝 <b>Notas:</b> ${data.notas}`);
  if (data.estado) l.push(`📌 <b>Estado:</b> ${data.estado}`);
  return l.join("\n");
}

async function showCheckoutTicketPreview(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);
  setScreen(sess, "TICKET");

  const costoEnvio = parseNumber(cfg.CostoEnvio || "0", 0);
  let total = cartTotal(sess.cart);
  if (
    sess.checkout.entregaTipo === "ENVIO" ||
    sess.checkout.entregaTipo === "EXPRESS"
  ) {
    total = roundARS(total + costoEnvio);
  }

  const t = ticketPOS(cfg, {
    orderId: "—",
    items: sess.cart,
    total,
    entregaTipo: sess.checkout.entregaTipo,
    pagoTipo: sess.checkout.pagoTipo,
    nombre: sess.checkout.nombre,
    telefono: sess.checkout.telefono,
    direccion: sess.checkout.direccion,
    notas: sess.checkout.notas,
    estado: "Pendiente de confirmación",
    costoEnvio,
  });

  await safeEditOrSend(ctx, {
    text: t,
    extra: Markup.inlineKeyboard([
      [Markup.button.callback("✅ Finalizar compra", "FINALIZE_ORDER")],
      [Markup.button.callback("❌ Cancelar compra", "CANCEL_FLOW")],
      ...backMenuRows(),
    ]),
  });
}

/* =========================================================
   FINALIZAR PEDIDO (NO SUMA SELLOS)
========================================================= */
function buildOrderId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `TQ-${d.getFullYear()}${p(d.getMonth() + 1)}${p(
    d.getDate()
  )}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function finalizeOrderCreate(ctx) {
  const cfg = await loadConfig();
  const sess = getSess(ctx.chat.id);

  if (!sess.cart.length) {
    await safeEditOrSend(ctx, {
      text: "Tu carrito está vacío.",
      extra: mainMenuKeyboard(),
    });
    return;
  }

  const costoEnvio = parseNumber(cfg.CostoEnvio || "0", 0);
  let total = cartTotal(sess.cart);
  if (
    sess.checkout.entregaTipo === "ENVIO" ||
    sess.checkout.entregaTipo === "EXPRESS"
  ) {
    total = roundARS(total + costoEnvio);
  }

  const nombre =
    sess.checkout.nombre ||
    `${ctx.from.first_name || ""} ${ctx.from.last_name || ""}`.trim();
  const usuario = ctx.from.username ? `@${ctx.from.username}` : "";

  const orderId = buildOrderId();
  const now = new Date();
  const expMs = 60 * 60 * 1000;
  const expIso = new Date(now.getTime() + expMs).toISOString();

  const itemsText = sess.cart
    .map((it) => `${it.name} (${fmtQty(it)})`)
    .join(" | ");

  await appendRow("Pedidos", [
    orderId,
    now.toISOString(),
    expIso,
    String(ctx.chat.id),
    nombre,
    usuario,
    itemsText,
    total,
    sess.checkout.entregaTipo,
    sess.checkout.pagoTipo,
    sess.checkout.direccion,
    sess.checkout.telefono,
    sess.checkout.notas,
    "PENDIENTE",
    sess.refBy ? String(sess.refBy) : "",
  ]);

  sess.cart = [];
  sess.checkout = {
    entregaTipo: null,
    pagoTipo: null,
    nombre: "",
    telefono: "",
    direccion: "",
    notas: "",
  };
  sess.waiting = null;

  await safeEditOrSend(ctx, {
    text: `🧾 Pedido <b>${orderId}</b> creado.\n\nQueda pendiente de confirmación.`,
    extra: mainMenuKeyboard(),
  });
}
/* =========================================================
   VENDEDOR CONFIRMA / RECHAZA (SUMA SELLOS ACÁ)
========================================================= */
async function findPedidoRow(orderId) {
  const rows = await getSheetValues(`Pedidos!A2:O`);
  const idx = rows.findIndex((r) => String(r[0] || "") === String(orderId));
  if (idx === -1) return null;
  return { row: rows[idx], rowNumber: idx + 2 };
}

async function setPedidoEstado(orderId, estado) {
  const found = await findPedidoRow(orderId);
  if (!found) return null;
  const { row, rowNumber } = found;
  row[13] = estado;
  await setSheetValues(`Pedidos!A${rowNumber}:O${rowNumber}`, [row]);
  return row;
}

async function upsertCliente({ chatId, nombre, usuario, addSellos = 0, addTotal = 0, refBy = "" }) {
  const rows = await getSheetValues(`Clientes!A2:H`);
  const idx = rows.findIndex((r) => String(r[0] || "") === String(chatId));
  const now = new Date().toISOString();

  if (idx === -1) {
    await appendRow("Clientes", [
      String(chatId),
      nombre || "",
      usuario || "",
      addSellos,
      addTotal,
      now,
      refBy || "",
      0,
    ]);
    return;
  }

  const row = rows[idx];
  const sellos = parseNumber(row[3], 0) + addSellos;
  const total = parseNumber(row[4], 0) + addTotal;
  const refGanados = parseNumber(row[7], 0);

  await setSheetValues(`Clientes!A${idx + 2}:H${idx + 2}`, [[
    row[0],
    nombre || row[1],
    usuario || row[2],
    sellos,
    total,
    now,
    row[6] || refBy || "",
    refGanados,
  ]]);
}

async function addSelloReferido(chatId) {
  const rows = await getSheetValues(`Clientes!A2:H`);
  const idx = rows.findIndex((r) => String(r[0] || "") === String(chatId));
  if (idx === -1) return;

  const row = rows[idx];
  await setSheetValues(`Clientes!A${idx + 2}:H${idx + 2}`, [[
    row[0],
    row[1],
    row[2],
    parseNumber(row[3], 0) + 1,
    row[4],
    new Date().toISOString(),
    row[6],
    parseNumber(row[7], 0) + 1,
  ]]);
}

bot.action(/^V_CONFIRM_(TQ-.+)$/i, async (ctx) => {
  await ctx.answerCbQuery("Confirmado");
  const cfg = await loadConfig();
  const orderId = ctx.match[1];

  const row = await setPedidoEstado(orderId, "APROBADO");
  if (!row) return;

  const chatIdCliente = Number(row[3]);
  const nombre = row[4] || "";
  const usuario = row[5] || "";
  const total = parseNumber(row[7], 0);
  const refBy = row[14] || "";

  const usaSellos = parseYes(cfg.UsaSellos || "SI");
  if (usaSellos) {
    const montoPorSello = parseNumber(cfg.MontoPorSello || "10000", 10000);
    const sellosGanados = Math.floor(total / montoPorSello);

    if (sellosGanados > 0) {
      await upsertCliente({
        chatId: chatIdCliente,
        nombre,
        usuario,
        addSellos: sellosGanados,
        addTotal: total,
        refBy,
      });
    }

    const bonus = parseNumber(cfg.BonusSellosShare || "1", 1);
    if (refBy) {
      for (let i = 0; i < bonus; i++) {
        await addSelloReferido(refBy);
      }
    }
  }

  if (Number.isFinite(chatIdCliente)) {
    await bot.telegram.sendMessage(
      chatIdCliente,
      `✅ <b>Pedido ${orderId}</b> confirmado.\nGracias por tu compra.`,
      { parse_mode: "HTML", reply_markup: mainMenuKeyboard().reply_markup }
    );
  }

  await ctx.editMessageText(`✅ Pedido ${orderId} APROBADO`, {
    parse_mode: "HTML",
  });
});

bot.action(/^V_REJECT_(TQ-.+)$/i, async (ctx) => {
  await ctx.answerCbQuery("Rechazado");
  const orderId = ctx.match[1];
  const row = await setPedidoEstado(orderId, "RECHAZADO");
  if (!row) return;

  const chatIdCliente = Number(row[3]);
  if (Number.isFinite(chatIdCliente)) {
    await bot.telegram.sendMessage(
      chatIdCliente,
      `❌ El pedido ${orderId} fue rechazado.`,
      { parse_mode: "HTML", reply_markup: mainMenuKeyboard().reply_markup }
    );
  }

  await ctx.editMessageText(`❌ Pedido ${orderId} RECHAZADO`, {
    parse_mode: "HTML",
  });
});
/* =========================================================
   CANCELACIONES
========================================================= */
bot.action("CANCEL_FLOW", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);
  sess.cart = [];
  sess.checkout = {
    entregaTipo: null,
    pagoTipo: null,
    nombre: "",
    telefono: "",
    direccion: "",
    notas: "",
  };
  sess.waiting = null;

  await safeEditOrSend(ctx, {
    text: `❌ Compra cancelada.`,
    extra: mainMenuKeyboard(),
  });
});

bot.action(/^CANCEL_(TQ-.+)$/i, async (ctx) => {
  await ctx.answerCbQuery();
  const orderId = ctx.match[1];
  const row = await setPedidoEstado(orderId, "CANCELADO");
  if (!row) {
    await safeEditOrSend(ctx, {
      text: "No pude cancelar el pedido.",
      extra: mainMenuKeyboard(),
    });
    return;
  }
  await safeEditOrSend(ctx, {
    text: `❌ Pedido <b>${orderId}</b> cancelado.`,
    extra: mainMenuKeyboard(),
  });
});

/* =========================================================
   VOLVER / MENÚ
========================================================= */
bot.action("GO_MENU", async (ctx) => {
  await ctx.answerCbQuery();
  await showMenu(ctx);
});

bot.action("GO_BACK", async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSess(ctx.chat.id);

  switch (sess.lastScreen) {
    case "PROD":
      await showCategories(ctx);
      break;
    case "CART":
      await showCategories(ctx);
      break;
    case "DELIVERY":
      await showCart(ctx);
      break;
    case "TICKET":
      await showDelivery(ctx);
      break;
    default:
      await showMenu(ctx);
  }
});

/* =========================================================
   TEXT HANDLER
========================================================= */
bot.on("text", async (ctx) => {
  const sess = getSess(ctx.chat.id);
  const cfg = await loadConfig();
  const txt = String(ctx.message.text || "").trim();

  if (!sess.waiting) return;

  const w = sess.waiting;
  sess.waiting = null;

  if (w.type === "QTY") {
    const p = sess.productsInView.find((x) => x.code === w.payload.code);
    if (!p) return;

    const n = parseNumber(txt, 0);
    if (!n || n <= 0) {
      sess.waiting = w;
      await safeEditOrSend(ctx, {
        text: `Pasame un número válido.`,
        extra: Markup.inlineKeyboard(backMenuRows()),
      });
      return;
    }

    addToCart(sess, p, w.payload.qtyType, n);
    await showCart(ctx);
    return;
  }

  if (w.type === "NAME") {
    sess.checkout.nombre = txt.slice(0, 60);
    sess.waiting = { type: "PHONE", payload: w.payload || {} };
    await safeEditOrSend(ctx, {
      text: `📞 Pasame tu teléfono:`,
      extra: Markup.inlineKeyboard(backMenuRows()),
    });
    return;
  }

  if (w.type === "PHONE") {
    sess.checkout.telefono = txt.replace(/[^\d+]/g, "").slice(0, 25);
    if (w.payload?.retiro) {
      await safeEditOrSend(ctx, {
        text: `Elegí el método de pago 👇`,
        extra: payKeyboard(cfg),
      });
      return;
    }
    sess.waiting = { type: "ADDR" };
    await safeEditOrSend(ctx, {
      text: `📍 Dirección completa:`,
      extra: Markup.inlineKeyboard(backMenuRows()),
    });
    return;
  }

  if (w.type === "ADDR") {
    sess.checkout.direccion = txt.slice(0, 120);
    sess.waiting = { type: "NOTES" };
    await safeEditOrSend(ctx, {
      text: `📝 ¿Alguna nota? (o escribí NO)`,
      extra: Markup.inlineKeyboard(backMenuRows()),
    });
    return;
  }

  if (w.type === "NOTES") {
    sess.checkout.notas =
      txt.toLowerCase() === "no" ? "" : txt.slice(0, 120);
    await safeEditOrSend(ctx, {
      text: `Elegí el método de pago 👇`,
      extra: payKeyboard(cfg),
    });
  }
});
/* =========================================================
   WEB SERVER (RENDER)
========================================================= */
const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.status(200).send("EzerBot OK");
});

/* =========================================================
   START BOT
========================================================= */
async function start() {
  await ensureBaseSheets();
  await expireOldPending();

  setInterval(() => {
    expireOldPending().catch(() => {});
  }, 5 * 60 * 1000);

  if (PUBLIC_URL && PUBLIC_URL.startsWith("http")) {
    const hook = `${PUBLIC_URL.replace(/\/$/, "")}/telegram`;
    await bot.telegram.setWebhook(hook);
    app.use(bot.webhookCallback("/telegram"));
    app.listen(PORT, () =>
      console.log(`Webhook activo ${hook} | Puerto ${PORT}`)
    );
  } else {
    await bot.launch();
    app.listen(PORT, () =>
      console.log(`Long polling activo | Puerto ${PORT}`)
    );
  }
}

start().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});

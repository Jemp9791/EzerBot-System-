import { Telegraf, Markup } from "telegraf";
import { google } from "googleapis";

// =====================
// ENV
// =====================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SA_B64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;

if (!BOT_TOKEN) throw new Error("Falta TELEGRAM_BOT_TOKEN");
if (!SHEET_ID) throw new Error("Falta GOOGLE_SHEET_ID");
if (!SA_B64) throw new Error("Falta GOOGLE_SERVICE_ACCOUNT_B64");

// =====================
// Google Sheets Client
// =====================
function decodeServiceAccountFromB64(b64) {
  const clean = String(b64).replace(/\s+/g, "");
  const decoded = Buffer.from(clean, "base64").toString("utf8");
  let obj;
  try {
    obj = JSON.parse(decoded);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_B64 decodifica pero NO es JSON válido");
  }
  if (!obj.client_email || !obj.private_key) throw new Error("Service Account JSON incompleto");
  return obj;
}

const serviceAccount = decodeServiceAccountFromB64(SA_B64);

const auth = new google.auth.JWT({
  email: serviceAccount.client_email,
  key: serviceAccount.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

// =====================
// Helpers Sheets
// =====================
async function readSheet(tabName, rangeA1 = "A:Z") {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!${rangeA1}`,
  });
  return res.data.values || [];
}

async function appendRow(tabName, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A:Z`,
    valueInputOption: "RAW",
    requestBody: { values: [row] },
  });
}

async function updateRow(tabName, rowIndex1Based, row) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A${rowIndex1Based}:Z${rowIndex1Based}`,
    valueInputOption: "RAW",
    requestBody: { values: [row] },
  });
}

function rowsToObjects(values) {
  if (!values.length) return [];
  const headers = values[0].map(h => String(h || "").trim());
  return values.slice(1).map(r => {
    const o = {};
    headers.forEach((h, i) => (o[h] = r[i] ?? ""));
    return o;
  });
}

function upper(v) {
  return String(v ?? "").trim().toUpperCase();
}

function isYes(v) {
  return ["SI", "SÍ", "YES", "TRUE", "1"].includes(upper(v));
}

function money(cfg, n) {
  const cur = cfg.Moneda || "ARS";
  const symbol = cur === "ARS" ? "$" : (cur === "USD" ? "US$" : `${cur} `);
  const num = Number(n) || 0;
  return `${symbol}${num.toLocaleString("es-AR")}`;
}

// =====================
// Config cache (hoja Config KEY/VALUE)
// =====================
let CONFIG_CACHE = null;
let CONFIG_CACHE_TS = 0;

async function getConfig(force = false) {
  const now = Date.now();
  if (!force && CONFIG_CACHE && now - CONFIG_CACHE_TS < 15000) return CONFIG_CACHE;

  const raw = await readSheet("Config", "A:B");
  const cfg = {};
  for (let i = 1; i < raw.length; i++) {
    const k = String(raw[i][0] ?? "").trim();
    const v = String(raw[i][1] ?? "").trim();
    if (k) cfg[k] = v;
  }
  CONFIG_CACHE = cfg;
  CONFIG_CACHE_TS = now;
  return cfg;
}

// =====================
// Tabs (flexibles por si tu sheet usa otros nombres)
// =====================
async function resolveTabName(candidates) {
  // candidates: ["Catalogo","Catálogo","Productos"]
  // probamos leer 1 celda, si no explota, existe
  for (const t of candidates) {
    try {
      await readSheet(t, "A1:A1");
      return t;
    } catch {}
  }
  return candidates[0];
}

// =====================
// Estado persistente por chat (hoja Estados)
// =====================
const STATE_TAB_CANDIDATES = ["Estados", "State", "EstadoBot"];
const SELL_TAB_CANDIDATES = ["Sellos", "Sello", "SelloClientes"];
const ORDERS_TAB_CANDIDATES = ["Pedidos", "Ordenes", "Órdenes", "Orders"];

async function loadState(chatId) {
  const tab = await resolveTabName(STATE_TAB_CANDIDATES);
  const values = await readSheet(tab, "A:C");
  for (let i = 1; i < values.length; i++) {
    const cid = String(values[i][0] ?? "");
    if (cid === String(chatId)) {
      const json = String(values[i][1] ?? "{}");
      try { return JSON.parse(json); } catch { return {}; }
    }
  }
  return {};
}

async function saveState(chatId, stateObj) {
  const tab = await resolveTabName(STATE_TAB_CANDIDATES);
  const values = await readSheet(tab, "A:C");
  const nowISO = new Date().toISOString();

  for (let i = 1; i < values.length; i++) {
    const cid = String(values[i][0] ?? "");
    if (cid === String(chatId)) {
      const rowIndex = i + 1;
      await updateRow(tab, rowIndex, [String(chatId), JSON.stringify(stateObj), nowISO]);
      return;
    }
  }
  await appendRow(tab, [String(chatId), JSON.stringify(stateObj), nowISO]);
}

// =====================
// Sellos
// =====================
async function getSellos(chatId) {
  const tab = await resolveTabName(SELL_TAB_CANDIDATES);
  const values = await readSheet(tab, "A:C");
  for (let i = 1; i < values.length; i++) {
    const cid = String(values[i][0] ?? "");
    if (cid === String(chatId)) return Number(values[i][1] ?? 0) || 0;
  }
  return 0;
}

async function addSello(chatId, add = 1) {
  const tab = await resolveTabName(SELL_TAB_CANDIDATES);
  const values = await readSheet(tab, "A:C");
  const nowISO = new Date().toISOString();

  for (let i = 1; i < values.length; i++) {
    const cid = String(values[i][0] ?? "");
    if (cid === String(chatId)) {
      const current = Number(values[i][1] ?? 0) || 0;
      const rowIndex = i + 1;
      await updateRow(tab, rowIndex, [String(chatId), String(current + add), nowISO]);
      return current + add;
    }
  }
  await appendRow(tab, [String(chatId), String(add), nowISO]);
  return add;
}

// =====================
// Catálogo real (hoja Catalogo/Catálogo/Productos)
// Columnas esperadas (tolerantes):
// Codigo | Nombre | Precio | Unidad | ImagenURL | Categoria | Activo | Stock
// =====================
async function getCatalog() {
  const tab = await resolveTabName(["Catalogo", "Catálogo", "Productos", "Producto", "CatalogoProductos"]);
  const values = await readSheet(tab, "A:Z");
  const objs = rowsToObjects(values);

  // tolerancia de nombres
  const norm = (o) => ({
    Codigo: o.Codigo || o.CODIGO || o.code || o.Code || "",
    Nombre: o.Nombre || o.NOMBRE || o.Producto || o.Product || "",
    Precio: o.Precio || o.PRECIO || o.Price || "",
    Unidad: o.Unidad || o.UNIDAD || o.Unit || "",
    ImagenURL: o.ImagenURL || o.Imagen || o.Foto || o.ImageURL || o.URLImagen || "",
    Categoria: o.Categoria || o.CATEGORIA || o.Category || "",
    Activo: o.Activo || o.ACTIVO || o.Habilitado || o.Enabled || "SI",
    Stock: o.Stock || o.STOCK || "",
  });

  return objs
    .map(norm)
    .filter(p => p.Codigo && isYes(p.Activo));
}

// =====================
// Pedidos (hoja Pedidos)
// =====================
function genPedidoId() {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 7);
  return `PED-${t}-${r}`.toUpperCase();
}

async function saveOrder(order) {
  const tab = await resolveTabName(ORDERS_TAB_CANDIDATES);
  await appendRow(tab, [
    order.PedidoID,
    order.ChatID,
    order.Nombre,
    order.Usuario,
    order.ItemsJSON,
    order.Subtotal,
    order.EnvioTipo,
    order.EnvioCosto,
    order.Total,
    order.PagoMetodo,
    order.Estado,
    order.CreatedAt
  ]);
}

async function updateOrderStatus(pedidoId, newStatus) {
  const tab = await resolveTabName(ORDERS_TAB_CANDIDATES);
  const values = await readSheet(tab, "A:Z");
  if (!values.length) return false;

  const headers = values[0];
  const idxPedido = headers.indexOf("PedidoID");
  const idxEstado = headers.indexOf("Estado");

  if (idxPedido === -1 || idxEstado === -1) return false;

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idxPedido] || "") === pedidoId) {
      values[i][idxEstado] = newStatus;
      await updateRow(tab, i + 1, values[i]);
      return true;
    }
  }
  return false;
}

// =====================
// Textos desde Config (con placeholders)
// =====================
function fillPlaceholders(text, data) {
  let t = String(text || "");
  for (const [k, v] of Object.entries(data || {})) {
    t = t.replaceAll(`{${k}}`, String(v ?? ""));
  }
  return t;
}

// =====================
// UI Menú principal (moderno y limpio)
// =====================
function mainMenuKeyboard(cfg) {
  const rows = [];

  rows.push([
    Markup.button.callback("📦 Catálogo", "MENU_CATALOGO"),
    Markup.button.callback("🎟️ Sellos", "MENU_SELLOS"),
  ]);

  rows.push([
    Markup.button.callback("❓ Ayuda", "MENU_AYUDA"),
    Markup.button.callback("📤 Compartir", "MENU_SHARE_BOT"),
  ]);

  return Markup.inlineKeyboard(rows);
}

function buildStatusLine(cfg) {
  const estado = (cfg.Estado || "").trim().toLowerCase(); // Abierto / Cerrado / Vacaciones
  if (estado.includes("abiert")) return "🟢 *Abierto*";
  if (estado.includes("cerrad")) return "🔴 *Cerrado*";
  if (estado.includes("vac")) return "🏖️ *De vacaciones*";
  return "ℹ️ *Estado*";
}

async function sendWelcome(ctx, edit = false) {
  const cfg = await getConfig(true);

  const negocio = cfg.NegocioNombre || "Todo Queso";
  const dir = cfg.NegocioDireccion || "";
  const hor = cfg.NegocioHorario || "";
  const tel = cfg.NegocioTelefono || "";
  const ig = cfg.NegocioInstagram || "";
  const map = cfg.MapaURL || cfg.MapURL || "";

  // Mensaje de bienvenida: si existe WelcomeMessage lo uso, si no construyo uno lindo.
  const baseWelcome = cfg.WelcomeMessage || cfg.MensajeBienvenida || "";
  const fallback =
`🧀 *${negocio}*
${buildStatusLine(cfg)}

📍 ${dir}
🕒 ${hor}
📞 ${tel}
${ig ? `📸 ${ig}` : ""}

${map ? `🗺️ ${map}` : ""}

Elegí una opción 👇`;

  const text = baseWelcome
    ? fillPlaceholders(baseWelcome, { NOMBRE: ctx.from?.first_name || "" })
    : fallback;

  const img = cfg.LogoURL || cfg.SALUDO_URL || cfg.SALUDO_URL2 || cfg.SaludoURL || cfg.SALUDO || "";
  const kb = mainMenuKeyboard(cfg);

  if (edit && ctx.callbackQuery?.message?.message_id) {
    try {
      if (img) {
        await ctx.editMessageMedia({ type: "photo", media: img, caption: text }, kb);
        return;
      }
    } catch {}
    await ctx.editMessageText(text, { parse_mode: "Markdown", ...kb });
    return;
  }

  if (img) return ctx.replyWithPhoto(img, { caption: text, ...kb });
  return ctx.reply(text, { parse_mode: "Markdown", ...kb });
}

function helpText(cfg) {
  const negocio = cfg.NegocioNombre || "Todo Queso";
  return (
`✅ *${negocio} — Ayuda rápida*

• *Catálogo:* mirás productos en carrusel (⬅️➡️) sin saturar el chat
• *Carrito:* agregás/quitas y finalizás
• *Envío:* retiro / envío a domicilio (y express si está activo)
• *Transferencia:* datos y confirmación
• *Sellos:* acumulás y canjeás

Tocá botones abajo 👇`
  );
}

// =====================
// Carrusel catálogo (edita un solo mensaje)
// =====================
function productKeyboard(product, index, total) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ Agregar", `ADD_${product.Codigo}`)],
    [
      Markup.button.callback("⬅️", `PREV_${index}`),
      Markup.button.callback(`${index + 1}/${total}`, "NOOP"),
      Markup.button.callback("➡️", `NEXT_${index}`)
    ],
    [
      Markup.button.callback("🔥 Quiero esta promo", `WANT_${product.Codigo}`),
      Markup.button.callback("📤 Compartir", `SHAREP_${product.Codigo}`)
    ],
    [Markup.button.callback("🛒 Carrito", "CART_VIEW"), Markup.button.callback("🏠 Menú", "MENU_HOME")]
  ]);
}

async function showCatalog(ctx, startIndex = 0, edit = false) {
  const cfg = await getConfig();
  if (!isYes(cfg.CatalogoActivo || "SI")) {
    return ctx.reply("📦 El catálogo está desactivado por el momento.");
  }

  const catalog = await getCatalog();
  if (!catalog.length) return ctx.reply("Todavía no hay productos activos en el catálogo.");

  const index = Math.max(0, Math.min(startIndex, catalog.length - 1));
  const p = catalog[index];

  const showPrices = isYes(cfg.CatalogoMostrarPrecios || "SI");
  const priceLine = showPrices ? `💰 ${money(cfg, p.Precio)} ${p.Unidad ? `(${p.Unidad})` : ""}\n` : "";

  const caption =
`🧀 *${p.Nombre}*
${priceLine}${p.Categoria ? `🏷️ ${p.Categoria}\n` : ""}${p.Stock !== "" ? `📦 Stock: ${p.Stock}\n` : ""}Código: ${p.Codigo}`;

  const img = p.ImagenURL || cfg.CARD_URL || cfg.Card_URL || cfg.CARD || cfg.LogoURL || "";
  const kb = productKeyboard(p, index, catalog.length);

  const state = await loadState(ctx.chat.id);
  state.catalogIndex = index;
  await saveState(ctx.chat.id, state);

  if (edit && ctx.callbackQuery?.message?.message_id) {
    if (img) {
      try {
        await ctx.editMessageMedia({ type: "photo", media: img, caption }, { parse_mode: "Markdown", ...kb });
        return;
      } catch {}
    }
    await ctx.editMessageText(caption, { parse_mode: "Markdown", ...kb });
    return;
  }

  if (img) return ctx.replyWithPhoto(img, { caption, parse_mode: "Markdown", ...kb });
  return ctx.reply(caption, { parse_mode: "Markdown", ...kb });
}

// =====================
// Carrito + Checkout
// =====================
function calcSubtotal(cart) {
  let sum = 0;
  for (const item of cart) sum += (Number(item.price) || 0) * (Number(item.qty) || 1);
  return sum;
}

function cartKeyboard(cfg, hasItems) {
  const rows = [];
  if (hasItems) {
    rows.push([Markup.button.callback("➖ Quitar 1", "CART_REMOVE_ONE"), Markup.button.callback("🗑️ Vaciar", "CART_CLEAR")]);
    rows.push([Markup.button.callback("🚚 Envío / Retiro", "SHIP_MENU"), Markup.button.callback("💳 Transferencia", "PAY_MENU")]);
  }
  rows.push([Markup.button.callback("📦 Seguir viendo", "MENU_CATALOGO"), Markup.button.callback("🏠 Menú", "MENU_HOME")]);
  return Markup.inlineKeyboard(rows);
}

async function showCart(ctx, edit = false) {
  const cfg = await getConfig();
  const state = await loadState(ctx.chat.id);
  const cart = state.cart || [];
  const subtotal = calcSubtotal(cart);

  let txt = `🛒 *Tu carrito*\n\n`;
  if (!cart.length) {
    txt += `Está vacío.\n`;
  } else {
    cart.forEach((it, i) => {
      txt += `${i + 1}) ${it.name} x${it.qty} — ${money(cfg, (Number(it.price)||0) * (Number(it.qty)||1))}\n`;
    });
    txt += `\nSubtotal: *${money(cfg, subtotal)}*\n`;

    if (state.shipping?.type) {
      txt += `Envío: *${state.shipping.type}* (${money(cfg, state.shipping.cost || 0)})\n`;
      txt += `Total: *${money(cfg, subtotal + (Number(state.shipping.cost)||0))}*\n`;
    }
  }

  const kb = cartKeyboard(cfg, cart.length > 0);

  if (edit && ctx.callbackQuery?.message?.message_id) {
    await ctx.editMessageText(txt, { parse_mode: "Markdown", ...kb });
  } else {
    await ctx.reply(txt, { parse_mode: "Markdown", ...kb });
  }
}

// =====================
// Envío / Retiro (desde TU Config)
// UsaEnvioDomicilio (SI/NO), CostoEnvio, TextoEnvioDomicilio
// UsaRetiroLocal (SI/NO), TextoRetiroLocal
// (Express opcional si tenés: UsaEnvioExpress / CostoEnvioExpress / TextoEnvioExpress)
// =====================
function shippingKeyboard(cfg) {
  const rows = [];
  if (isYes(cfg.UsaRetiroLocal || "SI")) rows.push([Markup.button.callback("🏪 Retiro en local (sin costo)", "SHIP_PICKUP")]);
  if (isYes(cfg.UsaEnvioDomicilio || "SI")) rows.push([Markup.button.callback(`🚚 Envío a domicilio (${money(cfg, cfg.CostoEnvio)})`, "SHIP_STD")]);

  // Express opcional
  if (isYes(cfg.UsaEnvioExpress || "NO")) {
    rows.push([Markup.button.callback(`⚡ Envío Express (${money(cfg, cfg.CostoEnvioExpress)})`, "SHIP_EXP")]);
  }

  rows.push([Markup.button.callback("🛒 Volver al carrito", "CART_VIEW")]);
  return Markup.inlineKeyboard(rows);
}

async function showShippingMenu(ctx, edit = false) {
  const cfg = await getConfig();
  const parts = [];
  parts.push("🚚 *Elegí cómo querés recibir tu pedido*");

  if (isYes(cfg.UsaRetiroLocal || "SI")) parts.push(`• 🏪 Retiro: sin costo\n${cfg.TextoRetiroLocal ? `_${cfg.TextoRetiroLocal}_` : ""}`);
  if (isYes(cfg.UsaEnvioDomicilio || "SI")) parts.push(`• 🚚 Envío: ${money(cfg, cfg.CostoEnvio)}\n${cfg.TextoEnvioDomicilio ? `_${cfg.TextoEnvioDomicilio}_` : ""}`);
  if (isYes(cfg.UsaEnvioExpress || "NO")) parts.push(`• ⚡ Express: ${money(cfg, cfg.CostoEnvioExpress)}\n${cfg.TextoEnvioExpress ? `_${cfg.TextoEnvioExpress}_` : ""}`);

  parts.push("\n(El costo se suma al total)");

  const txt = parts.join("\n\n");
  const kb = shippingKeyboard(cfg);

  if (edit && ctx.callbackQuery?.message?.message_id) {
    await ctx.editMessageText(txt, { parse_mode: "Markdown", ...kb });
  } else {
    await ctx.reply(txt, { parse_mode: "Markdown", ...kb });
  }
}

// =====================
// Transferencia (desde TU Config)
// AliasTransferencia, CBUoPago, MensajeTransferencia
// =====================
function payKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Ya transferí", "PAY_DONE")],
    [Markup.button.callback("🛒 Volver al carrito", "CART_VIEW"), Markup.button.callback("🏠 Menú", "MENU_HOME")]
  ]);
}

async function showPayMenu(ctx, edit = false) {
  const cfg = await getConfig();
  const state = await loadState(ctx.chat.id);
  const cart = state.cart || [];
  if (!cart.length) return ctx.reply("Tu carrito está vacío.");

  const subtotal = calcSubtotal(cart);
  const shipCost = Number(state.shipping?.cost || 0);
  const total = subtotal + shipCost;

  const alias = cfg.AliasTransferencia || "-";
  const cbu = cfg.CBUoPago || "-";
  const msg = cfg.MensajeTransferencia || "Cuando transfieras, tocá “Ya transferí”.";

  const txt =
`💳 *Transferencia*

Alias: \`${alias}\`
CBU: \`${cbu}\`

Total a transferir: *${money(cfg, total)}*

${msg}`;

  const kb = payKeyboard();

  if (edit && ctx.callbackQuery?.message?.message_id) {
    await ctx.editMessageText(txt, { parse_mode: "Markdown", ...kb });
  } else {
    await ctx.reply(txt, { parse_mode: "Markdown", ...kb });
  }
}

// =====================
// POS / Aviso vendedor (base)
// ChatIdVendedor (un chat id) o VENDOR_CHAT_IDS (varios separados por coma)
// TextoAvisoVendedor y TextoConfirmacionPedido
// =====================
function vendorKeyboard(pedidoId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Confirmar", `VCONF_${pedidoId}`), Markup.button.callback("👨‍🍳 Preparando", `VPREP_${pedidoId}`)],
    [Markup.button.callback("🚚 Enviado", `VSENT_${pedidoId}`), Markup.button.callback("🎉 Entregado", `VDONE_${pedidoId}`)],
    [Markup.button.callback("❌ Cancelar", `VCAN_${pedidoId}`)],
  ]);
}

async function notifyVendors(text, pedidoId) {
  const cfg = await getConfig();
  const idsRaw = cfg.VENDOR_CHAT_IDS || cfg.ChatIdVendedor || "";
  const ids = String(idsRaw).split(",").map(s => s.trim()).filter(Boolean);
  if (!ids.length) return;

  for (const id of ids) {
    try {
      await bot.telegram.sendMessage(id, text, { parse_mode: "Markdown", ...vendorKeyboard(pedidoId) });
    } catch {}
  }
}

// =====================
// Compartir bot + Compartir producto
// =====================
async function shareBotText() {
  const me = await bot.telegram.getMe();
  return `https://t.me/${me.username}`;
}

// =====================
// BOT
// =====================
const bot = new Telegraf(BOT_TOKEN);

// /start
bot.start(async (ctx) => {
  await sendWelcome(ctx, false);
});

// Texto (mínimo, para no romper flujo por botones)
bot.on("text", async (ctx) => {
  const t = String(ctx.message.text || "").trim().toLowerCase();

  if (t === "/start") return sendWelcome(ctx, false);

  if (t === "ayuda") {
    const cfg = await getConfig();
    return ctx.reply(helpText(cfg), { parse_mode: "Markdown", ...mainMenuKeyboard(cfg) });
  }

  if (t === "catálogo" || t === "catalogo") return showCatalog(ctx, 0, false);
  if (t === "carrito") return showCart(ctx, false);
  if (t === "sellos") {
    const cfg = await getConfig();
    const s = await getSellos(ctx.chat.id);
    return ctx.reply(`🎟️ Tenés *${s}* sellos acumulados.`, { parse_mode: "Markdown", ...mainMenuKeyboard(cfg) });
  }

  // si escriben números (por costumbre) no lo mando al “Estoy activo”
  if (["1","2","3"].includes(t)) {
    return ctx.reply("👆 Usá los botones, así mantenemos el chat limpio 😉");
  }

  const cfg = await getConfig();
  return ctx.reply("Escribí *catálogo* o tocá los botones 👇", { parse_mode: "Markdown", ...mainMenuKeyboard(cfg) });
});

// Menú
bot.action("MENU_HOME", async (ctx) => { await ctx.answerCbQuery(); await sendWelcome(ctx, true); });
bot.action("MENU_CATALOGO", async (ctx) => { await ctx.answerCbQuery(); await showCatalog(ctx, 0, true); });

bot.action("MENU_SELLOS", async (ctx) => {
  await ctx.answerCbQuery();
  const cfg = await getConfig();
  const s = await getSellos(ctx.chat.id);
  const txt = `🎟️ *Sellos*\n\nTenés *${s}* sellos acumulados.`;
  await ctx.editMessageText(txt, { parse_mode: "Markdown", ...mainMenuKeyboard(cfg) });
});

bot.action("MENU_AYUDA", async (ctx) => {
  await ctx.answerCbQuery();
  const cfg = await getConfig();
  await ctx.editMessageText(helpText(cfg), { parse_mode: "Markdown", ...mainMenuKeyboard(cfg) });
});

bot.action("MENU_SHARE_BOT", async (ctx) => {
  await ctx.answerCbQuery();
  const cfg = await getConfig();
  const link = await shareBotText();
  const msgCfg = cfg.TextoCompartirBot || "Compartí este bot con tus amigos:";
  await ctx.reply(`${msgCfg}\n${link}`);
});

// Catálogo navegación
bot.action(/^NEXT_(\d+)$/, async (ctx) => { await ctx.answerCbQuery(); await showCatalog(ctx, (Number(ctx.match[1])||0) + 1, true); });
bot.action(/^PREV_(\d+)$/, async (ctx) => { await ctx.answerCbQuery(); await showCatalog(ctx, (Number(ctx.match[1])||0) - 1, true); });
bot.action("NOOP", async (ctx) => { await ctx.answerCbQuery(); });

// Agregar al carrito
bot.action(/^ADD_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const code = ctx.match[1];
  const catalog = await getCatalog();
  const p = catalog.find(x => String(x.Codigo) === String(code));
  if (!p) return;

  const state = await loadState(ctx.chat.id);
  state.cart = state.cart || [];

  const existing = state.cart.find(it => it.code === code);
  if (existing) existing.qty += 1;
  else state.cart.push({ code, name: p.Nombre, price: Number(p.Precio) || 0, qty: 1, unit: p.Unidad || "" });

  await saveState(ctx.chat.id, state);
  // confirmación cortita (no ensucia)
  await ctx.reply(`✅ Agregado: ${p.Nombre}`);
});

// Quiero esta promo
bot.action(/^WANT_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const code = ctx.match[1];
  const state = await loadState(ctx.chat.id);
  state.want = { type: "PRODUCT", code };
  await saveState(ctx.chat.id, state);
  await ctx.reply("🔥 Perfecto. Guardé tu interés en este producto.");
});

// Compartir producto
bot.action(/^SHAREP_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const code = ctx.match[1];
  const me = await bot.telegram.getMe();
  const link = `https://t.me/${me.username}?start=p_${encodeURIComponent(code)}`;
  await ctx.reply(`📤 Compartí este producto:\n${link}`);
});

// Carrito
bot.action("CART_VIEW", async (ctx) => { await ctx.answerCbQuery(); await showCart(ctx, true); });

bot.action("CART_CLEAR", async (ctx) => {
  await ctx.answerCbQuery();
  const state = await loadState(ctx.chat.id);
  state.cart = [];
  state.shipping = null;
  await saveState(ctx.chat.id, state);
  await showCart(ctx, true);
});

bot.action("CART_REMOVE_ONE", async (ctx) => {
  await ctx.answerCbQuery();
  const state = await loadState(ctx.chat.id);
  state.cart = state.cart || [];
  if (state.cart.length) {
    state.cart[0].qty -= 1;
    if (state.cart[0].qty <= 0) state.cart.shift();
  }
  await saveState(ctx.chat.id, state);
  await showCart(ctx, true);
});

// Envío
bot.action("SHIP_MENU", async (ctx) => { await ctx.answerCbQuery(); await showShippingMenu(ctx, true); });

bot.action("SHIP_PICKUP", async (ctx) => {
  await ctx.answerCbQuery();
  const state = await loadState(ctx.chat.id);
  state.shipping = { type: "RETIRO", cost: 0 };
  await saveState(ctx.chat.id, state);
  await showCart(ctx, true);
});

bot.action("SHIP_STD", async (ctx) => {
  await ctx.answerCbQuery();
  const cfg = await getConfig();
  const state = await loadState(ctx.chat.id);
  state.shipping = { type: "ENVIO", cost: Number(cfg.CostoEnvio || 0) };
  await saveState(ctx.chat.id, state);
  await showCart(ctx, true);
});

bot.action("SHIP_EXP", async (ctx) => {
  await ctx.answerCbQuery();
  const cfg = await getConfig();
  const state = await loadState(ctx.chat.id);
  state.shipping = { type: "EXPRESS", cost: Number(cfg.CostoEnvioExpress || 0) };
  await saveState(ctx.chat.id, state);
  await showCart(ctx, true);
});

// Pago
bot.action("PAY_MENU", async (ctx) => { await ctx.answerCbQuery(); await showPayMenu(ctx, true); });

// Confirmo transferencia (genera pedido real + avisa vendedor)
bot.action("PAY_DONE", async (ctx) => {
  await ctx.answerCbQuery();
  const cfg = await getConfig();
  const state = await loadState(ctx.chat.id);
  const cart = state.cart || [];
  if (!cart.length) return ctx.reply("Tu carrito está vacío.");

  const subtotal = calcSubtotal(cart);
  const ship = state.shipping || { type: "RETIRO", cost: 0 };
  const total = subtotal + (Number(ship.cost) || 0);

  const pedidoId = genPedidoId();
  const user = ctx.from;
  const itemsJson = JSON.stringify(cart);
  const nowISO = new Date().toISOString();

  await saveOrder({
    PedidoID: pedidoId,
    ChatID: String(ctx.chat.id),
    Nombre: `${user.first_name || ""} ${user.last_name || ""}`.trim(),
    Usuario: user.username ? `@${user.username}` : "",
    ItemsJSON: itemsJson,
    Subtotal: String(subtotal),
    EnvioTipo: ship.type,
    EnvioCosto: String(ship.cost || 0),
    Total: String(total),
    PagoMetodo: "TRANSFERENCIA",
    Estado: "NUEVO",
    CreatedAt: nowISO,
  });

  // Sellos si están activos
  if (isYes(cfg.UsaSellos || "SI")) {
    await addSello(ctx.chat.id, Number(cfg.BonusSellosPorVenta || 1) || 1);
  }

  // Aviso vendedor (mensaje desde Config)
  const resumenItems = cart.map((it,i)=>`${i+1}) ${it.name} x${it.qty} — ${money(cfg, (it.price||0)*(it.qty||1))}`).join("\n");

  const avisoBase = cfg.TextoAvisoVendedor || "📣 Nuevo pedido pendiente de confirmación ✅";
  const aviso = fillPlaceholders(avisoBase, {
    PEDIDO: pedidoId,
    NOMBRE: user.first_name || "",
    TOTAL: money(cfg, total),
    ENVIO: ship.type,
  });

  const vendedorMsg =
`🧾 *Pedido* ${pedidoId}

Cliente: *${user.first_name || ""}* ${user.username ? `(@${user.username})` : ""}
Entrega: *${ship.type}* (${money(cfg, ship.cost || 0)})
Total: *${money(cfg, total)}*

Items:
${resumenItems}

${aviso}`;

  await notifyVendors(vendedorMsg, pedidoId);

  // Confirmación al cliente (desde Config)
  const confBase = cfg.TextoConfirmacionPedido || "Gracias. Tu compra fue confirmada y está en preparación. ✅";
  const conf = fillPlaceholders(confBase, { PEDIDO: pedidoId, TOTAL: money(cfg, total) });

  // limpiar carrito
  state.cart = [];
  state.shipping = null;
  await saveState(ctx.chat.id, state);

  await ctx.reply(`✅ *Listo!*\nID: *${pedidoId}*\n\n${conf}`, { parse_mode: "Markdown" });
});

// POS vendedor: estados
bot.action(/^VCONF_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const pedidoId = ctx.match[1];
  await updateOrderStatus(pedidoId, "CONFIRMADO");
  await ctx.editMessageText(`✅ Pedido ${pedidoId}: CONFIRMADO`);
});

bot.action(/^VPREP_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const pedidoId = ctx.match[1];
  await updateOrderStatus(pedidoId, "PREPARANDO");
  await ctx.editMessageText(`👨‍🍳 Pedido ${pedidoId}: PREPARANDO`);
});

bot.action(/^VSENT_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const pedidoId = ctx.match[1];
  await updateOrderStatus(pedidoId, "ENVIADO");
  await ctx.editMessageText(`🚚 Pedido ${pedidoId}: ENVIADO`);
});

bot.action(/^VDONE_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const pedidoId = ctx.match[1];
  await updateOrderStatus(pedidoId, "ENTREGADO");
  await ctx.editMessageText(`🎉 Pedido ${pedidoId}: ENTREGADO`);
});

bot.action(/^VCAN_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const pedidoId = ctx.match[1];
  await updateOrderStatus(pedidoId, "CANCELADO");
  await ctx.editMessageText(`❌ Pedido ${pedidoId}: CANCELADO`);
});

// Salud rápida
bot.command("ping", async (ctx) => ctx.reply("✅ OK"));

// Launch
bot.launch().then(() => console.log("✅ Bot iniciado (Telegraf)"));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

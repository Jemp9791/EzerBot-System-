import { Telegraf, Markup } from "telegraf";
import { google } from "googleapis";
import fetch from "node-fetch";

// =====================
// ENV
// =====================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SA_B64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;

if (!BOT_TOKEN) throw new Error("Falta TELEGRAM_BOT_TOKEN");
if (!SHEET_ID) throw new Error("Falta GOOGLE_SHEET_ID");
if (!SA_B64) throw new Error("Falta GOOGLE_SERVICE_ACCOUNT_B64");

const PORT = process.env.PORT || 10000;

// =====================
// Google Sheets Client
// =====================
function decodeServiceAccountFromB64(b64) {
  // Limpieza defensiva por si Render mete espacios
  const clean = String(b64).replace(/\s+/g, "");
  const decoded = Buffer.from(clean, "base64").toString("utf8");

  let obj;
  try {
    obj = JSON.parse(decoded);
  } catch (e) {
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

// =====================
// Config cache
// =====================
let CONFIG_CACHE = null;
let CONFIG_CACHE_TS = 0;

async function getConfig(force = false) {
  const now = Date.now();
  if (!force && CONFIG_CACHE && now - CONFIG_CACHE_TS < 15000) return CONFIG_CACHE; // 15s cache

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
// Estado persistente por ChatID
// =====================
async function loadState(chatId) {
  const values = await readSheet("Estados", "A:C");
  // headers: ChatID, StateJSON, UpdatedAt
  for (let i = 1; i < values.length; i++) {
    const cid = String(values[i][0] ?? "");
    if (cid === String(chatId)) {
      const json = String(values[i][1] ?? "{}");
      try {
        return JSON.parse(json);
      } catch {
        return {};
      }
    }
  }
  return {};
}

async function saveState(chatId, stateObj) {
  const values = await readSheet("Estados", "A:C");
  const nowISO = new Date().toISOString();

  for (let i = 1; i < values.length; i++) {
    const cid = String(values[i][0] ?? "");
    if (cid === String(chatId)) {
      const rowIndex = i + 1; // 1-based
      const row = [String(chatId), JSON.stringify(stateObj), nowISO];
      await updateRow("Estados", rowIndex, row);
      return;
    }
  }
  await appendRow("Estados", [String(chatId), JSON.stringify(stateObj), nowISO]);
}

// =====================
// Sellos
// =====================
async function getSellos(chatId) {
  const values = await readSheet("Sellos", "A:C");
  for (let i = 1; i < values.length; i++) {
    const cid = String(values[i][0] ?? "");
    if (cid === String(chatId)) {
      return Number(values[i][1] ?? 0) || 0;
    }
  }
  return 0;
}

async function addSello(chatId, add = 1) {
  const values = await readSheet("Sellos", "A:C");
  const nowISO = new Date().toISOString();

  for (let i = 1; i < values.length; i++) {
    const cid = String(values[i][0] ?? "");
    if (cid === String(chatId)) {
      const current = Number(values[i][1] ?? 0) || 0;
      const rowIndex = i + 1;
      await updateRow("Sellos", rowIndex, [String(chatId), String(current + add), nowISO]);
      return current + add;
    }
  }
  await appendRow("Sellos", [String(chatId), String(add), nowISO]);
  return add;
}

// =====================
// Catálogo / Combos
// =====================
async function getCatalog() {
  const values = await readSheet("Catalogo", "A:Z");
  const objs = rowsToObjects(values);
  return objs.filter(p => String(p.Activo || "").toUpperCase() === "SI");
}

async function getCombos() {
  try {
    const values = await readSheet("Combos", "A:Z");
    const objs = rowsToObjects(values);
    return objs.filter(c => String(c.Activo || "").toUpperCase() === "SI");
  } catch {
    return [];
  }
}

function money(cfg, n) {
  const cur = cfg.CURRENCY || "$";
  const num = Number(n) || 0;
  return `${cur}${num.toLocaleString("es-AR")}`;
}

// =====================
// UI: Menú principal
// =====================
function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📦 Catálogo", "MENU_CATALOGO"), Markup.button.callback("🎟️ Sellos", "MENU_SELLOS")],
    [Markup.button.callback("❓ Ayuda", "MENU_AYUDA"), Markup.button.callback("📤 Compartir bot", "MENU_SHARE_BOT")],
  ]);
}

function helpText() {
  return (
`✅ ¿Qué puedo hacer?

• 📦 Catálogo: mirá productos con carrusel (⬅️➡️)
• 🛒 Carrito: agregá / quitá y finalizá compra
• 🚚 Envío: retiro / envío / express (si está activo)
• 💳 Transferencia: datos y confirmación
• 🎟️ Sellos: acumulás por compras

Escribí “catálogo” o tocá el botón.`
  );
}

async function buildWelcome(cfg) {
  const status = (cfg.STATUS || "OPEN").toUpperCase();
  let statusLine = "🟢 Abierto";
  if (status === "CLOSED") statusLine = "🔴 Cerrado";
  if (status === "VACATION") statusLine = "🏖️ De vacaciones";

  const note = cfg.STATUS_NOTE ? `\n${cfg.STATUS_NOTE}` : "";

  const text =
`🧀 ${cfg.BOT_NAME || "EzerBot"}

${statusLine}${note}

📍 ${cfg.ADDRESS || "Dirección no configurada"}
🕒 ${cfg.HOURS || "Horarios no configurados"}
📞 ${cfg.PHONE || ""}

Elegí una opción 👇`;

  return text;
}

// =====================
// Carrusel (mensaje editable)
// =====================
function productKeyboard(product, index, total) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ Agregar al carrito", `ADD_${product.Codigo}`)],
    [
      Markup.button.callback("⬅️ Anterior", `PREV_${index}`),
      Markup.button.callback(`${index + 1}/${total}`, "NOOP"),
      Markup.button.callback("➡️ Siguiente", `NEXT_${index}`)
    ],
    [
      Markup.button.callback("🔥 Quiero esta promo", `WANT_${product.Codigo}`),
      Markup.button.callback("📤 Compartir", `SHAREP_${product.Codigo}`)
    ],
    [Markup.button.callback("🛒 Ver carrito", "CART_VIEW"), Markup.button.callback("🏠 Menú", "MENU_HOME")]
  ]);
}

function combosKeyboard(combo, index, total) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ Agregar combo", `ADD_COMBO_${combo.Codigo}`)],
    [
      Markup.button.callback("⬅️ Anterior", `CPREV_${index}`),
      Markup.button.callback(`${index + 1}/${total}`, "NOOP"),
      Markup.button.callback("➡️ Siguiente", `CNEXT_${index}`)
    ],
    [
      Markup.button.callback("🔥 Quiero esta promo", `WANTC_${combo.Codigo}`),
      Markup.button.callback("📤 Compartir", `SHAREC_${combo.Codigo}`)
    ],
    [Markup.button.callback("🛒 Ver carrito", "CART_VIEW"), Markup.button.callback("🏠 Menú", "MENU_HOME")]
  ]);
}

async function showCatalog(ctx, startIndex = 0, edit = false) {
  const cfg = await getConfig();
  const catalog = await getCatalog();
  if (!catalog.length) {
    return ctx.reply("No hay productos activos en el catálogo todavía.");
  }

  const index = Math.max(0, Math.min(startIndex, catalog.length - 1));
  const p = catalog[index];

  const caption =
`🧀 ${p.Nombre}
💰 ${money(cfg, p.Precio)} ${p.Unidad ? `(${p.Unidad})` : ""}

${p.Stock !== "" ? `📦 Stock: ${p.Stock}` : ""}

Categoría: ${p.Categoria || "-"}`;

  const img = p.ImagenURL || (await getConfig()).WELCOME_IMAGE_URL || null;
  const kb = productKeyboard(p, index, catalog.length);

  // Guardar índice actual
  const state = await loadState(ctx.chat.id);
  state.catalogIndex = index;
  await saveState(ctx.chat.id, state);

  if (edit && ctx.callbackQuery?.message?.message_id) {
    // editar media si hay img, sino editar texto
    if (img) {
      try {
        await ctx.editMessageMedia(
          { type: "photo", media: img, caption },
          kb
        );
        return;
      } catch {
        // fallback
      }
    }
    await ctx.editMessageText(caption, kb);
    return;
  } else {
    if (img) return ctx.replyWithPhoto(img, { caption, ...kb });
    return ctx.reply(caption, kb);
  }
}

async function showCombos(ctx, startIndex = 0, edit = false) {
  const cfg = await getConfig();
  const combos = await getCombos();
  if (!combos.length) return ctx.reply("Todavía no hay combos activos.");

  const index = Math.max(0, Math.min(startIndex, combos.length - 1));
  const c = combos[index];

  const caption =
`🔥 ${c.Nombre}
💰 ${money(cfg, c.Precio)}
${c.Descripcion ? `\n${c.Descripcion}` : ""}`;

  const img = c.ImagenURL || null;
  const kb = combosKeyboard(c, index, combos.length);

  const state = await loadState(ctx.chat.id);
  state.combosIndex = index;
  await saveState(ctx.chat.id, state);

  if (edit && ctx.callbackQuery?.message?.message_id) {
    if (img) {
      try {
        await ctx.editMessageMedia({ type: "photo", media: img, caption }, kb);
        return;
      } catch {}
    }
    await ctx.editMessageText(caption, kb);
    return;
  } else {
    if (img) return ctx.replyWithPhoto(img, { caption, ...kb });
    return ctx.reply(caption, kb);
  }
}

// =====================
// Carrito
// =====================
function calcSubtotal(cart) {
  let sum = 0;
  for (const item of cart) sum += (Number(item.price) || 0) * (Number(item.qty) || 1);
  return sum;
}

function cartKeyboard(hasItems) {
  const rows = [];
  if (hasItems) {
    rows.push([Markup.button.callback("➖ Quitar 1", "CART_REMOVE_ONE"), Markup.button.callback("🗑️ Vaciar", "CART_CLEAR")]);
    rows.push([Markup.button.callback("🚚 Envío", "SHIP_MENU"), Markup.button.callback("💳 Pagar", "PAY_MENU")]);
  }
  rows.push([Markup.button.callback("📦 Seguir comprando", "MENU_CATALOGO"), Markup.button.callback("🏠 Menú", "MENU_HOME")]);
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
      txt += `Envío: ${state.shipping.type} (${money(cfg, state.shipping.cost || 0)})\n`;
      txt += `Total: *${money(cfg, subtotal + (Number(state.shipping.cost)||0))}*\n`;
    }
  }

  const kb = cartKeyboard(cart.length > 0);

  if (edit && ctx.callbackQuery?.message?.message_id) {
    await ctx.editMessageText(txt, { parse_mode: "Markdown", ...kb });
  } else {
    await ctx.reply(txt, { parse_mode: "Markdown", ...kb });
  }
}

// =====================
// Envío
// =====================
function shippingKeyboard(cfg) {
  const expressEnabled = (cfg.DELIVERY_EXPRESS_ENABLED || "NO").toUpperCase() === "YES";
  const rows = [
    [Markup.button.callback("🏪 Retiro en local (sin costo)", "SHIP_PICKUP")],
    [Markup.button.callback(`🚚 Envío (${money(cfg, cfg.DELIVERY_COST)})`, "SHIP_STD")],
  ];
  if (expressEnabled) {
    rows.push([Markup.button.callback(`⚡ Envío Express (${money(cfg, cfg.DELIVERY_EXPRESS_COST)})`, "SHIP_EXP")]);
  }
  rows.push([Markup.button.callback("🛒 Volver al carrito", "CART_VIEW")]);
  return Markup.inlineKeyboard(rows);
}

async function showShippingMenu(ctx, edit = false) {
  const cfg = await getConfig();
  const txt =
`🚚 *Elegí tu envío*

• Retiro: sin costo
• Envío: ${money(cfg, cfg.DELIVERY_COST)}
${(cfg.DELIVERY_EXPRESS_ENABLED || "NO").toUpperCase() === "YES" ? `• Express: ${money(cfg, cfg.DELIVERY_EXPRESS_COST)}\n` : ""}

(El costo se suma al total)`;

  const kb = shippingKeyboard(cfg);
  if (edit && ctx.callbackQuery?.message?.message_id) {
    await ctx.editMessageText(txt, { parse_mode: "Markdown", ...kb });
  } else {
    await ctx.reply(txt, { parse_mode: "Markdown", ...kb });
  }
}

// =====================
// Pago (transferencia)
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

  const txt =
`💳 *Transferencia*

Alias: \`${cfg.TRANSFER_ALIAS || "-"}\`
CBU: \`${cfg.TRANSFER_CBU || "-"}\`
Titular: *${cfg.TRANSFER_NAME || "-"}*

Total a transferir: *${money(cfg, total)}*

Cuando transfieras, tocá “Ya transferí”.`;

  const kb = payKeyboard();
  if (edit && ctx.callbackQuery?.message?.message_id) {
    await ctx.editMessageText(txt, { parse_mode: "Markdown", ...kb });
  } else {
    await ctx.reply(txt, { parse_mode: "Markdown", ...kb });
  }
}

// =====================
// Pedidos + POS vendedor
// =====================
function genPedidoId() {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 7);
  return `PED-${t}-${r}`.toUpperCase();
}

function vendorKeyboard(pedidoId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Confirmar", `VCONF_${pedidoId}`)],
    [Markup.button.callback("👨‍🍳 Preparando", `VPREP_${pedidoId}`)],
    [Markup.button.callback("🚚 Enviado", `VSENT_${pedidoId}`)],
    [Markup.button.callback("🎉 Entregado", `VDONE_${pedidoId}`)],
    [Markup.button.callback("❌ Cancelar", `VCAN_${pedidoId}`)],
  ]);
}

async function notifyVendors(text, pedidoId) {
  const cfg = await getConfig();
  const ids = String(cfg.VENDOR_CHAT_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!ids.length) return;

  for (const id of ids) {
    try {
      await bot.telegram.sendMessage(id, text, { parse_mode: "Markdown", ...vendorKeyboard(pedidoId) });
    } catch {}
  }
}

async function updatePedidoStatus(pedidoId, newStatus) {
  const values = await readSheet("Pedidos", "A:Z");
  if (!values.length) return false;
  const headers = values[0];
  const idxPedido = headers.indexOf("PedidoID");
  const idxEstado = headers.indexOf("Estado");

  if (idxPedido === -1 || idxEstado === -1) return false;

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idxPedido] || "") === pedidoId) {
      values[i][idxEstado] = newStatus;
      await updateRow("Pedidos", i + 1, values[i]);
      return true;
    }
  }
  return false;
}

// =====================
// Bot
// =====================
const bot = new Telegraf(BOT_TOKEN);

// Start / Home
async function sendHome(ctx, edit = false) {
  const cfg = await getConfig(true);
  const text = await buildWelcome(cfg);
  const img = cfg.WELCOME_IMAGE_URL || null;
  const kb = mainMenuKeyboard();

  if (edit && ctx.callbackQuery?.message?.message_id) {
    // editar el mensaje si se puede
    try {
      if (img) {
        await ctx.editMessageMedia({ type: "photo", media: img, caption: text }, kb);
        return;
      }
    } catch {}
    await ctx.editMessageText(text, kb);
    return;
  } else {
    if (img) return ctx.replyWithPhoto(img, { caption: text, ...kb });
    return ctx.reply(text, kb);
  }
}

bot.start(async (ctx) => {
  await sendHome(ctx, false);
});

// Mensajes texto rápidos
bot.on("text", async (ctx) => {
  const t = String(ctx.message.text || "").trim().toLowerCase();
  if (t === "ayuda") return ctx.reply(helpText(), mainMenuKeyboard());
  if (t === "catálogo" || t === "catalogo") return showCatalog(ctx, 0, false);
  if (t === "combos") return showCombos(ctx, 0, false);
  if (t === "sellos") {
    const s = await getSellos(ctx.chat.id);
    return ctx.reply(`🎟️ Tenés *${s}* sellos acumulados.`, { parse_mode: "Markdown", ...mainMenuKeyboard() });
  }
  // fallback suave
  return ctx.reply("Escribí *catálogo*, *combos* o *ayuda* 👇", { parse_mode: "Markdown", ...mainMenuKeyboard() });
});

// Callbacks Menú
bot.action("MENU_HOME", async (ctx) => { await ctx.answerCbQuery(); await sendHome(ctx, true); });
bot.action("MENU_CATALOGO", async (ctx) => { await ctx.answerCbQuery(); await showCatalog(ctx, 0, true); });
bot.action("MENU_SELLOS", async (ctx) => {
  await ctx.answerCbQuery();
  const s = await getSellos(ctx.chat.id);
  await ctx.editMessageText(`🎟️ *Tus sellos*\n\nTenés *${s}* sellos acumulados.`, { parse_mode: "Markdown", ...mainMenuKeyboard() });
});
bot.action("MENU_AYUDA", async (ctx) => { await ctx.answerCbQuery(); await ctx.editMessageText(helpText(), mainMenuKeyboard()); });

bot.action("MENU_SHARE_BOT", async (ctx) => {
  await ctx.answerCbQuery();
  const me = await bot.telegram.getMe();
  const link = `https://t.me/${me.username}`;
  await ctx.reply(`📤 Compartí el bot con este link:\n${link}`);
});

// Catálogo navegación
bot.action(/^NEXT_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const i = Number(ctx.match[1]) || 0;
  await showCatalog(ctx, i + 1, true);
});
bot.action(/^PREV_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const i = Number(ctx.match[1]) || 0;
  await showCatalog(ctx, i - 1, true);
});
bot.action("NOOP", async (ctx) => { await ctx.answerCbQuery(); });

// Agregar producto
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
  await ctx.reply(`✅ Agregado: ${p.Nombre}\n🛒 Carrito: ${state.cart.length} ítems`);
});

// Quiero promo (producto)
bot.action(/^WANT_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const code = ctx.match[1];
  const state = await loadState(ctx.chat.id);
  state.want = { type: "PRODUCT", code };
  await saveState(ctx.chat.id, state);
  await ctx.reply("🔥 Listo. Guardé tu interés. Ahora podés seguir comprando o ir al carrito. 😉");
});

// Compartir producto
bot.action(/^SHAREP_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const code = ctx.match[1];
  const me = await bot.telegram.getMe();
  const link = `https://t.me/${me.username}?start=p_${encodeURIComponent(code)}`;
  await ctx.reply(`📤 Compartí este producto:\n${link}`);
});

// Combos (si existen)
bot.action(/^CNEXT_(\d+)$/, async (ctx) => { await ctx.answerCbQuery(); await showCombos(ctx, Number(ctx.match[1]) + 1, true); });
bot.action(/^CPREV_(\d+)$/, async (ctx) => { await ctx.answerCbQuery(); await showCombos(ctx, Number(ctx.match[1]) - 1, true); });

bot.action(/^ADD_COMBO_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const code = ctx.match[1];
  const combos = await getCombos();
  const c = combos.find(x => String(x.Codigo) === String(code));
  if (!c) return;

  const state = await loadState(ctx.chat.id);
  state.cart = state.cart || [];
  const existing = state.cart.find(it => it.code === `COMBO:${code}`);
  if (existing) existing.qty += 1;
  else state.cart.push({ code: `COMBO:${code}`, name: `Combo: ${c.Nombre}`, price: Number(c.Precio) || 0, qty: 1, unit: "combo" });

  await saveState(ctx.chat.id, state);
  await ctx.reply(`✅ Agregado: Combo ${c.Nombre}`);
});

bot.action(/^WANTC_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const code = ctx.match[1];
  const state = await loadState(ctx.chat.id);
  state.want = { type: "COMBO", code };
  await saveState(ctx.chat.id, state);
  await ctx.reply("🔥 Perfecto. Guardé tu interés en este combo.");
});

bot.action(/^SHAREC_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const code = ctx.match[1];
  const me = await bot.telegram.getMe();
  const link = `https://t.me/${me.username}?start=c_${encodeURIComponent(code)}`;
  await ctx.reply(`📤 Compartí este combo:\n${link}`);
});

// Start param (compartidos)
bot.start(async (ctx) => {
  const param = (ctx.message.text || "").split(" ")[1] || "";
  if (param.startsWith("p_")) {
    const code = decodeURIComponent(param.slice(2));
    await sendHome(ctx, false);
    return showCatalog(ctx, 0, false); // y el usuario navega, pero ya quedó “entró por share”
  }
  if (param.startsWith("c_")) {
    await sendHome(ctx, false);
    return showCombos(ctx, 0, false);
  }
  await sendHome(ctx, false);
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
  state.shipping = { type: "ENVIO", cost: Number(cfg.DELIVERY_COST || 0) };
  await saveState(ctx.chat.id, state);
  await showCart(ctx, true);
});
bot.action("SHIP_EXP", async (ctx) => {
  await ctx.answerCbQuery();
  const cfg = await getConfig();
  const state = await loadState(ctx.chat.id);
  state.shipping = { type: "EXPRESS", cost: Number(cfg.DELIVERY_EXPRESS_COST || 0) };
  await saveState(ctx.chat.id, state);
  await showCart(ctx, true);
});

// Pago
bot.action("PAY_MENU", async (ctx) => { await ctx.answerCbQuery(); await showPayMenu(ctx, true); });

bot.action("PAY_DONE", async (ctx) => {
  await ctx.answerCbQuery();

  const cfg = await getConfig();
  const state = await loadState(ctx.chat.id);
  const cart = state.cart || [];
  if (!cart.length) return ctx.reply("Tu carrito está vacío.");

  const subtotal = calcSubtotal(cart);
  const ship = state.shipping || { type: "RETIRO", cost: 0 };
  const total = subtotal + (Number(ship.cost)||0);

  const pedidoId = genPedidoId();
  const user = ctx.from;
  const itemsJson = JSON.stringify(cart);

  await appendRow("Pedidos", [
    pedidoId,
    String(ctx.chat.id),
    `${user.first_name || ""} ${user.last_name || ""}`.trim(),
    user.username ? `@${user.username}` : "",
    itemsJson,
    String(subtotal),
    ship.type,
    String(ship.cost || 0),
    String(total),
    "TRANSFERENCIA",
    "NUEVO",
    new Date().toISOString()
  ]);

  // Sellos: suma 1 por pedido (podés cambiar regla después)
  const newSellos = await addSello(ctx.chat.id, 1);

  // Notificar vendedores (POS)
  const resumen =
`🧾 *Nuevo pedido* ${pedidoId}

Cliente: *${user.first_name || ""}* ${user.username ? `(@${user.username})` : ""}
Envío: *${ship.type}* (${money(cfg, ship.cost || 0)})
Total: *${money(cfg, total)}*

Items:
${cart.map((it,i)=>`${i+1}) ${it.name} x${it.qty} — ${money(cfg, (it.price||0)*(it.qty||1))}`).join("\n")}

Sellos del cliente ahora: *${newSellos}*`;

  await notifyVendors(resumen, pedidoId);

  // Vaciar carrito y confirmar al cliente
  state.cart = [];
  state.shipping = null;
  await saveState(ctx.chat.id, state);

  await ctx.reply(
`✅ *Pedido enviado!*
ID: *${pedidoId}*

En breve el vendedor lo confirma.
Gracias 🙌`,
    { parse_mode: "Markdown" }
  );
});

// POS: callbacks vendedor
bot.action(/^VCONF_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const pedidoId = ctx.match[1];
  await updatePedidoStatus(pedidoId, "CONFIRMADO");
  await ctx.editMessageText(`✅ Pedido ${pedidoId}: CONFIRMADO`);
});

bot.action(/^VPREP_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const pedidoId = ctx.match[1];
  await updatePedidoStatus(pedidoId, "PREPARANDO");
  await ctx.editMessageText(`👨‍🍳 Pedido ${pedidoId}: PREPARANDO`);
});

bot.action(/^VSENT_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const pedidoId = ctx.match[1];
  await updatePedidoStatus(pedidoId, "ENVIADO");
  await ctx.editMessageText(`🚚 Pedido ${pedidoId}: ENVIADO`);
});

bot.action(/^VDONE_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const pedidoId = ctx.match[1];
  await updatePedidoStatus(pedidoId, "ENTREGADO");
  await ctx.editMessageText(`🎉 Pedido ${pedidoId}: ENTREGADO`);
});

bot.action(/^VCAN_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const pedidoId = ctx.match[1];
  await updatePedidoStatus(pedidoId, "CANCELADO");
  await ctx.editMessageText(`❌ Pedido ${pedidoId}: CANCELADO`);
});

// Salud
bot.command("ping", async (ctx) => ctx.reply("✅ OK"));

bot.launch().then(() => {
  console.log("✅ Bot iniciado");
});

// Render/Heroku shutdown
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

console.log(`Servidor en puerto ${PORT} (Render asigna PORT automáticamente)`);
// Nota: Telegraf long-polling no necesita express.

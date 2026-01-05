import express from "express";
import { Telegraf, Markup } from "telegraf";
import { google } from "googleapis";

/* =========================
   NOTA IMPORTANTE
   NO CAMBIAR VARIABLES
========================= */
const BOT_TOKEN = process.env.BOT_TOKEN;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_B64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const BOT_LINK = process.env.BOT_LINK || "";

if (!BOT_TOKEN) throw new Error("Falta BOT_TOKEN");
if (!GOOGLE_SHEET_ID) throw new Error("Falta GOOGLE_SHEET_ID");
if (!GOOGLE_SERVICE_ACCOUNT_B64) throw new Error("Falta GOOGLE_SERVICE_ACCOUNT_B64");

/* =========================
   GOOGLE AUTH
========================= */
function decodeServiceAccount(b64) {
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}
const sa = decodeServiceAccount(GOOGLE_SERVICE_ACCOUNT_B64);

const auth = new google.auth.JWT({
  email: sa.client_email,
  key: sa.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

/* =========================
   HELPERS SHEETS
========================= */
async function getValues(range) {
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range,
  });
  return r.data.values || [];
}
async function setValues(range, values) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: GOOGLE_SHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
}
async function appendRow(sheet, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `${sheet}!A:Z`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

/* =========================
   UTILS
========================= */
const yes = (v) => String(v || "").toLowerCase() === "si";
const num = (v, d = 0) => (isNaN(Number(v)) ? d : Number(v));
const money = (n, m = "ARS") => `${m} ${Math.round(n).toLocaleString("es-AR")}`;
const nowISO = () => new Date().toISOString();
const in1hISO = () => new Date(Date.now() + 60 * 60000).toISOString();
const token = () => Math.random().toString(36).substring(2, 10).toUpperCase();

/* =========================
   BADGES VISUALES
========================= */
const B_CLIENTE = "🟦 <b>CLIENTE</b>";
const B_VENDEDOR = "🟧 <b>VENDEDOR</b>";
const B_OK = "🟩 <b>PAGO CONFIRMADO</b>";
const B_PEND = "🟨 <b>PAGO PENDIENTE</b>";
const B_CANCEL = "🟥 <b>CANCELADO</b>";

/* =========================
   BOT
========================= */
const bot = new Telegraf(BOT_TOKEN);

/* =========================
   MEMORIA SIMPLE
========================= */
const SESS = new Map();
function S(chat) {
  if (!SESS.has(chat)) {
    SESS.set(chat, {
      cart: [],
      step: null,
      entrega: null,
      pago: null,
      nombre: "",
      telefono: "",
      direccion: "",
      lastMsg: null,
    });
  }
  return SESS.get(chat);
}

/* =========================
   SAFE SEND (NO SPAM)
========================= */
async function send(ctx, text, kb) {
  const s = S(ctx.chat.id);
  try {
    if (s.lastMsg) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        s.lastMsg,
        null,
        text,
        { parse_mode: "HTML", ...kb }
      );
      return;
    }
  } catch {}
  const m = await ctx.reply(text, { parse_mode: "HTML", ...kb });
  s.lastMsg = m.message_id;
}

/* =========================
   CONFIG
========================= */
async function loadConfig() {
  const rows = await getValues("Config!A:B");
  const cfg = {};
  rows.forEach(r => cfg[r[0]] = r[1]);
  return cfg;
}

/* =========================
   CATALOGO
========================= */
async function loadCatalogo() {
  const rows = await getValues("Catalogo!A1:Z");
  const h = rows[0];
  return rows.slice(1).map(r => ({
    codigo: r[h.indexOf("codigo")],
    nombre: r[h.indexOf("nombre")],
    precio: num(r[h.indexOf("precio")]),
    unidad: r[h.indexOf("unidad")],
    categoria: r[h.indexOf("categoria")],
  }));
}

/* =========================
   MENU INICIAL (CON LOGO)
========================= */
bot.start(async ctx => {
  const cfg = await loadConfig();
  const logo = cfg.LogoURL;
  const txt = `
${B_CLIENTE}
🏠 <b>${cfg.NegocioNombre}</b>
📍 ${cfg.NegocioDireccion || ""}
🕒 ${cfg.NegocioHorario || ""}

${cfg.Descripcion || ""}
`.trim();

  if (logo) {
    const m = await ctx.replyWithPhoto(logo, {
      caption: txt,
      parse_mode: "HTML",
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback("🧀 Catálogo", "CAT")],
        [Markup.button.callback("🎟️ Sellos", "SELL")],
      ]).reply_markup,
    });
    S(ctx.chat.id).lastMsg = m.message_id;
  } else {
    await send(ctx, txt, Markup.inlineKeyboard([
      [Markup.button.callback("🧀 Catálogo", "CAT")],
      [Markup.button.callback("🎟️ Sellos", "SELL")],
    ]));
  }
});

/* =========================
   PARTE 2 / 2  (PEGAR DEBAJO)
========================= */

/* ====== SHEETS BASE ====== */
const SHEET_CATALOGO = "Catalogo";
const SHEET_CLIENTES = "Clientes";
const SHEET_PEDIDOS  = "Pedidos";

async function listSheets() {
  const res = await sheets.spreadsheets.get({ spreadsheetId: GOOGLE_SHEET_ID });
  return (res.data.sheets || []).map((s) => s.properties.title);
}
async function ensureSheet(name, headers) {
  const existing = await listSheets();
  if (!existing.includes(name)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: GOOGLE_SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: name } } }] },
    });
    await setValues(`${name}!A1`, [headers]);
  } else {
    const first = await getValues(`${name}!A1:Z1`);
    if (!first.length || String(first[0]?.join("") || "").trim() === "") {
      await setValues(`${name}!A1`, [headers]);
    }
  }
}

const HEAD_CLIENTES = ["ChatId","Nombre","Usuario","Sellos","TotalComprado","UltISO"];
const HEAD_PEDIDOS  = ["PedidoId","FechaISO","ExpiraISO","Estado","ChatIdCliente","Nombre","Telefono","Direccion","Entrega","Pago","Items","Total","RefBy","ConfirmToken"];

async function ensureBase() {
  await ensureSheet(SHEET_CLIENTES, HEAD_CLIENTES);
  await ensureSheet(SHEET_PEDIDOS,  HEAD_PEDIDOS);
}

/* ====== CATALOGO ====== */
function hmapFrom(headerRow) {
  const m = {};
  headerRow.forEach((h,i)=>{
    const k = String(h||"").trim().toLowerCase().replace(/\s+/g,"");
    if (k) m[k]=i;
  });
  return m;
}
function pick(row, hm, keys, def="") {
  for (const k of keys) {
    const i = hm[k];
    if (i !== undefined && row[i] !== undefined && String(row[i]).trim() !== "") return row[i];
  }
  return def;
}
function normUnit(u) {
  const s = String(u||"").trim().toLowerCase();
  if (!s) return "";
  if (s.includes("gram") || s==="g") return "g";
  if (s.includes("kilo") || s==="kg" || s==="k") return "kg";
  if (s.includes("unidad") || s==="u" || s==="un" || s==="uni") return "u";
  return s;
}

async function loadCatalog() {
  const rows = await getValues(`${SHEET_CATALOGO}!A1:Z`);
  if (!rows.length) return { items: [], cats: [] };
  const header = rows[0];
  const hm = hmapFrom(header);
  const data = rows.slice(1).filter(r => r.some(c => String(c||"").trim()!==""));

  const items = data.map((r, idx) => {
    const code = String(pick(r, hm, ["codigo","codigoproducto","id","sku"], `P${idx+1}`)).trim();
    const name = String(pick(r, hm, ["nombre","producto","name"], "Producto")).trim();
    const cat  = String(pick(r, hm, ["categoria","categoría","rubro"], "General")).trim() || "General";
    const img  = String(pick(r, hm, ["imagenurl","imagen","foto","urlimagen"], "")).trim();
    const desc = String(pick(r, hm, ["descripcion","descripción","detalle"], "")).trim();

    const unidad = normUnit(pick(r, hm, ["unidad","unidadtipo","tipo","medida"], ""));
    const precio = num(pick(r, hm, ["precio","price","preciounitario"], 0), 0);
    const precioKg = num(pick(r, hm, ["precioporkg","precioxkg","preciokg"], 0), 0);

    const pesable = (unidad === "g" || unidad === "kg") || (precioKg > 0);

    return {
      code, name, cat, img, desc,
      unidad: unidad || (pesable ? "g" : "u"),
      pesable,
      precioUnit: precio,
      precioKg: precioKg || (pesable ? precio : 0),
    };
  });

  const set = new Set(items.map(i=>i.cat||"General"));
  const cats = Array.from(set).sort((a,b)=>a.localeCompare(b,"es"));

  return { items, cats };
}

function productCaption(cfg, p, idx, total) {
  const moneda = cfg.Moneda || "ARS";
  const showPrice = yes(cfg.CatalogoMostrarPrecios || "SI");
  const lines = [];
  lines.push(`<b>${p.name}</b>`);
  if (p.desc) lines.push(`${p.desc}`);
  lines.push(`📌 ${p.cat}`);

  if (showPrice) {
    if (p.pesable) {
      const pk = p.precioKg || 0;
      if (pk>0) lines.push(`💰 <b>${money(pk, moneda)}</b> / kg`);
      else lines.push(`💰 <b>${money(p.precioUnit, moneda)}</b>`);
    } else {
      lines.push(`💰 <b>${money(p.precioUnit, moneda)}</b>`);
    }
  }

  lines.push(`<code>${idx+1}/${total}</code>`);
  return lines.join("\n");
}

function kbCategories(cats) {
  const rows = [];
  for (let i=0;i<cats.length;i+=2) {
    const r = [];
    r.push(Markup.button.callback(`📁 ${cats[i]}`, `CATSEL_${encodeURIComponent(cats[i])}`));
    if (cats[i+1]) r.push(Markup.button.callback(`📁 ${cats[i+1]}`, `CATSEL_${encodeURIComponent(cats[i+1])}`));
    rows.push(r);
  }
  rows.push([Markup.button.callback("🏠 Menú", "HOME")]);
  return Markup.inlineKeyboard(rows);
}

function kbProduct() {
  return (p)=>Markup.inlineKeyboard([
    [Markup.button.callback("⬅️", "PROD_PREV"), Markup.button.callback("➡️", "PROD_NEXT")],
    [Markup.button.callback("🔥 Quiero éste", `BUY_${p.code}`), Markup.button.callback("🔗 Compartir", `SHARE_PROD_${p.code}`)],
    [Markup.button.callback("🏠 Menú", "HOME")],
  ]);
}

function kbCart() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Finalizar compra", "CHECKOUT")],
    [Markup.button.callback("🧀 Seguir comprando", "CAT")],
    [Markup.button.callback("🗑️ Vaciar carrito", "CART_CLEAR")],
    [Markup.button.callback("🏠 Menú", "HOME")],
  ]);
}

/* ====== CLIENTES / SELLOS ====== */
async function getClienteRow(chatId) {
  const rows = await getValues(`${SHEET_CLIENTES}!A2:F`);
  const idx = rows.findIndex(r => String(r[0]||"") === String(chatId));
  if (idx === -1) return { idx:-1, row:null, rowNumber:null };
  return { idx, row: rows[idx], rowNumber: idx+2 };
}

async function upsertClienteBase({ chatId, nombre, usuario }) {
  const ex = await getClienteRow(chatId);
  if (ex.idx === -1) {
    await appendRow(SHEET_CLIENTES, [String(chatId), nombre||"", usuario||"", 0, 0, nowISO()]);
    return;
  }
  const r = ex.row;
  await setValues(`${SHEET_CLIENTES}!A${ex.rowNumber}:F${ex.rowNumber}`, [[
    String(chatId),
    nombre || r[1] || "",
    usuario || r[2] || "",
    num(r[3],0),
    num(r[4],0),
    nowISO()
  ]]);
}

async function addSellos(chatId, add, addTotal = 0) {
  const ex = await getClienteRow(chatId);
  if (ex.idx === -1) return;
  const r = ex.row;
  const sellos = num(r[3],0) + (add||0);
  const total  = num(r[4],0) + (addTotal||0);
  await setValues(`${SHEET_CLIENTES}!A${ex.rowNumber}:F${ex.rowNumber}`, [[
    r[0]||"",
    r[1]||"",
    r[2]||"",
    sellos,
    total,
    nowISO()
  ]]);
  return sellos;
}

/* ====== TICKETS POS (CLIENTE / VENDEDOR) ====== */
function ticketBox(title, bodyLines) {
  const top = `┏━━━━━━━━━━━━━━━━━━━━━━┓`;
  const mid = `┣━━━━━━━━━━━━━━━━━━━━━━┫`;
  const bot = `┗━━━━━━━━━━━━━━━━━━━━━━┛`;
  const t = String(title||"").slice(0,20);
  const head = `┃ ${t.padEnd(20," ")} ┃`;
  const lines = bodyLines.map(l=>{
    const s = String(l||"");
    return `┃ ${s.slice(0,20).padEnd(20," ")} ┃`;
  });
  return `<pre>${[top, head, mid, ...lines, bot].join("\n")}</pre>`;
}

function buildTicketCliente(cfg, pedido) {
  const moneda = cfg.Moneda || "ARS";
  const lines = [];
  lines.push(`PEDIDO ${pedido.id}`);
  lines.push(`Total: ${money(pedido.total, moneda)}`);
  lines.push(`Entrega: ${pedido.entrega}`);
  lines.push(`Pago: ${pedido.pago}`);
  lines.push(`Estado: ${pedido.estado}`);
  lines.push(`Vence: 1 hora`);
  lines.push(`— Items —`);
  pedido.items.forEach(it=>{
    lines.push(`${it.name} x${it.qtyLabel}`);
  });
  return `${B_CLIENTE}\n${ticketBox("TICKET", lines)}`;
}

function buildTicketVendedor(cfg, pedido) {
  const moneda = cfg.Moneda || "ARS";
  const lines = [];
  lines.push(`PEDIDO ${pedido.id}`);
  lines.push(`Cliente: ${pedido.nombre}`);
  lines.push(`Tel: ${pedido.tel}`);
  if (pedido.dir) lines.push(`Dir: ${pedido.dir}`);
  lines.push(`Entrega: ${pedido.entrega}`);
  lines.push(`Pago: ${pedido.pago}`);
  lines.push(`Total: ${money(pedido.total, moneda)}`);
  lines.push(`— Items —`);
  pedido.items.forEach(it=>{
    lines.push(`${it.name} x${it.qtyLabel}`);
  });
  return `${B_VENDEDOR}\n${ticketBox("PEDIDO", lines)}`;
}

/* ====== SHARE LINKS ====== */
function buildShareLinks({ botLink, text }) {
  const url = encodeURIComponent(botLink);
  const t = encodeURIComponent(text);
  return {
    wa: `https://wa.me/?text=${t}%0A${url}`,
    tg: `https://t.me/share/url?url=${url}&text=${t}`,
  };
}
function kbShare(links) {
  return Markup.inlineKeyboard([
    [Markup.button.url("📲 WhatsApp", links.wa)],
    [Markup.button.url("✈️ Telegram", links.tg)],
    [Markup.button.callback("🏠 Menú", "HOME")],
  ]);
}

function deepLinkFrom(cfg, payload) {
  const base = (BOT_LINK || cfg.BotLink || "").trim();
  if (!base) return "";
  if (base.includes("?start=")) return base.replace(/\?start=.*$/,"?start="+encodeURIComponent(payload));
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}start=${encodeURIComponent(payload)}`;
}

/* ====== FLUJO UI ====== */
async function showCategories(ctx) {
  const cfg = await loadConfig();
  const { cats } = await loadCatalog();
  if (!cats.length) return send(ctx, "🧀 Catálogo vacío. Cargá productos en la hoja <b>Catalogo</b>.", Markup.inlineKeyboard([[Markup.button.callback("🏠 Menú","HOME")]]));
  return send(ctx, `🧀 <b>Catálogo</b>\nElegí categoría 👇`, kbCategories(cats));
}

async function showProduct(ctx) {
  const cfg = await loadConfig();
  const sess = S(ctx.chat.id);
  const p = sess._prods[sess._i];
  if (!p) return showCategories(ctx);

  const cap = productCaption(cfg, p, sess._i, sess._prods.length);
  const kb = kbProduct()(p);

  if (p.img && p.img.startsWith("http")) {
    try {
      if (sess.lastMsg) {
        await ctx.telegram.editMessageMedia(
          ctx.chat.id,
          sess.lastMsg,
          null,
          { type:"photo", media:p.img, caption:cap, parse_mode:"HTML" },
          { reply_markup: kb.reply_markup }
        );
        return;
      }
    } catch {}
    const m = await ctx.replyWithPhoto(p.img, { caption:cap, parse_mode:"HTML", reply_markup: kb.reply_markup });
    sess.lastMsg = m.message_id;
    return;
  }
  return send(ctx, cap, kb);
}

function cartTotal(sess, cfg) {
  const moneda = cfg.Moneda || "ARS";
  let total = 0;
  sess.cart.forEach(it => total += it.subtotal);
  return { total, totalTxt: money(total, moneda) };
}

async function showCart(ctx) {
  const cfg = await loadConfig();
  const sess = S(ctx.chat.id);
  if (!sess.cart.length) return send(ctx, "🛒 Tu carrito está vacío.\nVolvé al catálogo para elegir productos.", Markup.inlineKeyboard([[Markup.button.callback("🧀 Catálogo","CAT")],[Markup.button.callback("🏠 Menú","HOME")]]));

  const { totalTxt } = cartTotal(sess, cfg);
  const lines = [];
  lines.push(`${B_CLIENTE}\n🛒 <b>Carrito</b>\n`);
  sess.cart.forEach((it,i)=>{
    lines.push(`${i+1}) <b>${it.name}</b> — ${it.qtyLabel} → ${money(it.subtotal, cfg.Moneda||"ARS")}`);
  });
  lines.push(`\n<b>Total:</b> ${totalTxt}`);
  return send(ctx, lines.join("\n"), kbCart());
}

/* ====== CHECKOUT (datos + pago + pendiente 1h) ====== */
function kbEntrega(cfg) {
  const rows = [];
  if (yes(cfg.UsaEnvíoDomicilio || cfg.UsaEnvioDomicilio || "SI")) rows.push([Markup.button.callback("🚚 Envío a domicilio", "ENT_ENVIO")]);
  if (yes(cfg.UsaRetiroLocal || "SI")) rows.push([Markup.button.callback("🏪 Retiro en local", "ENT_RETIRO")]);
  rows.push([Markup.button.callback("⚡ Envío express", "ENT_EXPRESS")]);
  rows.push([Markup.button.callback("⬅️ Volver al carrito", "CART")]);
  return Markup.inlineKeyboard(rows);
}

function kbPago(cfg) {
  const tipoOnline = String(cfg.TipoPagoOnline || "TRANSFERENCIA").toUpperCase();
  const rows = [];
  if (yes(cfg.PermitirPagoOnline || cfg.PermitePagoOnline || "SI")) {
    rows.push([Markup.button.callback(`💳 ${tipoOnline}`, `PAY_${tipoOnline}`)]);
  }
  rows.push([Markup.button.callback("💵 EFECTIVO", "PAY_EFECTIVO")]);
  rows.push([Markup.button.callback("⬅️ Volver", "CHECKOUT")]);
  return Markup.inlineKeyboard(rows);
}

function kbCancelConfirm() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🟥 Confirmar cancelación", "CANCEL_YES")],
    [Markup.button.callback("🏠 Menú", "HOME")],
  ]);
}

async function askCheckoutData(ctx) {
  const cfg = await loadConfig();
  const sess = S(ctx.chat.id);
  if (!sess.cart.length) return showCart(ctx);

  sess.step = "ENTREGA";
  return send(ctx, `${B_CLIENTE}\n✅ <b>Finalizar compra</b>\nElegí entrega 👇`, kbEntrega(cfg));
}

async function askNombre(ctx) {
  const sess = S(ctx.chat.id);
  sess.step = "NOMBRE";
  return send(ctx, `${B_CLIENTE}\n🧾 Decime tu <b>nombre</b> para el pedido (ej: Jenny).`);
}
async function askTelefono(ctx) {
  const sess = S(ctx.chat.id);
  sess.step = "TEL";
  return send(ctx, `${B_CLIENTE}\n📞 Pasame tu <b>teléfono</b> (solo números si podés).`);
}
async function askDireccion(ctx, cfg) {
  const sess = S(ctx.chat.id);
  sess.step = "DIR";
  const texto = cfg.TextoEnvíoDomicilio || cfg.TextoEnvioDomicilio || "";
  const costo = num(cfg.CostoEnvio || "0", 0);
  return send(ctx, `${B_CLIENTE}\n📍 Pasame la <b>dirección completa</b> (calle, número, entre calles, localidad).\n\n🚚 Envío: <b>${money(costo, cfg.Moneda||"ARS")}</b>\n${texto}`);
}

async function showPago(ctx) {
  const cfg = await loadConfig();
  const sess = S(ctx.chat.id);

  const nota =
    sess.entrega === "RETIRO"
      ? (cfg.TextoRetiroLocal || "")
      : sess.entrega === "EXPRESS"
        ? `⚡ Envío express: se entregará lo más pronto posible.\n${cfg.TextoEnvíoDomicilio || cfg.TextoEnvioDomicilio || ""}`
        : `🚚 Envío a domicilio.\n${cfg.TextoEnvíoDomicilio || cfg.TextoEnvioDomicilio || ""}`;

  sess.step = "PAGO";
  return send(ctx, `${B_CLIENTE}\n💳 Elegí <b>pago</b> 👇\n\n${nota}`.trim(), kbPago(cfg));
}

async function createPedidoAndNotify(ctx) {
  const cfg = await loadConfig();
  const sess = S(ctx.chat.id);

  const moneda = cfg.Moneda || "ARS";
  let total = 0;
  sess.cart.forEach(it => total += it.subtotal);

  const envioCost = num(cfg.CostoEnvio || "0", 0);
  if (sess.entrega === "ENVIO" || sess.entrega === "EXPRESS") total += envioCost;

  const pedidoId = `TQ-${new Date().toISOString().replace(/[-:]/g,"").slice(0,15)}-${token(4)}`;
  const confirmToken = token(16);

  const itemsText = sess.cart.map(it => `${it.name} x${it.qtyLabel}`).join(" | ");
  const expira = in1hISO();

  const nombre = sess.nombre || `${ctx.from.first_name||""} ${ctx.from.last_name||""}`.trim();
  const usuario = ctx.from.username ? `@${ctx.from.username}` : "";

  await upsertClienteBase({ chatId: ctx.chat.id, nombre, usuario });

  await appendRow(SHEET_PEDIDOS, [
    pedidoId, nowISO(), expira, "PENDIENTE",
    String(ctx.chat.id), nombre, sess.telefono||"", sess.direccion||"",
    sess.entrega, sess.pago,
    itemsText,
    total,
    sess.refBy || "",
    confirmToken
  ]);

  // Sellos por compra (solo si está activo)
  const usaSellos = yes(cfg.UsaSellos || "SI");
  const montoPorSello = num(cfg.MontoPorSello || "10000", 10000);
  const sellosGanados = usaSellos ? Math.floor(total / montoPorSello) : 0;
  if (sellosGanados > 0) await addSellos(ctx.chat.id, sellosGanados, total);
  else await addSellos(ctx.chat.id, 0, total);

  // Sello extra por referido (si existe refBy)
  if (sess.refBy) await addSellos(sess.refBy, 1, 0);

  const pedidoObj = {
    id: pedidoId,
    total,
    entrega: sess.entrega,
    pago: sess.pago,
    estado: "PENDIENTE",
    nombre,
    tel: sess.telefono||"",
    dir: sess.direccion||"",
    items: sess.cart.map(it=>({ name: it.name, qtyLabel: it.qtyLabel })),
  };

  // Cliente: ticket + instrucciones transferencia
  const alias = (cfg.AliasTransferencia || "").trim();
  const cbu   = (cfg.CBUPago || "").trim();
  const msgTr = (cfg.MensajeTransferencia || "").trim();

  const wa = (cfg.WhatsAppLink || "").trim() || (() => {
    const tel = String(cfg.NegocioTelefono||"").replace(/[^\d]/g,"");
    return tel ? `https://wa.me/${tel}` : "";
  })();

  const avisoPend = `${B_PEND}\nTu pedido queda <b>PENDIENTE</b> por <b>1 hora</b> hasta confirmación del vendedor.`;

  let extraPay = "";
  if (String(sess.pago).toUpperCase() !== "EFECTIVO") {
    extraPay = [
      `\n<b>Transferencia</b>`,
      alias ? `• Alias: <code>${alias}</code>` : "",
      cbu ? `• CBU: <code>${cbu}</code>` : "",
      msgTr ? `\n${msgTr}` : "",
      wa ? `\n📲 Enviá el <b>comprobante</b> por WhatsApp:\n${wa}` : "",
      `\nLuego el vendedor confirma y te avisa por acá.`
    ].filter(Boolean).join("\n");
  } else {
    extraPay = `\n💵 Pagás en <b>efectivo</b>. El vendedor confirma y se prepara el pedido.`;
  }

  await send(ctx, `${buildTicketCliente(cfg, pedidoObj)}\n${avisoPend}\n${extraPay}`, Markup.inlineKeyboard([
    [Markup.button.callback("❌ Cancelar compra", `CANCEL_${pedidoId}`)],
    [Markup.button.callback("🏠 Menú", "HOME")],
  ]));

  // Vendedor: ticket + botón confirmar
  const vendChat = String(cfg.VendedorChatId || cfg.ChatIdVendedor || cfg.ChatIdVendedor || "").trim();
  const botLink = (BOT_LINK || cfg.BotLink || "").trim();

  const confirmStart = botLink ? deepLinkFrom(cfg, `CONF_${pedidoId}__TK_${confirmToken}`) : "";
  const vendMsg = `${buildTicketVendedor(cfg, pedidoObj)}\n${B_PEND}\nConfirmar pago del pedido 👇\n${confirmStart ? `\nLink directo (WhatsApp→Telegram):\n${confirmStart}` : ""}`;

  if (vendChat) {
    try {
      await bot.telegram.sendMessage(vendChat, vendMsg, {
        parse_mode:"HTML",
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback("✅ Confirmar transferencia", `CONFIRM_${pedidoId}__TK_${confirmToken}`)],
        ]).reply_markup
      });
    } catch {}
  }

  // limpiar carrito y pasos
  sess.cart = [];
  sess.step = null;
  sess.entrega = null;
  sess.pago = null;
  sess.nombre = "";
  sess.telefono = "";
  sess.direccion = "";
}

/* ====== SELL0S / AYUDA / COMPARTIR ====== */
async function showSellos(ctx) {
  const cfg = await loadConfig();
  const ex = await getClienteRow(ctx.chat.id);
  const sellos = ex.idx === -1 ? 0 : num(ex.row[3],0);

  const montoPorSello = num(cfg.MontoPorSello || "10000", 10000);
  const lines = [];
  lines.push(`${B_CLIENTE}`);
  lines.push(`🎟️ <b>Sellos</b>`);
  lines.push(`Tenés <b>${sellos}</b> sellos.`);
  lines.push(`Cada <b>${money(montoPorSello, cfg.Moneda||"ARS")}</b> = <b>1 sello</b>.`);
  if (yes(cfg.UsaNiveles || "SI")) {
    if (cfg.SellosPorNivel) lines.push(`\n🏅 <b>Niveles</b>\n${cfg.SellosPorNivel}`);
    if (cfg.BeneficiosPorNivel) lines.push(`\n🎁 <b>Beneficios</b>\n${cfg.BeneficiosPorNivel}`);
  }
  lines.push(`\n✨ Tip: si un referido compra desde tu link, ganás <b>1 sello</b>.`);

  const card = (cfg.CARD_URL || cfg.SelloURL || "").trim();
  const kb = Markup.inlineKeyboard([[Markup.button.callback("🧀 Catálogo","CAT")],[Markup.button.callback("🏠 Menú","HOME")]]);

  if (card && card.startsWith("http")) {
    const sess = S(ctx.chat.id);
    try {
      if (sess.lastMsg) {
        await ctx.telegram.editMessageMedia(
          ctx.chat.id, sess.lastMsg, null,
          { type:"photo", media: card, caption: lines.join("\n"), parse_mode:"HTML" },
          { reply_markup: kb.reply_markup }
        );
        return;
      }
    } catch {}
    const m = await ctx.replyWithPhoto(card, { caption: lines.join("\n"), parse_mode:"HTML", reply_markup: kb.reply_markup });
    sess.lastMsg = m.message_id;
    return;
  }
  return send(ctx, lines.join("\n"), kb);
}

async function showHelp(ctx) {
  const cfg = await loadConfig();
  const wa = (cfg.WhatsAppLink || "").trim() || (() => {
    const tel = String(cfg.NegocioTelefono||"").replace(/[^\d]/g,"");
    return tel ? `https://wa.me/${tel}` : "";
  })();

  const vend = String(cfg.VendedorChatId || cfg.ChatIdVendedor || "").trim();
  const kb = Markup.inlineKeyboard([
    wa ? [Markup.button.url("🧑‍🍳 Contactar vendedor (WhatsApp)", wa)] : [],
    [Markup.button.callback("🧀 Ver catálogo", "CAT")],
    [Markup.button.callback("🏠 Menú", "HOME")],
  ].filter(r=>r.length));

  const txt = [
    `${B_CLIENTE}`,
    `🆘 <b>Ayuda</b>`,
    `¿No encontraste algo?`,
    `• Decime qué te falta y lo agregamos.`,
    `• ¿Querés sugerir un producto?`,
    `• ¿Tenés alguna consulta del pedido?`,
    ``,
    `Tip: el catálogo se ojea con ⬅️➡️ para no llenar el chat.`
  ].join("\n");

  return send(ctx, txt, kb);
}

async function shareBot(ctx) {
  const cfg = await loadConfig();
  const link = (BOT_LINK || cfg.BotLink || "").trim();
  if (!link) return send(ctx, "Falta <b>BOT_LINK</b> (env) o <b>BotLink</b> (Config).", Markup.inlineKeyboard([[Markup.button.callback("🏠 Menú","HOME")]]));

  const text = (cfg.TextoCompartirBot || `🧀 Comprá en ${cfg.NegocioNombre||"Todo Queso"} desde este bot:`).trim();
  const links = buildShareLinks({ botLink: link, text });

  const contacto = (cfg.EmailSistema || "").trim();
  const sistema  = (cfg.TextoSistema || "").trim();
  const extra = (contacto || sistema) ? `\n\n${sistema}\n${contacto}`.trim() : "";

  return send(ctx, `${B_CLIENTE}\n📣 <b>Compartir bot</b>\nElegí dónde compartir 👇${extra ? "\n\n"+extra : ""}`, kbShare(links));
}

async function shareProduct(ctx, code) {
  const cfg = await loadConfig();
  const { items } = await loadCatalog();
  const p = items.find(x => x.code === code);
  if (!p) return send(ctx, "No encontré ese producto.", Markup.inlineKeyboard([[Markup.button.callback("🏠 Menú","HOME")]]));

  const payload = `PROD_${code}`;
  const deep = deepLinkFrom(cfg, payload);
  if (!deep) return send(ctx, "Falta <b>BOT_LINK</b> (env) o <b>BotLink</b> (Config).", Markup.inlineKeyboard([[Markup.button.callback("🏠 Menú","HOME")]]));

  const moneda = cfg.Moneda || "ARS";
  const priceTxt = p.pesable ? `${money(p.precioKg||0,moneda)} / kg` : `${money(p.precioUnit,moneda)}`;
  const text = `🧀 ${cfg.NegocioNombre||"Todo Queso"}\nPromo: ${p.name} — ${priceTxt}\nTocá el link y compralo 👇`;
  const links = buildShareLinks({ botLink: deep, text });

  return send(ctx, `${B_CLIENTE}\n🔗 <b>Compartir producto</b>\n${p.name}\nElegí dónde compartir 👇`, kbShare(links));
}

/* ====== COMPRA: cantidad (gramos/unidades) ====== */
async function startBuy(ctx, code) {
  const cfg = await loadConfig();
  const sess = S(ctx.chat.id);
  const p = sess._prods.find(x => x.code === code);
  if (!p) return;

  sess._buying = p.code;

  if (p.pesable) {
    sess.step = "QTY_G";
    const ejemplo = "250";
    return send(ctx, `${B_CLIENTE}\n🔥 <b>${p.name}</b>\n¿Cuántos <b>gramos</b> querés? (ej: <b>${ejemplo}</b>)`);
  } else {
    sess.step = "QTY_U";
    return send(ctx, `${B_CLIENTE}\n🔥 <b>${p.name}</b>\n¿Cuántas <b>unidades</b> querés? (ej: <b>2</b>)`);
  }
}

function addToCart(sess, p, qtyValue, cfg) {
  const moneda = cfg.Moneda || "ARS";
  if (p.pesable) {
    const grams = Math.max(1, Math.round(qtyValue));
    const priceKg = p.precioKg || 0;
    const subtotal = (priceKg * grams) / 1000;
    sess.cart.push({
      code: p.code,
      name: p.name,
      qtyLabel: `${grams}g`,
      subtotal
    });
    return { subtotalTxt: money(subtotal, moneda) };
  } else {
    const units = Math.max(1, Math.round(qtyValue));
    const subtotal = (p.precioUnit || 0) * units;
    sess.cart.push({
      code: p.code,
      name: p.name,
      qtyLabel: `${units}u`,
      subtotal
    });
    return { subtotalTxt: money(subtotal, moneda) };
  }
}

/* ====== PEDIDOS: confirmar / cancelar ====== */
async function findPedido(pedidoId) {
  const rows = await getValues(`${SHEET_PEDIDOS}!A2:N`);
  const idx = rows.findIndex(r => String(r[0]||"") === String(pedidoId));
  if (idx === -1) return { idx:-1, row:null, rowNumber:null };
  return { idx, row: rows[idx], rowNumber: idx+2 };
}

async function updatePedidoEstado(pedidoId, estado) {
  const p = await findPedido(pedidoId);
  if (p.idx === -1) return null;
  const r = p.row;
  r[3] = estado; // Estado
  await setValues(`${SHEET_PEDIDOS}!A${p.rowNumber}:N${p.rowNumber}`, [r]);
  return r;
}

function isExpired(expiraISO) {
  const t = Date.parse(expiraISO || "");
  return Number.isFinite(t) ? Date.now() > t : false;
}

/* ====== BOT: ACCIONES ====== */
bot.action("HOME", async (ctx)=>{ await ctx.answerCbQuery(); await showHome(ctx); });

bot.action("CAT", async (ctx)=>{ await ctx.answerCbQuery(); await showCategories(ctx); });

bot.action(/^CATSEL_(.+)$/i, async (ctx)=>{
  await ctx.answerCbQuery();
  const cat = decodeURIComponent(ctx.match[1]);
  const { items } = await loadCatalog();
  const sess = S(ctx.chat.id);
  sess._prods = items.filter(x => (x.cat||"General") === cat);
  sess._i = 0;
  if (!sess._prods.length) return send(ctx, "No hay productos en esa categoría.", Markup.inlineKeyboard([[Markup.button.callback("🧀 Catálogo","CAT")],[Markup.button.callback("🏠 Menú","HOME")]]));
  await showProduct(ctx);
});

bot.action("PROD_NEXT", async (ctx)=>{
  await ctx.answerCbQuery();
  const sess = S(ctx.chat.id);
  if (!sess._prods.length) return showCategories(ctx);
  sess._i = (sess._i + 1) % sess._prods.length;
  await showProduct(ctx);
});

bot.action("PROD_PREV", async (ctx)=>{
  await ctx.answerCbQuery();
  const sess = S(ctx.chat.id);
  if (!sess._prods.length) return showCategories(ctx);
  sess._i = (sess._i - 1 + sess._prods.length) % sess._prods.length;
  await showProduct(ctx);
});

bot.action(/^BUY_(.+)$/i, async (ctx)=>{
  await ctx.answerCbQuery();
  await startBuy(ctx, ctx.match[1]);
});

bot.action("CART", async (ctx)=>{ await ctx.answerCbQuery(); await showCart(ctx); });
bot.action("CART_CLEAR", async (ctx)=>{ await ctx.answerCbQuery(); const s=S(ctx.chat.id); s.cart=[]; await showCart(ctx); });

bot.action("CHECKOUT", async (ctx)=>{ await ctx.answerCbQuery(); await askCheckoutData(ctx); });

bot.action("ENT_ENVIO", async (ctx)=>{ await ctx.answerCbQuery(); const s=S(ctx.chat.id); s.entrega="ENVIO"; await askNombre(ctx); });
bot.action("ENT_RETIRO", async (ctx)=>{ await ctx.answerCbQuery(); const s=S(ctx.chat.id); s.entrega="RETIRO"; await askNombre(ctx); });
bot.action("ENT_EXPRESS", async (ctx)=>{ await ctx.answerCbQuery(); const s=S(ctx.chat.id); s.entrega="EXPRESS"; await askNombre(ctx); });

bot.action(/^PAY_(.+)$/i, async (ctx)=>{ await ctx.answerCbQuery(); const s=S(ctx.chat.id); s.pago=String(ctx.match[1]||"TRANSFERENCIA").toUpperCase(); await createPedidoAndNotify(ctx); });
bot.action("PAY_EFECTIVO", async (ctx)=>{ await ctx.answerCbQuery(); const s=S(ctx.chat.id); s.pago="EFECTIVO"; await createPedidoAndNotify(ctx); });

bot.action(/^CANCEL_(.+)$/i, async (ctx)=>{
  await ctx.answerCbQuery();
  const pedidoId = ctx.match[1];
  const sess = S(ctx.chat.id);
  sess._cancelPedido = pedidoId;
  return send(ctx, `${B_CLIENTE}\n${B_CANCEL}\n¿Confirmás que querés <b>cancelar</b> el pedido <b>${pedidoId}</b>?`, kbCancelConfirm());
});

bot.action("CANCEL_YES", async (ctx)=>{
  await ctx.answerCbQuery();
  const sess = S(ctx.chat.id);
  const pedidoId = sess._cancelPedido;
  sess._cancelPedido = "";
  if (!pedidoId) return showHome(ctx);
  const row = await updatePedidoEstado(pedidoId, "CANCELADO");
  if (row) await send(ctx, `${B_CLIENTE}\n${B_CANCEL}\nPedido <b>${pedidoId}</b> cancelado.`, Markup.inlineKeyboard([[Markup.button.callback("🏠 Menú","HOME")]]));
  else await send(ctx, "No encontré ese pedido.", Markup.inlineKeyboard([[Markup.button.callback("🏠 Menú","HOME")]]));
});

bot.action("SELL", async (ctx)=>{ await ctx.answerCbQuery(); await showSellos(ctx); });
bot.action("HELP", async (ctx)=>{ await ctx.answerCbQuery(); await showHelp(ctx); });
bot.action("SHARE_BOT", async (ctx)=>{ await ctx.answerCbQuery(); await shareBot(ctx); });
bot.action(/^SHARE_PROD_(.+)$/i, async (ctx)=>{ await ctx.answerCbQuery(); await shareProduct(ctx, ctx.match[1]); });

/* ====== CONFIRMACION VENDEDOR ====== */
async function confirmPedido(pedidoId, tk, fromCtx) {
  const cfg = await loadConfig();
  const p = await findPedido(pedidoId);
  if (p.idx === -1) return { ok:false, msg:"No encontré el pedido." };

  const r = p.row;
  const expira = r[2];
  const estado = String(r[3]||"");
  const chatCliente = r[4];
  const tkSheet = String(r[13]||"");

  if (tk && tkSheet && String(tk) !== tkSheet) return { ok:false, msg:"Token inválido." };
  if (estado === "CONFIRMADO") return { ok:true, msg:"Ya estaba confirmado." };
  if (estado === "CANCELADO") return { ok:false, msg:"Está cancelado." };
  if (isExpired(expira)) {
    await updatePedidoEstado(pedidoId, "VENCIDO");
    return { ok:false, msg:"El pedido venció (1 hora).", expired:true };
  }

  await updatePedidoEstado(pedidoId, "CONFIRMADO");

  // Aviso al cliente (ticket confirmado)
  const pedidoObj = {
    id: pedidoId,
    total: num(r[11],0),
    entrega: r[8],
    pago: r[9],
    estado: "CONFIRMADO",
    nombre: r[5],
    tel: r[6],
    dir: r[7],
    items: String(r[10]||"").split("|").map(s=>({ name: String(s).trim(), qtyLabel:"" })).filter(x=>x.name)
  };

  const txtConf = (cfg.TextoConfirmacionPedido || "✅ Pedido confirmado. ¡Se está preparando!").trim();
  const extraEntrega =
    pedidoObj.entrega === "RETIRO"
      ? `\n🏪 Podés retirar dentro del horario: ${cfg.NegocioHorario||""}`.trim()
      : pedidoObj.entrega === "EXPRESS"
        ? `\n⚡ Envío express: lo antes posible.` : `\n🚚 Envío a domicilio.`;

  try {
    await bot.telegram.sendMessage(chatCliente, `${B_OK}\n${buildTicketCliente(cfg, pedidoObj)}\n${txtConf}${extraEntrega}`, { parse_mode:"HTML" });
  } catch {}

  return { ok:true, msg:"Confirmado y avisado al cliente." };
}

bot.action(/^CONFIRM_(.+)__TK_(.+)$/i, async (ctx)=>{
  await ctx.answerCbQuery();
  const pedidoId = ctx.match[1];
  const tk = ctx.match[2];
  const res = await confirmPedido(pedidoId, tk, ctx);
  const msg = res.ok ? `✅ ${res.msg}` : `⚠️ ${res.msg}`;
  await send(ctx, `${B_VENDEDOR}\n${msg}`, Markup.inlineKeyboard([[Markup.button.callback("🏠 Menú","HOME")]]));
});

/* ====== /start payloads: PROD_ / CONF_ / REF_ ====== */
bot.command("start", async (ctx) => {
  await ensureBase();

  const sess = S(ctx.chat.id);
  const payload = String(ctx.startPayload || "").trim();

  // CONFIRMACION desde link (WhatsApp→Telegram)
  // formato: CONF_<pedidoId>__TK_<token>
  if (payload.startsWith("CONF_")) {
    const m = payload.match(/^CONF_(.+)__TK_(.+)$/i);
    if (!m) return send(ctx, `${B_VENDEDOR}\n⚠️ Link inválido.`, Markup.inlineKeyboard([[Markup.button.callback("🏠 Menú","HOME")]]));
    const pedidoId = m[1];
    const tk = m[2];
    const res = await confirmPedido(pedidoId, tk, ctx);
    const msg = res.ok ? `✅ ${res.msg}` : `⚠️ ${res.msg}`;
    return send(ctx, `${B_VENDEDOR}\n${msg}`, Markup.inlineKeyboard([[Markup.button.callback("🏠 Menú","HOME")]]));
  }

  // Link a producto: PROD_<code>
  if (payload.startsWith("PROD_")) {
    const code = payload.replace(/^PROD_/i,"").trim();
    const { items } = await loadCatalog();
    const p = items.find(x => x.code === code);
    if (p) {
      sess._prods = items.filter(x => (x.cat||"General") === (p.cat||"General"));
      sess._i = Math.max(0, sess._prods.findIndex(x=>x.code===code));
      await showProduct(ctx);
      return;
    }
  }

  // Referidos (si algún día lo querés activar): REF_<chatId>__PROD_<code>
  if (payload.includes("REF_")) {
    const mRef = payload.match(/REF_(\d+)/i);
    if (mRef) sess.refBy = mRef[1];
    const mProd = payload.match(/PROD_([A-Za-z0-9_-]+)/i);
    if (mProd) {
      const code = mProd[1];
      const { items } = await loadCatalog();
      const p = items.find(x => x.code === code);
      if (p) {
        sess._prods = items.filter(x => (x.cat||"General") === (p.cat||"General"));
        sess._i = Math.max(0, sess._prods.findIndex(x=>x.code===code));
        await showProduct(ctx);
        return;
      }
    }
  }

  await showHome(ctx);
});

/* ====== INPUT TEXT (cantidad + datos envío) ====== */
bot.on("text", async (ctx) => {
  await ensureBase();

  const cfg = await loadConfig();
  const sess = S(ctx.chat.id);
  const txt = String(ctx.message.text || "").trim();

  // cantidad pesable (gramos)
  if (sess.step === "QTY_G" && sess._buying) {
    const grams = Math.round(num(txt, 0));
    if (!grams || grams <= 0) return send(ctx, `${B_CLIENTE}\nDecime un número de <b>gramos</b> (ej: 250).`);
    const p = sess._prods.find(x => x.code === sess._buying);
    if (!p) return showCategories(ctx);
    addToCart(sess, p, grams, cfg);
    sess._buying = null;
    sess.step = null;
    return showCart(ctx);
  }

  // cantidad unidades
  if (sess.step === "QTY_U" && sess._buying) {
    const units = Math.round(num(txt, 0));
    if (!units || units <= 0) return send(ctx, `${B_CLIENTE}\nDecime cuántas <b>unidades</b> (ej: 2).`);
    const p = sess._prods.find(x => x.code === sess._buying);
    if (!p) return showCategories(ctx);
    addToCart(sess, p, units, cfg);
    sess._buying = null;
    sess.step = null;
    return showCart(ctx);
  }

  // datos checkout
  if (sess.step === "NOMBRE") {
    sess.nombre = txt.slice(0, 60);
    await askTelefono(ctx);
    return;
  }
  if (sess.step === "TEL") {
    sess.telefono = txt.slice(0, 40);
    if (sess.entrega === "ENVIO" || sess.entrega === "EXPRESS") {
      await askDireccion(ctx, cfg);
      return;
    }
    // retiro
    await showPago(ctx);
    return;
  }
  if (sess.step === "DIR") {
    sess.direccion = txt.slice(0, 120);
    await showPago(ctx);
    return;
  }

  // si no está en flujo, no ensucia: vuelve al menú
  return showHome(ctx);
});

/* ====== SERVER (Render) ====== */
const app = express();
app.use(express.json());
app.get("/", (req,res)=>res.status(200).send("EzerBot OK ✅"));
app.get("/health", (req,res)=>res.status(200).send("OK"));

const PORT = process.env.PORT || 10000;

async function start() {
  await ensureBase();

  if (PUBLIC_URL && PUBLIC_URL.startsWith("http")) {
    const hook = `${PUBLIC_URL.replace(/\/$/, "")}/telegram`;
    await bot.telegram.setWebhook(hook);
    app.use(bot.webhookCallback("/telegram"));
    app.listen(PORT, ()=>console.log(`✅ Webhook: ${hook} | PORT ${PORT}`));
  } else {
    bot.launch();
    app.listen(PORT, ()=>console.log(`✅ Long polling | PORT ${PORT}`));
  }
}

start().catch((e)=>{
  console.error("FATAL:", e?.message || e);
  process.exit(1);
});
```0


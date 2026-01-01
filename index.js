// index.js (ESM) — UN SOLO SCRIPT COMPLETO
// Variables en Render (solo estas 3):
// TELEGRAM_TOKEN
// DATA_API_URL   (tu Apps Script URL /exec)
// PUBLIC_URL     (https://ezerbot-system.onrender.com)

// ✅ Telegram con carrusel (foto + botones)
// ✅ Catálogo por botones (no link vacío)
// ✅ Sellos en web /card/:userId con logo de Todo Queso y sellos llenos por compras
// ✅ Lee TODO desde Sheets (Config + Catalogo + Clientes + Referidos)
// ✅ Sin node-fetch (usa fetch nativo de Node 18+ / 22)
// ✅ Sin requerir cambiar más variables

import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const TOKEN = process.env.TELEGRAM_TOKEN || "";
const DATA_API_URL = (process.env.DATA_API_URL || "").trim();
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");

if (!TOKEN || !DATA_API_URL || !PUBLIC_URL) {
  console.error("Faltan variables: TELEGRAM_TOKEN, DATA_API_URL, PUBLIC_URL");
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;
const WEBHOOK_PATH = `/tg/${TOKEN}`;

const PORT = process.env.PORT || 3000;

// =========================
// Helpers Telegram
// =========================
async function tg(method, payload) {
  const r = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  return j;
}

function safeText(x) {
  return (x ?? "").toString().trim();
}

function escHtml(s) {
  return safeText(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// =========================
// CSV utils
// =========================
function parseCSV(csvText) {
  const text = safeText(csvText);
  if (!text) return [];
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"' && inQuotes && next === '"') {
      cur += '"';
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (ch === "," || ch === ";")) {
      row.push(cur);
      cur = "";
      continue;
    }
    if (!inQuotes && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
      continue;
    }
    cur += ch;
  }
  row.push(cur);
  rows.push(row);

  const cleaned = rows
    .map((r) => r.map((c) => safeText(c)))
    .filter((r) => r.some((c) => c !== ""));
  if (!cleaned.length) return [];

  const header = cleaned[0];
  const out = [];
  for (let i = 1; i < cleaned.length; i++) {
    const obj = {};
    for (let k = 0; k < header.length; k++) obj[header[k]] = cleaned[i][k] ?? "";
    out.push(obj);
  }
  return out;
}

async function fetchTabCSV(tabName) {
  const url = `${DATA_API_URL}?tab=${encodeURIComponent(tabName)}`;
  const r = await fetch(url, { method: "GET" });
  const txt = await r.text();
  // si el Apps Script devuelve JSON con "csv", lo soportamos
  try {
    const j = JSON.parse(txt);
    if (j && typeof j === "object") {
      if (j.csv) return safeText(j.csv);
      if (j.data && Array.isArray(j.data) && j.data.length) {
        // no es csv, pero algo devolvió
      }
      if (j.ok === true && j.message) {
        // sigue
      }
    }
  } catch {}
  return txt;
}

// =========================
// Carga de datos
// =========================
let CACHE = {
  ts: 0,
  config: null,
  catalogo: null,
  clientes: null,
  referidos: null,
};

const CACHE_MS = 7000;

async function loadAll() {
  const now = Date.now();
  if (now - CACHE.ts < CACHE_MS && CACHE.config && CACHE.catalogo) return CACHE;

  const [configCSV, catalogCSV, clientesCSV, referidosCSV] = await Promise.all([
    fetchTabCSV("Config").catch(() => ""),
    fetchTabCSV("Catalogo").catch(() => ""),
    fetchTabCSV("Clientes").catch(() => ""),
    fetchTabCSV("Referidos").catch(() => ""),
  ]);

  const configRows = parseCSV(configCSV);
  const catalogRows = parseCSV(catalogCSV);
  const clientesRows = parseCSV(clientesCSV);
  const referidosRows = parseCSV(referidosCSV);

  const config = {};
  for (const r of configRows) {
    const k = safeText(r.KEY || r.Key || r.key);
    const v = safeText(r.VALUE || r.Value || r.value);
    if (k) config[k] = v;
  }

  CACHE = {
    ts: now,
    config,
    catalogo: catalogRows,
    clientes: clientesRows,
    referidos: referidosRows,
  };
  return CACHE;
}

function pickConfig(config, key, fallback = "") {
  const v = safeText(config?.[key]);
  return v || fallback;
}

// =========================
// Lógica negocio: unidades/gramos
// =========================
function isPeso(unidad) {
  const u = safeText(unidad).toLowerCase();
  return ["kg", "kilo", "kilos", "g", "gr", "gramos"].includes(u);
}

function precioTexto(p) {
  const unidad = safeText(p.UNIDAD);
  const precio = safeText(p.PRECIO);
  const ppk = safeText(p.PRECIOPORKILO);

  if (isPeso(unidad)) {
    if (ppk) return `$${ppk} / kg`;
    if (precio) return `$${precio} / kg`;
    return `$0 / kg`;
  }
  return `$${precio || "0"} c/u`;
}

function descripcionProducto(p) {
  const desc = safeText(p.DESCRIPCION);
  if (!desc) return "";
  return desc.length > 800 ? desc.slice(0, 800) + "…" : desc;
}

// =========================
// Estado en memoria (carritos / paginación)
// =========================
const STATE = {
  cart: new Map(), // userId -> {items: {codigo: qtyOrGrams}, lastMsgId, lastChatId}
  page: new Map(), // userId -> {cat, idx}
};

function getUserCart(userId) {
  if (!STATE.cart.has(userId)) STATE.cart.set(userId, { items: {}, lastMsgId: null, lastChatId: null });
  return STATE.cart.get(userId);
}

function setUserPage(userId, cat, idx) {
  STATE.page.set(userId, { cat, idx });
}
function getUserPage(userId) {
  return STATE.page.get(userId) || { cat: "ALL", idx: 0 };
}

// =========================
// Catálogo en Telegram estilo carrusel (1 producto por mensaje + botones, paginado)
// =========================
function buildProductList(catalogo, cat) {
  const list = catalogo
    .map((p) => ({
      CODIGO: safeText(p.CODIGO),
      NOMBRE: safeText(p.NOMBRE),
      PRECIO: safeText(p.PRECIO),
      UNIDAD: safeText(p.UNIDAD),
      PRECIOPORKILO: safeText(p.PRECIOPORKILO),
      CODIGOBARRAS: safeText(p.CODIGOBARRAS),
      DESCRIPCION: safeText(p.DESCRIPCION),
      IMAGEN: safeText(p.IMAGEN),
      CATEGORIA: safeText(p.CATEGORIA || "General"),
    }))
    .filter((p) => p.CODIGO && p.NOMBRE);

  if (!cat || cat === "ALL") return list;
  return list.filter((p) => safeText(p.CATEGORIA).toLowerCase() === safeText(cat).toLowerCase());
}

function uniqueCategories(catalogo) {
  const set = new Set();
  for (const p of catalogo) {
    const c = safeText(p.CATEGORIA || "General");
    if (c) set.add(c);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function cartTotalText(catalogo, items) {
  let total = 0;
  let lines = [];
  for (const [codigo, qty] of Object.entries(items || {})) {
    if (!qty || qty <= 0) continue;
    const p = catalogo.find((x) => safeText(x.CODIGO) === codigo);
    if (!p) continue;

    if (isPeso(p.UNIDAD)) {
      const grams = qty;
      const ppk = Number(safeText(p.PRECIOPORKILO || p.PRECIO) || 0);
      const subtotal = Math.round((grams / 1000) * ppk);
      total += subtotal;
      lines.push(`• ${p.NOMBRE} — ${grams}g — $${subtotal}`);
    } else {
      const units = qty;
      const pu = Number(safeText(p.PRECIO) || 0);
      const subtotal = units * pu;
      total += subtotal;
      lines.push(`• ${p.NOMBRE} — ${units}u — $${subtotal}`);
    }
  }
  if (!lines.length) return "🛒 Carrito vacío.";
  return `🛒 Tu carrito:\n${lines.join("\n")}\n\n💰 Total: $${total}`;
}

async function sendProduct(chatId, userId, producto, idx, totalCount, catLabel) {
  const cart = getUserCart(userId);
  const qty = cart.items[producto.CODIGO] || 0;

  const title = `🧀 ${producto.NOMBRE}`;
  const price = precioTexto(producto);
  const desc = descripcionProducto(producto);

  const qtyText = isPeso(producto.UNIDAD) ? `${qty}g` : `${qty}u`;

  const caption =
`${title}
${price}
${desc ? "\n" + desc : ""}

📍 Categoría: ${producto.CATEGORIA || "General"}
📦 En carrito: ${qtyText}

📄 ${idx + 1}/${totalCount} ${catLabel ? "— " + catLabel : ""}`;

  const addStep = isPeso(producto.UNIDAD) ? 100 : 1;
  const addLabel = isPeso(producto.UNIDAD) ? "➕ 100g" : "➕ 1";
  const minusLabel = "➖";
  const nextLabel = "➡️";
  const prevLabel = "⬅️";

  const keyboard = {
    inline_keyboard: [
      [
        { text: prevLabel, callback_data: `nav|prev` },
        { text: nextLabel, callback_data: `nav|next` },
      ],
      [
        { text: minusLabel, callback_data: `cart|menos|${producto.CODIGO}|${addStep}` },
        { text: addLabel, callback_data: `cart|mas|${producto.CODIGO}|${addStep}` },
      ],
      [
        { text: "🧾 Ver carrito", callback_data: `cart|ver` },
        { text: "✅ Finalizar", callback_data: `cart|fin` },
      ],
      [
        { text: "📂 Categorías", callback_data: `cats|open` },
      ],
    ],
  };

  // Preferimos sendPhoto si hay IMAGEN válida; si no, sendMessage
  const photo = safeText(producto.IMAGEN);
  let sent;
  if (photo) {
    sent = await tg("sendPhoto", {
      chat_id: chatId,
      photo,
      caption,
      reply_markup: keyboard,
    });
  } else {
    sent = await tg("sendMessage", {
      chat_id: chatId,
      text: caption,
      reply_markup: keyboard,
    });
  }

  // guardar último msg para editar (si hace falta)
  if (sent?.ok && sent.result?.message_id) {
    cart.lastMsgId = sent.result.message_id;
    cart.lastChatId = chatId;
  }
}

async function showCatalog(chatId, userId, forceCat = null, forceIdx = null) {
  const { config, catalogo } = await loadAll();

  const cats = uniqueCategories(catalogo);
  const page = getUserPage(userId);
  const cat = forceCat ?? page.cat ?? "ALL";
  const idx = forceIdx ?? page.idx ?? 0;

  const list = buildProductList(catalogo, cat);
  if (!list.length) {
    await tg("sendMessage", { chat_id: chatId, text: "No hay productos para mostrar." });
    return;
  }

  const realIdx = Math.max(0, Math.min(idx, list.length - 1));
  setUserPage(userId, cat, realIdx);

  const catLabel = cat === "ALL" ? "Todas" : cat;
  await sendProduct(chatId, userId, list[realIdx], realIdx, list.length, catLabel);

  // Si es primera vez y hay categorías, opcional: no spamear
  const msgCatalogo = pickConfig(config, "CATALOGO_TEXTO", "");
  if (msgCatalogo) {
    // no repetimos siempre
  }
}

// =========================
// Categorías inline
// =========================
async function showCategories(chatId) {
  const { catalogo } = await loadAll();
  const cats = uniqueCategories(catalogo);
  const rows = [];
  const chunk = 2;
  for (let i = 0; i < cats.length; i += chunk) {
    const r = [];
    for (let j = i; j < i + chunk && j < cats.length; j++) {
      const c = cats[j];
      r.push({ text: c, callback_data: `cats|set|${c}` });
    }
    rows.push(r);
  }
  rows.push([{ text: "📦 Ver todo", callback_data: `cats|set|ALL` }]);
  await tg("sendMessage", {
    chat_id: chatId,
    text: "📂 Elegí una categoría:",
    reply_markup: { inline_keyboard: rows },
  });
}

// =========================
// Clientes / Referidos (lectura + fallback)
// =========================
function findClient(clientes, userId) {
  return (clientes || []).find((c) => safeText(c.UserIdTG) === safeText(userId)) || null;
}

function genCode(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// Intento de escritura opcional (si tu Apps Script lo soporta). Si no, no rompe.
async function tryUpsertClient(payload) {
  try {
    const r = await fetch(DATA_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "upsertClient", ...payload }),
    });
    const txt = await r.text();
    return txt;
  } catch {
    return null;
  }
}

async function ensureClient(userId, name, phone, referidoPorCode = "") {
  const data = await loadAll();
  let cli = findClient(data.clientes, userId);

  if (cli) return cli;

  // crear en memoria (y tratar de persistir si tu Apps Script lo permite)
  const nuevo = {
    UserIdTG: String(userId),
    Nombre: safeText(name) || "",
    Telefono: safeText(phone) || "",
    Sellos: "0",
    TotalConfirmado: "0",
    CodigoReferido: genCode(6),
    ReferidoPor: safeText(referidoPorCode),
    UltAct: new Date().toISOString(),
  };

  await tryUpsertClient(nuevo);
  // refrescar cache
  CACHE.ts = 0;
  const refreshed = await loadAll();
  cli = findClient(refreshed.clientes, userId) || nuevo;
  return cli;
}

// =========================
// Mensajes (Config)
// =========================
function applyVars(tpl, vars) {
  let s = safeText(tpl);
  for (const [k, v] of Object.entries(vars || {})) {
    const re = new RegExp(`\\{${k}\\}`, "g");
    s = s.replace(re, safeText(v));
  }
  return s;
}

async function sendWelcome(chatId, from) {
  const { config, clientes } = await loadAll();

  const saludo = pickConfig(
    config,
    "SALUDO",
    "👋 Bienvenido/a a Todo Queso 🧀\n\n¡Hola {NOMBRE}! 👋\n\n🛍️ Mirá el catálogo y acumulá sellos."
  );

  const nombre = safeText(from?.first_name || from?.username || "!");
  const text = applyVars(saludo, { NOMBRE: nombre });

  const keyboard = {
    keyboard: [
      [{ text: "🛍️ Catálogo" }],
      [{ text: "🏷️ Sellos" }, { text: "📣 Compartir bot" }],
      [{ text: "🆘 Ayuda" }],
    ],
    resize_keyboard: true,
  };

  await tg("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: keyboard,
  });
}

async function sendAyuda(chatId) {
  const { config } = await loadAll();
  const whatsapp = pickConfig(config, "WHATSAPP", "");
  const instagram = pickConfig(config, "INSTAGRAM", "");

  const ayudaTpl = pickConfig(
    config,
    "AYUDA_TEXTO",
    "📌 Si necesitás hacer una consulta o reclamo:\n\n✅ WhatsApp: {WHATSAPP}\n📸 Instagram: {INSTAGRAM}\n\nGracias por elegir Todo Queso 🧀"
  );

  const text = applyVars(ayudaTpl, { WHATSAPP: whatsapp, INSTAGRAM: instagram });
  await tg("sendMessage", { chat_id: chatId, text });
}

async function sendCompartir(chatId, userId) {
  const { config, clientes } = await loadAll();
  const botUser = pickConfig(config, "BOT_USERNAME", "Todo_Queso"); // ponelo en Config si querés exacto
  const cli = findClient(clientes, userId);

  const code = safeText(cli?.CodigoReferido) || genCode(6);
  const link = `https://t.me/${botUser}?start=${code}`;

  const tpl = pickConfig(
    config,
    "COMPARTIR_TEXTO",
    "🤖 ¿Querés este sistema para tu negocio?\n\n📩 {MAIL}\n🔗 {LINK}"
  );
  const mail = pickConfig(config, "MAIL", "ezerbot.assistant@gmail.com");

  await tg("sendMessage", {
    chat_id: chatId,
    text: applyVars(tpl, { MAIL: mail, LINK: link }),
    disable_web_page_preview: true,
  });
}

async function sendSellos(chatId, userId) {
  const url = `${PUBLIC_URL}/card/${encodeURIComponent(userId)}`;
  await tg("sendMessage", {
    chat_id: chatId,
    text: `🏷️ Tu tarjeta / sellos:\n${url}`,
    disable_web_page_preview: false,
  });
}

// =========================
// Web: Tarjeta/Sellos
// =========================
function renderCardHTML(cfg, cliente, userId) {
  const logo = pickConfig(cfg, "LOGO_URL", "");
  const brand = pickConfig(cfg, "BRAND_NAME", "Todo Queso");
  const maxSellos = Number(pickConfig(cfg, "SELLOS_MAX", "10")) || 10;

  const nombre = escHtml(safeText(cliente?.Nombre || "Cliente"));
  const sellos = Math.max(0, Number(safeText(cliente?.Sellos || "0")) || 0);
  const filled = Math.min(sellos, maxSellos);

  const bg = pickConfig(cfg, "CARD_BG", "#0b0f14");
  const card = pickConfig(cfg, "CARD_COLOR", "#111827");
  const accent = pickConfig(cfg, "ACCENT", "#f59e0b");

  const stamps = [];
  for (let i = 1; i <= maxSellos; i++) {
    const isOn = i <= filled;
    stamps.push(`
      <div class="stamp ${isOn ? "on" : ""}">
        ${logo ? `<img src="${escHtml(logo)}" alt="logo">` : `<div class="txt">🧀</div>`}
        <div class="n">${i}</div>
      </div>
    `);
  }

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escHtml(brand)} — Sellos</title>
<style>
  body{margin:0;font-family:system-ui, -apple-system, Segoe UI, Roboto, Arial;background:${escHtml(bg)};color:#fff}
  .wrap{max-width:900px;margin:0 auto;padding:18px}
  .head{display:flex;gap:14px;align-items:center;margin-bottom:14px}
  .head .brand{font-weight:800;font-size:22px}
  .badge{background:${escHtml(card)};border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:14px}
  .row{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
  .k{opacity:.75;font-size:13px}
  .v{font-weight:700}
  .grid{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-top:14px}
  .stamp{position:relative;background:#0f172a;border:1px dashed rgba(255,255,255,.18);border-radius:14px;min-height:88px;display:flex;align-items:center;justify-content:center;overflow:hidden}
  .stamp.on{border:2px solid ${escHtml(accent)};box-shadow:0 0 0 2px rgba(245,158,11,.15) inset}
  .stamp img{width:64px;height:64px;object-fit:contain;opacity:.95;filter:drop-shadow(0 6px 16px rgba(0,0,0,.4))}
  .stamp .txt{font-size:34px}
  .stamp .n{position:absolute;bottom:6px;right:8px;font-size:12px;opacity:.75}
  .foot{margin-top:14px;opacity:.75;font-size:12px}
  @media (max-width:520px){.grid{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body>
  <div class="wrap">
    <div class="head">
      ${logo ? `<img src="${escHtml(logo)}" style="width:44px;height:44px;border-radius:10px;object-fit:contain;background:${escHtml(card)};padding:8px;border:1px solid rgba(255,255,255,.08)">` : ""}
      <div>
        <div class="brand">${escHtml(brand)}</div>
        <div class="k">Tarjeta de sellos</div>
      </div>
    </div>

    <div class="badge">
      <div class="row">
        <div><div class="k">Nombre</div><div class="v">${nombre}</div></div>
        <div><div class="k">Sellos</div><div class="v">${filled} / ${maxSellos}</div></div>
        <div><div class="k">ID</div><div class="v">${escHtml(String(userId))}</div></div>
      </div>

      <div class="grid">${stamps.join("")}</div>
      <div class="foot">Si no ves los sellos actualizados, cerrá y volvé a abrir el link.</div>
    </div>
  </div>
</body>
</html>`;
}

app.get("/card/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const { config, clientes } = await loadAll();
    const cli = findClient(clientes, userId);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderCardHTML(config, cli, userId));
  } catch (e) {
    res.status(500).send("Error");
  }
});

// =========================
// Web: health
// =========================
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// =========================
// Telegram Webhook
// =========================
app.post(WEBHOOK_PATH, async (req, res) => {
  try {
    const update = req.body || {};

    // callbacks (botones inline)
    if (update.callback_query) {
      const q = update.callback_query;
      const data = safeText(q.data);
      const chatId = q.message?.chat?.id;
      const userId = q.from?.id;

      // nav
      if (data.startsWith("nav|")) {
        const dir = data.split("|")[1];
        const { catalogo } = await loadAll();
        const page = getUserPage(userId);
        const list = buildProductList(catalogo, page.cat);
        let idx = page.idx;

        if (dir === "next") idx++;
        if (dir === "prev") idx--;

        if (idx < 0) idx = list.length - 1;
        if (idx >= list.length) idx = 0;

        setUserPage(userId, page.cat, idx);
        await showCatalog(chatId, userId, page.cat, idx);

        await tg("answerCallbackQuery", { callback_query_id: q.id });
        return res.send("ok");
      }

      // categorias
      if (data === "cats|open") {
        await showCategories(chatId);
        await tg("answerCallbackQuery", { callback_query_id: q.id });
        return res.send("ok");
      }
      if (data.startsWith("cats|set|")) {
        const cat = data.split("|").slice(2).join("|");
        setUserPage(userId, cat === "ALL" ? "ALL" : cat, 0);
        await showCatalog(chatId, userId, cat === "ALL" ? "ALL" : cat, 0);
        await tg("answerCallbackQuery", { callback_query_id: q.id });
        return res.send("ok");
      }

      // carrito
      if (data.startsWith("cart|")) {
        const parts = data.split("|");
        const action = parts[1];
        const cart = getUserCart(userId);
        const { catalogo } = await loadAll();

        if (action === "mas" || action === "menos") {
          const codigo = parts[2];
          const step = Number(parts[3] || "1") || 1;
          if (!cart.items[codigo]) cart.items[codigo] = 0;

          if (action === "mas") cart.items[codigo] += step;
          if (action === "menos") cart.items[codigo] -= step;

          if (cart.items[codigo] < 0) cart.items[codigo] = 0;

          await tg("answerCallbackQuery", {
            callback_query_id: q.id,
            text: "Listo ✅",
            show_alert: false,
          });

          // refrescar el producto actual
          const page = getUserPage(userId);
          const list = buildProductList(catalogo, page.cat);
          const prod = list[page.idx] || list[0];
          await sendProduct(chatId, userId, prod, page.idx, list.length, page.cat === "ALL" ? "Todas" : page.cat);

          return res.send("ok");
        }

        if (action === "ver") {
          const txt = cartTotalText(catalogo, cart.items);
          await tg("sendMessage", { chat_id: chatId, text: txt });
          await tg("answerCallbackQuery", { callback_query_id: q.id });
          return res.send("ok");
        }

        if (action === "fin") {
          const txt = cartTotalText(catalogo, cart.items);
          await tg("sendMessage", {
            chat_id: chatId,
            text: `${txt}\n\n📩 Para confirmar, escribinos por WhatsApp.`,
          });
          await tg("answerCallbackQuery", { callback_query_id: q.id });
          return res.send("ok");
        }
      }

      await tg("answerCallbackQuery", { callback_query_id: q.id });
      return res.send("ok");
    }

    // mensajes
    if (update.message) {
      const m = update.message;
      const chatId = m.chat.id;
      const userId = m.from.id;
      const text = safeText(m.text);
      const from = m.from;

      // /start con referido
      if (text.startsWith("/start")) {
        const parts = text.split(" ");
        const ref = safeText(parts[1] || "");
        await ensureClient(userId, from.first_name, "", ref);
        await sendWelcome(chatId, from);
        return res.send("ok");
      }

      // botones principales
      if (text === "🛍️ Catálogo" || text.toLowerCase() === "catalogo" || text.toLowerCase() === "catálogo") {
        await showCatalog(chatId, userId, null, null);
        return res.send("ok");
      }

      if (text === "🏷️ Sellos" || text.toLowerCase() === "sellos") {
        await sendSellos(chatId, userId);
        return res.send("ok");
      }

      if (text === "📣 Compartir bot" || text.toLowerCase().includes("compartir")) {
        await sendCompartir(chatId, userId);
        return res.send("ok");
      }

      if (text === "🆘 Ayuda" || text.toLowerCase() === "ayuda") {
        await sendAyuda(chatId);
        return res.send("ok");
      }

      // fallback mínimo
      // si escribe cualquier cosa, mostramos menú corto
      await tg("sendMessage", {
        chat_id: chatId,
        text: "Usá el menú 👇",
      });
      return res.send("ok");
    }

    res.send("ok");
  } catch (e) {
    console.error("Webhook error:", e);
    res.send("ok");
  }
});

// =========================
// Webhook setup en inicio
// =========================
async function setWebhook() {
  const url = `${PUBLIC_URL}${WEBHOOK_PATH}`;
  const r = await tg("setWebhook", { url });
  console.log("setWebhook:", r?.ok ? "OK" : r);
}

app.listen(PORT, async () => {
  console.log("EZERBOT ACTIVO");
  console.log("URL:", PUBLIC_URL);
  await setWebhook();
});
```0

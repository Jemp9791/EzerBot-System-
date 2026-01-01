/* ==============================
   EZERBOT - index.js (Render/Node 22)
   ENV REQUIRED:
   - TELEGRAM_TOKEN
   - PUBLIC_URL         (ej: https://ezerbot-system.onrender.com)
   - DATA_API_URL       (tu Apps Script /exec)
   ============================== */

import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const DATA_API_URL = (process.env.DATA_API_URL || "").replace(/\/+$/, "");

const TG_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const WEBHOOK_PATH = `/tg-webhook/${crypto.createHash("sha1").update(TELEGRAM_TOKEN).digest("hex")}`;

function escHtml(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function splitCSVLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQ = !inQ;
      }
    } else if (ch === "," && !inQ) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseCSV(csvText) {
  const text = (csvText || "").trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (!lines.length) return [];
  const headers = splitCSVLine(lines[0]).map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const cols = splitCSVLine(line);
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = (cols[idx] ?? "").trim();
    });
    rows.push(obj);
  }
  return rows;
}

async function tg(method, payload) {
  const r = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return await r.json().catch(() => null);
}

async function getTabCSV(tabName) {
  const url = `${DATA_API_URL}?tab=${encodeURIComponent(tabName)}`;
  const r = await fetch(url);
  const txt = await r.text();

  // Si Apps Script devolvió JSON con message => error
  const t = txt.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    const j = JSON.parse(t);
    if (j && typeof j === "object" && "message" in j) {
      throw new Error(j.message || "Error DATA_API_URL");
    }
  }
  return parseCSV(txt);
}

function cfgGet(cfg, ...keys) {
  for (const k of keys) {
    if (k in cfg && String(cfg[k] || "").trim() !== "") return String(cfg[k]).trim();
  }
  return "";
}

async function loadConfig() {
  const rows = await getTabCSV("Config");
  const cfg = {};
  if (!rows.length) return cfg;

  const keys = Object.keys(rows[0]);
  const hasKV = keys.some((k) => k.toLowerCase() === "key") && keys.some((k) => k.toLowerCase() === "value");

  if (hasKV) {
    for (const r of rows) {
      const k = r.KEY ?? r.Key ?? r.key;
      const v = r.VALUE ?? r.Value ?? r.value;
      if (k) cfg[String(k).trim()] = String(v ?? "").trim();
    }
  } else {
    Object.entries(rows[0]).forEach(([k, v]) => {
      if (k) cfg[String(k).trim()] = String(v ?? "").trim();
    });
  }
  return cfg;
}

async function loadCatalog() {
  const rows = await getTabCSV("Catalogo");
  return rows.map((r) => ({
    CODIGO: r.CODIGO || r.Codigo || r.codigo || "",
    NOMBRE: r.NOMBRE || r.Nombre || r.nombre || "",
    PRECIO: r.PRECIO || r.Precio || r.precio || "",
    UNIDAD: r.UNIDAD || r.Unidad || r.unidad || "",
    PRECIOPORKILO: r.PRECIOPORKILO || r.PrecioPorKilo || r.precioPorKilo || r.precio_porkilo || "",
    CODIGOBARRAS: r.CODIGOBARRAS || r.CodigoBarras || r.codigobarras || "",
    DESCRIPCION: r.DESCRIPCION || r.Descripcion || r.descripcion || "",
    IMAGEN: r.IMAGEN || r.Imagen || r.imagen || "",
    CATEGORIA: r.CATEGORIA || r.Categoria || r.categoria || "General",
  }));
}

function parseIntSafe(v) {
  const n = String(v ?? "").replace(/[^0-9]/g, "");
  return n ? parseInt(n, 10) : 0;
}

function isWeightUnit(unidadRaw) {
  const u = String(unidadRaw || "").toLowerCase().trim();
  return u === "kg" || u === "kilo" || u === "kilos" || u === "gramos" || u === "gr" || u === "g";
}

// ==============================
// Web endpoints
// ==============================
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/catalog", async (req, res) => {
  try {
    const [cfg, catalog] = await Promise.all([loadConfig(), loadCatalog()]);
    const brand = cfgGet(cfg, "brand_name", "BRAND_NAME") || "Todo Queso";
    const logo = cfgGet(cfg, "logo_url", "LOGO_URL") || "";
    const wa = cfgGet(cfg, "whatsapp", "WHATSAPP", "WHATSAPP_NUMBER") || "";
    const ig = cfgGet(cfg, "instagram", "INSTAGRAM") || "";

    const categories = Array.from(new Set(catalog.map((p) => (p.CATEGORIA || "General").trim()))).sort();
    const catalogJson = JSON.stringify(catalog);

    res.setHeader("content-type", "text/html; charset=utf-8");
    res.send(`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escHtml(brand)} - Catálogo</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;margin:0;background:#0f0f10;color:#fff}
  header{position:sticky;top:0;background:#111;z-index:10;padding:12px 14px;border-bottom:1px solid #222}
  .row{display:flex;gap:10px;align-items:center}
  .logo{width:44px;height:44px;border-radius:10px;object-fit:cover;background:#222}
  .brand{font-weight:800;font-size:18px;line-height:1.1}
  .sub{opacity:.8;font-size:12px}
  .wrap{padding:12px 14px;max-width:980px;margin:0 auto}
  .toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 14px}
  input,select,button{border-radius:12px;border:1px solid #2a2a2a;background:#151518;color:#fff;padding:10px 12px;font-size:14px}
  button{cursor:pointer;font-weight:700}
  .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
  @media (min-width:720px){.grid{grid-template-columns:repeat(3,minmax(0,1fr));}}
  .card{background:#121215;border:1px solid #242428;border-radius:16px;overflow:hidden;display:flex;flex-direction:column}
  .img{width:100%;aspect-ratio:1/1;background:#1a1a1e;object-fit:cover}
  .p{padding:10px 10px 12px}
  .name{font-weight:800}
  .desc{opacity:.85;font-size:12px;white-space:pre-line;margin-top:6px;min-height:34px}
  .meta{display:flex;justify-content:space-between;align-items:center;margin-top:10px}
  .price{font-weight:900}
  .pill{font-size:11px;opacity:.85;border:1px solid #2a2a2a;border-radius:999px;padding:4px 8px}
  .qty{display:flex;gap:6px;align-items:center;margin-top:10px;flex-wrap:wrap}
  .qty button{padding:8px 10px}
  .footerbar{position:sticky;bottom:0;background:#0f0f10;border-top:1px solid #222;padding:10px 14px}
  .cartline{display:flex;justify-content:space-between;align-items:center;gap:10px}
  .muted{opacity:.8}
  .danger{background:#2a1414;border-color:#4a1f1f}
</style>
</head>
<body>
<header>
  <div class="row">
    ${logo ? `<img class="logo" src="${escHtml(logo)}" alt="logo">` : `<div class="logo"></div>`}
    <div>
      <div class="brand">${escHtml(brand)}</div>
      <div class="sub">Catálogo online · Armá tu pedido</div>
    </div>
  </div>
</header>

<div class="wrap">
  <div class="toolbar">
    <input id="q" placeholder="Buscar…" style="flex:1;min-width:170px" />
    <select id="cat">
      <option value="">Todas las categorías</option>
      ${categories.map((c) => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join("")}
    </select>
    <button id="clear" class="danger">Vaciar carrito</button>
  </div>

  <div id="grid" class="grid"></div>
</div>

<div class="footerbar">
  <div class="cartline">
    <div>
      <div><b>Total:</b> $<span id="total">0</span></div>
      <div class="muted" id="count">0 ítems</div>
    </div>
    <button id="send">Enviar pedido</button>
  </div>
  <div class="muted" style="font-size:12px;margin-top:6px">
    ${wa ? `WhatsApp: ${escHtml(wa)} · ` : ""}${ig ? `Instagram: ${escHtml(ig)}` : ""}
  </div>
</div>

<script>
const CATALOG = ${catalogJson};
const money = (n)=> String(Math.round(n)).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ".");
const cart = JSON.parse(localStorage.getItem("cart_v2")||"{}");

// Config de pesado:
const GRAMS_STEP = 100; // 100g por toque (cambialo si querés)

function parseIntSafe(v){
  const s = String(v ?? "").replace(/[^0-9]/g,"");
  return s ? parseInt(s,10) : 0;
}

function isWeightUnit(unidadRaw){
  const u = String(unidadRaw||"").toLowerCase().trim();
  return (u==="kg"||u==="kilo"||u==="kilos"||u==="gramos"||u==="gr"||u==="g");
}

function unitLabel(p){
  const u = String(p.UNIDAD||"").toLowerCase().trim();
  if(isWeightUnit(u)) return "g";
  return "u";
}

function displayQty(p, qty){
  if(isWeightUnit(p.UNIDAD)) return qty + "g";
  return qty + "u";
}

function pricePerKg(p){
  // Usa PRECIOPORKILO si está, sino usa PRECIO como precio por kg
  const pk = parseIntSafe(p.PRECIOPORKILO);
  if(pk>0) return pk;
  return parseIntSafe(p.PRECIO);
}

function pricePerUnit(p){
  return parseIntSafe(p.PRECIO);
}

function itemSubtotal(p, qty){
  if(isWeightUnit(p.UNIDAD)){
    const pk = pricePerKg(p);
    return (qty/1000) * pk;
  }
  return qty * pricePerUnit(p);
}

function render(){
  const q = (document.getElementById("q").value||"").toLowerCase().trim();
  const cat = document.getElementById("cat").value||"";
  const grid = document.getElementById("grid");

  const list = CATALOG.filter(p=>{
    const okCat = !cat || (String(p.CATEGORIA||"")===cat);
    const hay = (String(p.NOMBRE||"")+" "+String(p.DESCRIPCION||"")+" "+String(p.CODIGO||"")).toLowerCase();
    const okQ = !q || hay.includes(q);
    return okCat && okQ;
  });

  grid.innerHTML = list.map(p=>{
    const code = p.CODIGO || "";
    const isW = isWeightUnit(p.UNIDAD);
    const qty = cart[code]?.qty || 0;

    const priceTxt = isW
      ? ("$ " + money(pricePerKg(p)) + " / kg")
      : ("$ " + money(pricePerUnit(p)) + " c/u");

    return \`
      <div class="card">
        \${p.IMAGEN ? \`<img class="img" src="\${p.IMAGEN}" alt="">\` : \`<div class="img"></div>\`}
        <div class="p">
          <div class="name">\${p.NOMBRE || "Producto"}</div>
          <div class="desc">\${p.DESCRIPCION || ""}</div>
          <div class="meta">
            <div class="price">\${priceTxt}</div>
            <div class="pill">\${p.CATEGORIA || "General"}</div>
          </div>

          <div class="qty">
            <button onclick="dec('\${code}')">-</button>
            <div><b>\${qty ? displayQty(p, qty) : "0" + unitLabel(p)}</b></div>
            <button onclick="inc('\${code}')">+</button>
            \${isW ? \`<span class="muted" style="font-size:12px">(+/- \${GRAMS_STEP}g)</span>\` : \`\`}
          </div>
        </div>
      </div>
    \`;
  }).join("");

  refreshTotals();
}

function inc(code){
  const p = CATALOG.find(x=>x.CODIGO===code);
  if(!p) return;

  const isW = isWeightUnit(p.UNIDAD);
  const cur = cart[code]?.qty || 0;

  const next = isW ? (cur + GRAMS_STEP) : (cur + 1);

  cart[code] = {
    qty: next,
    nombre: p.NOMBRE||"",
    unidad: p.UNIDAD||"",
    precio: parseIntSafe(p.PRECIO),
    precioPorKilo: parseIntSafe(p.PRECIOPORKILO),
  };

  localStorage.setItem("cart_v2", JSON.stringify(cart));
  render();
}

function dec(code){
  const p = CATALOG.find(x=>x.CODIGO===code);
  if(!p) return;

  const isW = isWeightUnit(p.UNIDAD);
  const cur = cart[code]?.qty || 0;
  if(cur<=0) return;

  const next = isW ? (cur - GRAMS_STEP) : (cur - 1);

  if(next<=0){
    delete cart[code];
  }else{
    cart[code].qty = next;
  }

  localStorage.setItem("cart_v2", JSON.stringify(cart));
  render();
}

function refreshTotals(){
  let total = 0;
  let count = 0;

  Object.entries(cart).forEach(([code,it])=>{
    const p = CATALOG.find(x=>x.CODIGO===code);
    if(!p) return;
    total += itemSubtotal(p, it.qty||0);
    count += 1; // cuenta líneas del pedido
  });

  document.getElementById("total").textContent = money(total);
  document.getElementById("count").textContent = count + (count===1 ? " producto" : " productos");
}

document.getElementById("q").addEventListener("input", render);
document.getElementById("cat").addEventListener("change", render);

document.getElementById("clear").addEventListener("click", ()=>{
  for(const k of Object.keys(cart)) delete cart[k];
  localStorage.setItem("cart_v2", JSON.stringify(cart));
  render();
});

document.getElementById("send").addEventListener("click", ()=>{
  const items = Object.entries(cart);
  if(!items.length){ alert("Carrito vacío"); return; }

  let msg = "Pedido:\\n";
  let total = 0;

  items.forEach(([code,it])=>{
    const p = CATALOG.find(x=>x.CODIGO===code);
    if(!p) return;

    const qtyTxt = isWeightUnit(p.UNIDAD) ? (it.qty + "g") : (it.qty + "u");
    const sub = itemSubtotal(p, it.qty||0);
    total += sub;

    msg += "- " + (p.NOMBRE||code) + " (" + qtyTxt + ") = $" + money(sub) + "\\n";
  });

  msg += "\\nTotal: $" + money(total);

  const wa = ${JSON.stringify(wa)};
  if(!wa){ alert("Falta WhatsApp en Config."); return; }

  const num = wa.replace(/[^0-9]/g,"");
  const url = "https://wa.me/" + num + "?text=" + encodeURIComponent(msg);
  window.open(url, "_blank");
});

render();
</script>
</body>
</html>`);
  } catch (e) {
    res.status(500).send(`Error catálogo: ${escHtml(e.message || String(e))}`);
  }
});

app.get("/card/:uid", async (req, res) => {
  try {
    const uid = String(req.params.uid || "").trim();
    const [cfg, clients] = await Promise.all([loadConfig(), getTabCSV("Clientes")]);

    const brand = cfgGet(cfg, "brand_name", "BRAND_NAME") || "Todo Queso";
    const logo = cfgGet(cfg, "logo_url", "LOGO_URL") || "";

    const row =
      clients.find((r) => String(r.UserIdTG || r.USERIDTG || "").trim() === uid) || {};

    const nombre = row.Nombre || row.NOMBRE || "Cliente";
    const sellos = row.Sellos || row.SELLOS || "0";
    const total = row.TotalConfirmado || row.TOTALCONFIRMADO || "0";

    res.setHeader("content-type", "text/html; charset=utf-8");
    res.send(`<!doctype html>
<html lang="es"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escHtml(brand)} - Sellos</title>
<style>
body{font-family:system-ui;background:#0f0f10;color:#fff;margin:0}
.wrap{max-width:560px;margin:0 auto;padding:18px}
.card{background:#121215;border:1px solid #242428;border-radius:18px;padding:14px}
.row{display:flex;gap:10px;align-items:center}
.logo{width:56px;height:56px;border-radius:14px;background:#222;object-fit:cover}
h1{margin:10px 0 0;font-size:18px}
.big{font-size:42px;font-weight:900;margin:8px 0}
.muted{opacity:.8}
.badge{display:inline-block;border:1px solid #2a2a2a;border-radius:999px;padding:6px 10px;margin-top:8px}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <div class="row">
      ${logo ? `<img class="logo" src="${escHtml(logo)}" alt="">` : `<div class="logo"></div>`}
      <div>
        <div style="font-weight:900">${escHtml(brand)}</div>
        <div class="muted">Tarjeta de sellos</div>
      </div>
    </div>
    <h1>${escHtml(nombre)}</h1>
    <div class="big">${escHtml(sellos)} ✅</div>
    <div class="badge">Total confirmado: ${escHtml(total)}</div>
    <div class="muted" style="margin-top:10px">Se actualiza con tus compras.</div>
  </div>
</div>
</body></html>`);
  } catch (e) {
    res.status(500).send(`Error tarjeta: ${escHtml(e.message || String(e))}`);
  }
});

// ==============================
// Telegram
// ==============================
async function buildMainKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🛍️ Catálogo" }],
        [{ text: "🏷️ Sellos" }, { text: "📣 Compartir bot" }],
        [{ text: "🆘 Ayuda" }],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };
}

async function sendWelcome(chatId, firstName) {
  const cfg = await loadConfig();
  const brand = cfgGet(cfg, "brand_name", "BRAND_NAME") || "Todo Queso";
  const logo = cfgGet(cfg, "logo_url", "LOGO_URL") || "";
  const welcome =
    cfgGet(cfg, "welcome_text", "WELCOME_TEXT") ||
    `👋 Bienvenido/a a ${brand} 🧀\n\n🧀 ¡Hola ${firstName || "👋"}!\n\n🛍️ Mirá el catálogo y acumulá sellos.`;

  const kb = await buildMainKeyboard();

  if (logo) {
    await tg("sendPhoto", {
      chat_id: chatId,
      photo: logo,
      caption: welcome,
      ...kb,
    });
  } else {
    await tg("sendMessage", {
      chat_id: chatId,
      text: welcome,
      ...kb,
    });
  }
}

async function handleText(chatId, text, from) {
  const cfg = await loadConfig();
  const brand = cfgGet(cfg, "brand_name", "BRAND_NAME") || "Todo Queso";
  const wa = cfgGet(cfg, "whatsapp", "WHATSAPP", "WHATSAPP_NUMBER") || "";
  const ig = cfgGet(cfg, "instagram", "INSTAGRAM") || "";
  const helpTitle = cfgGet(cfg, "help_title", "HELP_TITLE") || "📌 Si necesitás hacer una consulta o reclamo:";
  const shareText = cfgGet(cfg, "share_text", "SHARE_TEXT") || "¿Querés este sistema para tu negocio? Contactános";
  const contactEmail = cfgGet(cfg, "contact_email", "CONTACT_EMAIL") || "ezerbot.assistant@gmail.com";

  const t = (text || "").trim();

  if (t === "/start" || t.toLowerCase() === "menu") {
    await sendWelcome(chatId, from?.first_name || "");
    return;
  }

  if (t === "🛍️ Catálogo" || t.toLowerCase() === "catálogo" || t.toLowerCase() === "catalogo") {
    const url = `${PUBLIC_URL}/catalog`;
    await tg("sendMessage", { chat_id: chatId, text: `🛍️ Catálogo online:\n${url}` });
    return;
  }

  if (t === "🏷️ Sellos" || t.toLowerCase() === "sellos") {
    const url = `${PUBLIC_URL}/card/${chatId}`;
    await tg("sendMessage", { chat_id: chatId, text: `🏷️ Tu tarjeta / sellos:\n${url}` });
    return;
  }

  if (t === "📣 Compartir bot" || t.toLowerCase().includes("compartir")) {
    await tg("sendMessage", { chat_id: chatId, text: `🤖 ${shareText}\n\n✉️ ${contactEmail}` });
    return;
  }

  if (t === "🆘 Ayuda" || t.toLowerCase() === "ayuda") {
    let msg = `${helpTitle}\n\n`;
    if (wa) msg += `✅ WhatsApp: ${wa}\n`;
    if (ig) msg += `📸 Instagram: ${ig}\n`;
    msg += `\nGracias por elegir ${brand} 🧀`;
    await tg("sendMessage", { chat_id: chatId, text: msg });
    return;
  }

  await tg("sendMessage", { chat_id: chatId, text: `Escribí /start para ver el menú.` });
}

app.post(WEBHOOK_PATH, async (req, res) => {
  try {
    const update = req.body || {};
    const msg = update.message || update.edited_message;
    if (msg?.chat?.id) {
      await handleText(msg.chat.id, msg.text || "", msg.from || {});
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("Webhook error:", e);
    res.json({ ok: true });
  }
});

// ==============================
// Startup
// ==============================
async function setWebhook() {
  if (!TELEGRAM_TOKEN || !PUBLIC_URL) return;
  const url = `${PUBLIC_URL}${WEBHOOK_PATH}`;
  const r = await fetch(`${TG_API}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const j = await r.json().catch(() => null);
  console.log("setWebhook:", j);
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  console.log("EZERBOT ACTIVO");
  console.log("Listening on", PORT);
  await setWebhook();
});

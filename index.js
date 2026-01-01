// index.js  ✅ (SIN node-fetch, SIN express, SIN require)
// Render: Node 18+ (fetch ya viene). Webhook en "/"

import http from "http";
import { URL } from "url";

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_TOKEN;
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const DATA_API_URL = (process.env.DATA_API_URL || "").replace(/\/$/, "");

if (!TOKEN || !PUBLIC_URL || !DATA_API_URL) {
  console.error("Faltan variables: TELEGRAM_TOKEN, PUBLIC_URL, DATA_API_URL");
}

const TG = (m) => `https://api.telegram.org/bot${TOKEN}/${m}`;

async function tg(method, body) {
  const r = await fetch(TG(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json().catch(() => ({}));
}

function sendMenu(chatId, text, extra = {}) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    reply_markup: {
      keyboard: [
        [{ text: "🛍️ Catálogo" }],
        [{ text: "🏷️ Sellos" }],
        [{ text: "📣 Compartir bot" }],
        [{ text: "🆘 Ayuda" }],
      ],
      resize_keyboard: true,
    },
    ...extra,
  });
}

/* ===== Data API (Apps Script) =====
   Espera: ?tab=Config | ?tab=Catalogo | ?tab=Clientes | ?tab=Referidos
*/
async function fetchTab(tab) {
  const u = new URL(DATA_API_URL);
  u.searchParams.set("tab", tab);
  const r = await fetch(u.toString());
  const text = await r.text();

  // JSON
  try {
    const j = JSON.parse(text);
    return j;
  } catch (_) {}

  // CSV fallback simple
  const lines = text.split(/\r?\n/).filter(Boolean);
  const rows = lines.map((l) => l.split(",").map((x) => x.trim()));
  return { ok: true, rows };
}

let CACHE = { ts: 0, config: null, catalogo: null, clientes: null, referidos: null };
const CACHE_MS = 10_000;

async function loadAll() {
  const now = Date.now();
  if (CACHE.config && now - CACHE.ts < CACHE_MS) return CACHE;

  const [configRaw, catalogoRaw, clientesRaw, referidosRaw] = await Promise.all([
    fetchTab("Config"),
    fetchTab("Catalogo"),
    fetchTab("Clientes"),
    fetchTab("Referidos"),
  ]);

  // Config: KEY/VALUE -> objeto
  let config = {};
  if (configRaw && configRaw.ok && Array.isArray(configRaw.rows)) {
    // rows: [ ["KEY","VALUE"], ... ]
    for (let i = 1; i < configRaw.rows.length; i++) {
      const [k, v] = configRaw.rows[i] || [];
      if (!k) continue;
      config[k] = v ?? "";
    }
  } else if (configRaw && configRaw.ok && configRaw.data) {
    config = configRaw.data;
  } else if (configRaw && typeof configRaw === "object") {
    config = configRaw;
  }

  // Catalogo: columnas -> items
  let catalogo = [];
  if (catalogoRaw && catalogoRaw.ok && Array.isArray(catalogoRaw.rows)) {
    const header = catalogoRaw.rows[0] || [];
    for (let i = 1; i < catalogoRaw.rows.length; i++) {
      const row = catalogoRaw.rows[i] || [];
      const obj = {};
      for (let c = 0; c < header.length; c++) obj[header[c]] = row[c];
      if (obj.NOMBRE || obj.CODIGO) catalogo.push(obj);
    }
  } else if (catalogoRaw && catalogoRaw.items) {
    catalogo = catalogoRaw.items;
  }

  // Clientes: columnas -> items
  let clientes = [];
  if (clientesRaw && clientesRaw.ok && Array.isArray(clientesRaw.rows)) {
    const header = clientesRaw.rows[0] || [];
    for (let i = 1; i < clientesRaw.rows.length; i++) {
      const row = clientesRaw.rows[i] || [];
      const obj = {};
      for (let c = 0; c < header.length; c++) obj[header[c]] = row[c];
      if (obj.UserIdTG) clientes.push(obj);
    }
  } else if (clientesRaw && clientesRaw.items) {
    clientes = clientesRaw.items;
  }

  // Referidos: CodigoReferido, OwnerUserIdTG
  let referidos = [];
  if (referidosRaw && referidosRaw.ok && Array.isArray(referidosRaw.rows)) {
    const header = referidosRaw.rows[0] || [];
    for (let i = 1; i < referidosRaw.rows.length; i++) {
      const row = referidosRaw.rows[i] || [];
      const obj = {};
      for (let c = 0; c < header.length; c++) obj[header[c]] = row[c];
      if (obj.CodigoReferido) referidos.push(obj);
    }
  } else if (referidosRaw && referidosRaw.items) {
    referidos = referidosRaw.items;
  }

  CACHE = { ts: now, config, catalogo, clientes, referidos };
  return CACHE;
}

function parseLevels(config) {
  const nombres = String(config.NombresNiveles || "").split("|").map((s) => s.trim()).filter(Boolean);
  const sellos = String(config.SellosPorNivel || "").split("|").map((s) => Number(String(s).trim()) || 0);
  const beneficios = String(config.BeneficiosPorNivel || "").split("|").map((s) => s.trim());
  const levels = [];
  for (let i = 0; i < Math.max(nombres.length, sellos.length, beneficios.length); i++) {
    if (!sellos[i]) continue;
    levels.push({ nombre: nombres[i] || `Nivel ${i + 1}`, sellos: sellos[i], beneficio: beneficios[i] || "" });
  }
  levels.sort((a, b) => a.sellos - b.sellos);
  return levels;
}

function menuTextStart(config) {
  const n = config.NegocioNombre || "el negocio";
  const desc = (config.Descripcion || "").replace(/^"|"$/g, "");
  const dir = config.NegocioDireccion ? `📍 ${config.NegocioDireccion}\n` : "";
  const hor = config.NegocioHorario ? `🕒 ${config.NegocioHorario}\n` : "";
  return `👋 *Bienvenido/a a ${n}* 🧀\n\n${dir}${hor}\n${desc}`.trim();
}

/* ===== Handlers ===== */
async function onStart(chatId) {
  const { config } = await loadAll();
  return sendMenu(chatId, menuTextStart(config));
}

async function onCatalogo(chatId) {
  const { config } = await loadAll();
  const url = `${PUBLIC_URL}/catalog`;
  const txt = `🛍️ *Catálogo online:*\n${url}`;
  return sendMenu(chatId, txt);
}

async function onSellos(chatId) {
  const { config, clientes } = await loadAll();
  const montoPorSello = Number(config.MontoPorSello || 10000) || 10000;

  const c = clientes.find((x) => String(x.UserIdTG) === String(chatId));
  const sellos = Number(c?.Sellos || 0) || 0;

  const levels = parseLevels(config);
  let next = null;
  for (const lv of levels) {
    if (sellos < lv.sellos) { next = lv; break; }
  }

  let extra = "";
  if (next) {
    const faltan = Math.max(0, next.sellos - sellos);
    extra = `\n\n🎯 Próximo nivel: *${next.nombre}*\nTe faltan *${faltan}* sellos.\n🎁 Beneficio: ${next.beneficio || "—"}`;
  } else if (levels.length) {
    const last = levels[levels.length - 1];
    extra = `\n\n🏆 Ya estás en el máximo nivel: *${last.nombre}*`;
  }

  const cardUrl = config.CARD_URL || `${PUBLIC_URL}/card/${chatId}`;
  const txt =
    `🏷️ *Tus sellos*\n` +
    `Tenés *${sellos}* sellos acumulados.\n` +
    `1 sello cada *$${montoPorSello.toLocaleString("es-AR")}*.\n\n` +
    `🪪 Tarjeta: ${cardUrl}` +
    extra;

  return sendMenu(chatId, txt);
}

async function onAyuda(chatId) {
  const { config } = await loadAll();
  const wa = config.WhatsAppLink || "";
  const ig = config.NegocioInstagram || "";
  const n = config.NegocioNombre || "el negocio";

  const txt =
    `📌 *Ayuda*\n\n` +
    `Si te faltó algo del pedido o no encontraste un producto en el catálogo, escribinos y lo resolvemos.\n\n` +
    (wa ? `✅ WhatsApp: ${wa}\n` : "") +
    (ig ? `📸 Instagram: ${ig}\n` : "") +
    `\nGracias por elegir *${n}* 🧀`;

  return sendMenu(chatId, txt);
}

async function onCompartir(chatId) {
  const { config } = await loadAll();
  const email = config.EmailSistema || "ezerbot.assistant@gmail.com";
  const txtBase = (config.TextoSistema || "¿Querés este sistema para tu negocio? Contactános").trim();
  const txt = `🤖 ${txtBase}\n\n📩 ${email}`;
  return sendMenu(chatId, txt);
}

/* ===== Webhook server ===== */
function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

const server = http.createServer(async (req, res) => {
  try {
    // Health
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("EZERBOT OK");
    }

    // Webhook
    if (req.method === "POST" && req.url === "/") {
      const raw = await readBody(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));

      let update = null;
      try { update = JSON.parse(raw); } catch (_) { return; }

      const msg = update.message;
      if (msg && msg.chat && msg.chat.id) {
        const chatId = msg.chat.id;
        const text = (msg.text || "").trim();

        if (text === "/start") return onStart(chatId);
        if (text === "🛍️ Catálogo") return onCatalogo(chatId);
        if (text === "🏷️ Sellos") return onSellos(chatId);
        if (text === "📣 Compartir bot") return onCompartir(chatId);
        if (text === "🆘 Ayuda") return onAyuda(chatId);

        // fallback
        return onStart(chatId);
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Error");
  }
});

server.listen(PORT, async () => {
  console.log("✅ EZERBOT ACTIVO en puerto", PORT);

  // setWebhook (una vez)
  try {
    await fetch(TG("setWebhook"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: `${PUBLIC_URL}/` }),
    });
  } catch (_) {}
});
```0

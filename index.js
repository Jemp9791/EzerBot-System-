import express from "express";
import TelegramBot from "node-telegram-bot-api";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");   // sin / final
const DATA_API_URL = (process.env.DATA_API_URL || "").trim();

if (!TELEGRAM_TOKEN || !PUBLIC_URL || !DATA_API_URL) {
  console.error("❌ FALTAN VARIABLES: TELEGRAM_TOKEN / PUBLIC_URL / DATA_API_URL");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "2mb" }));

// ====== Helpers ======
let CONFIG = {};
const cfg = (k, d = "") => (CONFIG[k] ?? d);

function parseKeyValueTextToMap(text) {
  // Acepta formatos tipo:
  // KEY\tVALUE
  // NegocioNombre\tTodo Queso
  const lines = String(text || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const map = {};
  for (const line of lines) {
    if (/^KEY\s+VALUE$/i.test(line)) continue;
    const parts = line.split(/\t|,|;|\s{2,}/); // tab o separadores comunes
    if (parts.length >= 2) {
      const key = String(parts[0]).trim();
      const value = String(parts.slice(1).join(" ")).trim();
      if (key) map[key] = value;
    }
  }
  return map;
}

function normalizeConfigMap(map) {
  // Limpia keys con espacios raros
  const out = {};
  for (const [k, v] of Object.entries(map || {})) {
    const kk = String(k).trim();
    out[kk] = (v == null) ? "" : String(v);
  }
  return out;
}

async function fetchAsText(url) {
  const r = await fetch(url, { method: "GET" });
  const t = await r.text();
  if (!r.ok) throw new Error("HTTP " + r.status + " " + (t || "").slice(0, 120));
  return t;
}

function tryJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function extractConfigFromJson(j) {
  // Soporta: [{KEY,VALUE}] o {config:[{KEY,VALUE}]} o {data:{config:[...]}}
  const rows =
    (Array.isArray(j) ? j :
      j?.config ? j.config :
      j?.data?.config ? j.data.config :
      j?.data ? j.data :
      []);

  const map = {};
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const key = row?.KEY ?? row?.key ?? row?.Key;
      const value = row?.VALUE ?? row?.value ?? row?.Value;
      if (key != null) map[String(key).trim()] = String(value ?? "");
    }
  }
  return map;
}

async function loadConfig() {
  const base = DATA_API_URL;
  // Intento 1: JSON directo
  const raw = await fetchAsText(base);
  const j = tryJsonParse(raw);

  let map = {};
  if (j) {
    map = extractConfigFromJson(j);
  } else {
    // Intento 2: texto tipo KEY VALUE
    map = parseKeyValueTextToMap(raw);
  }

  CONFIG = normalizeConfigMap(map);

  // Fallbacks útiles si faltan
  if (!cfg("WhatsAppLink") && cfg("NegocioTelefono")) {
    const tel = cfg("NegocioTelefono").replace(/\D/g, "");
    CONFIG["WhatsAppLink"] = `https://wa.me/${tel}?text=Hola%20quiero%20hacer%20una%20consulta`;
  }
  if (!cfg("NegocioInstagram") && cfg("Instagram")) {
    CONFIG["NegocioInstagram"] = cfg("Instagram");
  }

  console.log("✅ CONFIG OK:", Object.keys(CONFIG).length, "keys");
}

// ====== Telegram ======
const bot = new TelegramBot(TELEGRAM_TOKEN, { webHook: true });

const MENU = {
  keyboard: [
    [{ text: "🛍️ Catálogo" }],
    [{ text: "🏷️ Sellos" }, { text: "📣 Compartir bot" }],
    [{ text: "🆘 Ayuda" }]
  ],
  resize_keyboard: true
};

// Webhook endpoint
app.post("/telegram", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Health
app.get("/", (_, res) => res.status(200).send("EZERBOT OK"));

// ====== Sellos (API opcional) ======
async function getSellos(chatId) {
  // Intenta pedir sellos al Apps Script si lo soporta:
  // ?action=sellos&chatId=...
  // Si no, devuelve 0.
  try {
    const url = `${DATA_API_URL}?action=sellos&chatId=${encodeURIComponent(chatId)}`;
    const raw = await fetchAsText(url);
    const j = tryJsonParse(raw);
    const n =
      (typeof j === "number") ? j :
      (j?.sellos ?? j?.data?.sellos ?? j?.stamps ?? j?.data?.stamps);
    const num = Number(n);
    return Number.isFinite(num) ? num : 0;
  } catch {
    return 0;
  }
}

// ====== Páginas web simples ======
app.get("/card/:id", async (req, res) => {
  const id = req.params.id;
  const negocio = cfg("NegocioNombre", "Todo Queso");
  const selloUrl = cfg("SelloURL", cfg("LogoURL", ""));
  const cardUrl = cfg("CARD_URL", "");
  const montoPorSello = Number(cfg("MontoPorSello", "10000")) || 10000;

  const sellos = await getSellos(id);

  const chips = Array.from({ length: Math.max(10, sellos) }, (_, i) => i < sellos);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${negocio} - Sellos</title>
</head>
<body style="margin:0;background:#0b1220;color:#fff;font-family:system-ui">
  <div style="max-width:520px;margin:0 auto;padding:18px">
    <h2 style="margin:0 0 6px">${negocio}</h2>
    <div style="opacity:.85;margin-bottom:14px">Cada $${montoPorSello.toLocaleString("es-AR")} = 1 sello</div>

    ${cardUrl ? `<img src="${cardUrl}" style="width:100%;max-width:520px;border-radius:16px;display:block;margin:0 0 14px" />` : ""}

    <div style="background:#111a2c;border:1px solid #22304d;border-radius:16px;padding:14px">
      <div style="font-size:16px;margin-bottom:10px">Sellos acumulados: <b>${sellos}</b></div>

      <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px">
        ${chips.slice(0, 50).map(full => `
          <div style="height:56px;border-radius:14px;border:1px solid #2b3a5e;display:flex;align-items:center;justify-content:center;background:${full ? "#152449" : "transparent"}">
            ${full && selloUrl ? `<img src="${selloUrl}" style="width:36px;height:36px;border-radius:10px;object-fit:cover" />` : (full ? "✅" : "•")}
          </div>
        `).join("")}
      </div>

      <div style="opacity:.8;margin-top:12px;font-size:13px">Si no ves sellos, es porque tu Apps Script aún no está devolviendo el número de sellos. El bot ya queda listo.</div>
    </div>
  </div>
</body>
</html>`);
});

app.get("/catalog", (_, res) => {
  const negocio = cfg("NegocioNombre", "Todo Queso");
  const ig = cfg("NegocioInstagram", "@todoqueso.club");
  const wa = cfg("WhatsAppLink", "");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body style="margin:0;background:#0b1220;color:#fff;font-family:system-ui;text-align:center;padding:24px">
  <h2 style="margin:0 0 8px">${negocio}</h2>
  <div style="opacity:.85;margin-bottom:18px">Catálogo</div>
  <div style="max-width:420px;margin:0 auto;background:#111a2c;border:1px solid #22304d;border-radius:16px;padding:16px">
    <div style="opacity:.9;margin-bottom:10px">Este link está para mostrar el sistema mientras terminamos el catálogo dentro del bot.</div>
    ${wa ? `<div style="margin:10px 0"><a href="${wa}" style="color:#7dd3fc">WhatsApp</a></div>` : ""}
    <div style="margin:10px 0">Instagram: <b>${ig}</b></div>
  </div>
</body>
</html>`);
});

// ====== Bot mensajes ======
bot.onText(/\/start/, async (msg) => {
  const name = msg.from?.first_name || "";
  const desc = cfg("Descripcion", "Hola 😊").replace("{NOMBRE}", name);
  await bot.sendMessage(msg.chat.id, desc, { reply_markup: MENU });
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const t = (msg.text || "").trim();

  if (t === "🛍️ Catálogo") {
    await bot.sendMessage(
      chatId,
      `🛍️ Catálogo online:\n${PUBLIC_URL}/catalog`,
      { reply_markup: MENU, disable_web_page_preview: true }
    );
  }

  if (t === "🏷️ Sellos") {
    await bot.sendMessage(
      chatId,
      `🏷️ Tu tarjeta / sellos:\n${PUBLIC_URL}/card/${chatId}`,
      { reply_markup: MENU, disable_web_page_preview: true }
    );
  }

  if (t === "📣 Compartir bot") {
    await bot.sendMessage(
      chatId,
      `🤖 ${cfg("TextoSistema", "¿Querés este sistema para tu negocio? Contactános")}\n\n✉️ ${cfg("EmailSistema","ezerbot.assistant@gmail.com")}\n🔗 ${cfg("BotLink","")}`.trim(),
      { reply_markup: MENU, disable_web_page_preview: true }
    );
  }

  if (t === "🆘 Ayuda") {
    const wa = cfg("WhatsAppLink", "");
    const ig = cfg("NegocioInstagram", "");
    await bot.sendMessage(
      chatId,
      `📌 Si necesitás hacer una consulta o reclamo:\n\n✅ WhatsApp: ${wa}\n📸 Instagram: ${ig}\n\nGracias por elegir ${cfg("NegocioNombre","Todo Queso")} 🧀`,
      { reply_markup: MENU, disable_web_page_preview: true }
    );
  }
});

// ====== Start ======
async function start() {
  await loadConfig();

  await bot.setWebHook(`${PUBLIC_URL}/telegram`);

  const PORT = process.env.PORT || 10000;
  app.listen(PORT, () => {
    console.log("🟢 EZERBOT ACTIVO:", PUBLIC_URL);
  });
}

start().catch((e) => {
  console.error("❌ FATAL:", e?.message || e);
  process.exit(1);
});

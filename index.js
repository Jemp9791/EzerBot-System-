import http from "http";

/* =========================
   VARIABLES (Render)
========================= */
const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_TOKEN;
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const DATA_API_URL = (process.env.DATA_API_URL || "").replace(/\/$/, "");

if (!TOKEN || !PUBLIC_URL || !DATA_API_URL) {
  console.error("❌ Faltan variables de entorno (TELEGRAM_TOKEN / PUBLIC_URL / DATA_API_URL)");
}

/* =========================
   TELEGRAM HELPERS
========================= */
const TG_API = `https://api.telegram.org/bot${TOKEN}`;

async function tg(method, payload) {
  try {
    await fetch(`${TG_API}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("Telegram error", e);
  }
}

function showMenu(chatId, text) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: {
      keyboard: [
        [{ text: "🛍️ Catálogo" }],
        [{ text: "🏷️ Sellos" }],
        [{ text: "📣 Compartir bot" }],
        [{ text: "🆘 Ayuda" }],
      ],
      resize_keyboard: true,
    },
  });
}

/* =========================
   PARSERS (JSON / TSV / CSV)
========================= */
function splitLine(line) {
  // acepta tab o coma
  if (line.includes("\t")) return line.split("\t");
  return line.split(",");
}

function parseKeyValueText(txt) {
  // Para Config: "KEY<TAB>VALUE" o "KEY,VALUE"
  const lines = txt
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  if (!lines.length) return {};
  const header = splitLine(lines[0]).map(s => s.trim().toUpperCase());
  // si no tiene KEY/VALUE, no es config
  const idxKey = header.indexOf("KEY");
  const idxVal = header.indexOf("VALUE");

  if (idxKey === -1 || idxVal === -1) return null;

  const obj = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = splitLine(lines[i]);
    const k = (cols[idxKey] || "").trim();
    const v = (cols[idxVal] || "").trim();
    if (k) obj[k] = v;
  }
  return obj;
}

function parseTableText(txt) {
  // Para Clientes/Catalogo/Referidos: tabla con encabezados
  const lines = txt
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length < 2) return [];

  const headers = splitLine(lines[0]).map(h => h.trim());
  const out = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = splitLine(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (cols[j] ?? "").trim();
    }
    out.push(row);
  }
  return out;
}

/* =========================
   DATA API (Apps Script)
   Soporta JSON o TSV/CSV
========================= */
async function getTab(tab) {
  const url = `${DATA_API_URL}?tab=${encodeURIComponent(tab)}`;
  try {
    const r = await fetch(url);
    const txt = await r.text();

    // 1) intentar JSON
    try {
      const j = JSON.parse(txt);
      // si tu Apps Script devuelve {ok:true, data:...} también lo acepto
      if (j && typeof j === "object" && j.data) return j.data;
      return j;
    } catch (_) {
      // 2) no es JSON: parsear TSV/CSV
      if (tab.toLowerCase() === "config") {
        const kv = parseKeyValueText(txt);
        if (kv && typeof kv === "object") return kv;
      }
      // tablas
      return parseTableText(txt);
    }
  } catch (e) {
    console.error("❌ Error leyendo DATA_API_URL:", e);
    // Nunca crashear
    return tab.toLowerCase() === "config" ? {} : [];
  }
}

/* =========================
   BOT ACTIONS
========================= */
async function start(chatId) {
  const config = await getTab("Config");
  const nombre = config.NegocioNombre || "Todo Queso";
  const desc = config.Descripcion || "Elegí tus productos desde el catálogo 👇";
  await showMenu(chatId, `👋 Bienvenido/a a ${nombre} 🧀\n\n${desc}`);
}

async function catalogo(chatId) {
  await tg("sendMessage", {
    chat_id: chatId,
    text: `🛍️ Catálogo online:\n${PUBLIC_URL}/catalog`,
  });
}

async function sellos(chatId) {
  const clientes = await getTab("Clientes");
  const config = await getTab("Config");

  const cli = (Array.isArray(clientes) ? clientes : []).find(
    c => String(c.UserIdTG) === String(chatId)
  );

  const sellos = cli ? Number(cli.Sellos || 0) : 0;
  const monto = Number(config.MontoPorSello || 10000);

  await tg("sendMessage", {
    chat_id: chatId,
    text:
      `🏷️ Tus sellos\n\n` +
      `Tenés ${sellos} sellos acumulados.\n` +
      `1 sello cada $${monto}\n\n` +
      `🪪 Tu tarjeta:\n${PUBLIC_URL}/card/${chatId}`,
  });
}

async function ayuda(chatId) {
  const config = await getTab("Config");
  await tg("sendMessage", {
    chat_id: chatId,
    text:
      `🆘 Ayuda\n\n` +
      `Si necesitás hacer una consulta, reclamo o te faltó algo del pedido y no lo viste en el catálogo, escribinos:\n\n` +
      `✅ WhatsApp: ${config.WhatsAppLink || ""}\n` +
      `📸 Instagram: ${config.NegocioInstagram || ""}\n\n` +
      `Gracias por elegir ${config.NegocioNombre || "Todo Queso"} 🧀`,
  });
}

async function compartir(chatId) {
  const config = await getTab("Config");
  await tg("sendMessage", {
    chat_id: chatId,
    text:
      `🤖 ¿Querés este sistema para tu negocio?\n` +
      `📩 ${config.EmailSistema || "ezerbot.assistant@gmail.com"}\n` +
      (config.BotLink ? `🔗 Bot demo: ${config.BotLink}` : ""),
  });
}

/* =========================
   WEBHOOK SERVER
========================= */
const server = http.createServer((req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("EZERBOT OK");
  }

  if (req.method === "POST") {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", async () => {
      res.writeHead(200);
      res.end("OK");

      let update = {};
      try { update = JSON.parse(body || "{}"); } catch (_) { return; }

      const msg = update.message;
      if (!msg || !msg.chat) return;

      const chatId = msg.chat.id;
      const text = msg.text || "";

      if (text === "/start") return start(chatId);
      if (text === "🛍️ Catálogo") return catalogo(chatId);
      if (text === "🏷️ Sellos") return sellos(chatId);
      if (text === "📣 Compartir bot") return compartir(chatId);
      if (text === "🆘 Ayuda") return ayuda(chatId);

      return start(chatId);
    });
  }
});

server.listen(Number(PORT), "0.0.0.0", async () => {
  console.log("✅ EZERBOT ACTIVO - escuchando en", PORT);

  // setWebhook siempre al root
  try {
    await fetch(`${TG_API}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: `${PUBLIC_URL}/` }),
    });
    console.log("✅ Webhook seteado:", `${PUBLIC_URL}/`);
  } catch (e) {
    console.error("❌ No pude setear webhook:", e);
  }
});

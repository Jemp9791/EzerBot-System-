import http from "http";
import { URL } from "url";

/* ========= ENV (SOLO 3) ========= */
const PORT = process.env.PORT || 10000;
const TOKEN = process.env.TELEGRAM_TOKEN;
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
const DATA_API_URL = (process.env.DATA_API_URL || "").replace(/\/$/, "");

const TG_API = `https://api.telegram.org/bot${TOKEN}`;

if (!TOKEN || !PUBLIC_URL || !DATA_API_URL) {
  console.error("❌ Faltan variables de entorno (TELEGRAM_TOKEN / PUBLIC_URL / DATA_API_URL)");
}

/* ========= TELEGRAM ========= */
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

/* ========= DATA PARSERS (JSON / TSV / CSV) ========= */
function splitLine(line) {
  return line.includes("\t") ? line.split("\t") : line.split(",");
}

function parseKeyValueText(txt) {
  const lines = txt
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (!lines.length) return {};

  const header = splitLine(lines[0]).map((s) => s.trim().toUpperCase());
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
  const lines = txt
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 2) return [];

  const headers = splitLine(lines[0]).map((h) => h.trim());
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

async function getTab(tab) {
  const url = `${DATA_API_URL}?tab=${encodeURIComponent(tab)}`;
  try {
    const r = await fetch(url);
    const txt = await r.text();

    // JSON
    try {
      const j = JSON.parse(txt);
      if (j && typeof j === "object" && j.data) return j.data;
      return j;
    } catch (_) {
      // TSV/CSV
      if (tab.toLowerCase() === "config") {
        const kv = parseKeyValueText(txt);
        if (kv && typeof kv === "object") return kv;
      }
      return parseTableText(txt);
    }
  } catch (e) {
    console.error("❌ Error leyendo DATA_API_URL:", e);
    return tab.toLowerCase() === "config" ? {} : [];
  }
}

/* ========= HELPERS ========= */
function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function money(n) {
  const x = Number(n || 0);
  return x.toLocaleString("es-AR");
}

function page(title, bodyHtml) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<style>
  body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;background:#0b1220;color:#e5e7eb}
  header{padding:14px 16px;background:#0f172a;border-bottom:1px solid rgba(255,255,255,.08);position:sticky;top:0}
  header .t{font-weight:800;font-size:16px}
  header .s{opacity:.8;font-size:12px;margin-top:2px}
  .wrap{padding:14px 12px;max-width:980px;margin:0 auto}
  .card{background:#111827;border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:12px;margin-bottom:10px}
  .btn{display:inline-block;padding:10px 12px;border-radius:12px;background:#16a34a;color:#08130b;text-decoration:none;font-weight:800}
  .muted{opacity:.8}
  .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
  @media (min-width:780px){.grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
  .pimg{width:100%;height:140px;object-fit:cover;border-radius:12px;border:1px solid rgba(255,255,255,.08);background:#0b1220}
  .pname{font-weight:800;margin-top:8px}
  .pcat{font-size:12px;opacity:.7;margin-top:2px}
  .pprice{margin-top:6px;font-weight:900}
  .badge{display:inline-block;padding:4px 8px;border-radius:999px;background:rgba(255,255,255,.08);font-size:12px;margin-top:8px}
  .stamps{display:flex;flex-wrap:wrap;gap:10px}
  .stamp{width:86px;height:86px;border-radius:18px;background:#0b1220;border:2px dashed rgba(255,255,255,.18);
         display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}
  .stamp.f{border-style:solid;border-color:rgba(22,163,74,.75);background:rgba(22,163,74,.08)}
  .stamp img{width:62px;height:62px;object-fit:contain;opacity:.95}
  .stamp .n{position:absolute;bottom:6px;right:9px;font-size:11px;opacity:.75}
</style>
</head>
<body>
<header>
  <div class="t">${esc(title)}</div>
</header>
<div class="wrap">${bodyHtml}</div>
</body>
</html>`;
}

/* ========= BOT ACTIONS ========= */
async function start(chatId) {
  const config = await getTab("Config");
  const clientes = await getTab("Clientes");

  const cli = (Array.isArray(clientes) ? clientes : []).find(
    (c) => String(c.UserIdTG) === String(chatId)
  );

  const negocio = config.NegocioNombre || "Todo Queso";
  const nombre = (cli?.Nombre || "").trim();
  const saludoTpl =
    config.Saludo ||
    `🧀 ¡Hola {NOMBRE}!\n\n🛍️ Mirá el catálogo y acumulá sellos.`;

  const saludo = saludoTpl.replaceAll("{NOMBRE}", nombre || "👋");

  await showMenu(
    chatId,
    `👋 Bienvenido/a a ${negocio} 🧀\n\n${saludo}`
  );
}

async function catalogo(chatId) {
  await tg("sendMessage", {
    chat_id: chatId,
    text: `🛍️ Catálogo online:\n${PUBLIC_URL}/catalog`,
  });
}

async function sellos(chatId) {
  await tg("sendMessage", {
    chat_id: chatId,
    text: `🏷️ Tu tarjeta / sellos:\n${PUBLIC_URL}/card/${chatId}`,
  });
}

async function ayuda(chatId) {
  const config = await getTab("Config");
  const negocio = config.NegocioNombre || "Todo Queso";

  await tg("sendMessage", {
    chat_id: chatId,
    text:
      `🆘 Ayuda\n\n` +
      `Si necesitás hacer una consulta, reclamo o te faltó algo del pedido y no lo viste en el catálogo, escribinos:\n\n` +
      `✅ WhatsApp: ${config.WhatsAppLink || ""}\n` +
      `📸 Instagram: ${config.NegocioInstagram || ""}\n\n` +
      `Gracias por elegir ${negocio} 🧀`,
  });
}

async function compartir(chatId) {
  const config = await getTab("Config");
  await tg("sendMessage", {
    chat_id: chatId,
    text:
      `🤖 ¿Querés este sistema para tu negocio? Contactános\n\n` +
      `📩 Email: ${config.EmailSistema || "ezerbot.assistant@gmail.com"}\n` +
      (config.BotLink ? `🔗 Bot demo: ${config.BotLink}` : ""),
  });
}

/* ========= WEB PAGES ========= */
async function renderCatalog() {
  const config = await getTab("Config");
  const catalogo = await getTab("Catalogo");

  const negocio = config.NegocioNombre || "Todo Queso";
  const insta = config.NegocioInstagram || "";
  const wa = config.WhatsAppLink || "";

  const items = Array.isArray(catalogo) ? catalogo : [];
  const cards = items
    .map((p) => {
      const nombre = p.NOMBRE || p.Nombre || "";
      const cat = p.CATEGORIA || p.Categoria || "Productos";
      const img = p.IMAGEN || p.Imagen || "";
      const unidad = (p.UNIDAD || p.Unidad || "").toLowerCase();
      const precio = p.PRECIO || p.Precio || "";

      const label = unidad ? `Unidad: ${unidad}` : " ";
      return `<div class="card">
        ${img ? `<img class="pimg" src="${esc(img)}" alt="${esc(nombre)}">` : ""}
        <div class="pname">${esc(nombre)}</div>
        <div class="pcat">${esc(cat)}</div>
        <div class="pprice">$ ${esc(money(precio))}</div>
        <div class="badge">${esc(label)}</div>
      </div>`;
    })
    .join("");

  const html = page(
    `${negocio} · Catálogo`,
    `<div class="card">
       <div class="muted">Catálogo online</div>
       <div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">
         ${wa ? `<a class="btn" href="${esc(wa)}">WhatsApp</a>` : ""}
         ${insta ? `<a class="btn" style="background:#38bdf8;color:#071018" href="https://instagram.com/${esc(insta.replace("@",""))}">Instagram</a>` : ""}
       </div>
     </div>
     <div class="grid">${cards || `<div class="card">No hay productos cargados.</div>`}</div>`
  );

  return html;
}

async function renderCard(userId) {
  const config = await getTab("Config");
  const clientes = await getTab("Clientes");

  const negocio = config.NegocioNombre || "Todo Queso";
  const logo = config.LogoURL || config.Logo || "";
  const montoPorSello = Number(config.MontoPorSello || 10000);

  const cli = (Array.isArray(clientes) ? clientes : []).find(
    (c) => String(c.UserIdTG) === String(userId)
  );

  const nombre = cli?.Nombre || "Cliente";
  const sellos = Number(cli?.Sellos || 0);

  const maxMostrados = Number(config.SellosParaPremio || 10) || 10;
  const totalSlots = Math.max(6, Math.min(24, maxMostrados));
  const filled = Math.min(sellos, totalSlots);

  const stampsHtml = Array.from({ length: totalSlots })
    .map((_, i) => {
      const f = i < filled ? "f" : "";
      return `<div class="stamp ${f}">
        ${logo ? `<img src="${esc(logo)}" alt="logo">` : `<div style="font-weight:900;opacity:.85">🧀</div>`}
        <div class="n">${i + 1}</div>
      </div>`;
    })
    .join("");

  const html = page(
    `${negocio} · Sellos`,
    `<div class="card">
      <div class="muted">Tarjeta de sellos</div>
      <div style="margin-top:6px;font-weight:900;font-size:18px">${esc(nombre)}</div>
      <div class="muted" style="margin-top:6px">Sellos acumulados: <b>${sellos}</b></div>
      <div class="muted">1 sello cada $${money(montoPorSello)}</div>
    </div>
    <div class="card">
      <div class="muted" style="margin-bottom:10px">Tus sellos</div>
      <div class="stamps">${stampsHtml}</div>
    </div>`
  );

  return html;
}

/* ========= SERVER ========= */
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = u.pathname || "/";

  // WEB
  if (req.method === "GET") {
    (async () => {
      try {
        if (path === "/" || path === "/health") {
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          return res.end("EZERBOT OK");
        }

        if (path === "/catalog") {
          const html = await renderCatalog();
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          return res.end(html);
        }

        if (path.startsWith("/card/")) {
          const userId = path.split("/").pop();
          const html = await renderCard(userId);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          return res.end(html);
        }

        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("Not found");
      } catch (e) {
        console.error("GET error", e);
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("Server error");
      }
    })();
    return;
  }

  // TELEGRAM WEBHOOK (POST al /)
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      res.writeHead(200);
      res.end("OK");

      let update = {};
      try {
        update = JSON.parse(body || "{}");
      } catch (_) {
        return;
      }

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
    return;
  }

  res.writeHead(405);
  res.end("Method not allowed");
});

server.listen(Number(PORT), "0.0.0.0", async () => {
  console.log("✅ EZERBOT ACTIVO - escuchando en", PORT);

  // Webhook al root
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

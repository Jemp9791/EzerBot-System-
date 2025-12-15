/**
 * index.js — EzerBot System (Render + Telegram Webhook)
 * Requisitos ENV en Render:
 * - BOT_TOKEN   (token del bot)
 * - PUBLIC_URL  (https://tu-servicio.onrender.com)
 * - GAS_URL     (URL del WebApp de Apps Script, termina en /exec)
 *
 * IMPORTANTE:
 * Tu Apps Script debe responder JSON para:
 *   GAS_URL?action=config
 *   GAS_URL?action=catalogo   (opcional)
 */

import express from "express";
import TelegramBot from "node-telegram-bot-api";

const app = express();
app.use(express.json({ limit: "2mb" }));

// ===== ENV =====
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const GAS_URL = process.env.GAS_URL || "";
const PORT = process.env.PORT || 10000;

if (!BOT_TOKEN) console.log("❌ Falta BOT_TOKEN");
if (!PUBLIC_URL) console.log("❌ Falta PUBLIC_URL");
if (!GAS_URL) console.log("❌ Falta GAS_URL");

// ===== Telegram bot =====
const bot = new TelegramBot(BOT_TOKEN, { webHook: true });

// ===== Estado / cache =====
const state = {
  bootedAt: new Date().toISOString(),
  botInfo: null,
  lastUpdateAt: null,
  lastChatId: null,
  lastText: null,
  lastError: null,

  config: {},       // key->value
  configRaw: null,  // raw JSON
  configLoadedAt: null,

  catalogo: [],       // productos
  catalogoLoadedAt: null,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== Helpers =====
function norm(s) {
  return (s || "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // sin tildes
}

function pickConfig(keys, fallback = "") {
  for (const k of keys) {
    const v = state.config[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v);
  }
  return fallback;
}

function money(n) {
  try {
    const num = Number(n) || 0;
    return num.toLocaleString("es-AR");
  } catch {
    return String(n);
  }
}

// Busca una “respuesta” dentro de Config, como cerebro.
// Estrategia:
// 1) match exacto por key
// 2) contiene palabra clave (keys parecidas) en pregunta
// 3) si no, intenta buscar dentro de valores (por si guardaste FAQs)
function answerFromConfig(userText) {
  const q = norm(userText);

  if (!q) return null;

  // 1) exacto: si el usuario escribe la key tal cual (o parecida)
  const direct = state.config[q];
  if (direct) return direct;

  // 2) contiene: si pregunta incluye alguna key
  // Ej: pregunta "horarios" y Config tiene key "horarios"
  const keys = Object.keys(state.config || {});
  // keys largas primero para evitar colisiones
  keys.sort((a, b) => b.length - a.length);

  for (const k of keys) {
    if (!k) continue;
    if (k.length < 3) continue;
    if (q.includes(k)) return state.config[k];
  }

  // 3) fallback: si tu Config tiene preguntas guardadas como texto
  // busca en valores
  for (const k of keys) {
    const v = state.config[k];
    if (typeof v === "string" && norm(v).includes(q) && q.length > 6) {
      return v;
    }
  }

  return null;
}

// ===== Fetch GAS =====
async function fetchJSON(url) {
  const res = await fetch(url, { method: "GET" });
  const text = await res.text();

  // Si devuelve HTML (login / error), esto lo detecta
  const looksHTML = /<html|<!doctype/i.test(text);

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} :: ${text.slice(0, 200)}`);
  }
  if (looksHTML) {
    throw new Error(
      `GAS devolvió HTML (no JSON). ¿WebApp no es público o no está devolviendo JSON? :: ${text.slice(0, 200)}`
    );
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`No pude parsear JSON. Respuesta: ${text.slice(0, 200)}`);
  }
}

// Convierte Config en “diccionario cerebro”.
// Soporta dos formatos:
// A) { ok:true, config:{...} }
// B) { ok:true, rows:[["key","value"], ...] }  o rows como objetos
function parseConfigToDict(data) {
  if (!data) return {};

  if (data.config && typeof data.config === "object") {
    const dict = {};
    for (const [k, v] of Object.entries(data.config)) {
      dict[norm(k)] = typeof v === "string" ? v.trim() : String(v ?? "");
    }
    return dict;
  }

  const dict = {};
  const rows = data.rows || data.data || data.values || [];
  if (Array.isArray(rows)) {
    for (const r of rows) {
      if (!r) continue;
      // fila tipo array [k,v]
      if (Array.isArray(r)) {
        const k = norm(r[0]);
        const v = r[1];
        if (k) dict[k] = typeof v === "string" ? v.trim() : String(v ?? "");
      } else if (typeof r === "object") {
        // fila tipo objeto {key:"", value:""} o {K:"", V:""}
        const k = norm(r.key || r.KEY || r.clave || r.Clave || r[0]);
        const v = r.value || r.VALUE || r.valor || r.Valor || r[1];
        if (k) dict[k] = typeof v === "string" ? v.trim() : String(v ?? "");
      }
    }
  }
  return dict;
}

async function loadConfig({ force = false } = {}) {
  if (!GAS_URL) return;

  // cache 2 min si no force
  if (!force && state.configLoadedAt) {
    const age = Date.now() - new Date(state.configLoadedAt).getTime();
    if (age < 2 * 60 * 1000) return;
  }

  try {
    const url = `${GAS_URL}?action=config&_t=${Date.now()}`;
    const data = await fetchJSON(url);

    state.configRaw = data;
    state.config = parseConfigToDict(data);
    state.configLoadedAt = new Date().toISOString();
    state.lastError = null;

    console.log("✅ Config cargado. Keys:", Object.keys(state.config).length);
  } catch (err) {
    state.lastError = String(err?.message || err);
    console.log("❌ Error cargando Config:", state.lastError);
  }
}

async function loadCatalogo({ force = false } = {}) {
  if (!GAS_URL) return;

  // cache 3 min si no force
  if (!force && state.catalogoLoadedAt) {
    const age = Date.now() - new Date(state.catalogoLoadedAt).getTime();
    if (age < 3 * 60 * 1000) return;
  }

  try {
    const url = `${GAS_URL}?action=catalogo&_t=${Date.now()}`;
    const data = await fetchJSON(url);

    const items = data.items || data.catalogo || data.rows || data.data || [];
    state.catalogo = Array.isArray(items) ? items : [];
    state.catalogoLoadedAt = new Date().toISOString();
    state.lastError = null;

    console.log("✅ Catálogo cargado. Items:", state.catalogo.length);
  } catch (err) {
    // no frenamos el bot si catálogo falla
    const msg = String(err?.message || err);
    state.lastError = msg;
    console.log("⚠️ Error cargando Catálogo:", msg);
  }
}

// ===== UI / Mensajes =====
function mainMenuKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🛍️ Catálogo" }, { text: "🛒 Mi carrito" }],
        [{ text: "✅ Finalizar compra" }],
        [{ text: "🏪 Información del local" }, { text: "💬 Hablar con el vendedor" }],
        [{ text: "🔄 Recargar catálogo" }, { text: "📣 Compartir el bot" }],
      ],
      resize_keyboard: true,
    },
  };
}

function warmStartText(firstName = "") {
  // Todo esto sale de Config si existe
  const brand = pickConfig(["marca", "brand", "negocio", "nombrelocal"], "Todo Queso");
  const saludo = pickConfig(
    ["saludo_inicio", "saludo", "bienvenida"],
    `Hola ${firstName ? firstName : ""} 😊\nSoy el asistente de ${brand} 🧀`
  );

  const bullets = pickConfig(
    ["saludo_bullets", "bienvenida_bullets"],
    "• Ver el catálogo\n• Armar tu pedido\n• Finalizar compra"
  );

  return `${saludo}\n\nDesde acá podés:\n${bullets}\n\n👇 Elegí una opción`;
}

async function sendLocalInfo(chatId) {
  await loadConfig();

  const nombre = pickConfig(["nombrelocal", "marca", "brand"], "Todo Queso");
  const direccion = pickConfig(["direccion", "domicilio"], "Fructuoso Díaz 893, Garín");
  const horarios = pickConfig(["horarios", "horario"], "LUN a SAB 08:30-14:00 / 16:30-21:00");
  const tel = pickConfig(["telefono", "tel", "whatsapp_local"], "");
  const ig = pickConfig(["instagram"], "");
  const fb = pickConfig(["facebook"], "");
  const desc = pickConfig(["descripcion_local", "descripcion"], "");

  const logo = pickConfig(["logo", "logo_url", "imagen_logo"], "");

  // Si hay logo, mandamos foto + caption (Telegram)
  const caption =
    `🏪 *${nombre}*\n` +
    `📍 ${direccion}\n` +
    `🕒 ${horarios}\n` +
    (tel ? `📞 ${tel}\n` : "") +
    (ig ? `📸 Instagram: ${ig}\n` : "") +
    (fb ? `📘 Facebook: ${fb}\n` : "") +
    (desc ? `\n${desc}` : "");

  if (logo && /^https?:\/\//i.test(logo)) {
    return bot.sendPhoto(chatId, logo, { caption, parse_mode: "Markdown" });
  }

  // sin logo, igual respuesta completa
  return bot.sendMessage(chatId, caption, { parse_mode: "Markdown" });
}

async function sendVendorWhatsApp(chatId) {
  await loadConfig();

  const vendorWsp = pickConfig(
    ["whatsapp_vendedor", "wsp_vendedor", "whatsapp", "whatsapp_ventas"],
    ""
  );

  if (!vendorWsp) {
    return bot.sendMessage(
      chatId,
      "📲 En este momento no tengo cargado el WhatsApp del vendedor. Avisame y lo dejamos configurado en *Config* 😊",
      { parse_mode: "Markdown" }
    );
  }

  // normaliza número
  const num = vendorWsp.replace(/[^\d]/g, "");
  const link = `https://wa.me/${num}`;
  return bot.sendMessage(chatId, "💬 Hablá con nosotros por WhatsApp 👇", {
    reply_markup: {
      inline_keyboard: [[{ text: "📱 Abrir WhatsApp", url: link }]],
    },
  });
}

// ===== Handler principal (cualquier mensaje) =====
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const firstName = msg.from?.first_name || "";
  const text = msg.text || "";

  state.lastChatId = chatId;
  state.lastText = text;
  state.lastUpdateAt = new Date().toISOString();

  // Respuesta rápida para que no parezca “mudo”
  // (y cuando Render se despierta, esto ayuda)
  try {
    await bot.sendChatAction(chatId, "typing");
  } catch {}

  // Asegura Config cargado
  await loadConfig();

  const t = norm(text);

  // Comandos y triggers
  if (t.startsWith("/start") || t === "start") {
    await bot.sendMessage(chatId, warmStartText(firstName), mainMenuKeyboard());
    return;
  }

  // Cualquier comando tipo /algo → respondemos igual (no ignorar)
  if (t.startsWith("/")) {
    await bot.sendMessage(chatId, `😊 Dale. ¿Qué necesitás? (Podés tocar una opción del menú 👇)`, mainMenuKeyboard());
    return;
  }

  // Botones del teclado
  if (t.includes("recargar")) {
    await bot.sendMessage(chatId, "🔄 Listo. Recargando catálogo...");
    await loadCatalogo({ force: true });
    // mostramos categorías desde catálogo si hay
    const cats = Array.from(
      new Set(
        (state.catalogo || [])
          .map((p) => (p.categoria || p.CATEGORIA || "").toString().trim())
          .filter(Boolean)
      )
    );

    if (!cats.length) {
      await bot.sendMessage(
        chatId,
        "⚠️ No encontré categorías todavía. Revisá que tu GAS devuelva productos con `categoria`, `codigo`, `nombre`, `precio|precioporkg`, `imagen`."
      );
      return;
    }

    const buttons = cats.map((c) => [{ text: `📂 ${c}` }]);
    await bot.sendMessage(chatId, "📂 Elegí una categoría:", {
      reply_markup: { keyboard: buttons.concat([[{ text: "⬅️ Menú" }]]), resize_keyboard: true },
    });
    return;
  }

  if (t.includes("informacion") || t.includes("información") || t.includes("local")) {
    await sendLocalInfo(chatId);
    return;
  }

  if (t.includes("hablar") || t.includes("vendedor") || t.includes("whatsapp")) {
    await sendVendorWhatsApp(chatId);
    return;
  }

  if (t.includes("menu") || t === "menú" || t === "⬅️ menú") {
    await bot.sendMessage(chatId, "👌 Dale. Elegí una opción del menú 👇", mainMenuKeyboard());
    return;
  }

  // ⭐ “Config como cerebro”: responder a casi cualquier pregunta usando keys/values
  const cfgAnswer = answerFromConfig(text);
  if (cfgAnswer) {
    // Si la respuesta parece URL de imagen, la mandamos como foto
    const ans = String(cfgAnswer).trim();
    if (/^https?:\/\/.*\.(png|jpg|jpeg|webp)$/i.test(ans)) {
      await bot.sendPhoto(chatId, ans);
      return;
    }
    await bot.sendMessage(chatId, ans, mainMenuKeyboard());
    return;
  }

  // Fallback amable (nunca “mudo”, nunca técnico)
  await bot.sendMessage(
    chatId,
    "😊 Te leo. Si querés comprar, tocá *Catálogo*. Si buscás info del local, tocá *Información del local*.\n\n👇 Elegí una opción:",
    { parse_mode: "Markdown", ...mainMenuKeyboard() }
  );
}

// ===== Webhook endpoint =====
app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;
    // Telegram necesita 200 rápido
    res.sendStatus(200);

    if (update.message) {
      await handleMessage(update.message);
    }
  } catch (err) {
    state.lastError = String(err?.message || err);
    console.log("❌ Error webhook:", state.lastError);
  }
});

// Health check
app.get("/", (req, res) => res.status(200).send("ok"));

// Debug (para ver si Config se está leyendo o no)
app.get("/debug", async (req, res) => {
  await loadConfig({ force: true });
  await loadCatalogo({ force: true });

  res.json({
    ok: true,
    bootedAt: state.bootedAt,
    bot: state.botInfo,
    gasUrlSet: Boolean(GAS_URL),
    configLoadedAt: state.configLoadedAt,
    configKeysCount: Object.keys(state.config || {}).length,
    sampleKeys: Object.keys(state.config || {}).slice(0, 30),
    catalogoLoadedAt: state.catalogoLoadedAt,
    catalogoCount: (state.catalogo || []).length,
    lastUpdateAt: state.lastUpdateAt,
    lastChatId: state.lastChatId,
    lastText: state.lastText,
    lastError: state.lastError,
    // Te muestra raw por si tu GAS responde distinto:
    configRawPreview: state.configRaw ? JSON.stringify(state.configRaw).slice(0, 800) : null,
  });
});

// ===== Start server + webhook =====
async function start() {
  app.listen(PORT, async () => {
    console.log(`✅ Server up on ${PORT}`);

    try {
      state.botInfo = await bot.getMe();

      // Set webhook
      const webhookUrl = `${PUBLIC_URL.replace(/\/$/, "")}/webhook`;
      await bot.setWebHook(webhookUrl);
      console.log("✅ Webhook seteado:", webhookUrl);

      // Preload config/catalogo
      await loadConfig({ force: true });
      await loadCatalogo({ force: true });

      console.log("✅ Service listo");
    } catch (err) {
      state.lastError = String(err?.message || err);
      console.log("❌ Error iniciando:", state.lastError);
    }
  });
}

start();

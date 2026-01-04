/**
 * EzerBot / Todo Queso - index.js (Render)
 * - Telegraf + Google Sheets API (service account JSON en base64)
 * - UI limpia: edita mensajes (menos spam en el chat
 * - Catálogo carrusel (prev/next)
 *
 * ENV requeridas en Render:
 *   TELEGRAM_BOT_TOKEN=xxxxx
 *   GOOGLE_SHEET_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 *   GOOGLE_SERVICE_ACCOUNT_B64=base64_del_json (SIN saltos)
 *   PUBLIC_URL=https://tu-servicio.onrender.com   (opcional pero recomendado)
 *   PORT=10000 (Render lo setea)
 */

import express from "express";
import { Telegraf, Markup } from "telegraf";
import { google } from "googleapis";

// =====================
// ENV
// =====================
const {
  TELEGRAM_BOT_TOKEN,
  GOOGLE_SHEET_ID,
  GOOGLE_SERVICE_ACCOUNT_B64,
  PUBLIC_URL,
  PORT,
} = process.env;

if (!TELEGRAM_BOT_TOKEN) throw new Error("Falta TELEGRAM_BOT_TOKEN");
if (!GOOGLE_SHEET_ID) throw new Error("Falta GOOGLE_SHEET_ID");
if (!GOOGLE_SERVICE_ACCOUNT_B64) throw new Error("Falta GOOGLE_SERVICE_ACCOUNT_B64");

const port = Number(PORT || 10000);
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// =====================
// Helpers: seguridad Telegram (evitar crash)
// =====================
function ensureText(text) {
  if (typeof text === "string" && text.trim().length > 0) return text;
  return "⚠️ Hubo un problema al armar este mensaje. Probá nuevamente.";
}

async function safeReply(ctx, text, extra = {}) {
  try {
    return await ctx.reply(ensureText(text), extra);
  } catch (e) {
    console.error("safeReply error:", e?.message || e);
    return null;
  }
}

async function safeEditMessage(ctx, text, extra = {}) {
  const safeText = ensureText(text);
  try {
    // editMessageText sobre el mensaje “actual” (callback o message)
    return await ctx.editMessageText(safeText, { parse_mode: "Markdown", ...extra });
  } catch (e) {
    // Si no se puede editar (por ejemplo, mensaje viejo), mandamos uno nuevo
    const msg = e?.message || "";
    console.warn("safeEditMessage fallback:", msg);
    return await safeReply(ctx, safeText, { parse_mode: "Markdown", ...extra });
  }
}

async function safeEditOrSendPhoto(ctx, photoUrl, caption, keyboard) {
  const cap = ensureText(caption);
  const markup = keyboard ? { ...keyboard } : {};
  // Intento editar media si estamos en callback (carrusel)
  try {
    // editMessageMedia requiere InputMedia
    await ctx.editMessageMedia(
      { type: "photo", media: photoUrl, caption: cap, parse_mode: "Markdown" },
      markup
    );
    return true;
  } catch (e) {
    // Si no se puede editar media, mando foto nueva (y listo)
    try {
      await ctx.replyWithPhoto(photoUrl, { caption: cap, parse_mode: "Markdown", ...markup });
      return true;
    } catch (e2) {
      console.error("safeEditOrSendPhoto failed:", e2?.message || e2);
      await safeReply(ctx, cap, { parse_mode: "Markdown", ...markup });
      return false;
    }
  }
}

// =====================
// Google Sheets (Service Account)
// =====================
function decodeServiceAccountB64(b64) {
  // Acepta base64 “puro” y también base64url
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const buff = Buffer.from(normalized, "base64");
  const txt = buff.toString("utf8").trim();

  // Validación mínima
  if (!txt.startsWith("{") || !txt.endsWith("}")) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_B64 decodifica pero NO es JSON válido.");
  }
  return JSON.parse(txt);
}

const sa = decodeServiceAccountB64(GOOGLE_SERVICE_ACCOUNT_B64);

const auth = new google.auth.JWT({
  email: sa.client_email,
  key: sa.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});

const sheets = google.sheets({ version: "v4", auth });

function sheetRange(sheetName, a1) {
  // Si tiene espacios o caracteres raros, se escapa con comillas simples.
  const needsQuotes = /[^A-Za-z0-9_]/.test(sheetName);
  const name = needsQuotes ? `'${sheetName.replace(/'/g, "''")}'` : sheetName;
  return `${name}!${a1}`;
}

async function getValues(rangeA1) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: rangeA1,
  });
  return res.data.values || [];
}

// =====================
// Cache liviano (evitar pegarle a Sheets en cada click)
// =====================
const cache = {
  config: { at: 0, data: null },
  catalog: { at: 0, data: null },
};
const TTL_MS = 15_000; // 15s: rápido pero no mata Sheets

async function loadConfig() {
  const now = Date.now();
  if (cache.config.data && now - cache.config.at < TTL_MS) return cache.config.data;

  // Config: columnas A=KEY, B=VALUE
  const rows = await getValues(sheetRange("Config", "A:B"));
  const obj = {};
  for (const r of rows) {
    const k = (r?.[0] || "").toString().trim();
    const v = (r?.[1] || "").toString();
    if (k) obj[k] = v;
  }
  cache.config = { at: now, data: obj };
  return obj;
}

async function loadCatalog() {
  const now = Date.now();
  if (cache.catalog.data && now - cache.catalog.at < TTL_MS) return cache.catalog.data;

  // Catalogo: asumimos columnas:
  // A Código | B Nombre | C Precio | D Unidad | E PrecioKg | F Barcode | G Descripción | H Imagen | I Categoría | J Activo(SI/NO)
  const rows = await getValues(sheetRange("Catalogo", "A:J"));
  const headers = rows.shift() || [];
  const items = rows
    .map((r) => ({
      codigo: r?.[0] || "",
      nombre: r?.[1] || "",
      precio: r?.[2] || "",
      unidad: r?.[3] || "",
      precioKg: r?.[4] || "",
      barcode: r?.[5] || "",
      descripcion: r?.[6] || "",
      imagen: r?.[7] || "",
      categoria: r?.[8] || "General",
      activo: (r?.[9] || "SI").toString().toUpperCase() !== "NO",
    }))
    .filter((x) => x.activo && x.nombre);

  cache.catalog = { at: now, data: { headers, items } };
  return cache.catalog.data;
}

// =====================
// Estado por chat (para carrusel)
// =====================
const state = new Map(); // chatId -> { catIndex, catFilter, pageIndex }

function getChatState(chatId) {
  if (!state.has(chatId)) {
    state.set(chatId, { category: null, index: 0 });
  }
  return state.get(chatId);
}

// =====================
// UI: menú principal (inline)
// =====================
function mainMenuKeyboard(cfg) {
  const usarSellos = (cfg.UsaSellos || "SI").toUpperCase() === "SI";
  const btns = [
    [Markup.button.callback("🧀 Catálogo", "MENU_CATALOGO")],
    [
      ...(usarSellos ? [Markup.button.callback("🎟️ Sellos", "MENU_SELLOS")] : []),
      Markup.button.callback("ℹ️ Ayuda", "MENU_AYUDA"),
    ],
    [Markup.button.callback("📣 Compartir", "MENU_COMPARTIR")],
  ];
  return Markup.inlineKeyboard(btns);
}

function headerInfo(cfg) {
  const nombre = cfg.NegocioNombre || "Todo Queso";
  const dir = cfg.NegocioDireccion || "";
  const horario = cfg.NegocioHorario || "";
  const estado = cfg.Estado || "Abierto";
  const tel = cfg.NegocioTelefono || "";
  const ig = cfg.NegocioInstagram || "";
  const moneda = cfg.Moneda || "ARS";

  const estadoEmoji =
    estado.toLowerCase().includes("abier") ? "✅" :
    estado.toLowerCase().includes("cierra") ? "⛔" :
    estado.toLowerCase().includes("vac") ? "🏖️" : "ℹ️";

  let lines = [];
  lines.push(`*${nombre}* ${estadoEmoji}`);
  if (estado) lines.push(`*Estado:* ${estado}`);
  if (horario) lines.push(`*Horario:* ${horario}`);
  if (dir) lines.push(`*Dirección:* ${dir}`);
  if (tel) lines.push(`*Tel:* ${tel}`);
  if (ig) lines.push(`*IG:* ${ig}`);
  lines.push(`*Moneda:* ${moneda}`);

  return lines.join("\n");
}

// =====================
// Saludo (con imagen)
// =====================
async function sendWelcome(ctx) {
  const cfg = await loadConfig();
  const logo = cfg.LogoURL || cfg.CARD_URL || "";
  const textoBase = cfg.Descripcion || "Elegí una opción 👇";
  const caption = `${headerInfo(cfg)}\n\n${textoBase}`;
  const kb = mainMenuKeyboard(cfg);

  if (logo) {
    await safeEditOrSendPhoto(ctx, logo, caption, kb);
  } else {
    await safeEditMessage(ctx, caption, { reply_markup: kb.reply_markup });
  }
}

// =====================
// Catálogo (carrusel)
// =====================
function productCaption(cfg, p, idx, total) {
  const moneda = cfg.Moneda || "ARS";
  const precio =
    p.unidad?.toLowerCase().includes("kg") || p.precioKg
      ? (p.precioKg ? `${moneda} ${p.precioKg} /kg` : `${moneda} ${p.precio}`)
      : `${moneda} ${p.precio}`;

  const desc = (p.descripcion || "").trim();
  const cat = (p.categoria || "").trim();

  const lines = [];
  lines.push(`*${p.nombre}*`);
  if (cat) lines.push(`_${cat}_`);
  if (precio) lines.push(`💰 *${precio}*`);
  if (desc) lines.push(`\n${desc}`);
  lines.push(`\n📦 ${idx + 1}/${total}`);
  return lines.join("\n");
}

function productKeyboard(p) {
  const shareText = `Quiero ${p.nombre}. ¿Me lo preparás?`;
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Quiero esta promo", `BUY_${encodeURIComponent(p.codigo)}`)],
    [Markup.button.url("🔗 Compartir producto", `https://t.me/share/url?url=&text=${encodeURIComponent(shareText)}`)],
    [
      Markup.button.callback("⬅️ Anterior", "CAT_PREV"),
      Markup.button.callback("Siguiente ➡️", "CAT_NEXT"),
    ],
    [Markup.button.callback("🏠 Menú", "MENU_HOME")],
  ]);
}

async function showCatalogItem(ctx, direction = 0) {
  const cfg = await loadConfig();
  const { items } = await loadCatalog();
  const chatId = ctx.chat?.id || ctx.from?.id;
  const st = getChatState(chatId);

  if (!items || items.length === 0) {
    return safeEditMessage(ctx, "⚠️ No hay productos activos en *Catalogo*.", {
      reply_markup: mainMenuKeyboard(cfg).reply_markup,
    });
  }

  st.index = Math.max(0, Math.min(items.length - 1, st.index + direction));
  const p = items[st.index];

  const caption = productCaption(cfg, p, st.index, items.length);
  const kb = productKeyboard(p);

  const img = (p.imagen || "").trim() || (cfg.CARD_URL || "").trim() || (cfg.LogoURL || "").trim();
  if (img) {
    await safeEditOrSendPhoto(ctx, img, caption, kb);
  } else {
    await safeEditMessage(ctx, caption, { reply_markup: kb.reply_markup });
  }
}

// =====================
// Sellos (placeholder real desde Config / futuro desde hoja Sellos)
// =====================
async function showSellos(ctx) {
  const cfg = await loadConfig();
  // Si tenés una hoja Clientes/Sellos real, acá se lee por chatId/telefono.
  // Por ahora: muestra 0 pero SIN romper el bot.
  const text = `🎟️ *Sellos*\n\nTenés *0* sellos acumulados.\n\n(Esto ya está listo para conectarlo a la hoja de clientes/sellos cuando me digas el nombre exacto de esa hoja y columnas.)`;
  return safeEditMessage(ctx, text, { reply_markup: mainMenuKeyboard(cfg).reply_markup });
}

// =====================
// Ayuda / Compartir bot
// =====================
async function showHelp(ctx) {
  const cfg = await loadConfig();
  const text = `ℹ️ *Ayuda*\n\n` +
    `• Tocá *🧀 Catálogo* para mirar productos con *Siguiente/Anterior*.\n` +
    `• Tocá *✅ Quiero esta promo* para pedir ese producto.\n` +
    `• *📣 Compartir* para enviarle el bot a alguien.\n\n` +
    `Si querés comprar rápido: escribí *catálogo*.`;
  return safeEditMessage(ctx, text, { reply_markup: mainMenuKeyboard(cfg).reply_markup });
}

async function showShare(ctx) {
  const cfg = await loadConfig();
  const botLink = cfg.BotLink || ""; // si lo tenés en Config
  const msg = cfg.TextoCompartirBot || "Compartí este bot con tus amigos para comprar más fácil.";
  const url = botLink || `https://t.me/${(await bot.telegram.getMe()).username}`;
  const text = `📣 *Compartir*\n\n${msg}\n\n👉 ${url}`;
  return safeEditMessage(ctx, text, {
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.url("🔗 Compartir bot", `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(msg)}`)],
      [Markup.button.callback("🏠 Menú", "MENU_HOME")],
    ]).reply_markup,
  });
}

// =====================
// “Quiero esta promo” (pedido simple - sin ensuciar)
// =====================
async function handleBuy(ctx, codigo) {
  const cfg = await loadConfig();
  const { items } = await loadCatalog();
  const p = items.find((x) => String(x.codigo) === String(codigo));

  if (!p) {
    return safeEditMessage(ctx, "⚠️ No encontré ese producto en el catálogo.", {
      reply_markup: mainMenuKeyboard(cfg).reply_markup,
    });
  }

  const tel = (cfg.NegocioTelefono || "").replace(/[^\d+]/g, "");
  const wa = tel ? `https://wa.me/${tel}` : "";

  const text =
    `✅ *Perfecto*\n\n` +
    `Anoté tu pedido:\n` +
    `• *${p.nombre}*\n\n` +
    (wa ? `📲 Si querés, confirmalo por WhatsApp:\n${wa}\n\n` : "") +
    `¿Querés seguir mirando?`;

  return safeEditMessage(ctx, text, {
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback("🧀 Seguir en Catálogo", "MENU_CATALOGO")],
      [Markup.button.callback("🏠 Menú", "MENU_HOME")],
    ]).reply_markup,
  });
}

// =====================
// Rutas / Comandos
// =====================
bot.start(async (ctx) => sendWelcome(ctx));

bot.hears(/^(ayuda|help)$/i, async (ctx) => {
  const cfg = await loadConfig();
  await safeReply(ctx, "Escribí /start para ver el menú.", { reply_markup: mainMenuKeyboard(cfg).reply_markup });
});

bot.hears(/^cat[aá]logo$/i, async (ctx) => {
  const chatId = ctx.chat?.id || ctx.from?.id;
  const st = getChatState(chatId);
  st.index = 0;
  await showCatalogItem(ctx, 0);
});

// =====================
// Callbacks (inline)
// =====================
bot.action("MENU_HOME", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await sendWelcome(ctx);
});

bot.action("MENU_CATALOGO", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const chatId = ctx.chat?.id || ctx.from?.id;
  const st = getChatState(chatId);
  st.index = 0;
  await showCatalogItem(ctx, 0);
});

bot.action("CAT_NEXT", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await showCatalogItem(ctx, +1);
});

bot.action("CAT_PREV", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await showCatalogItem(ctx, -1);
});

bot.action("MENU_SELLOS", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await showSellos(ctx);
});

bot.action("MENU_AYUDA", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await showHelp(ctx);
});

bot.action("MENU_COMPARTIR", async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  await showShare(ctx);
});

bot.action(/^BUY_(.+)$/i, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const code = decodeURIComponent(ctx.match[1] || "");
  await handleBuy(ctx, code);
});

// Texto libre (si el cliente escribe opciones)
bot.on("text", async (ctx) => {
  const t = (ctx.message?.text || "").trim().toLowerCase();

  if (t === "start" || t === "/start") return sendWelcome(ctx);
  if (t === "catálogo" || t === "catalogo") return ctx.reply("Abrí el catálogo desde el menú 👇").then(() => sendWelcome(ctx));
  if (t === "sellos") return showSellos(ctx);
  if (t === "ayuda") return showHelp(ctx);
  if (t === "compartir") return showShare(ctx);

  // Mantener chat limpio: NO spameamos, solo recordamos menú
  return safeReply(ctx, "Elegí una opción del menú 👇", {
    reply_markup: mainMenuKeyboard(await loadConfig()).reply_markup,
  });
});

// =====================
// Render: servidor HTTP + webhook opcional
// =====================
const app = express();
app.use(express.json());

app.get("/", (_, res) => res.status(200).send("OK - EzerBot running"));

async function start() {
  await auth.authorize(); // valida SA (si falla, se cae aquí con mensaje claro)
  const me = await bot.telegram.getMe();
  console.log("Bot:", me.username);

  if (PUBLIC_URL && PUBLIC_URL.startsWith("http")) {
    // Webhook (recomendado en Render)
    const webhookPath = `/telegram/${TELEGRAM_BOT_TOKEN}`;
    const webhookUrl = `${PUBLIC_URL}${webhookPath}`;
    await bot.telegram.setWebhook(webhookUrl);
    app.use(bot.webhookCallback(webhookPath));
    console.log("Webhook:", webhookUrl);
  } else {
    // Long polling
    await bot.launch();
    console.log("Long polling activo");
  }

  app.listen(port, () => console.log("HTTP escuchando en puerto", port));
}

start().catch((err) => {
  console.error("FATAL START ERROR:", err?.message || err);
  process.exit(1);
});

// Para apagado prolijo
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

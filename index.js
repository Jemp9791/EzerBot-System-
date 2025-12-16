import express from "express";

/* =========================
   CONFIG GENERAL
========================= */
const BOT_TOKEN = process.env.BOT_TOKEN;
const CONFIG_URL =
  process.env.CONFIG_URL ||
  "https://jemp9791.github.io/ezerbot-config/config.json";

if (!BOT_TOKEN) {
  console.error("❌ Falta BOT_TOKEN");
  process.exit(1);
}

const PORT = process.env.PORT || 10000;
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

/* =========================
   HELPERS TELEGRAM
========================= */
async function tg(method, payload) {
  const r = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return r.json();
}

const sendMessage = (chat_id, text, opts = {}) =>
  tg("sendMessage", {
    chat_id,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...opts,
  });

/* =========================
   CACHE CONFIG
========================= */
let CACHE = { ts: 0, data: null };
const TTL = 30_000;

async function loadConfig(force = false) {
  if (!force && CACHE.data && Date.now() - CACHE.ts < TTL) return CACHE.data;
  const r = await fetch(CONFIG_URL, { cache: "no-store" });
  const j = await r.json();
  CACHE = { ts: Date.now(), data: j };
  return j;
}

/* =========================
   UTILIDADES
========================= */
const esc = (s) =>
  String(s || "").replace(/[<>&]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])
  );

const money = (n) =>
  Number(n || 0).toLocaleString("es-AR", { minimumFractionDigits: 0 });

const kb = (rows) => ({ inline_keyboard: rows });

const shareLinks = (text, url) => ({
  wa: `https://wa.me/?text=${encodeURIComponent(text + "\n" + url)}`,
  tg: `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`,
  mail: `mailto:?subject=Te%20comparto%20esto&body=${encodeURIComponent(
    text + "\n" + url
  )}`,
});

/* =========================
   ESTADO POR CHAT
========================= */
const CARTS = new Map();

const cart = (id) => {
  if (!CARTS.has(id)) CARTS.set(id, []);
  return CARTS.get(id);
};

const totalCart = (id) =>
  cart(id).reduce((s, i) => s + i.precio * i.cantidad, 0);

/* =========================
   MENÚ PRINCIPAL
========================= */
async function menu(chatId) {
  const cfg = await loadConfig();
  const t = cfg.textos || {};
  const n = cfg.negocio || {};

  return sendMessage(
    chatId,
    `<b>${esc(n.nombre || "Nuestro negocio")}</b>\n\n${esc(
      t.saludo ||
        "Hola 😊\nSoy tu asistente.\nElegí una opción del menú 👇"
    )}`,
    {
      reply_markup: kb([
        [
          { text: "🛍️ Ver catálogo", callback_data: "CAT" },
          { text: "🛒 Mi carrito", callback_data: "CART" },
        ],
        [{ text: "ℹ️ Información del local", callback_data: "INFO" }],
        [{ text: "💬 Hablar con el vendedor", callback_data: "VEND" }],
        [
          { text: "📣 Compartir promo", callback_data: "SHARE_PROMO" },
          { text: "📢 Compartir el bot", callback_data: "SHARE_BOT" },
        ],
      ]),
    }
  );
}

/* =========================
   CATÁLOGO
========================= */
async function showCategories(chatId) {
  const cfg = await loadConfig();
  const cats = [
    ...new Set((cfg.catalogo || []).map((p) => p.categoria)),
  ];

  return sendMessage(chatId, "Elegí una categoría 👇", {
    reply_markup: kb(
      cats.map((c) => [{ text: c, callback_data: `CAT_${c}` }]).concat([
        [{ text: "⬅️ Menú", callback_data: "MENU" }],
      ])
    ),
  });
}

async function showProducts(chatId, cat) {
  const cfg = await loadConfig();
  const items = cfg.catalogo.filter((p) => p.categoria === cat);

  let txt = `<b>${esc(cat)}</b>\n\n`;
  const rows = [];

  items.forEach((p) => {
    txt += `• ${esc(p.nombre)} — $${money(p.precio)}\n`;
    rows.push([
      { text: `➕ ${p.nombre}`, callback_data: `ADD_${p.codigo}` },
    ]);
  });

  rows.push([{ text: "🛒 Ver carrito", callback_data: "CART" }]);
  rows.push([{ text: "⬅️ Categorías", callback_data: "CAT" }]);

  return sendMessage(chatId, txt, { reply_markup: kb(rows) });
}

/* =========================
   CARRITO
========================= */
async function showCart(chatId) {
  const cfg = await loadConfig();
  const envio = cfg.envios?.zonas?.[0]?.costo || 0;
  const items = cart(chatId);

  if (!items.length)
    return sendMessage(chatId, "🛒 Tu carrito está vacío.", {
      reply_markup: kb([[{ text: "⬅️ Menú", callback_data: "MENU" }]]),
    });

  let txt = "🛒 <b>Tu pedido</b>\n\n";
  items.forEach(
    (i) =>
      (txt += `• ${esc(i.nombre)} x${i.cantidad} — $${money(
        i.precio * i.cantidad
      )}\n`)
  );

  txt += `\nSubtotal: $${money(totalCart(chatId))}`;
  txt += `\nEnvío: $${money(envio)}`;
  txt += `\n<b>Total: $${money(totalCart(chatId) + envio)}</b>`;

  return sendMessage(chatId, txt, {
    reply_markup: kb([
      [{ text: "✅ Finalizar compra", callback_data: "FINISH" }],
      [{ text: "⬅️ Menú", callback_data: "MENU" }],
    ]),
  });
}

/* =========================
   FINALIZAR COMPRA
========================= */
async function finish(chatId) {
  const cfg = await loadConfig();
  const n = cfg.negocio || {};
  const t = cfg.textos || {};
  const envio = cfg.envios?.zonas?.[0]?.costo || 0;
  const total = totalCart(chatId) + envio;

  const vendedor = cfg.vendedor?.whatsapp || n.telefono;

  await sendMessage(
    chatId,
    `✅ <b>Pedido recibido</b>\n\n${esc(
      t.postCompra ||
        "Gracias por tu compra 😊\nEstamos revisando el comprobante y preparando tu pedido."
    )}\n\n<b>Total:</b> $${money(total)}`
  );

  if (vendedor) {
    const link = `https://wa.me/${vendedor}?text=${encodeURIComponent(
      "Nuevo pedido recibido. Revisar comprobante."
    )}`;
    await sendMessage(chatId, "📲 Avisamos al vendedor.", {
      reply_markup: kb([[{ text: "Abrir WhatsApp vendedor", url: link }]]),
    });
  }

  CARTS.set(chatId, []);
}

/* =========================
   SERVER + WEBHOOK
========================= */
const app = express();
app.use(express.json());

app.post("/webhook", async (req, res) => {
  const u = req.body;

  if (u.message?.chat?.id) {
    await menu(u.message.chat.id);
  }

  if (u.callback_query) {
    const c = u.callback_query;
    const id = c.message.chat.id;
    const d = c.data;

    if (d === "MENU") menu(id);
    else if (d === "CAT") showCategories(id);
    else if (d.startsWith("CAT_")) showProducts(id, d.replace("CAT_", ""));
    else if (d.startsWith("ADD_")) {
      const cfg = await loadConfig();
      const p = cfg.catalogo.find((x) => x.codigo === d.replace("ADD_", ""));
      cart(id).push({ ...p, cantidad: 1 });
      showCart(id);
    } else if (d === "CART") showCart(id);
    else if (d === "FINISH") finish(id);
    else if (d === "INFO") {
      const n = (await loadConfig()).negocio;
      sendMessage(
        id,
        `<b>${esc(n.nombre)}</b>\n📍 ${esc(n.direccion)}\n🕒 ${esc(
          n.horarios
        )}`
      );
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, async () => {
  console.log("Bot activo");
  await tg("setWebhook", {
    url: `${process.env.RENDER_EXTERNAL_URL}/webhook`,
  });
});

import express from "express";
import TelegramBot from "node-telegram-bot-api";

// ===============================
// CONFIG (podés pasar a ENV después)
// ===============================
const TOKEN =
  process.env.TELEGRAM_TOKEN ||
  "8130447159:AAHxzp5S1lcgYOemw5dgF5V1DGh141dHmkA";

const BACKEND =
  process.env.BACKEND ||
  "https://script.google.com/macros/s/AKfycbxznmXVhDFd45kwrtsO0lORoGDn7AcHVdQIYQkgYy_63jaJCrjumzphVK_N39T_zjK_/exec";

const LOGO =
  process.env.LOGO ||
  "https://i.postimg.cc/q7WvjsYm/20251206-210311.jpg";

const URL_BASE =
  process.env.URL_BASE ||
  "https://ezerbot-system.onrender.com"; // tu URL de Render

const PORT = process.env.PORT || 10000;

// ===============================
// APP + BOT
// ===============================
const app = express();
app.use(express.json());

// ✅ No usamos "webHook: { port }" acá (eso te rompe Render muchas veces).
// ✅ Solo procesamos updates por express con /webhook
const bot = new TelegramBot(TOKEN);

// ===============================
// HELPERS
// ===============================
async function GAS(action, params = {}) {
  const url = new URL(BACKEND);
  url.searchParams.set("accion", action);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  // ✅ Node 22 ya trae fetch global (así evitamos node-fetch y errores de deploy)
  const r = await fetch(url.toString());
  const data = await r.json().catch(() => ({}));
  return data;
}

function safeText(x, fallback = "") {
  return (x ?? "").toString().trim() || fallback;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ===============================
// MENÚ PRINCIPAL (2 botones arriba en fila)
// ===============================
async function sendHome(chatId, firstName = "amiga") {
  const cfg = await GAS("config").catch(() => ({}));

  const negocio = safeText(cfg.NegocioNombre, "TODO QUESO CLUB");
  const slogan = safeText(cfg.Slogan, "Productos frescos, promos y beneficios exclusivos.");

  const caption =
`*${negocio}*
${slogan}

Hola ${firstName} 👋
Soy el asistente de *${negocio}*.
Desde acá podés ver el catálogo, armar tu pedido, sumar sellos y hablar con el vendedor.

👇 Elegí una opción para empezar`;

  const menu = {
    reply_markup: {
      inline_keyboard: [
        // ✅ 2 botones juntos como querés
        [
          { text: "🛍️ Catálogo", callback_data: "CATALOGO" },
          { text: "🛒 Mi carrito", callback_data: "CARRITO" }
        ],
        [
          { text: "🏆 Mis sellos", callback_data: "SELLOS" }
        ],
        [
          { text: "💬 Hablar con el vendedor", callback_data: "HABLAR" }
        ],
        [
          { text: "🏪 Información del local", callback_data: "INFO" },
          { text: "📣 Compartir el bot", callback_data: "COMPARTIR" }
        ]
      ]
    }
  };

  await bot.sendPhoto(chatId, LOGO, {
    caption,
    parse_mode: "Markdown",
    ...menu
  });
}

// ===============================
// START
// ===============================
bot.onText(/\/start|^hola$|^hola!$|buenas|buen día|buen dia/i, async (msg) => {
  try {
    const chatId = msg.chat.id;
    const nombre = msg.chat.first_name || "amiga";
    await sendHome(chatId, nombre);
  } catch (e) {
    console.error("start error:", e);
  }
});

// ===============================
// CALLBACKS
// ===============================
bot.on("callback_query", async (q) => {
  const chatId = q.message?.chat?.id;
  const data = q.data || "";

  try {
    // siempre respondemos el callback (evita “loading infinito”)
    await bot.answerCallbackQuery(q.id).catch(() => {});

    if (!chatId) return;

    if (data === "CATALOGO") return mostrarCategorias(chatId);
    if (data === "INFO") return infoLocal(chatId);
    if (data === "HABLAR") return hablarVendedor(chatId);
    if (data === "COMPARTIR") return compartirBot(chatId);
    if (data === "SELLOS") return mostrarSellos(chatId);
    if (data === "CARRITO") return bot.sendMessage(chatId, "🛒 Tu carrito está vacío por ahora.");

    // categorías
    if (data.startsWith("CAT_")) {
      const categoria = data.slice(4);
      return mostrarProductos(chatId, categoria, 0);
    }

    // paginado
    if (data.startsWith("PAGE_")) {
      const parts = data.split("_");
      const categoria = parts[1];
      const page = Number(parts[2] || 0);
      return mostrarProductos(chatId, categoria, page);
    }

    // comprar / share (por ahora solo sugerencia + guía)
    if (data.startsWith("BUY_")) {
      const code = data.slice(4);
      return bot.sendMessage(
        chatId,
        `✅ Listo. Agregué *${code}* al carrito.\n\n💡 Ya que estás… mirá también en *Catálogo* 👉 *Panificados / Dulces / Bebidas* (según lo que te combine).`,
        { parse_mode: "Markdown" }
      );
    }

    if (data.startsWith("SHARE_")) {
      const code = data.slice(6);
      return bot.sendMessage(
        chatId,
        `📣 Pasale esta promo a alguien:\n\n👉 ${safeText(URL_BASE)}/promo/${encodeURIComponent(code)}\n\n(Después lo dejamos más lindo para WhatsApp/IG)`,
      );
    }

  } catch (e) {
    console.error("callback error:", e);
    if (chatId) bot.sendMessage(chatId, "⚠️ Uy, algo falló. Probá de nuevo en un ratito.");
  }
});

// ===============================
// INFO LOCAL
// ===============================
async function infoLocal(chatId) {
  const cfg = await GAS("config").catch(() => ({}));
  const negocio = safeText(cfg.NegocioNombre, "TODO QUESO CLUB");

  const msg =
`🏪 *${negocio}*
📍 Dirección: ${safeText(cfg.Dirección, "Dirección no configurada")}
🕒 Horarios: ${safeText(cfg.Horarios, "Horarios no configurados")}
📞 Teléfono: ${safeText(cfg.TeléfonoNegocio, "No configurado")}
📸 Instagram: ${safeText(cfg.Instagram, "No configurado")}

Gracias por elegir productos frescos y de calidad 💛`;

  await bot.sendPhoto(chatId, LOGO, { caption: msg, parse_mode: "Markdown" });
}

// ===============================
// HABLAR VENDEDOR
// ===============================
async function hablarVendedor(chatId) {
  const cfg = await GAS("config").catch(() => ({}));
  const w = safeText(cfg.WhatsAppLink, "https://wa.me/5493484230184");

  await bot.sendMessage(chatId,
`💬 *Te atiende una persona real*
Escribinos por WhatsApp y te respondemos al toque 👇`,
{
  parse_mode: "Markdown",
  reply_markup: { inline_keyboard: [[{ text: "📞 Abrir WhatsApp", url: w }]] }
});
}

// ===============================
// COMPARTIR BOT
// ===============================
async function compartirBot(chatId) {
  const share = `https://t.me/Ezer_IA_Bot`;

  await bot.sendMessage(chatId,
`📣 *Compartí este bot*
Así tus contactos también ven promos y suman sellos.

👉 Link del bot: ${share}`,
{ parse_mode: "Markdown" });
}

// ===============================
// CATEGORÍAS (desde hoja Catalogo)
// ===============================
async function mostrarCategorias(chatId) {
  const r = await GAS("catalogo").catch(() => ({}));
  const items = Array.isArray(r.items) ? r.items : [];

  if (items.length === 0) {
    return bot.sendMessage(chatId, "⚠️ No pude leer *Catalogo*. Revisá que el GAS esté devolviendo `items`.", { parse_mode: "Markdown" });
  }

  const cats = [...new Set(items.map(i => safeText(i.categoria, "General")))];
  // botones 2 por fila (más prolijo en celu)
  const rows = chunkArray(
    cats.map(c => ({ text: `📦 ${c}`, callback_data: "CAT_" + c })),
    2
  );

  await bot.sendMessage(chatId, "🛍️ *Elegí una categoría:*", {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: rows }
  });
}

// ===============================
// PRODUCTOS (3 por página)
// ===============================
async function mostrarProductos(chatId, categoria, page = 0) {
  const r = await GAS("catalogo").catch(() => ({}));
  const all = Array.isArray(r.items) ? r.items : [];

  const items = all.filter(p => safeText(p.categoria, "General") === categoria);

  const porPagina = 3;
  const inicio = page * porPagina;
  const lista = items.slice(inicio, inicio + porPagina);

  if (lista.length === 0) {
    return bot.sendMessage(chatId, "No hay productos en esta categoría.");
  }

  for (const p of lista) {
    const nombre = safeText(p.nombre, "Producto");
    const desc = safeText(p.descripcion, "");
    const precio = safeText(p.precio, "-");
    const codigo = safeText(p.codigo, "SIN-CODIGO");
    const img = safeText(p.imagenUrl, LOGO);

    await bot.sendPhoto(chatId, img, {
      caption:
`*${nombre}*
${desc ? desc + "\n" : ""}💲 ${precio} ARS
🆔 Código: *${codigo}*`,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🛒 Comprar", callback_data: "BUY_" + codigo },
            { text: "📣 Compartir", callback_data: "SHARE_" + codigo }
          ]
        ]
      }
    });
  }

  const nav = [];
  if (inicio > 0) nav.push({ text: "⬅️ Anterior", callback_data: `PAGE_${categoria}_${page - 1}` });
  if (inicio + porPagina < items.length) nav.push({ text: "Siguiente ➡️", callback_data: `PAGE_${categoria}_${page + 1}` });

  if (nav.length) {
    await bot.sendMessage(chatId, "📄 Página:", {
      reply_markup: { inline_keyboard: [nav] }
    });
  }
}

// ===============================
// SELLOS
// ===============================
async function mostrarSellos(chatId) {
  const r = await GAS("estadoCliente", { chatId }).catch(() => ({}));

  if (!r || !r.tieneTarjeta) {
    return bot.sendMessage(chatId, "Este comercio todavía no activó el sistema de sellos.");
  }

  const total = safeText(r.sellosTotalesAcumulados, "0");
  const nivel = safeText(r.nivelActual, "-");

  await bot.sendPhoto(chatId, safeText(r.tarjetaImagenUrl, LOGO), {
    caption: `🏆 *Tus sellos:* ${total}\n⭐ Nivel: ${nivel}`,
    parse_mode: "Markdown"
  });
}

// ===============================
// WEBHOOK + DEBUG (LO QUE TE FALTABA)
// ===============================
app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get("/debug", async (req, res) => {
  try {
    const me = await bot.getMe();
    const info = await bot.getWebHookInfo();
    res.json({
      ok: true,
      now: new Date().toISOString(),
      bot_me: me,
      webhookInfo: info
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// fuerza re-set del webhook desde navegador
app.get("/setWebhook", async (req, res) => {
  try {
    const url = `${URL_BASE}/webhook`;
    await bot.setWebHook(url);
    const info = await bot.getWebHookInfo();
    res.json({ ok: true, setTo: url, webhookInfo: info });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.get("/", (_, res) => res.send({ ok: true, msg: "EzerBot corriendo" }));

app.listen(PORT, async () => {
  console.log("Servidor activo en puerto", PORT);

  // seteamos webhook al levantar (clave en Render)
  try {
    const url = `${URL_BASE}/webhook`;
    await bot.setWebHook(url);
    console.log("Webhook seteado:", url);
  } catch (e) {
    console.log("No pude setear webhook:", e?.message || e);
  }
});

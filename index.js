import express from "express";
import TelegramBot from "node-telegram-bot-api";

const TOKEN = "8130447159:AAHxzp5S1lcgYOemw5dgF5V1DGh141dHmkA";
const BACKEND =
  "https://script.google.com/macros/s/AKfycbxznmXVhDFd45kwrtsO0lORoGDn7AcHVdQIYQkgYy_63jaJCrjumzphVK_N39T_zjK_/exec";

const URL_BASE = "https://ezerbot-system.onrender.com"; // tu render URL
const LOGO = "https://i.postimg.cc/q7WvjsYm/20251206-210311.jpg";

const PORT = process.env.PORT || 10000;

const app = express();
app.use(express.json({ limit: "2mb" }));

// ✅ IMPORTANTE: NO abrir puerto desde TelegramBot.
// El único puerto lo abre Express (Render).
const bot = new TelegramBot(TOKEN);

// Webhook hacia tu Render
bot.setWebHook(`${URL_BASE}/webhook`).then(() => {
  console.log("✅ Webhook seteado:", `${URL_BASE}/webhook`);
}).catch((e) => {
  console.log("❌ Error seteando webhook:", e?.message || e);
});

// ===============================
// Helpers
// ===============================
function escHTML(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function GAS(action, params = {}) {
  const url = new URL(BACKEND);
  url.searchParams.set("accion", action);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const r = await fetch(url.toString(), { method: "GET" });
  return r.json();
}

function mainMenu() {
  // ✅ 2 columnas en la primera fila (como pediste)
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🛍️ Catálogo", callback_data: "CATALOGO" },
          { text: "🛒 Mi carrito", callback_data: "CARRITO" },
        ],
        [{ text: "🎁 Mis sellos", callback_data: "SELLOS" }],
        [{ text: "💬 Hablar con el vendedor", callback_data: "HABLAR" }],
        [
          { text: "🏪 Información del local", callback_data: "INFO" },
          { text: "📣 Compartir el bot", callback_data: "COMPARTIR" },
        ],
      ],
    },
  };
}

// ===============================
// START / SALUDO
// ===============================
bot.onText(/\/start|hola|hola!|buenas/i, async (msg) => {
  const chatId = msg.chat.id;
  const nombre = msg.chat.first_name || "amigo";

  let cfg = {};
  try { cfg = await GAS("config"); } catch {}
  const negocio = cfg?.NegocioNombre || "TODO QUESO CLUB";

  const caption =
    `<b>${escHTML(negocio)}</b>\n` +
    `Productos frescos, promos y beneficios exclusivos.\n\n` +
    `Hola <b>${escHTML(nombre)}</b> 👋\n` +
    `Soy el asistente de <b>${escHTML(negocio)}</b>.\n` +
    `Desde acá podés ver el catálogo, armar tu pedido y hablar con nosotros.\n\n` +
    `👇 Elegí una opción para empezar`;

  try {
    await bot.sendPhoto(chatId, LOGO, { caption, parse_mode: "HTML" });
  } catch {
    await bot.sendMessage(chatId, caption, { parse_mode: "HTML" });
  }

  await bot.sendMessage(chatId, " ", mainMenu());
});

// ===============================
// Webhook endpoint (Telegram pega acá)
// ===============================
app.post("/webhook", (req, res) => {
  try {
    bot.processUpdate(req.body);
  } catch (e) {
    console.log("❌ processUpdate error:", e?.message || e);
  }
  res.sendStatus(200);
});

app.get("/", (_, res) => res.json({ ok: true, msg: "EzerBot backend activo" }));

// ===============================
// BOTONES
// ===============================
bot.on("callback_query", async (q) => {
  const chatId = q.message?.chat?.id;
  const data = q.data || "";

  // Saca el “relojito” del botón
  try { await bot.answerCallbackQuery(q.id); } catch {}

  if (!chatId) return;

  if (data === "INFO") return infoLocal(chatId);
  if (data === "CATALOGO") return mostrarCategorias(chatId);
  if (data === "COMPARTIR") return compartirBot(chatId);
  if (data === "SELLOS") return mostrarSellos(chatId);
  if (data === "HABLAR") return hablarVendedor(chatId);
  if (data === "CARRITO") return bot.sendMessage(chatId, "🛒 Carrito: (lo conectamos después sin romper lo que anda).");

  if (data.startsWith("CAT_")) {
    const categoria = data.slice(4);
    return mostrarProductos(chatId, categoria, 0);
  }

  if (data.startsWith("PAGE_")) {
    const parts = data.split("_");
    const categoria = parts[1];
    const page = Number(parts[2] || "0");
    return mostrarProductos(chatId, categoria, page);
  }
});

// ===============================
// INFO LOCAL
// ===============================
async function infoLocal(chatId) {
  let cfg = {};
  try { cfg = await GAS("config"); } catch {}

  const negocio = cfg?.NegocioNombre || "Tu tienda";
  const dir = cfg?.Dirección || "Dirección no configurada";
  const horarios = cfg?.Horarios || "Horarios no configurados";
  const tel = cfg?.TeléfonoNegocio || "Teléfono no configurado";
  const ig = cfg?.Instagram || "";

  const msg =
    `<b>${escHTML(negocio)}</b>\n` +
    `📍 ${escHTML(dir)}\n` +
    `🕒 ${escHTML(horarios)}\n` +
    `📞 ${escHTML(tel)}\n` +
    (ig ? `📸 Instagram: ${escHTML(ig)}\n` : "") +
    `\nGracias por elegir productos frescos y de calidad 💛`;

  try {
    await bot.sendPhoto(chatId, LOGO, { caption: msg, parse_mode: "HTML" });
  } catch {
    await bot.sendMessage(chatId, msg, { parse_mode: "HTML" });
  }
}

// ===============================
// HABLAR CON VENDEDOR
// ===============================
async function hablarVendedor(chatId) {
  let cfg = {};
  try { cfg = await GAS("config"); } catch {}

  const w = cfg?.WhatsAppLink || "https://wa.me/5491122538102";
  const negocio = cfg?.NegocioNombre || "Todo Queso";

  await bot.sendMessage(
    chatId,
    `💬 <b>${escHTML(negocio)}</b>\nEscribinos por WhatsApp y te atendemos como si estuvieras en el mostrador 😉`,
    {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "📲 Abrir WhatsApp", url: w }]] },
    }
  );
}

// ===============================
// COMPARTIR BOT
// ===============================
async function compartirBot(chatId) {
  let cfg = {};
  try { cfg = await GAS("config"); } catch {}

  const activo = String(cfg?.CompartirBotActivo || "true").toLowerCase() !== "false";
  if (!activo) return bot.sendMessage(chatId, "📣 Compartir está desactivado por el comercio.");

  const texto = cfg?.TextoCompartirBot ||
    `📣 Compartí este bot con tus contactos para que aprovechen promos y beneficios.\n\n👉 Entrá al bot: ${URL_BASE}`;

  // Ojo: Telegram no permite “compartir a whatsapp” directo desde el bot.
  // Lo correcto es dar texto + link para copiar/pegar.
  await bot.sendMessage(chatId, escHTML(texto), { parse_mode: "HTML" });
}

// ===============================
// CATEGORÍAS / CATÁLOGO
// ===============================
async function mostrarCategorias(chatId) {
  const r = await GAS("catalogo");
  const items = r.items || r.productos || [];

  const cats = [...new Set(items.map(p => (p.categoria || p.category || "General")))];
  const botones = cats.map(c => [{ text: `📦 ${c}`, callback_data: `CAT_${c}` }]);

  await bot.sendMessage(chatId, "📂 <b>Elegí una categoría:</b>", {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: botones.length ? botones : [[{ text: "📦 General", callback_data: "CAT_General" }]] }
  });
}

async function mostrarProductos(chatId, categoria, page = 0) {
  const r = await GAS("catalogo");
  const all = r.items || r.productos || [];

  const items = all.filter(p => (p.categoria || p.category || "General") === categoria);

  const porPagina = 3;
  const inicio = page * porPagina;
  const lista = items.slice(inicio, inicio + porPagina);

  if (!lista.length) {
    return bot.sendMessage(chatId, "No hay productos en esta categoría.");
  }

  for (const p of lista) {
    const nombre = p.nombre || p.name || "Producto";
    const desc = p.descripcion || p.description || "";
    const codigo = p.codigo || p.code || "SIN-CODIGO";
    const precio = p.precio || p.price || "";
    const img = p.imagenUrl || p.imagen || p.image || LOGO;

    const caption =
      `<b>${escHTML(nombre)}</b>\n` +
      (desc ? `${escHTML(desc)}\n\n` : "\n") +
      (precio ? `💲 <b>${escHTML(precio)}</b>\n` : "") +
      `🆔 Código: <b>${escHTML(codigo)}</b>`;

    try {
      await bot.sendPhoto(chatId, img, {
        caption,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🛒 Agregar al carrito", callback_data: `BUY_${codigo}` }],
            [{ text: "📣 Compartir promo", callback_data: `SHARE_${codigo}` }],
          ],
        },
      });
    } catch {
      await bot.sendMessage(chatId, caption, { parse_mode: "HTML" });
    }
  }

  const nav = [];
  if (inicio > 0) nav.push({ text: "⬅️ Anterior", callback_data: `PAGE_${categoria}_${page - 1}` });
  if (inicio + porPagina < items.length) nav.push({ text: "Siguiente ➡️", callback_data: `PAGE_${categoria}_${page + 1}` });

  if (nav.length) {
    await bot.sendMessage(chatId, "📌 Navegación:", { reply_markup: { inline_keyboard: [nav] } });
  }
}

// ===============================
// SELLOS
// ===============================
async function mostrarSellos(chatId) {
  const r = await GAS("estadoCliente", { chatId });

  if (!r?.tieneTarjeta) {
    return bot.sendMessage(chatId, "Este comercio todavía no activó el sistema de sellos.");
  }

  const sellos = r.sellosTotalesAcumulados ?? 0;
  const nivel = r.nivelActual ?? "—";
  const img = r.tarjetaImagenUrl || LOGO;

  await bot.sendPhoto(chatId, img, {
    caption: `🎉 <b>Tus sellos:</b> ${escHTML(sellos)}\n🏅 <b>Nivel:</b> ${escHTML(nivel)}`,
    parse_mode: "HTML",
  });
}

// ===============================
// LISTEN
// ===============================
app.listen(PORT, () => {
  console.log("✅ Servidor activo en puerto", PORT);
});

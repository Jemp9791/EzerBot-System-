import express from "express";
import TelegramBot from "node-telegram-bot-api";

const TOKEN = "8130447159:AAHxzp5S1lcgYOemw5dgF5V1DGh141dHmkA";
const BACKEND = "https://script.google.com/macros/s/AKfycbxznmXVhDFd45kwrtsO0lORoGDn7AcHVdQIYQkgYy_63jaJCrjumzphVK_N39T_zjK_/exec";
const BASE_URL = "https://ezerbot-system.onrender.com";
const PORT = process.env.PORT || 10000;

const app = express();
app.use(express.json());

const bot = new TelegramBot(TOKEN, { webHook: true });
bot.setWebHook(`${BASE_URL}/webhook`);

/* =========================
   UTILIDAD GAS
========================= */
async function GAS(accion, params = {}) {
  try {
    const url = new URL(BACKEND);
    url.searchParams.set("accion", accion);
    Object.entries(params).forEach(([k, v]) =>
      url.searchParams.set(k, v)
    );
    const res = await fetch(url);
    return await res.json();
  } catch (e) {
    console.error("GAS error:", e);
    return null;
  }
}

/* =========================
   MENÚ PRINCIPAL
========================= */
function menuPrincipal() {
  return {
    inline_keyboard: [
      [
        { text: "🛍️ Catálogo", callback_data: "CATALOGO" },
        { text: "🛒 Mi carrito", callback_data: "CARRITO" }
      ],
      [{ text: "🏆 Mis sellos", callback_data: "SELLOS" }],
      [{ text: "💬 Hablar con el vendedor", callback_data: "HABLAR" }],
      [
        { text: "ℹ️ Info del local", callback_data: "INFO" },
        { text: "📣 Compartir bot", callback_data: "COMPARTIR" }
      ]
    ]
  };
}

/* =========================
   START
========================= */
bot.onText(/\/start|hola|menu/i, async (msg) => {
  const chatId = msg.chat.id;
  const nombre = msg.chat.first_name || "amigo";

  await bot.sendMessage(
    chatId,
`Hola ${nombre} 👋  
Soy el asistente de **TODO QUESO CLUB 🧀**

Desde acá podés:
• Ver el catálogo
• Armar tu pedido
• Sumar sellos
• Hablar con nosotros

👇 Elegí una opción`,
    {
      parse_mode: "Markdown",
      reply_markup: menuPrincipal()
    }
  );
});

/* =========================
   CALLBACKS
========================= */
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const data = q.data;

  if (data === "MENU") {
    return bot.sendMessage(chatId, "📋 Menú principal:", {
      reply_markup: menuPrincipal()
    });
  }

  if (data === "CATALOGO") return mostrarCategorias(chatId);
  if (data === "INFO") return infoLocal(chatId);
  if (data === "HABLAR") return hablarVendedor(chatId);
  if (data === "COMPARTIR") return compartirBot(chatId);

  if (data.startsWith("CAT_")) {
    return mostrarProductos(chatId, data.replace("CAT_", ""), 0);
  }

  if (data.startsWith("PAGE_")) {
    const [, cat, page] = data.split("_");
    return mostrarProductos(chatId, cat, Number(page));
  }
});

/* =========================
   INFO LOCAL
========================= */
async function infoLocal(chatId) {
  const cfg = await GAS("config") || {};
  await bot.sendMessage(
    chatId,
`🏪 *${cfg.NegocioNombre || "Todo Queso"}*
📍 ${cfg.Dirección || "-"}
🕒 ${cfg.Horarios || "-"}
📞 ${cfg.TeléfonoNegocio || "-"}`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[{ text: "⬅️ Volver", callback_data: "MENU" }]]
      }
    }
  );
}

/* =========================
   HABLAR
========================= */
async function hablarVendedor(chatId) {
  const cfg = await GAS("config") || {};
  const link = cfg.WhatsAppLink || "https://wa.me/5490000000000";

  await bot.sendMessage(
    chatId,
`💬 *Estamos acá para ayudarte*
Hablá con nosotros por WhatsApp`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📞 Abrir WhatsApp", url: link }],
          [{ text: "⬅️ Volver", callback_data: "MENU" }]
        ]
      }
    }
  );
}

/* =========================
   COMPARTIR
========================= */
async function compartirBot(chatId) {
  await bot.sendMessage(
    chatId,
`📣 *Compartí Todo Queso Club*
Invitá a tus contactos y sumá beneficios`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔗 Abrir bot", url: "https://t.me/EzerBot" }],
          [{ text: "⬅️ Volver", callback_data: "MENU" }]
        ]
      }
    }
  );
}

/* =========================
   CATEGORÍAS
========================= */
async function mostrarCategorias(chatId) {
  const r = await GAS("catalogo");

  if (!r || !Array.isArray(r.items)) {
    return bot.sendMessage(chatId, "⚠️ No pude leer el catálogo.", {
      reply_markup: { inline_keyboard: [[{ text: "⬅️ Volver", callback_data: "MENU" }]] }
    });
  }

  const categorias = [...new Set(r.items.map(i => i.categoria || "General"))];

  const botones = categorias.map(c => [{ text: `📦 ${c}`, callback_data: `CAT_${c}` }]);
  botones.push([{ text: "⬅️ Volver", callback_data: "MENU" }]);

  await bot.sendMessage(chatId, "📂 Elegí una categoría:", {
    reply_markup: { inline_keyboard: botones }
  });
}

/* =========================
   PRODUCTOS (3 POR PÁGINA)
========================= */
async function mostrarProductos(chatId, categoria, page) {
  const r = await GAS("catalogo");
  if (!r || !Array.isArray(r.items)) return;

  const productos = r.items.filter(p => (p.categoria || "General") === categoria);

  const porPagina = 3;
  const inicio = page * porPagina;
  const slice = productos.slice(inicio, inicio + porPagina);

  for (const p of slice) {
    await bot.sendPhoto(chatId, p.imagenUrl || "", {
      caption:
`*${p.nombre}*
${p.descripcion || ""}
💲 ${p.precio} ARS`,
      parse_mode: "Markdown"
    });
  }

  const nav = [];
  if (inicio > 0) nav.push({ text: "⬅️ Anterior", callback_data: `PAGE_${categoria}_${page - 1}` });
  if (inicio + porPagina < productos.length)
    nav.push({ text: "Siguiente ➡️", callback_data: `PAGE_${categoria}_${page + 1}` });

  nav.push({ text: "⬅️ Categorías", callback_data: "CATALOGO" });

  await bot.sendMessage(chatId, "Navegación:", {
    reply_markup: { inline_keyboard: [nav] }
  });
}

/* =========================
   EXPRESS
========================= */
app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (_, res) => res.send("EzerBot activo"));

app.listen(PORT, () => {
  console.log("Servidor activo en puerto", PORT);
});

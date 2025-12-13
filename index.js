import TelegramBot from "node-telegram-bot-api";

// ================= CONFIG =================
const TOKEN = process.env.BOT_TOKEN;
const GAS_URL = process.env.GAS_URL;

if (!TOKEN || !GAS_URL) {
  throw new Error("Faltan BOT_TOKEN o GAS_URL en ENV");
}

const bot = new TelegramBot(TOKEN, { polling: true });

// ================= ESTADO SIMPLE =================
const userState = {}; 
// userState[chatId] = { categoria, index, productos }

// ================= HELPERS =================
async function getCatalogo() {
  const res = await fetch(GAS_URL);
  const data = await res.json();
  if (!data.ok || !Array.isArray(data.productos)) return [];
  return data.productos;
}

function categoriasDesde(productos) {
  return [...new Set(productos.map(p => p.categoria))];
}

function botonesCategorias(categorias) {
  return {
    reply_markup: {
      inline_keyboard: categorias.map(c => [{ text: c, callback_data: `cat:${c}` }])
    }
  };
}

function botonesProducto() {
  return {
    inline_keyboard: [
      [
        { text: "✅ Quiero este", callback_data: "quiero" },
        { text: "📣 Compartir promo", callback_data: "compartir" }
      ],
      [
        { text: "⬅️ Anterior", callback_data: "prev" },
        { text: "➡️ Siguiente", callback_data: "next" }
      ],
      [
        { text: "📂 Volver a categoría", callback_data: "volver_cat" }
      ]
    ]
  };
}

function textoProducto(p) {
  return `
${p.nombre}
${p.descripcion || ""}

💰 $ ${p.precio} ARS
🆔 ${p.codigo}
`.trim();
}

// ================= FLUJOS =================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const productos = await getCatalogo();

  if (!productos.length) {
    bot.sendMessage(chatId, "⚠️ No hay productos cargados.");
    return;
  }

  userState[chatId] = { productos };

  const categorias = categoriasDesde(productos);
  bot.sendMessage(
    chatId,
    "📂 Elegí una categoría:",
    botonesCategorias(categorias)
  );
});

bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const data = q.data;

  const state = userState[chatId];
  if (!state) return;

  // ====== CATEGORÍA ======
  if (data.startsWith("cat:")) {
    const categoria = data.split(":")[1];
    const lista = state.productos.filter(p => p.categoria === categoria);

    state.categoria = categoria;
    state.lista = lista;
    state.index = 0;

    const p = lista[0];

    bot.sendPhoto(
      chatId,
      p.imagen,
      {
        caption: textoProducto(p),
        reply_markup: botonesProducto(),
      }
    );
  }

  // ====== NAVEGACIÓN ======
  if (data === "next" || data === "prev") {
    let i = state.index;
    if (data === "next" && i < state.lista.length - 1) i++;
    if (data === "prev" && i > 0) i--;

    state.index = i;
    const p = state.lista[i];

    bot.sendPhoto(
      chatId,
      p.imagen,
      {
        caption: textoProducto(p),
        reply_markup: botonesProducto(),
      }
    );
  }

  // ====== VOLVER ======
  if (data === "volver_cat") {
    const categorias = categoriasDesde(state.productos);
    bot.sendMessage(
      chatId,
      "📂 Elegí una categoría:",
      botonesCategorias(categorias)
    );
  }

  // ====== QUIERO ESTE ======
  if (data === "quiero") {
    const p = state.lista[state.index];
    bot.sendMessage(
      chatId,
      `🧀 Agregamos:\n${p.nombre}\n\n👉 Próximo paso: ¿cuántos kg o gramos?`
    );
  }

  // ====== COMPARTIR ======
  if (data === "compartir") {
    const p = state.lista[state.index];
    const texto = `🔥 ${p.nombre}\n💰 $${p.precio}\n🧀 Todo Queso Club`;
    bot.sendMessage(chatId, texto);
  }

  bot.answerCallbackQuery(q.id);
}); 

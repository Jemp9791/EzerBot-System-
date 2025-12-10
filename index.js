// --------------------------------------------------------------
// EZERBOT IA – SISTEMA CLIENTE TODO QUESO
// Catálogo por categorías + carrito + compartir + envío/retiro
// --------------------------------------------------------------

import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// =====================
// CONFIG (DATOS TUYOS)
// =====================

const BOT_TOKEN = "8130447159:AAHxzp5S1lcgYOemw5dgF5V1DGh141dHmkA";
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Tu Apps Script (debe devolver JSON con items)
const SHEETS_URL = "https://script.google.com/macros/s/AKfycbyxm5E2Y7t0hgqh48-AVWpiru2MBXM3E-53T5WgnljMZb_CXZx-F-akgIJVJ4j76MjE/exec";

// Logo de Todo Queso
const LOGO_URL = "https://i.postimg.cc/q7WvjsYm/20251206-210311.jpg";

// WhatsApp del vendedor (por ahora el tuyo)
const WHATSAPP_VENDEDOR = "5493484230184";

// Íconos por categoría (se eligen por palabra clave)
const CATEGORY_ICONS = {
  "queso": "🧀",
  "fiambre": "🥓",
  "pan": "🍞",
  "lácteo": "🥛",
  "leche": "🥛",
  "bebida": "🥤",
  "promo": "🔥",
  "dulce": "🍬",
  "torta": "🍰",
  "default": "📦"
};

// Carrito en memoria por chatId
const carts = {};

// =====================
// UTILIDADES
// =====================

async function sendMessage(chatId, text, keyboard = null) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML"
  };
  if (keyboard) payload.reply_markup = keyboard;
  return axios.post(`${API}/sendMessage`, payload);
}

async function sendPhoto(chatId, photoUrl, caption, keyboard = null) {
  const payload = {
    chat_id: chatId,
    photo: photoUrl,
    caption,
    parse_mode: "HTML"
  };
  if (keyboard) payload.reply_markup = keyboard;
  return axios.post(`${API}/sendPhoto`, payload);
}

function iconForCategory(cat = "") {
  const lc = cat.toLowerCase();
  for (const key of Object.keys(CATEGORY_ICONS)) {
    if (lc.includes(key)) return CATEGORY_ICONS[key];
  }
  return CATEGORY_ICONS.default;
}

// =====================
// LEER CATÁLOGO DE SHEETS
// =====================

async function fetchCatalog() {
  try {
    const res = await axios.get(SHEETS_URL);
    // Esperamos algo tipo: { items: [ {CODIGO, NOMBRE,...} ] }
    if (!res.data || !res.data.items) return [];
    return res.data.items.map((i) => ({
      codigo: i.CODIGO || "",
      nombre: i.NOMBRE || "",
      precio: Number(i.PRECIO || 0),
      unidad: i.UNIDAD || "",
      desc: i.DESCRIPCION || "",
      imagen: i.IMAGEN || "",
      categoria: i.CATEGORIA || "General"
    }));
  } catch (err) {
    console.error("ERROR leyendo catálogo:", err.toString());
    return [];
  }
}

// =====================
// MENÚ Y BIENVENIDA
// =====================

function mainMenu() {
  return {
    keyboard: [
      [{ text: "🛍 Catálogo" }],
      [{ text: "🛒 Mi carrito" }],
      [{ text: "🏆 Mis sellos" }],
      [{ text: "💬 Hablar con el vendedor" }],
      [{ text: "🏪 Información del local" }],
      [{ text: "📢 Compartir el bot" }]
    ],
    resize_keyboard: true
  };
}

async function sendWelcome(chatId) {
  await sendPhoto(
    chatId,
    LOGO_URL,
    "<b>¡Bienvenido/a a TODO QUESO CLUB! 🧀</b>\n" +
      "Encontrá promos, sumá sellos y canjeá beneficios.\n\n" +
      "Elegí una opción del menú de abajo 👇",
    mainMenu()
  );
}

// =====================
// CATÁLOGO POR CATEGORÍAS
// =====================

async function showCategories(chatId) {
  const items = await fetchCatalog();
  if (!items || items.length === 0) {
    return sendMessage(chatId, "El catálogo todavía no tiene productos cargados.", mainMenu());
  }

  const categoriasSet = new Set();
  for (const it of items) {
    if (it.categoria && String(it.categoria).trim() !== "") {
      categoriasSet.add(String(it.categoria).trim());
    } else {
      categoriasSet.add("Otros");
    }
  }

  const categorias = Array.from(categoriasSet).sort((a, b) => a.localeCompare(b));
  const inline_keyboard = categorias.map((c) => [
    {
      text: `${iconForCategory(c)} ${c}`,
      callback_data: `cat_${c}`
    }
  ]);

  await sendMessage(chatId, "<b>Elegí una categoría:</b>", {
    inline_keyboard
  });
}

// Mostrar productos de una categoría (uno debajo del otro)
async function showProductsOfCategory(chatId, category) {
  const items = await fetchCatalog();
  const filtered = items.filter((i) => (i.categoria || "Otros") === category);

  if (filtered.length === 0) {
    return sendMessage(chatId, "No hay productos en esta categoría.", mainMenu());
  }

  for (const p of filtered) {
    const caption =
      `<b>${p.nombre}</b>\n` +
      `Código: <code>${p.codigo}</code>\n` +
      `Precio: $${p.precio}\n` +
      (p.desc ? `${p.desc}\n` : "");

    const keyboard = {
      inline_keyboard: [
        [
          {
            text: "🛍 Comprar",
            callback_data: `buy_${p.codigo}`
          }
        ],
        [
          {
            text: "🔁 Compartir promo",
            callback_data: `share_${p.codigo}`
          }
        ]
      ]
    };

    await sendPhoto(chatId, p.imagen, caption, keyboard);
  }

  await sendMessage(chatId, "¿Querés volver a elegir categoría o ver tu carrito?", {
    inline_keyboard: [
      [{ text: "⬅️ Volver a categorías", callback_data: "volver_categorias" }],
      [{ text: "🛒 Ver carrito", callback_data: "ver_carrito" }]
    ]
  });
}

// =====================
// COMPRA Y CARRITO
// =====================

async function startBuy(chatId, codigo) {
  const items = await fetchCatalog();
  const item = items.find((i) => i.codigo === codigo);
  if (!item) {
    return sendMessage(chatId, "No encontré ese producto en el catálogo.");
  }

  if (!carts[chatId]) carts[chatId] = { items: [], pending: null };
  carts[chatId].pending = item;

  const msg =
    `Vas a comprar <b>${item.nombre}</b> (código <code>${item.codigo}</code>).\n\n` +
    "Indicá la cantidad:\n" +
    "• Si es por unidad → escribí 1, 2, 3…\n" +
    "• Si es por kilo → escribí los gramos (mínimo 100g).";

  await sendMessage(chatId, msg, mainMenu());
}

async function handleQuantity(chatId, text) {
  const cart = carts[chatId];
  if (!cart || !cart.pending) return;

  const item = cart.pending;
  const qty = Number(text.replace(",", "."));

  if (!qty || qty <= 0) {
    return sendMessage(chatId, "Por favor ingresá un número válido de unidades o gramos.");
  }

  let subtotal;
  if (item.unidad && item.unidad.toLowerCase() === "unidad") {
    subtotal = item.precio * qty;
  } else {
    // Se interpreta como gramos
    if (qty < 100) {
      return sendMessage(chatId, "El mínimo son 100 gramos. Ingresá un valor mayor o igual a 100.");
    }
    subtotal = (item.precio * qty) / 1000;
  }

  if (!cart.items) cart.items = [];
  cart.items.push({
    ...item,
    qty,
    subtotal
  });

  cart.pending = null;

  const msg =
    `🧺 <b>Producto agregado</b>\n` +
    `${item.nombre}\n` +
    `Cantidad: ${qty} ${item.unidad === "unidad" ? "unid." : "g"}\n` +
    `Subtotal: $${subtotal}\n\n` +
    "¿Querés seguir comprando o finalizar tu pedido?";

  await sendMessage(chatId, msg, {
    inline_keyboard: [
      [{ text: "🛍 Seguir comprando", callback_data: "catalogo" }],
      [{ text: "🛒 Ver carrito", callback_data: "ver_carrito" }],
      [{ text: "💸 Finalizar compra", callback_data: "checkout" }]
    ]
  });
}

async function showCart(chatId) {
  const cart = carts[chatId];
  if (!cart || !cart.items || cart.items.length === 0) {
    return sendMessage(chatId, "Tu carrito está vacío por ahora.", mainMenu());
  }

  let total = 0;
  let texto = "<b>🛒 Tu carrito:</b>\n\n";
  for (const p of cart.items) {
    total += p.subtotal;
    texto += `• ${p.nombre} x ${p.qty} → $${p.subtotal}\n`;
  }
  texto += `\n<b>Total: $${total}</b>`;

  await sendMessage(chatId, texto, {
    inline_keyboard: [
      [{ text: "💸 Finalizar compra", callback_data: "checkout" }],
      [{ text: "🗑 Vaciar carrito", callback_data: "clearcart" }],
      [{ text: "🛍 Seguir comprando", callback_data: "catalogo" }]
    ]
  });
}

async function checkout(chatId) {
  const cart = carts[chatId];
  if (!cart || !cart.items || cart.items.length === 0) {
    return sendMessage(chatId, "Tu carrito está vacío. Agregá algo primero 😊", mainMenu());
  }

  await sendMessage(
    chatId,
    "<b>¿Cómo querés recibir tu pedido?</b>",
    {
      inline_keyboard: [
        [{ text: "🏪 Retiro en local", callback_data: "retiro" }],
        [{ text: "🚚 Envío a domicilio (+$1000)", callback_data: "envio" }]
      ]
    }
  );
}

async function sendOrderToVendor(chatId, method) {
  const cart = carts[chatId];
  if (!cart || !cart.items || cart.items.length === 0) {
    return sendMessage(chatId, "Tu carrito quedó vacío, cargá de nuevo.", mainMenu());
  }

  let total = 0;
  let detalle = "";
  for (const p of cart.items) {
    total += p.subtotal;
    detalle += `• ${p.nombre} x ${p.qty} → $${p.subtotal}\n`;
  }

  if (method === "envio") {
    total += 1000;
  }

  const textoCliente =
    `🎉 <b>Pedido registrado</b>\n\n` +
    `${detalle}\n` +
    `<b>Total con ${method === "envio" ? "envío" : "retiro"}: $${total}</b>\n\n` +
    `📲 Pagá por transferencia al alias <b>jennyocampos.mp</b>.\n` +
    `Luego, si querés, avisá por WhatsApp al vendedor para confirmar.`;

  await sendMessage(chatId, textoCliente, mainMenu());

  // Podríamos enviar detalle al vendedor después (para el POS)
  // Por ahora sólo limpiamos el carrito
  carts[chatId] = { items: [] };
}

// =====================
// COMPARTIR PROMO / BOT
// =====================

async function sharePromo(chatId, codigo) {
  const items = await fetchCatalog();
  const item = items.find((i) => i.codigo === codigo);
  if (!item) {
    return sendMessage(chatId, "No encontré esa promo para compartir.");
  }

  const texto =
    `🔥 Mirá esta promo de TODO QUESO CLUB:\n\n` +
    `${item.nombre} (código ${item.codigo})\n` +
    `Precio: $${item.precio}\n\n` +
    `Comprá desde el bot y sumá sellos.\n` +
    `Yo también gano beneficios si comprás ❤️\n\n` +
    `👉 Abrí el bot: https://t.me/Ezer_IA_Bot?start=${item.codigo}`;

  await sendMessage(
    chatId,
    "Copiá y pegá este texto para compartir por WhatsApp, Telegram, mail, etc:\n\n" + texto
  );
}

async function shareBot(chatId) {
  const texto =
    "🧀 Sumate a TODO QUESO CLUB\n\n" +
    "Comprá directo desde el bot, sumá sellos y canjeá beneficios.\n\n" +
    "👉 https://t.me/Ezer_IA_Bot";

  await sendMessage(
    chatId,
    "Compartí este texto con tus contactos para que también usen el bot y sumen sellos:\n\n" + texto
  );
}

// =====================
// INFO LOCAL / SELLOS / VENDEDOR
// =====================

async function sendInfoLocal(chatId) {
  const texto =
    "<b>🏪 TODO QUESO CLUB</b>\n\n" +
    "📍 Fructuoso Díaz 893, Garín\n" +
    "🕒 Lun a Sáb 08:30–14:00 / 16:30–21:00\n" +
    "📱 3484 230184\n" +
    "📲 Instagram: @todoqueso.club";

  await sendMessage(chatId, texto, mainMenu());
}

async function talkToVendor(chatId) {
  const url = `https://wa.me/${WHATSAPP_VENDEDOR}`;
  const texto =
    "Si necesitás algo especial, escribile directo al vendedor por WhatsApp:\n\n" +
    url;

  await sendMessage(chatId, texto, mainMenu());
}

async function showSellos(chatId) {
  // Placeholder por ahora
  await sendMessage(
    chatId,
    "🏆 Tu tarjeta de sellos personalizada va a aparecer acá.\nMuy pronto vas a poder ver tus sellos y beneficios en tiempo real.",
    mainMenu()
  );
}

// =====================
// WEBHOOK TELEGRAM
// =====================

app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;
    const msg = update.message;
    const cb = update.callback_query;

    if (msg) {
      const chatId = msg.chat.id;
      const text = (msg.text || "").trim();

      // Si hay una compra pendiente, interpretamos el texto como cantidad
      if (carts[chatId] && carts[chatId].pending && text && !text.startsWith("/")) {
        await handleQuantity(chatId, text);
        return res.send("OK");
      }

      // Comandos o textos directos
      if (text === "/start") {
        await sendWelcome(chatId);
        return res.send("OK");
      }

      switch (text) {
        case "🛍 Catálogo":
          await showCategories(chatId);
          break;
        case "🛒 Mi carrito":
          await showCart(chatId);
          break;
        case "🏆 Mis sellos":
          await showSellos(chatId);
          break;
        case "💬 Hablar con el vendedor":
          await talkToVendor(chatId);
          break;
        case "🏪 Información del local":
          await sendInfoLocal(chatId);
          break;
        case "📢 Compartir el bot":
          await shareBot(chatId);
          break;
        default:
          // Cualquier otra cosa: bienvenida + menú
          await sendWelcome(chatId);
          break;
      }

      return res.send("OK");
    }

    if (cb) {
      const chatId = cb.message.chat.id;
      const data = cb.data || "";

      if (data === "volver_categorias") {
        await showCategories(chatId);
      } else if (data === "ver_carrito") {
        await showCart(chatId);
      } else if (data === "catalogo") {
        await showCategories(chatId);
      } else if (data.startsWith("cat_")) {
        const cat = data.substring(4);
        await showProductsOfCategory(chatId, cat);
      } else if (data.startsWith("buy_")) {
        const codigo = data.substring(4);
        await startBuy(chatId, codigo);
      } else if (data.startsWith("share_")) {
        const codigo = data.substring(6);
        await sharePromo(chatId, codigo);
      } else if (data === "checkout") {
        await checkout(chatId);
      } else if (data === "clearcart") {
        carts[chatId] = { items: [] };
        await sendMessage(chatId, "Vaciamos tu carrito. Podés empezar de nuevo 😊", mainMenu());
      } else if (data === "retiro") {
        await sendOrderToVendor(chatId, "retiro");
      } else if (data === "envio") {
        await sendOrderToVendor(chatId, "envio");
      }

      return res.send("OK");
    }

    res.send("OK");
  } catch (err) {
    console.error("Error en webhook:", err.toString());
    res.send("OK");
  }
});

// Endpoint simple para que Render despierte
app.get("/", (req, res) => {
  res.send("EzerBot cliente está vivo ✅");
});

// Arrancar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`EzerBot escuchando en puerto ${PORT}`);
});

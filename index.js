// --------------------------------------------------------------
// EZERBOT IA – SISTEMA CLIENTE TODO QUESO
// Catálogo por categorías + carrito + compartir + sellos
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

// Tu Apps Script (backend con acciones: catalogo, estadoCliente, etc.)
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
// LEER CATÁLOGO Y ESTADO
// =====================

async function fetchCatalog() {
  try {
    const res = await axios.get(`${SHEETS_URL}?accion=catalogo`);
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

async function fetchEstadoCliente(chatId) {
  try {
    const url = `${SHEETS_URL}?accion=estadoCliente&chatId=${encodeURIComponent(
      chatId
    )}`;
    const res = await axios.get(url);
    return res.data || {};
  } catch (err) {
    console.error("ERROR leyendo estadoCliente:", err.toString());
    return {};
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
  const caption =
    "<b>¡Hola! Soy TODO QUESO CLUB 🧀</b>\n\n" +
    "Somos tu fiambre y quesería de confianza en Garín. " +
    "Desde este bot podés:\n" +
    "• Ver promos y productos del día\n" +
    "• Armar tu pedido paso a paso\n" +
    "• Sumar sellos con cada compra\n" +
    "• Canjear beneficios especiales 🎁\n\n" +
    "Elegí una opción del menú de abajo para empezar 👇";

  await sendPhoto(chatId, LOGO_URL, caption, mainMenu());
}

// =====================
// CATÁLOGO POR CATEGORÍAS
// =====================

async function showCategories(chatId) {
  const items = await fetchCatalog();
  if (!items || items.length === 0) {
    return sendMessage(
      chatId,
      "Por ahora el catálogo no tiene productos cargados. Volvé a intentar más tarde 🧀",
      mainMenu()
    );
  }

  const categoriasSet = new Set();
  for (const it of items) {
    if (it.categoria && String(it.categoria).trim() !== "") {
      categoriasSet.add(String(it.categoria).trim());
    } else {
      categoriasSet.add("Otros");
    }
  }

  const categorias = Array.from(categoriasSet).sort((a, b) =>
    a.localeCompare(b)
  );
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

// Mostrar productos de una categoría (fotos con botones)
async function showProductsOfCategory(chatId, category) {
  const items = await fetchCatalog();
  const filtered = items.filter(
    (i) => (i.categoria || "Otros") === category
  );

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

    await sendPhoto(chatId, p.imagen || LOGO_URL, caption, keyboard);
  }

  await sendMessage(
    chatId,
    "Si no encontraste algo, podés escribirle al vendedor desde el menú 💬.",
    {
      inline_keyboard: [
        [
          {
            text: "⬅️ Volver a categorías",
            callback_data: "volver_categorias"
          }
        ],
        [{ text: "🛒 Ver carrito", callback_data: "ver_carrito" }]
      ]
    }
  );
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
    "Escribí la cantidad:\n" +
    "• Si es por unidad → 1, 2, 3…\n" +
    "• Si es por kilo → los gramos (mínimo 100g).";

  await sendMessage(chatId, msg, mainMenu());
}

async function handleQuantity(chatId, text) {
  const cart = carts[chatId];
  if (!cart || !cart.pending) return;

  const item = cart.pending;
  const qty = Number(text.replace(",", "."));

  if (!qty || qty <= 0) {
    return sendMessage(
      chatId,
      "Por favor ingresá un número válido de unidades o gramos."
    );
  }

  let subtotal;
  if (item.unidad && item.unidad.toLowerCase() === "unidad") {
    subtotal = item.precio * qty;
  } else {
    // Se interpreta como gramos
    if (qty < 100) {
      return sendMessage(
        chatId,
        "El mínimo son 100 gramos. Ingresá un valor mayor o igual a 100."
      );
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
    return sendMessage(chatId, "Tu carrito está vacío por ahora 🧀", mainMenu());
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
    return sendMessage(
      chatId,
      "Tu carrito está vacío. Agregá algo primero 😊",
      mainMenu()
    );
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
    return sendMessage(
      chatId,
      "Tu carrito quedó vacío, empezá un pedido nuevo.",
      mainMenu()
    );
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
    "📲 Podés pagar por transferencia al alias <b>jennyocampos.mp</b>.\n" +
    "Cuando termines, si querés, avisá por WhatsApp al vendedor para confirmar el pedido 😊.";

  await sendMessage(chatId, textoCliente, mainMenu());

  // limpiar carrito
  carts[chatId] = { items: [] };
}

// =====================
// COMPARTIR PROMO / BOT
// =====================

function buildShareButtons(text) {
  const encodedText = encodeURIComponent(text);
  const waUrl = `https://wa.me/?text=${encodedText}`;
  const tgUrl = `https://t.me/share/url?url=${encodedText}&text=${encodedText}`;
  const mailUrl = `mailto:?subject=Todo%20Queso%20Club&body=${encodedText}`;

  return {
    inline_keyboard: [
      [{ text: "📲 WhatsApp", url: waUrl }],
      [{ text: "📨 Telegram", url: tgUrl }],
      [{ text: "✉️ Email", url: mailUrl }]
    ]
  };
}

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
    "Compartí esta promo con tus contactos para que también sumen sellos:\n\n" + texto,
    buildShareButtons(texto)
  );
}

async function shareBot(chatId) {
  const texto =
    "🧀 Sumate a TODO QUESO CLUB\n\n" +
    "Comprá directo desde el bot, sumá sellos y canjeá beneficios.\n\n" +
    "👉 https://t.me/Ezer_IA_Bot";

  await sendMessage(
    chatId,
    "Compartí este texto con tus contactos para que también usen el bot y sumen sellos:\n\n" +
      texto,
    buildShareButtons(texto)
  );
}

// =====================
// INFO LOCAL / SELLOS / VENDEDOR
// =====================

async function sendInfoLocal(chatId) {
  const caption =
    "<b>🏪 TODO QUESO CLUB</b>\n\n" +
    "📍 Fructuoso Díaz 893, Garín\n" +
    "🕒 Lun a Sáb 08:30–14:00 / 16:30–21:00\n" +
    "📱 3484 230184\n" +
    "📲 Instagram: @todoqueso.club\n\n" +
    "Mostrale este bot al vendedor para sumar sellos con tus compras 🧀.";

  await sendPhoto(chatId, LOGO_URL, caption, mainMenu());
}

async function talkToVendor(chatId) {
  const url = `https://wa.me/${WHATSAPP_VENDEDOR}`;
  const texto =
    "Si necesitás algo especial o no encontrás un producto en el catálogo, " +
    "escribile directo al vendedor por WhatsApp:\n\n" +
    url;

  await sendMessage(chatId, texto, mainMenu());
}

function buildSellosBar(actual, nivel) {
  const tot = Math.max(1, nivel || 1);
  const act = Math.min(actual || 0, tot);
  return "🧀".repeat(act) + "◻️".repeat(tot - act);
}

async function showSellos(chatId) {
  const estado = await fetchEstadoCliente(chatId);

  // Sin registro
  if (!estado || !estado.tieneTarjeta) {
    const caption =
      "<b>🏆 Tu tarjeta de sellos</b>\n\n" +
      "Todavía no estás registrado para sumar sellos.\n\n" +
      "🧀 Mostrale este bot al vendedor en el local y pedile que te registre.\n" +
      "Desde tu próxima compra vas a empezar a ver acá tu tarjeta personalizada.";
    await sendPhoto(chatId, LOGO_URL, caption, mainMenu());
    return;
  }

  const bar = buildSellosBar(
    estado.sellosActuales,
    estado.sellosNivelActual
  );

  let texto =
    `<b>🏆 Tarjeta de ${estado.nombreCliente || "cliente"}</b>\n\n` +
    `Nivel actual: <b>${estado.nivelActual || ""}</b>\n` +
    `Sellos en este nivel: ${estado.sellosActuales}/${estado.sellosNivelActual}\n` +
    `${bar}\n\n` +
    `Sellos totales acumulados: ${estado.sellosTotalesAcumulados || 0}\n`;

  if (estado.beneficioDisponible) {
    texto +=
      `\n🎁 <b>Tenés un beneficio disponible:</b>\n` +
      `${estado.descripcionBeneficio || ""}\n` +
      (estado.venceEl ? `Vence el: ${estado.venceEl}\n` : "") +
      (estado.codigoCanje ? `Código de canje: <code>${estado.codigoCanje}</code>\n` : "") +
      "\nMostrale este código al vendedor para usarlo.";
  } else if (estado.beneficioProximo) {
    texto +=
      `\n✨ Te falta poquito para: ${estado.beneficioProximo}\n` +
      "Seguí sumando sellos con tus compras 🧀.";
  }

  const foto = estado.tarjetaImagenUrl || LOGO_URL;
  await sendPhoto(chatId, foto, texto, mainMenu());
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

      // Si hay compra pendiente, el texto es la cantidad
      if (carts[chatId] && carts[chatId].pending && text && !text.startsWith("/")) {
        await handleQuantity(chatId, text);
        return res.send("OK");
      }

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
          // Cualquier cosa (hola, etc.) → bienvenida
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
        await sendMessage(
          chatId,
          "Vaciamos tu carrito. Podés empezar de nuevo 😊",
          mainMenu()
        );
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

// Endpoint simple para Render
app.get("/", (req, res) => {
  res.send("EzerBot cliente está vivo ✅");
});

// Arrancar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`EzerBot escuchando en puerto ${PORT}`);
});

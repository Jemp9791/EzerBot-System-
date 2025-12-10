//--------------------------------------------------------------
// EZERBOT IA – SISTEMA COMPLETO 2025
// Con Catálogo, Carrito, Categorías, Compartir, Envío, POS-ready
//--------------------------------------------------------------

import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// -------------------------------------------------------------
// CONFIG – Datos proporcionados por Jenny
// -------------------------------------------------------------

const BOT_TOKEN = "8130447159:AAHxzp5S1lcgYOemw5dgF5V1DGh141dHmkA";
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Tu Apps Script publicado (usa JSON, funciona perfecto)
const SHEETS_URL = "https://script.google.com/macros/s/AKfycbyxm5E2Y7t0hgqh48-AVWpiru2MBXM3E-53T5WgnljMZb_CXZx-F-akgIJVJ4j76MjE/exec";

// Logo del negocio
const LOGO_URL = "https://i.postimg.cc/q7WvjsYm/20251206-210311.jpg";

// Íconos por categoría
const CATEGORY_ICONS = {
  "queso": "🧀",
  "fiambre": "🥓",
  "pan": "🍞",
  "lácteo": "🥛",
  "leche": "🥛",
  "bebida": "🥤",
  "promo": "🔥",
  "dulce": "🍬",
  "default": "📦"
};

// Carritos por usuario
const carts = {};

// -------------------------------------------------------------
// UTILIDADES
// -------------------------------------------------------------

async function sendMessage(chatId, text, keyboard = null) {
  const payload = { chat_id: chatId, text, parse_mode: "HTML" };
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
  const c = cat.toLowerCase();
  for (const key of Object.keys(CATEGORY_ICONS)) {
    if (c.includes(key)) return CATEGORY_ICONS[key];
  }
  return CATEGORY_ICONS.default;
}

// -------------------------------------------------------------
// LECTURA DE CATÁLOGO
// -------------------------------------------------------------
async function fetchCatalog() {
  try {
    const res = await axios.get(SHEETS_URL);
    if (!res.data || !res.data.items) return [];
    return res.data.items.map(i => ({
      codigo: i.CODIGO || "",
      nombre: i.NOMBRE || "",
      precio: Number(i.PRECIO || 0),
      desc: i.DESCRIPCION || "",
      imagen: i.IMAGEN || "",
      unidad: i.UNIDAD || "",
      categoria: i.CATEGORIA || "General"
    }));
  } catch (err) {
    console.error("ERROR leyendo catálogo:", err);
    return [];
  }
}

// -------------------------------------------------------------
// BIENVENIDA CON LOGO
// -------------------------------------------------------------
async function welcome(chatId) {
  await sendPhoto(
    chatId,
    LOGO_URL,
    "<b>¡Bienvenido a Todo Queso! 🧀</b>\nExplorá productos, sumá sellos y obtené beneficios.",
    menuKeyboard()
  );
}

// -------------------------------------------------------------
// MENÚ PRINCIPAL
// -------------------------------------------------------------
function menuKeyboard() {
  return {
    keyboard: [
      [{ text: "🛒 Catálogo" }],
      [{ text: "📥 Mi carrito" }],
      [{ text: "🏅 Tarjeta de sellos" }],
      [{ text: "☎️ Hablar con el vendedor" }],
      [{ text: "🎁 Compartir y ganar sellos" }],
      [{ text: "ℹ️ Información del local" }]
    ],
    resize_keyboard: true
  };
}

// -------------------------------------------------------------
// CATÁLOGO POR CATEGORÍAS
// -------------------------------------------------------------
async function showCategories(chatId) {
  const items = await fetchCatalog();
  const categorias = [...new Set(items.map(i => i.categoria))].sort();

  const botones = categorias.map(c => [
    { text: `${iconForCategory(c)} ${c}`, callback_data: `cat_${c}` }
  ]);

  await sendMessage(chatId, "<b>Elegí una categoría:</b>", {
    inline_keyboard: botones
  });
}

// -------------------------------------------------------------
// MOSTRAR PRODUCTOS DE UNA CATEGORIA
// -------------------------------------------------------------
async function showProducts(chatId, category) {
  const items = await fetchCatalog();
  const filtered = items.filter(i => i.categoria === category);

  if (filtered.length === 0)
    return sendMessage(chatId, "No hay productos para esta categoría.");

  for (const p of filtered) {
    await sendPhoto(
      chatId,
      p.imagen,
      `<b>${p.nombre}</b>\nCódigo: <code>${p.codigo}</code>\n$${p.precio}\n${p.desc}`,
      {
        inline_keyboard: [
          [{ text: "🛍 Comprar", callback_data: `buy_${p.codigo}` }],
          [{ text: "🔁 Compartir promo", switch_inline_query: p.nombre }]
        ]
      }
    );
  }
}

// -------------------------------------------------------------
// INICIO DE COMPRA
// -------------------------------------------------------------
async function startBuy(chatId, codigo) {
  const items = await fetchCatalog();
  const item = items.find(i => i.codigo === codigo);

  if (!item)
    return sendMessage(chatId, "No encontré el producto seleccionado.");

  carts[chatId] = carts[chatId] || {};
  carts[chatId].pending = item;

  await sendMessage(
    chatId,
    `Vas a comprar <b>${item.nombre}</b>\n\nIndicá la cantidad:\n• Unidades → 1, 2, 3…\n• Si es por kilo → escribí gramos (mínimo 100g)`,
    menuKeyboard()
  );
}

// -------------------------------------------------------------
// MANEJO DE CANTIDAD
// -------------------------------------------------------------
async function handleQuantity(chatId, qtyText) {
  const cart = carts[chatId];
  if (!cart || !cart.pending) return;

  let qty = Number(qtyText);
  if (isNaN(qty) || qty <= 0)
    return sendMessage(chatId, "Ingresá un número válido.");

  const item = cart.pending;

  let subtotal =
    item.unidad === "unidad"
      ? item.precio * qty
      : (item.precio * qty) / 1000;

  carts[chatId].items = carts[chatId].items || [];
  carts[chatId].items.push({
    ...item,
    qty,
    subtotal
  });

  carts[chatId].pending = null;

  await sendMessage(
    chatId,
    `🧺 <b>Producto agregado</b>\n${item.nombre}\nCantidad: ${qty}\nSubtotal: $${subtotal}`,
    {
      inline_keyboard: [
        [{ text: "🛒 Seguir comprando", callback_data: "catalogo" }],
        [{ text: "💸 Finalizar compra", callback_data: "checkout" }]
      ]
    }
  );
}

// -------------------------------------------------------------
// VER CARRITO
// -------------------------------------------------------------
async function showCart(chatId) {
  const cart = carts[chatId];
  if (!cart || !cart.items || cart.items.length === 0)
    return sendMessage(chatId, "Tu carrito está vacío.");

  let total = 0;
  let text = "<b>🛒 Tu carrito:</b>\n\n";

  for (const p of cart.items) {
    total += p.subtotal;
    text += `• ${p.nombre} x ${p.qty} → $${p.subtotal}\n`;
  }

  text += `\n<b>Total: $${total}</b>`;

  await sendMessage(chatId, text, {
    inline_keyboard: [
        [{ text: "💸 Finalizar compra", callback_data: "checkout" }],
        [{ text: "🗑 Vaciar carrito", callback_data: "clearcart" }]
    ]
  });
}

// -------------------------------------------------------------
// CHECKOUT
// -------------------------------------------------------------
async function checkout(chatId) {
  const cart = carts[chatId];
  if (!cart || !cart.items || cart.items.length === 0)
    return sendMessage(chatId, "Tu carrito está vacío.");

  await sendMessage(
    chatId,
    `<b>Elegí cómo recibir tu pedido:</b>`,
    {
      inline_keyboard: [
        [{ text: "🏪 Retiro en local", callback_data: "retiro" }],
        [{ text: "🚚 Envío a domicilio (+$1000)", callback_data: "envio" }]
      ]
    }
  );
}

// -------------------------------------------------------------
// CONFIRMAR PEDIDO AL VENDEDOR
// -------------------------------------------------------------
async function sendOrderToVendor(chatId, method) {
  const cart = carts[chatId];
  let total = cart.items.reduce((s, p) => s + p.subtotal, 0);

  if (method === "envio") total += 1000;

  await sendMessage(
    chatId,
    `🎉 <b>Pedido enviado</b>\nTotal: $${total}\nUn vendedor lo confirmará por WhatsApp antes de prepararlo.`,
    menuKeyboard()
  );

  carts[chatId] = { items: [] };
}

// -------------------------------------------------------------
// WEBHOOK TELEGRAM
// -------------------------------------------------------------
app.post("/webhook", async (req, res) => {
  const msg = req.body.message;
  const cb = req.body.callback_query;

  if (msg) {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (text === "/start") return welcome(chatId);

    const cart = carts[chatId];
    if (cart && cart.pending) return handleQuantity(chatId, text);

    switch (text) {
      case "🛒 Catálogo": return showCategories(chatId);
      case "📥 Mi carrito": return showCart(chatId);
      case "🏅 Tarjeta de sellos": 
          return sendMessage(chatId, "Tu tarjeta personalizada estará aquí muy pronto.");
      case "☎️ Hablar con el vendedor": 
          return sendMessage(chatId, "WhatsApp: https://wa.me/5493484230184");
      case "🎁 Compartir y ganar sellos":
          return sendMessage(chatId, "Compartí este bot y ganá sellos: https://t.me/Ezer_IA_Bot");
      case "ℹ️ Información del local":
          return sendMessage(chatId, "📍 Fructuoso Díaz 893, Garín\n🕒 L-S 8:30-21h\n📱 3484230184");
      default:
          return welcome(chatId);
    }
  }

  if (cb) {
    const chatId = cb.message.chat.id;
    const data = cb.data;

    if (data.startsWith("cat_")) return showProducts(chatId, data.replace("cat_", ""));
    if (data.startsWith("buy_")) return startBuy(chatId, data.replace("buy_", ""));
    if (data === "catalogo") return showCategories(chatId);
    if (data === "checkout") return checkout(chatId);
    if (data === "clearcart") { carts[chatId] = {}; return sendMessage(chatId, "Carrito borrado."); }
    if (data === "retiro") return sendOrderToVendor(chatId, "retiro");
    if (data === "envio") return sendOrderToVendor(chatId, "envio");
  }

  res.send("OK");
});

// -------------------------------------------------------------
// SERVER
// -------------------------------------------------------------
app.listen(3000, () => console.log("Bot funcionando en Render ✔"));

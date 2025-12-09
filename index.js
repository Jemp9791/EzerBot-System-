// ===========================
//    EZERBOT - SISTEMA POS
// ===========================

import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// ===========================
//   VARIABLES DE ENTORNO
// ===========================
const TOKEN = process.env.BOT_TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;
const SHEETS = process.env.SHEETS_URL;

const estadoCarrito = {};         // { chatId: { productoSeleccionado, carrito: [], etapa, retiroTipo } }

// ===========================
//   ENVIAR MENSAJES
// ===========================
async function sendMessage(chatId, text, opts = {}) {
  return axios.post(`${API}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...opts
  });
}

async function sendPhoto(chatId, photo, text) {
  return axios.post(`${API}/sendPhoto`, {
    chat_id: chatId,
    photo,
    caption: text,
    parse_mode: "HTML"
  });
}

// ===========================
//     GET CONFIG & CATÁLOGO
// ===========================
async function getConfig() {
  const url = `${SHEETS}?accion=config`;
  let r = await axios.get(url);
  return r.data;
}

async function getCatalogo() {
  const url = `${SHEETS}?accion=catalogo`;
  let r = await axios.get(url);
  return r.data.items || [];
}

async function registrarCompra(chatId, total, nombre) {
  const url = `${SHEETS}?accion=registrarCompra&chatId=${chatId}&monto=${total}&nombre=${encodeURIComponent(nombre)}`;
  let r = await axios.get(url);
  return r.data;
}

// ===========================
//         MENÚ PRINCIPAL
// ===========================
async function mostrarMenu(chatId) {
  return sendMessage(chatId, "Elegí una opción 👇", {
    reply_markup: {
      keyboard: [
        [{ text: "🛒 Ver catálogo" }, { text: "🛍️ Mi carrito" }],
        [{ text: "🏪 Información del local" }]
      ],
      resize_keyboard: true
    }
  });
}

// ===========================
//      MOSTRAR INFORMACIÓN
// ===========================
async function mostrarInfoLocal(chatId) {
  const cfg = await getConfig();

  const logo = cfg.LogoURL || "";
  const nombre = cfg.NombreLocal || "Comercio";
  const direccion = cfg.Direccion || "No configurado";
  const telefono = cfg.Telefono || "-";
  const instagram = cfg.Instagram || "-";
  const horario = cfg.Horarios || "-";

  if (logo) {
    await sendPhoto(chatId, logo, `<b>${nombre}</b>`);
  }

  return sendMessage(
    chatId,
    `🏪 <b>${nombre}</b>\n\n📍 Dirección: ${direccion}\n⏰ Horarios: ${horario}\n📞 Teléfono: ${telefono}\n📸 Instagram: ${instagram}\n\nGracias por ser parte 💛`
  );
}

// ===========================
//      MOSTRAR CATÁLOGO
// ===========================
async function mostrarCatalogo(chatId) {
  const items = await getCatalogo();

  if (!items.length) {
    return sendMessage(chatId, "El catálogo está vacío por ahora.");
  }

  for (let item of items) {
    await sendPhoto(
      chatId,
      item.imagenUrl,
      `🛒 <b>${item.nombre}</b>\n💵 <b>Precio:</b> ${item.precio} ARS\n\n${item.descripcion}`
    );
    await sendMessage(chatId, "👉 Escribí el nombre EXACTO del producto para añadirlo al carrito.");
  }
}

// ===========================
//       SELECCIÓN INICIAL
// ===========================
async function seleccionarProducto(chatId, texto) {
  const items = await getCatalogo();
  const match = items.find(p => p.nombre.toUpperCase() === texto.toUpperCase());

  if (!match) {
    return sendMessage(chatId, "No encontré ese producto. Asegurate de escribir el nombre tal cual aparece.");
  }

  // Crear estado del carrito si no existe
  if (!estadoCarrito[chatId]) {
    estadoCarrito[chatId] = { carrito: [] };
  }

  estadoCarrito[chatId].productoSeleccionado = match;

  if (match.unidad === "kg") {
    estadoCarrito[chatId].etapa = "esperando_gramos";
    return sendMessage(chatId, `¿Cuántos gramos querés de <b>${match.nombre}</b>?`);
  } else {
    estadoCarrito[chatId].etapa = "esperando_unidades";
    return sendMessage(chatId, `¿Cuántas unidades de <b>${match.nombre}</b> querés?`);
  }
}

// ===========================
//      AGREGA PESO O UND
// ===========================
async function procesarCantidad(chatId, cantidad) {
  const est = estadoCarrito[chatId];
  if (!est || !est.productoSeleccionado) return;

  const p = est.productoSeleccionado;
  let subtotal = 0;
  let texto = "";

  if (est.etapa === "esperando_gramos") {
    let gramos = parseInt(cantidad);
    if (isNaN(gramos) || gramos < 100) {
      return sendMessage(chatId, "Min 100 gramos. Ingresá un número válido.");
    }
    subtotal = (p.precio * gramos) / 1000;

    est.carrito.push({
      nombre: p.nombre,
      cantidad: gramos + " g",
      subtotal
    });

    texto = `🛒 Agregué <b>${gramos} g</b> de <b>${p.nombre}</b>\nSubtotal: <b>${subtotal} ARS</b>`;
  }

  if (est.etapa === "esperando_unidades") {
    let unidades = parseInt(cantidad);
    if (isNaN(unidades) || unidades <= 0) {
      return sendMessage(chatId, "Escribí una cantidad válida.");
    }
    subtotal = p.precio * unidades;

    est.carrito.push({
      nombre: p.nombre,
      cantidad: unidades + " un.",
      subtotal
    });

    texto = `🛒 Agregué <b>${unidades} un.</b> de <b>${p.nombre}</b>\nSubtotal: <b>${subtotal} ARS</b>`;
  }

  est.productoSeleccionado = null;
  est.etapa = null;

  await sendMessage(chatId, texto);
  return mostrarMenu(chatId);
}

// ===========================
//      MOSTRAR CARRITO
// ===========================
async function mostrarCarrito(chatId) {
  const est = estadoCarrito[chatId];

  if (!est || !est.carrito.length) {
    return sendMessage(chatId, "Tu carrito está vacío 🛒");
  }

  let texto = "🛍️ <b>Tu carrito</b>\n\n";
  let total = 0;

  est.carrito.forEach((i, idx) => {
    texto += `${idx + 1}) ${i.nombre} – ${i.cantidad} – ${i.subtotal} ARS\n`;
    total += i.subtotal;
  });

  texto += `\n<b>Total:</b> ${total} ARS`;

  await sendMessage(chatId, texto, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Confirmar pedido", callback_data: "confirmar_pedido" }],
        [{ text: "Vaciar carrito", callback_data: "vaciar_carrito" }]
      ]
    }
  });
}

// ===========================
//   CONFIRMAR PEDIDO
// ===========================
async function iniciarConfirmacion(chatId) {
  estadoCarrito[chatId].etapa = "elige_retiro";
  return sendMessage(chatId, "¿Cómo querés recibir tu pedido?", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🏪 Retiro en local", callback_data: "retiro_local" }],
        [{ text: "🚚 Envío a domicilio", callback_data: "envio_domicilio" }]
      ]
    }
  });
}

async function finalizarPedido(chatId, retiroTipo) {
  const est = estadoCarrito[chatId];
  if (!est) return;

  let total = est.carrito.reduce((a,b)=>a+b.subtotal,0);

  // Registrar compra en Sheets
  await registrarCompra(chatId, total, "Cliente Telegram");

  // Aviso al vendedor (si configurado)
  const cfg = await getConfig();
  const vendedor = cfg.TelefonoVendedor || null;

  if (vendedor) {
    const link = `https://wa.me/${vendedor}?text=Nuevo%20pedido%20de%20${chatId}%20por%20${total}%20ARS`;
    await sendMessage(chatId, `Contacto del vendedor: ${link}`);
  }

  await sendMessage(
    chatId,
    `🎉 <b>Pedido confirmado</b>\n\nTipo: <b>${retiroTipo}</b>\nTotal: <b>${total} ARS</b>\n\n¡Gracias por tu compra!`
  );

  estadoCarrito[chatId] = { carrito: [] };
  return mostrarMenu(chatId);
}

// ===========================
//        CALLBACKS
// ===========================
app.post(`/webhook/${TOKEN}`, async (req, res) => {
  res.sendStatus(200);

  const upd = req.body;

  // BOTONES INLINE
  if (upd.callback_query) {
    const chatId = upd.callback_query.message.chat.id;
    const data = upd.callback_query.data;

    if (data === "confirmar_pedido") return iniciarConfirmacion(chatId);
    if (data === "vaciar_carrito") {
      estadoCarrito[chatId] = { carrito: [] };
      return sendMessage(chatId, "Carrito vaciado 🗑️");
    }
    if (data === "retiro_local") return finalizarPedido(chatId, "Retiro en local");
    if (data === "envio_domicilio") return finalizarPedido(chatId, "Envío a domicilio");

    return;
  }

  // MENSAJES DE TEXTO
  if (upd.message) {
    const chatId = upd.message.chat.id;
    const texto = upd.message.text;

    // Menú
    if (texto === "/start") return mostrarMenu(chatId);
    if (texto.includes("Ver catálogo")) return mostrarCatalogo(chatId);
    if (texto.includes("Mi carrito")) return mostrarCarrito(chatId);
    if (texto.includes("Información del local")) return mostrarInfoLocal(chatId);

    // Proceso de compra
    const est = estadoCarrito[chatId];
    if (est?.etapa === "esperando_gramos" || est?.etapa === "esperando_unidades") {
      return procesarCantidad(chatId, texto);
    }

    // Intento de seleccionar producto
    return seleccionarProducto(chatId, texto);
  }
});

// ===========================
//         INICIO SERVER
// ===========================
app.listen(10000, () => console.log("EzerBot listo en Render"));

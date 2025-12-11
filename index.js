// index.js – EzerBot System para TODO QUESO
// Node 22 + Express + node-telegram-bot-api

import express from "express";
import TelegramBot from "node-telegram-bot-api";
import axios from "axios";

// ==========================
//  CONFIG BÁSICA
// ==========================

// Podés dejar estos valores así y no tocar nada.
// Si algún día usás variables de entorno, las toma de ahí.
const BOT_TOKEN =
  process.env.BOT_TOKEN ||
  "8130447159:AAHxzp5S1lcgYOemw5dgF5V1DGh141dHmkA";

const BACKEND_URL =
  process.env.BACKEND_URL ||
  "https://script.google.com/macros/s/AKfycbxznmXVhDFd45kwrtsO0lORoGDn7AcHVdQIYQkgYy_63jaJCrjumzphVK_N39T_zjK_/exec";

const VENDEDOR_CHAT_ID =
  process.env.VENDEDOR_CHAT_ID || "7454984023"; // Tu chat ID (Jenny)

const PORT = process.env.PORT || 10000;

// ==========================
//  ESTADO EN MEMORIA
// ==========================

let productos = [];
let config = {};
let botUsername = "";

const carritos = {}; // { chatId: [ {codigo, nombre, cantidad, precioUnitario, subtotal} ] }
const estadosUsuario = {}; // { chatId: { accion: 'cantidad', codigo } }

// ==========================
//  HELPERS DE CONFIG
// ==========================

function getConfig(key, defaultValue = "") {
  if (!config || typeof config !== "object") return defaultValue;
  const val = config[key];
  if (val === undefined || val === null || val === "") return defaultValue;
  return val;
}

function getBool(key, defaultValue = false) {
  const raw = getConfig(key, "");
  if (raw === "") return defaultValue;
  const v = String(raw).toLowerCase().trim();
  return ["si", "sí", "true", "1", "x", "ok", "y"].includes(v);
}

function getNumber(key, defaultValue = 0) {
  const raw = getConfig(key, "");
  if (raw === "") return defaultValue;
  const n = parseFloat(String(raw).replace(",", "."));
  if (Number.isNaN(n)) return defaultValue;
  return n;
}

function getMoneda() {
  return getConfig("Moneda", "ARS");
}

// ==========================
//  CARGA DEL BACKEND
// ==========================

async function cargarBackend() {
  try {
    console.log("Cargando catálogo desde backend…");
    const resp = await axios.get(BACKEND_URL);
    if (!resp.data || !resp.data.ok) {
      console.error("Respuesta inválida del backend:", resp.data);
      return;
    }
    const datos = resp.data;

    productos = Array.isArray(datos.productos) ? datos.productos : [];
    config = datos.config || {};

    console.log(
      `Catálogo cargado: ${productos.length} productos. Negocio: ${getConfig(
        "NegocioNombre",
        "Sin nombre"
      )}`
    );
  } catch (err) {
    console.error("Error cargando backend:", err.message);
  }
}

// Cargar al inicio y refrescar cada 5 minutos
await cargarBackend();
setInterval(cargarBackend, 5 * 60 * 1000);

// ==========================
//  INICIALIZAR BOT + EXPRESS
// ==========================

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

bot
  .getMe()
  .then((me) => {
    botUsername = me.username || "";
    console.log("Bot iniciado como @", botUsername);
  })
  .catch((err) => console.error("Error en getMe:", err.message));

const app = express();
app.use(express.json());

// Endpoint para Telegram webhook
app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Endpoints simples de prueba
app.get("/", (req, res) => {
  res.json({ ok: true, accion: "ping", mensaje: "EzerBot backend activo" });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, status: "healthy" });
});

app.listen(PORT, () => {
  console.log(`Servidor iniciado en puerto ${PORT}`);
});

// ==========================
//  MENÚ PRINCIPAL
// ==========================

function getMenuPrincipal() {
  return {
    keyboard: [
      [{ text: "🛍 Catálogo" }, { text: "🛒 Mi carrito" }],
      [{ text: "🏆 Mis sellos" }],
      [{ text: "💬 Hablar con el vendedor" }],
      [{ text: "🏬 Información del local" }],
      [{ text: "📣 Compartir el bot" }],
    ],
    resize_keyboard: true,
  };
}

async function enviarBienvenida(chatId, firstName) {
  const nombreNegocio = getConfig("NegocioNombre", "Tu tienda favorita");
  const descripcion = getConfig(
    "Descripcion",
    "Productos frescos y de calidad."
  );
  const logoURL = getConfig("LogoURL", "");

  if (logoURL) {
    try {
      await bot.sendPhoto(chatId, logoURL, {
        caption: `${nombreNegocio}\n${descripcion}`,
      });
    } catch (err) {
      console.error("Error enviando logo:", err.message);
      await bot.sendMessage(chatId, `${nombreNegocio}\n${descripcion}`);
    }
  } else {
    await bot.sendMessage(chatId, `${nombreNegocio}\n${descripcion}`);
  }

  const saludo = `¡Hola ${firstName || ""}! Soy el asistente de ${nombreNegocio}.\nElegí una opción del menú de abajo para empezar 👇`;
  await bot.sendMessage(chatId, saludo, {
    reply_markup: getMenuPrincipal(),
  });
}

// ==========================
//  CATÁLOGO POR CATEGORÍAS
// ==========================

const PRODUCTOS_POR_PAGINA = 3;

function obtenerCategorias() {
  if (!Array.isArray(productos)) return ["General"];
  const set = new Set();
  for (const p of productos) {
    const cat = (p.categoria || "General").trim();
    if (cat) set.add(cat);
  }
  if (set.size === 0) set.add("General");
  return Array.from(set);
}

async function mostrarCategorias(chatId) {
  const categorias = obtenerCategorias();
  const filas = [];
  for (let i = 0; i < categorias.length; i += 2) {
    const fila = [];
    fila.push({
      text: `📦 ${categorias[i]}`,
      callback_data: `cat:${categorias[i]}`,
    });
    if (categorias[i + 1]) {
      fila.push({
        text: `📦 ${categorias[i + 1]}`,
        callback_data: `cat:${categorias[i + 1]}`,
      });
    }
    filas.push(fila);
  }

  await bot.sendMessage(chatId, "Elegí una categoría:", {
    reply_markup: { inline_keyboard: filas },
  });
}

async function mostrarProductosCategoria(chatId, categoria, page = 0) {
  const moneda = getMoneda();
  const lista = productos.filter(
    (p) => (p.categoria || "General").trim() === categoria
  );

  if (lista.length === 0) {
    await bot.sendMessage(
      chatId,
      "Todavía no hay productos cargados en esta categoría."
    );
    return;
  }

  const totalPaginas = Math.ceil(lista.length / PRODUCTOS_POR_PAGINA);
  if (page < 0) page = 0;
  if (page >= totalPaginas) page = totalPaginas - 1;

  const inicio = page * PRODUCTOS_POR_PAGINA;
  const items = lista.slice(inicio, inicio + PRODUCTOS_POR_PAGINA);

  for (const p of items) {
    const codigo = p.codigo || p.CODIGO || "";
    const nombre = p.nombre || p.NOMBRE || "";
    const descripcion = p.descripcion || p.DESCRIPCION || "";
    const precio = p.precio || p.PRECIO || 0;
    const imagen = p.imagen || p.IMAGEN || getConfig("LogoURL", "");

    const caption =
      `🧀 ${nombre}\n` +
      (descripcion ? `${descripcion}\n` : "") +
      `Código: ${codigo}\n` +
      `Precio: ${precio} ${moneda}`;

    const botones = {
      inline_keyboard: [
        [
          {
            text: "🛒 Comprar",
            callback_data: `buy:${codigo}`,
          },
          {
            text: "📤 Compartir promo",
            callback_data: `share:${codigo}`,
          },
        ],
      ],
    };

    if (imagen) {
      try {
        await bot.sendPhoto(chatId, imagen, {
          caption,
          reply_markup: botones,
        });
      } catch (err) {
        console.error("Error enviando foto de producto:", err.message);
        await bot.sendMessage(chatId, caption, { reply_markup: botones });
      }
    } else {
      await bot.sendMessage(chatId, caption, { reply_markup: botones });
    }
  }

  // Navegación de páginas
  const nav = [];
  if (page > 0) {
    nav.push({
      text: "⬅️ Anterior",
      callback_data: `page:${categoria}:${page - 1}`,
    });
  }
  if (page < totalPaginas - 1) {
    nav.push({
      text: "➡️ Siguiente",
      callback_data: `page:${categoria}:${page + 1}`,
    });
  }

  if (nav.length > 0) {
    await bot.sendMessage(chatId, `Página ${page + 1} de ${totalPaginas}`, {
      reply_markup: { inline_keyboard: [nav] },
    });
  }

  await bot.sendMessage(
    chatId,
    "Si no encontrás algo en el listado, podés escribirle al vendedor desde el botón 💬 Hablar con el vendedor."
  );
}

// ==========================
//  CARRITO Y COMPRA
// ==========================

function obtenerProductoPorCodigo(codigo) {
  return productos.find(
    (p) =>
      p.codigo === codigo ||
      p.CODIGO === codigo ||
      String(p.codigo) === String(codigo)
  );
}

async function pedirCantidad(chatId, producto) {
  const nombre = producto.nombre || producto.NOMBRE || "";
  const unidad = (producto.unidad || producto.UNIDAD || "").toLowerCase();
  let mensaje = "";

  if (unidad === "kg" || unidad === "g") {
    mensaje =
      `¿Cuántos gramos de ${nombre} querés?\n` +
      "Escribí un número (por ejemplo: 100, 250, 500…).";
  } else {
    mensaje =
      `¿Cuántas unidades de ${nombre} querés?\n` +
      "Escribí un número (por ejemplo: 1, 2, 3…).";
  }

  estadosUsuario[chatId] = {
    accion: "cantidad",
    codigo: producto.codigo || producto.CODIGO,
    unidad,
  };

  await bot.sendMessage(chatId, mensaje);
}

function agregarAlCarrito(chatId, producto, cantidad) {
  if (!carritos[chatId]) carritos[chatId] = [];

  const moneda = getMoneda();
  const unidad = (producto.unidad || producto.UNIDAD || "").toLowerCase();
  const precio = producto.precio || producto.PRECIO || 0;

  let subtotal = 0;
  let detalleCantidad = "";

  if (unidad === "kg" || unidad === "g") {
    // Interpretamos la cantidad ingresada como gramos
    subtotal = Math.round((precio * cantidad) / 1000);
    const kilos = cantidad / 1000;
    detalleCantidad = `${cantidad} g (${kilos} kg)`;
  } else {
    subtotal = precio * cantidad;
    detalleCantidad = `${cantidad} un.`;
  }

  carritos[chatId].push({
    codigo: producto.codigo || producto.CODIGO,
    nombre: producto.nombre || producto.NOMBRE,
    cantidad: detalleCantidad,
    precioUnitario: precio,
    subtotal,
    unidad,
  });

  return { subtotal, moneda };
}

async function mostrarCarrito(chatId) {
  const carrito = carritos[chatId] || [];
  const moneda = getMoneda();

  if (carrito.length === 0) {
    await bot.sendMessage(chatId, "🛒 Tu carrito está vacío por ahora.");
    return;
  }

  let texto = "🛒 Tu carrito:\n\n";
  let total = 0;

  carrito.forEach((item, idx) => {
    texto += `${idx + 1}) ${item.nombre} — ${item.cantidad} — ${
      item.subtotal
    } ${moneda}\n`;
    total += item.subtotal;
  });

  texto += `\nSubtotal (sin envío): ${total} ${moneda}`;

  if (getBool("UsaEnvíoDomicilio")) {
    const costoEnvio = getNumber("CostoEnvíoBase", 0);
    texto += `\nEnvío base: ${costoEnvio} ${moneda} (se suma al elegir Envío a domicilio)`;
  }

  const botones = {
    inline_keyboard: [
      [
        { text: "✅ Confirmar pedido", callback_data: "confirmar_pedido" },
        { text: "🗑 Vaciar carrito", callback_data: "vaciar_carrito" },
      ],
    ],
  };

  await bot.sendMessage(chatId, texto, { reply_markup: botones });
}

async function enviarTicketPedido(chatId, tipoEntrega, username, firstName) {
  const carrito = carritos[chatId] || [];
  const moneda = getMoneda();

  if (carrito.length === 0) {
    await bot.sendMessage(
      chatId,
      "Tu carrito está vacío. Volvé al catálogo para agregar productos."
    );
    return;
  }

  const nombreNegocio = getConfig("NegocioNombre", "Tu tienda");
  let texto = `🧾 ${nombreNegocio} — Detalle de tu pedido\n\n`;

  let total = 0;
  carrito.forEach((item, idx) => {
    texto += `${idx + 1}) ${item.nombre} — ${item.cantidad} — ${
      item.subtotal
    } ${moneda}\n`;
    total += item.subtotal;
  });

  let envioTexto = "";
  let costoEnvio = 0;

  if (tipoEntrega === "envio" && getBool("UsaEnvíoDomicilio")) {
    costoEnvio = getNumber("CostoEnvíoBase", 0);
    total += costoEnvio;
    envioTexto = `Envío a domicilio: ${costoEnvio} ${moneda}`;
  } else if (tipoEntrega === "retiro" && getBool("UsaRetiroLocal")) {
    envioTexto = "Retiro en local (sin costo adicional)";
  }

  if (envioTexto) {
    texto += `\n${envioTexto}\n`;
  }

  texto += `\nTOTAL: ${total} ${moneda}\n\n`;

  if (getBool("PermitirPagoOnline")) {
    const tipoPago = getConfig("TipoPagoOnline", "Transferencia");
    const alias = getConfig("AliasPago", "");
    const cbu = getConfig("CBUPago", "");

    texto += `Forma de pago: ${tipoPago}\n`;
    if (alias) texto += `Alias: ${alias}\n`;
    if (cbu) texto += `CBU: ${cbu}\n`;
    texto +=
      "\nRealizá el pago y enviá una foto o captura del comprobante por este chat para que podamos confirmar tu pedido.";
  } else {
    texto += "Pagás al recibir o retirar tu pedido.";
  }

  const mensajePost = getConfig(
    "MensajePostCompra",
    "¡Gracias por confiar en nosotros! 💛"
  );
  texto += `\n\n${mensajePost}`;

  await bot.sendMessage(chatId, texto);

  // Aviso al vendedor
  const aviso = getConfig(
    "TextoAvisoVendedor",
    "Nuevo pedido recibido desde el bot."
  );
  const clienteTexto = username
    ? `@${username}`
    : firstName
    ? firstName
    : `ID ${chatId}`;

  const textoVendedor =
    `📦 ${aviso}\n\n` +
    `Cliente: ${clienteTexto}\n` +
    `Tipo: ${
      tipoEntrega === "envio" ? "Envío a domicilio" : "Retiro en local"
    }\n` +
    `Total: ${total} ${moneda}`;

  await bot.sendMessage(VENDEDOR_CHAT_ID, textoVendedor).catch(() => {});

  // Después del ticket, podrías limpiar carrito si querés:
  // carritos[chatId] = [];
}

// ==========================
//  SELLOS Y TARJETA
// ==========================

async function mostrarSellos(chatId, firstName) {
  if (!getBool("UsaSellos")) {
    await bot.sendMessage(
      chatId,
      "Este comercio todavía no activó el sistema de sellos."
    );
    return;
  }

  const tarjetaURL = getConfig("TarjetaURL", "");
  const nombreNegocio = getConfig("NegocioNombre", "el comercio");

  const texto =
    `Esta es tu tarjeta de sellos de ${nombreNegocio}.\n` +
    "Cada compra suma sellos. Cuando completes un nivel, vas a poder canjear beneficios especiales.";

  if (tarjetaURL) {
    try {
      await bot.sendPhoto(chatId, tarjetaURL, {
        caption: texto,
      });
      return;
    } catch (err) {
      console.error("Error enviando tarjeta de sellos:", err.message);
    }
  }

  await bot.sendMessage(chatId, texto);
}

// ==========================
//  INFORMACIÓN DEL LOCAL
// ==========================

async function mostrarInfoLocal(chatId) {
  const nombreNegocio = getConfig("NegocioNombre", "Tu tienda");
  const direccion = getConfig("Dirección", "Dirección no configurada");
  const horarios = getConfig("Horarios", "");
  const tel = getConfig("TeléfonoNegocio", "");
  const insta = getConfig("Instagram", "");
  const facebook = getConfig("Facebook", "");
  const whats = getConfig("WhatsAppLink", "");

  let texto = `🏬 Información de ${nombreNegocio}\n\n`;
  texto += `📍 Dirección: ${direccion}\n`;
  if (horarios) texto += `🕒 Horarios: ${horarios}\n`;
  if (tel) texto += `📞 Contacto: ${tel}\n`;
  if (insta) texto += `📸 Instagram: ${insta}\n`;
  if (facebook) texto += `📘 Facebook: ${facebook}\n`;
  if (whats) texto += `💬 WhatsApp: ${whats}\n`;

  texto += "\nGracias por elegir productos frescos y de calidad 💛";

  await bot.sendMessage(chatId, texto);
}

// ==========================
//  COMPARTIR EL BOT
// ==========================

async function compartirBot(chatId) {
  if (!getBool("CompartirBotActivo", true)) {
    await bot.sendMessage(
      chatId,
      "Por el momento no está habilitada la opción de compartir el bot."
    );
    return;
  }

  const nombreNegocio = getConfig("NegocioNombre", "este comercio");
  const textoConfig = getConfig("TextoCompartirBot", "");
  const linkBot = botUsername ? `https://t.me/${botUsername}` : "";

  const texto =
    (textoConfig ||
      `Compartí este mensaje para que tus contactos también usen el bot y ganen sellos 🧀👇\n\n` +
        `Sumate a ${nombreNegocio}. Comprá directo desde el bot, sumá sellos y canjeá beneficios.`) +
    (linkBot ? `\n\n👉 ${linkBot}` : "");

  await bot.sendMessage(chatId, texto);
}

// ==========================
//  HABLAR CON EL VENDEDOR
// ==========================

async function hablarConVendedor(chatId) {
  const mensaje = getConfig(
    "TextoAvisoVendedor",
    "Escribí tu consulta y un vendedor te responderá a la brevedad."
  );
  await bot.sendMessage(chatId, mensaje);
}

// ==========================
//  MANEJO DE MENSAJES
// ==========================

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const firstName = msg.from.first_name || "";
  const username = msg.from.username || "";

  // Si está ingresando cantidad
  const estado = estadosUsuario[chatId];
  if (estado && estado.accion === "cantidad" && text && !text.startsWith("/")) {
    const numero = parseInt(text.replace(/\D/g, ""), 10);
    if (Number.isNaN(numero) || numero <= 0) {
      await bot.sendMessage(
        chatId,
        "Por favor escribí un número válido (ej: 1, 2, 250…)."
      );
      return;
    }

    const producto = obtenerProductoPorCodigo(estado.codigo);
    if (!producto) {
      await bot.sendMessage(
        chatId,
        "No encontré el producto. Volvé a elegirlo desde el catálogo, por favor."
      );
      delete estadosUsuario[chatId];
      return;
    }

    const { subtotal, moneda } = agregarAlCarrito(
      chatId,
      producto,
      numero
    );

    await bot.sendMessage(
      chatId,
      `Agregué ${producto.nombre || producto.NOMBRE} a tu carrito.\nSubtotal de este producto: ${subtotal} ${moneda}.`
    );

    delete estadosUsuario[chatId];
    await mostrarCarrito(chatId);
    return;
  }

  // Comandos de inicio
  if (text === "/start") {
    await enviarBienvenida(chatId, firstName);
    return;
  }

  // Menú principal
  if (text === "🛍 Catálogo") {
    await mostrarCategorias(chatId);
    return;
  }

  if (text === "🛒 Mi carrito") {
    await mostrarCarrito(chatId);
    return;
  }

  if (text === "🏆 Mis sellos") {
    await mostrarSellos(chatId, firstName);
    return;
  }

  if (text === "💬 Hablar con el vendedor") {
    await hablarConVendedor(chatId);
    return;
  }

  if (text === "🏬 Información del local") {
    await mostrarInfoLocal(chatId);
    return;
  }

  if (text === "📣 Compartir el bot") {
    await compartirBot(chatId);
    return;
  }

  // Cualquier otra cosa: volver a mostrar bienvenida + menú
  if (!text.startsWith("/")) {
    await enviarBienvenida(chatId, firstName);
  }
});

// ==========================
//  MANEJO DE CALLBACKS
// ==========================

bot.on("callback_query", async (query) => {
  const data = query.data || "";
  const chatId = query.message.chat.id;
  const firstName = query.from.first_name || "";
  const username = query.from.username || "";

  try {
    if (data.startsWith("cat:")) {
      const categoria = data.slice(4);
      await mostrarProductosCategoria(chatId, categoria, 0);
    } else if (data.startsWith("page:")) {
      const partes = data.split(":");
      const categoria = partes[1];
      const page = parseInt(partes[2], 10) || 0;
      await mostrarProductosCategoria(chatId, categoria, page);
    } else if (data.startsWith("buy:")) {
      const codigo = data.slice(4);
      const producto = obtenerProductoPorCodigo(codigo);
      if (!producto) {
        await bot.sendMessage(
          chatId,
          "No encontré ese producto. Probá de nuevo desde el catálogo."
        );
      } else {
        await pedirCantidad(chatId, producto);
      }
    } else if (data.startsWith("share:")) {
      // Compartir promo de un producto específico
      const codigo = data.slice(6);
      const producto = obtenerProductoPorCodigo(codigo);
      if (!producto) {
        await bot.sendMessage(
          chatId,
          "No encontré ese producto para compartir."
        );
      } else {
        const nombreNegocio = getConfig("NegocioNombre", "este comercio");
        const moneda = getMoneda();
        const nombre = producto.nombre || producto.NOMBRE || "";
        const precio = producto.precio || producto.PRECIO || 0;

        const textoShare =
          `Mirá esta promo de ${nombreNegocio}:\n` +
          `${nombre} — ${precio} ${moneda}\n` +
          (botUsername ? `Pedilo directo en el bot: https://t.me/${botUsername}` : "");

        await bot.sendMessage(chatId, textoShare);
      }
    } else if (data === "confirmar_pedido") {
      // Elegir tipo de entrega
      const teclas = [];
      if (getBool("UsaEnvíoDomicilio")) {
        const textoEnvio =
          getConfig("TextoEnvíoDomicilio", "Envío a domicilio");
        teclas.push([
          { text: `🚚 ${textoEnvio}`, callback_data: "entrega:envio" },
        ]);
      }
      if (getBool("UsaRetiroLocal")) {
        const textoRetiro = getConfig(
          "TextoRetiroLocal",
          "Retiro en el local"
        );
        teclas.push([
          { text: `🏬 ${textoRetiro}`, callback_data: "entrega:retiro" },
        ]);
      }

      if (teclas.length === 0) {
        await bot.sendMessage(
          chatId,
          "Todavía no está configurado el tipo de entrega. Consultá con el vendedor."
        );
      } else {
        await bot.sendMessage(
          chatId,
          "¿Cómo querés recibir tu pedido?",
          { reply_markup: { inline_keyboard: teclas } }
        );
      }
    } else if (data === "vaciar_carrito") {
      carritos[chatId] = [];
      await bot.sendMessage(chatId, "Vacié tu carrito. Podés volver al catálogo para seguir comprando.");
    } else if (data.startsWith("entrega:")) {
      const tipo = data.split(":")[1]; // envio o retiro
      await enviarTicketPedido(chatId, tipo, username, firstName);
    }
  } catch (err) {
    console.error("Error en callback_query:", err.message);
  }

  // Siempre responder al callback para que Telegram saque el relojito
  try {
    await bot.answerCallbackQuery(query.id);
  } catch (e) {
    // ignorar
  }
});

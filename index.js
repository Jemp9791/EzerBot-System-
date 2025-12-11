// index.js - EzerBot System
// Versión: catálogo por categorías + carrito + compartir + info local
// Usa webhook (Render) y backend en Google Apps Script

import express from "express";
import axios from "axios";
import TelegramBot from "node-telegram-bot-api";

// ==========================
// CONFIGURACIÓN BÁSICA
// ==========================

// Token del bot (primero env vars, luego fallback al que me pasaste)
const BOT_TOKEN =
  process.env.BOT_TOKEN ||
  process.env.TELEGRAM_BOT_TOKEN ||
  "8130447159:AAHxzp5S1lcgYOemw5dgF5V1DGh141dHmkA";

// URL pública de Render (para el webhook)
const PUBLIC_URL =
  process.env.PUBLIC_URL || "https://ezerbot-system.onrender.com";

// URL del backend (Apps Script) - la más reciente que me pasaste
const BACKEND_URL =
  process.env.CATALOG_BACKEND_URL ||
  "https://script.google.com/macros/s/AKfycbxznmXVhDFd45kwrtsO0lORoGDn7AcHVdQIYQkgYy_63jaJCrjumzphVK_N39T_zjK_/exec";

// Puerto que usa Render
const PORT = process.env.PORT || 10000;

// ==========================
// ESTADO EN MEMORIA
// ==========================

let config = {};
let productos = []; // catálogo normalizado
const carritos = {}; // { chatId: [ { codigo, nombre, precio, moneda, cantidad } ] }

// ==========================
// FUNCIONES AUXILIARES
// ==========================

function normalizarProducto(p) {
  // Soporta distintos nombres de campos
  const categoriaRaw =
    p.categoria || p.Categoria || p.CATEGORIA || p.category || p.CATEGORÍA;
  const categoria = categoriaRaw && String(categoriaRaw).trim()
    ? String(categoriaRaw).trim()
    : "General";

  const precioRaw =
    p.precio ||
    p.Precio ||
    p.precioUnitario ||
    p.PrecioUnitario ||
    p.precio_venta ||
    0;

  return {
    codigo: p.codigo || p.CODIGO || p.code || p.Cod || "",
    nombre: p.nombre || p.Nombre || p.NOMBRE || "Producto",
    categoria,
    precio: Number(precioRaw) || 0,
    moneda: p.moneda || p.Moneda || config.moneda || "ARS",
    imagen: p.imagen || p.Imagen || p.image || null,
    descripcion: p.descripcion || p.Descripcion || p.DESCRIPCION || "",
  };
}

function parseBool(val) {
  if (val === undefined || val === null) return false;
  const s = String(val).toLowerCase().trim();
  return ["1", "true", "sí", "si", "on", "x", "yes"].includes(s);
}

function normalizarConfig(raw = {}) {
  const get = (...keys) => {
    for (const k of keys) {
      if (raw[k] !== undefined && raw[k] !== "") return raw[k];
    }
    return undefined;
  };

  return {
    negocioNombre:
      get("NegocioNombre", "negocioNombre", "nombreNegocio") || "Tu tienda",
    logoUrl: get("LogoURL", "logoUrl", "logo"),
    usaSellos: parseBool(get("UsaSellos", "usaSellos")),
    montoPorSello: Number(get("MontoPorSello", "montoPorSello") || 0),
    direccion: get("Dirección", "Direccion", "direccion"),
    horarios: get("Horarios", "horario", "horarios"),
    telefonoNegocio: get(
      "TeléfonoNegocio",
      "TelefonoNegocio",
      "telefonoNegocio"
    ),
    whatsappLink: get("WhatsAppLink", "whatsappLink"),
    descripcion:
      get("Descripcion", "Descripción", "descripcion") ||
      "Productos frescos, promos y beneficios exclusivos.",
    moneda: get("Moneda", "moneda") || "ARS",
    permitirPagoOnline: parseBool(
      get("PermitirPagoOnline", "permitirPagoOnline")
    ),
    tipoPagoOnline: get("TipoPagoOnline", "tipoPagoOnline"),
    aliasPago: get("AliasPago", "aliasPago"),
    cbuPago: get("CBUPago", "cbuPago", "cbu"),
    usaEnvioDomicilio: parseBool(
      get("UsaEnvíoDomicilio", "UsaEnvioDomicilio", "usaEnvioDomicilio")
    ),
    costoEnvioBase:
      Number(
        get("CostoEnvíoBase", "CostoEnvioBase", "costoEnvioBase") || 0
      ) || 0,
    textoEnvioDomicilio: get(
      "TextoEnvíoDomicilio",
      "TextoEnvioDomicilio",
      "textoEnvioDomicilio"
    ),
    usaRetiroLocal: parseBool(get("UsaRetiroLocal", "usaRetiroLocal")),
    textoRetiroLocal: get("TextoRetiroLocal", "textoRetiroLocal"),
    chatIdVendedor: get(
      "ChatIdVendedor",
      "telegramVendedorId",
      "telegramVendedor",
      "chatIdVendedor"
    ),
    textoAvisoVendedor:
      get("TextoAvisoVendedor", "textoAvisoVendedor") ||
      "Nuevo pedido desde el bot:",
    mensajePostCompra:
      get("MensajePostCompra", "mensajePostCompra") ||
      "Gracias por tu compra 💛",
    compartirBotActivo: parseBool(
      get("CompartirBotActivo", "compartirBotActivo")
    ),
    textoCompartirBot: get("TextoCompartirBot", "textoCompartirBot"),
  };
}

async function cargarBackend() {
  try {
    console.log("Cargando catálogo desde backend...");
    const resp = await axios.get(BACKEND_URL, { timeout: 10000 });

    if (!resp.data || resp.data.ok !== true) {
      console.error("Respuesta inesperada del backend:", resp.data);
      throw new Error("Backend sin ok:true");
    }

    const data = resp.data;

    config = normalizarConfig(data.config || {});
    productos = Array.isArray(data.productos)
      ? data.productos.map(normalizarProducto)
      : [];

    console.log(
      `Catálogo cargado: ${productos.length} productos. Negocio: ${config.negocioNombre}`
    );
  } catch (err) {
    console.error("Error al cargar catálogo:", err.message);
    // En caso de fallo, dejamos arrays vacíos pero el bot igual responde al menú
    productos = [];
    config = normalizarConfig({});
  }
}

function obtenerCategorias() {
  // Devuelve categorías únicas a partir de productos.categoria
  if (!Array.isArray(productos) || productos.length === 0) return ["General"];

  const set = new Set();
  for (const p of productos) {
    const cat = p.categoria && String(p.categoria).trim()
      ? String(p.categoria).trim()
      : "General";
    set.add(cat);
  }
  return Array.from(set);
}

function getCarrito(chatId) {
  if (!carritos[chatId]) {
    carritos[chatId] = [];
  }
  return carritos[chatId];
}

// ==========================
// INICIALIZAR BOT Y SERVER
// ==========================

if (!BOT_TOKEN) {
  console.error(
    "ERROR: No hay BOT_TOKEN ni TELEGRAM_BOT_TOKEN en las variables de entorno."
  );
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: false });
const app = express();
app.use(express.json());

// Webhook para Telegram
app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Endpoint de prueba
app.get("/", (req, res) => {
  res.json({ ok: true, accion: "ping", mensaje: "EzerBot backend activo" });
});

// Arrancar servidor Express
app.listen(PORT, async () => {
  console.log(`Servidor iniciado en puerto ${PORT}`);

  await cargarBackend();

  try {
    const webhookUrl = `${PUBLIC_URL}/webhook`;
    await bot.setWebHook(webhookUrl);
    console.log("Webhook configurado en:", webhookUrl);
  } catch (err) {
    console.error("Error configurando webhook:", err.message);
  }
});

// ==========================
// HANDLERS DEL BOT
// ==========================

function menuPrincipal(chatId, firstName) {
  const nombre = firstName || "👋";
  const titulo = config.negocioNombre || "Tu tienda";

  const textoIntro = `${titulo}
${config.descripcion}

Hola ${nombre} 👋
Soy el asistente de ${titulo}.
Desde acá podés ver el catálogo, armar tu pedido, sumar sellos y hablar con el vendedor.

Elegí una opción del menú de abajo para empezar 👇`;

  bot.sendMessage(chatId, textoIntro, {
    reply_markup: {
      keyboard: [
        ["🛍️ Catálogo", "🛒 Mi carrito"],
        ["🏆 Mis sellos"],
        ["💬 Hablar con el vendedor"],
        ["🏬 Información del local"],
        ["📣 Compartir el bot"],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  });
}

async function mostrarCategorias(chatId) {
  if (!productos || productos.length === 0) {
    await cargarBackend();
  }

  if (!productos || productos.length === 0) {
    return bot.sendMessage(
      chatId,
      "Todavía no hay productos cargados en el catálogo. Probá de nuevo más tarde."
    );
  }

  const categorias = obtenerCategorias();

  const botones = categorias.map((cat) => [
    {
      text: `📦 ${cat}`,
      callback_data: `CAT_${encodeURIComponent(cat)}`,
    },
  ]);

  bot.sendMessage(chatId, "Elegí una categoría:", {
    reply_markup: {
      inline_keyboard: botones,
    },
  });
}

async function mostrarProductosPorCategoria(chatId, categoria) {
  const catDecod = decodeURIComponent(categoria);
  const lista = productos.filter(
    (p) => String(p.categoria).trim() === catDecod
  );

  if (lista.length === 0) {
    return bot.sendMessage(
      chatId,
      `No encontré productos para la categoría "${catDecod}".`
    );
  }

  // Enviamos cada producto con botón "Agregar al carrito"
  for (const p of lista) {
    const titulo = `${p.nombre}`;
    const precioLinea =
      p.precio > 0
        ? `Precio: ${p.precio.toLocaleString("es-AR")} ${p.moneda}`
        : "Precio: consultar";

    const texto = `${titulo}
${precioLinea}

Código: ${p.codigo}
${p.descripcion ? "\n" + p.descripcion : ""}`;

    const opciones = {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🛒 Agregar al carrito",
              callback_data: `ADD_${p.codigo}`,
            },
          ],
        ],
      },
    };

    if (p.imagen) {
      await bot.sendPhoto(chatId, p.imagen, {
        caption: texto,
        reply_markup: opciones.reply_markup,
      });
    } else {
      await bot.sendMessage(chatId, texto, opciones);
    }
  }

  bot.sendMessage(
    chatId,
    "Cuando termines de elegir, tocá *Mi carrito* para revisar tu pedido.",
    { parse_mode: "Markdown" }
  );
}

function mostrarCarrito(chatId) {
  const carrito = getCarrito(chatId);

  if (!carrito.length) {
    return bot.sendMessage(chatId, "🧺 Tu carrito está vacío por ahora.");
  }

  const moneda = config.moneda || "ARS";

  let total = 0;
  const lineas = carrito.map((item, idx) => {
    const subtotal = item.precio * item.cantidad;
    total += subtotal;
    return `${idx + 1}) ${item.nombre} — ${
      item.cantidad
    } x ${item.precio.toLocaleString("es-AR")} ${moneda} = ${subtotal.toLocaleString(
      "es-AR"
    )} ${moneda}`;
  });

  let texto = `🧺 Tu carrito:\n\n${lineas.join("\n")}\n\nSubtotal (sin envío): ${total.toLocaleString(
    "es-AR"
  )} ${moneda}`;

  bot.sendMessage(chatId, texto, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Confirmar pedido", callback_data: "CART_CONFIRM" },
          { text: "🗑️ Vaciar carrito", callback_data: "CART_CLEAR" },
        ],
      ],
    },
  });
}

function agregarAlCarrito(chatId, codigo) {
  const prod = productos.find((p) => p.codigo === codigo);
  if (!prod) {
    return bot.sendMessage(
      chatId,
      "No encontré ese producto en el catálogo. Probá de nuevo."
    );
  }

  const carrito = getCarrito(chatId);
  const existente = carrito.find((i) => i.codigo === codigo);
  if (existente) {
    existente.cantidad += 1;
  } else {
    carrito.push({
      codigo: prod.codigo,
      nombre: prod.nombre,
      precio: prod.precio,
      moneda: prod.moneda,
      cantidad: 1,
    });
  }

  bot.sendMessage(
    chatId,
    `🛒 "${prod.nombre}" se agregó a tu carrito. Seguimos comprando.`
  );
}

async function confirmarPedido(chatId) {
  const carrito = getCarrito(chatId);
  if (!carrito.length) {
    return bot.sendMessage(chatId, "Tu carrito está vacío.");
  }

  const moneda = config.moneda || "ARS";
  let total = 0;
  const lineas = carrito.map((item, idx) => {
    const subtotal = item.precio * item.cantidad;
    total += subtotal;
    return `${idx + 1}) ${item.nombre} — ${
      item.cantidad
    } x ${item.precio.toLocaleString("es-AR")} ${moneda} = ${subtotal.toLocaleString(
      "es-AR"
    )} ${moneda}`;
  });

  // Envío / retiro
  let txtEntrega = "";
  if (config.usaEnvioDomicilio && config.costoEnvioBase > 0) {
    txtEntrega += `\n🚚 Envío a domicilio: +${config.costoEnvioBase.toLocaleString(
      "es-AR"
    )} ${moneda}`;
  }
  if (config.usaRetiroLocal) {
    txtEntrega += `\n🏬 O podés retirar en el local.`;
  }

  const textoCliente = `🧾 Resumen de tu pedido en ${
    config.negocioNombre
  }:

${lineas.join("\n")}

Subtotal (sin envío): ${total.toLocaleString("es-AR")} ${moneda}${txtEntrega}

${
  config.permitirPagoOnline && config.aliasPago
    ? `💳 Datos para pagar por transferencia:\nAlias: ${config.aliasPago}\n${
        config.cbuPago ? `CBU: ${config.cbuPago}` : ""
      }\n\nDespués de pagar, envianos el comprobante por este chat.`
    : "Un vendedor te va a indicar cómo finalizar el pago."
}

${config.mensajePostCompra}`;

  await bot.sendMessage(chatId, textoCliente);

  // Aviso al vendedor (si hay chatId configurado)
  if (config.chatIdVendedor) {
    try {
      await bot.sendMessage(
        config.chatIdVendedor,
        `${config.textoAvisoVendedor}

Cliente: ${chatId}
Pedido:
${lineas.join("\n")}

Subtotal (sin envío): ${total.toLocaleString("es-AR")} ${moneda}`
      );
    } catch (err) {
      console.error("Error avisando al vendedor:", err.message);
    }
  }

  // Vaciar carrito
  carritos[chatId] = [];
}

function infoLocal(chatId) {
  const titulo = config.negocioNombre || "Tu tienda";
  const direccion =
    config.direccion || "Dirección no configurada (consultá con el local)";
  const horarios = config.horarios ? `🕒 Horarios: ${config.horarios}\n` : "";
  const tel = config.telefonoNegocio
    ? `📞 Contacto: ${config.telefonoNegocio}\n`
    : "";

  const texto = `🏬 ${titulo}

📍 Dirección: ${direccion}
${horarios}${tel}
Gracias por elegir productos frescos y de calidad 💛`;

  bot.sendMessage(chatId, texto);
}

function hablarConVendedor(chatId) {
  const texto = `💬 Hola, soy el asistente de ${
    config.negocioNombre || "Tu tienda"
  }.

Escribí tu consulta por este chat y un vendedor real te va a responder.`;
  bot.sendMessage(chatId, texto);
}

function compartirBot(chatId) {
  const titulo = config.negocioNombre || "Tu tienda";
  const textoConfig = config.textoCompartirBot;

  const texto =
    textoConfig ||
    `📣 Compartí este bot con tus contactos para que también aprovechen las promos y sumen sellos.

🧀 Sumate a ${titulo} y disfrutá de productos frescos, combos y beneficios.

👉 Entrá al bot: https://t.me/Ezer_IABot

Podés copiar este mensaje y pegarlo en WhatsApp, Instagram, email o donde quieras para invitar a tus contactos.`;

  bot.sendMessage(chatId, texto);
}

// ==========================
// EVENTOS DE TELEGRAM
// ==========================

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  if (!text) return;

  if (text === "/start" || /^hola\b/i.test(text)) {
    return menuPrincipal(chatId, msg.from?.first_name);
  }

  switch (text) {
    case "🛍️ Catálogo":
      return mostrarCategorias(chatId);

    case "🛒 Mi carrito":
      return mostrarCarrito(chatId);

    case "🏆 Mis sellos":
      if (!config.usaSellos) {
        return bot.sendMessage(
          chatId,
          "Este comercio todavía no activó el sistema de sellos."
        );
      } else {
        // Más adelante se puede conectar con Fideliza 360
        return bot.sendMessage(
          chatId,
          "Pronto vas a poder ver tu tarjeta digital con tus sellos. 🏆"
        );
      }

    case "💬 Hablar con el vendedor":
      return hablarConVendedor(chatId);

    case "🏬 Información del local":
      return infoLocal(chatId);

    case "📣 Compartir el bot":
      return compartirBot(chatId);

    default:
      // Respuesta genérica si escriben otra cosa
      return bot.sendMessage(
        chatId,
        "Elegí una opción del menú de abajo para seguir usando el bot 👇"
      );
  }
});

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data || "";

  try {
    if (data.startsWith("CAT_")) {
      const categoria = data.slice(4); // después de "CAT_"
      await mostrarProductosPorCategoria(chatId, categoria);
    } else if (data.startsWith("ADD_")) {
      const codigo = data.slice(4);
      agregarAlCarrito(chatId, codigo);
    } else if (data === "CART_CLEAR") {
      carritos[chatId] = [];
      await bot.sendMessage(
        chatId,
        "Vacié tu carrito. Podés volver al catálogo para seguir comprando."
      );
    } else if (data === "CART_CONFIRM") {
      await confirmarPedido(chatId);
    }

    // Confirmar callback
    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    console.error("Error en callback_query:", err.message);
    try {
      await bot.answerCallbackQuery(query.id, {
        text: "Ocurrió un error procesando tu acción. Probá de nuevo.",
        show_alert: false,
      });
    } catch (_) {}
  }
});

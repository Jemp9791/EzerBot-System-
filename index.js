// index.js – EzerBot System para TODO QUESO (y otros negocios)
// Node 22 + Express + node-telegram-bot-api

import express from "express";
import TelegramBot from "node-telegram-bot-api";
import axios from "axios";

// ==========================
//  CONFIG BÁSICA
// ==========================

// Si después querés usar variables de entorno, Render las va a tomar desde process.env
const BOT_TOKEN =
  process.env.BOT_TOKEN ||
  "8130447159:AAHxzp5S1lcgYOemw5dgF5V1DGh141dHmkA";

const BACKEND_URL =
  process.env.BACKEND_URL ||
  "https://script.google.com/macros/s/AKfycbxznmXVhDFd45kwrtsO0lORoGDn7AcHVdQIYQkgYy_63jaJCrjumzphVK_N39T_zjK_/exec";

const DEFAULT_VENDEDOR_CHAT_ID =
  process.env.VENDEDOR_CHAT_ID || "7454984023"; // tu chat de Jenny, por defecto

const PORT = process.env.PORT || 10000;

// ==========================
//  ESTADO EN MEMORIA
// ==========================

let productos = [];      // viene de hoja Catalogo
let config = {};         // viene de hoja Config
let monedaPorDefecto = "ARS";

let botUsername = "";    // ej. Ezer_IA_Bot

// Carrito por usuario
const carritos = {};        // { chatId: [ {codigo, nombre, cantidad, precioUnitario, subtotal, unidad} ] }
const estadosUsuario = {};  // { chatId: { accion: 'cantidad', codigo, unidad } }

// Config normalizada para usar fácil en el bot
let cfg = {
  nombre: "Tu tienda",
  logoUrl: "",
  descripcion: "",
  usaSellos: false,
  tarjetaURL: "",
  selloURL: "",
  direccion: "Dirección no configurada",
  horarios: "",
  telefono: "",
  instagram: "",
  facebook: "",
  whatsappLink: "",
  compartirBotActivo: false,
  textoCompartirBot: "",
  bonusSellosShare: 0,
  usaEnvioDomicilio: false,
  costoEnvioBase: 0,
  textoEnvioDomicilio: "",
  usaRetiroLocal: false,
  textoRetiroLocal: "",
  permitirPagoOnline: false,
  tipoPagoOnline: "",
  aliasPago: "",
  cbuPago: "",
  mensajePostCompra: "",
  chatIdVendedor: "",
  usaCumpleanios: false
};

// ==========================
//  HELPERS CONFIG
// ==========================

function getConfig(key, defaultValue = "") {
  if (!config || typeof config !== "object") return defaultValue;
  const v = config[key];
  if (v === undefined || v === null || v === "") return defaultValue;
  return v;
}

function getBoolFromConfig(key, defaultValue = false) {
  const raw = getConfig(key, "");
  if (raw === "") return defaultValue;
  const v = String(raw).trim().toLowerCase();
  return ["si", "sí", "true", "1", "x", "ok", "on"].includes(v);
}

function getNumberFromConfig(key, defaultValue = 0) {
  const raw = getConfig(key, "");
  if (raw === "") return defaultValue;
  const n = Number(String(raw).replace(",", "."));
  if (Number.isNaN(n)) return defaultValue;
  return n;
}

function getMoneda() {
  return getConfig("Moneda", monedaPorDefecto || "ARS");
}

// Emoji según categoría (modo C: automático)
function emojiCategoria(cat) {
  if (!cat) return "📦";
  const c = cat.toLowerCase();
  if (c.includes("queso")) return "🧀";
  if (c.includes("fiambre")) return "🥓";
  if (c.includes("pan")) return "🍞";
  if (c.includes("lact")) return "🥛";
  if (c.includes("bebida") || c.includes("gaseosa")) return "🥤";
  if (c.includes("promo") || c.includes("combo") || c.includes("oferta"))
    return "💥";
  return "📦";
}

// ==========================
//  CARGA DEL BACKEND
// ==========================

async function cargarBackend() {
  try {
    console.log("🔄 Cargando configuración desde Apps Script…");
    // 1) Config
    const cfgResp = await axios.get(`${BACKEND_URL}?accion=config`);
    if (cfgResp && cfgResp.data) {
      config = cfgResp.data;
    } else {
      config = {};
    }

    // Moneda por defecto (si existe en Config)
    monedaPorDefecto = getConfig("Moneda", "ARS");

    // Normalizar config
    const rawCfg = config || {};

    cfg.nombre = rawCfg["NegocioNombre"] || cfg.nombre;
    cfg.logoUrl = rawCfg["LogoURL"] || rawCfg["LogoUrl"] || cfg.logoUrl;
    cfg.descripcion =
      rawCfg["Descripcion"] ||
      "Productos frescos, promos y beneficios exclusivos.";

    cfg.usaSellos = getBoolFromConfig("UsaSellos", false);
    cfg.tarjetaURL = rawCfg["TarjetaURL"] || cfg.tarjetaURL;
    cfg.selloURL = rawCfg["SelloURL"] || cfg.selloURL;

    cfg.direccion =
      rawCfg["Dirección"] || rawCfg["Direccion"] || cfg.direccion;
    cfg.horarios = rawCfg["Horarios"] || cfg.horarios;
    cfg.telefono =
      rawCfg["TeléfonoNegocio"] ||
      rawCfg["TelefonoNegocio"] ||
      cfg.telefono;

    cfg.instagram = rawCfg["Instagram"] || cfg.instagram;
    cfg.facebook = rawCfg["Facebook"] || cfg.facebook;
    cfg.whatsappLink = rawCfg["WhatsAppLink"] || cfg.whatsappLink;

    cfg.compartirBotActivo = getBoolFromConfig("CompartirBotActivo", true);
    cfg.textoCompartirBot = rawCfg["TextoCompartirBot"] || "";
    cfg.bonusSellosShare = getNumberFromConfig("BonusSellosShare", 0);

    cfg.usaEnvioDomicilio = getBoolFromConfig("UsaEnvíoDomicilio", false);
    cfg.costoEnvioBase = getNumberFromConfig("CostoEnvíoBase", 0);
    cfg.textoEnvioDomicilio =
      rawCfg["TextoEnvíoDomicilio"] ||
      rawCfg["TextoEnvioDomicilio"] ||
      "";

    cfg.usaRetiroLocal = getBoolFromConfig("UsaRetiroLocal", true);
    cfg.textoRetiroLocal = rawCfg["TextoRetiroLocal"] || "";

    cfg.permitirPagoOnline = getBoolFromConfig("PermitirPagoOnline", true);
    cfg.tipoPagoOnline = rawCfg["TipoPagoOnline"] || "TRANSFERENCIA";
    cfg.aliasPago = rawCfg["AliasPago"] || "jennyocampos.mp";
    cfg.cbuPago =
      rawCfg["CBUPago"] || "0000003100014980639781"; // valor por defecto, se puede cambiar en Config
    cfg.mensajePostCompra =
      rawCfg["MensajePostCompra"] ||
      "Gracias por tu compra 💛 Enviá el comprobante por aquí para confirmar tu pedido.";

    cfg.chatIdVendedor =
      rawCfg["ChatIdVendedor"] || DEFAULT_VENDEDOR_CHAT_ID;

    cfg.usaCumpleanios = getBoolFromConfig("UsaCumpleanios", false);

    console.log(
      `✅ Config cargada. Negocio: ${cfg.nombre} – Moneda: ${getMoneda()}`
    );

    // 2) Catálogo
    console.log("🔄 Cargando catálogo (Catalogo) desde Apps Script…");
    const catResp = await axios.get(`${BACKEND_URL}?accion=catalogo`);
    if (catResp && catResp.data) {
      productos = Array.isArray(catResp.data.items)
        ? catResp.data.items
        : [];
      if (catResp.data.moneda) {
        monedaPorDefecto = catResp.data.moneda;
      }
      console.log(
        `✅ Catálogo cargado: ${productos.length} productos (moneda: ${monedaPorDefecto})`
      );
    } else {
      productos = [];
      console.log("⚠️ Respuesta de catálogo vacía, productos = 0");
    }
  } catch (err) {
    console.error("❌ Error cargando backend:", err.message);
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
    console.log("🤖 Bot iniciado como @", botUsername);
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
  console.log(`🚀 Servidor iniciado en puerto ${PORT}`);
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
      [{ text: "📣 Compartir el bot" }]
    ],
    resize_keyboard: true
  };
}

async function enviarBienvenida(chatId, firstName) {
  const nombre = cfg.nombre || "Tu tienda favorita";
  const desc = cfg.descripcion || "";

  const saludo =
    `Hola ${firstName || ""} 👋\n` +
    `Soy el asistente de ${nombre}. Desde acá podés ver el catálogo, armar tu pedido, sumar sellos y hablar con el vendedor.\n\n` +
    `Elegí una opción del menú de abajo para empezar 👇`;

  if (cfg.logoUrl) {
    try {
      await bot.sendPhoto(chatId, cfg.logoUrl, {
        caption: `${nombre}\n${desc}`
      });
    } catch (e) {
      console.error("Error enviando logo:", e.message);
      await bot.sendMessage(chatId, `${nombre}\n${desc}`);
    }
  } else {
    await bot.sendMessage(chatId, `${nombre}\n${desc}`);
  }

  await bot.sendMessage(chatId, saludo, {
    reply_markup: getMenuPrincipal()
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
    const cat =
      (p.categoria ||
        p.CATEGORIA ||
        "General")
        .toString()
        .trim() || "General";
    set.add(cat);
  }
  if (set.size === 0) set.add("General");
  return Array.from(set);
}

async function mostrarCategorias(chatId) {
  const categorias = obtenerCategorias();
  const filas = [];

  for (let i = 0; i < categorias.length; i += 2) {
    const fila = [];
    const cat1 = categorias[i];
    const cat2 = categorias[i + 1];

    fila.push({
      text: `${emojiCategoria(cat1)} ${cat1}`,
      callback_data: `cat:${cat1}`
    });

    if (cat2) {
      fila.push({
        text: `${emojiCategoria(cat2)} ${cat2}`,
        callback_data: `cat:${cat2}`
      });
    }

    filas.push(fila);
  }

  await bot.sendMessage(chatId, "Elegí una categoría:", {
    reply_markup: { inline_keyboard: filas }
  });
}

function filtrarPorCategoria(categoria) {
  const lista = productos.filter((p) => {
    const cat =
      (p.categoria ||
        p.CATEGORIA ||
        "General")
        .toString()
        .trim() || "General";
    return cat === categoria;
  });
  return lista;
}

async function mostrarProductosCategoria(chatId, categoria, page = 0) {
  const lista = filtrarPorCategoria(categoria);
  const moneda = getMoneda();

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
    const imagen =
      p.imagenUrl ||
      p.imagen ||
      p.IMAGEN ||
      cfg.logoUrl ||
      "";

    let caption =
      `🧀 ${nombre}\n` +
      (descripcion ? `${descripcion}\n` : "") +
      (codigo ? `Código: ${codigo}\n` : "") +
      `Precio: ${precio} ${moneda}`;

    const botones = {
      inline_keyboard: [
        [
          { text: "🛒 Comprar", callback_data: `buy:${codigo}` },
          { text: "📤 Compartir promo", callback_data: `share:${codigo}` }
        ]
      ]
    };

    if (imagen) {
      try {
        await bot.sendPhoto(chatId, imagen, {
          caption,
          reply_markup: botones
        });
      } catch (e) {
        console.error("Error enviando foto producto:", e.message);
        await bot.sendMessage(chatId, caption, { reply_markup: botones });
      }
    } else {
      await bot.sendMessage(chatId, caption, { reply_markup: botones });
    }
  }

  // Navegación
  const nav = [];
  if (page > 0) {
    nav.push({
      text: "⬅️ Anterior",
      callback_data: `page:${categoria}:${page - 1}`
    });
  }
  if (page < totalPaginas - 1) {
    nav.push({
      text: "➡️ Siguiente",
      callback_data: `page:${categoria}:${page + 1}`
    });
  }

  if (nav.length > 0) {
    await bot.sendMessage(
      chatId,
      `Página ${page + 1} de ${totalPaginas}`,
      { reply_markup: { inline_keyboard: [nav] } }
    );
  }

  await bot.sendMessage(
    chatId,
    "Si no encontrás algo en el listado, podés usar el botón 💬 Hablar con el vendedor para consultar.",
  );
}

// ==========================
//  CARRITO Y COMPRA
// ==========================

function obtenerProductoPorCodigo(codigo) {
  if (!codigo) return null;
  return productos.find(
    (p) =>
      String(p.codigo) === String(codigo) ||
      String(p.CODIGO) === String(codigo)
  );
}

async function pedirCantidad(chatId, producto) {
  const nombre = producto.nombre || producto.NOMBRE || "";
  const unidad = (producto.unidad || producto.UNIDAD || "").toLowerCase();

  let mensaje = "";
  if (unidad === "kg" || unidad === "kilo" || unidad === "kilos") {
    mensaje =
      `¿Cuántos gramos de ${nombre} querés?\n` +
      "Escribí solo el número (por ejemplo: 100, 250, 500…).";
  } else {
    mensaje =
      `¿Cuántas unidades de ${nombre} querés?\n` +
      "Escribí solo el número (por ejemplo: 1, 2, 3…).";
  }

  estadosUsuario[chatId] = {
    accion: "cantidad",
    codigo: producto.codigo || producto.CODIGO,
    unidad
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

  if (unidad === "kg" || unidad === "kilo" || unidad === "kilos") {
    // cantidad en gramos
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
    unidad
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

  carrito.forEach((item, i) => {
    texto += `${i + 1}) ${item.nombre} — ${item.cantidad} — ${item.subtotal} ${moneda}\n`;
    total += item.subtotal;
  });

  texto += `\nSubtotal (sin envío): ${total} ${moneda}`;

  if (cfg.usaEnvioDomicilio && cfg.costoEnvioBase > 0) {
    texto += `\nEnvío base estimado: ${cfg.costoEnvioBase} ${moneda}`;
  }

  const botones = {
    inline_keyboard: [
      [
        { text: "✅ Confirmar pedido", callback_data: "confirmar_pedido" },
        { text: "🗑 Vaciar carrito", callback_data: "vaciar_carrito" }
      ]
    ]
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

  const ahora = new Date();
  const fecha =
    ahora.getDate().toString().padStart(2, "0") +
    "/" +
    (ahora.getMonth() + 1).toString().padStart(2, "0") +
    "/" +
    ahora.getFullYear() +
    " " +
    ahora.getHours().toString().padStart(2, "0") +
    ":" +
    ahora.getMinutes().toString().padStart(2, "0");

  const nombreNegocio = cfg.nombre || "Tu tienda";
  let texto = `🧾 Ticket de compra – ${nombreNegocio}\n`;
  texto += `Fecha: ${fecha}\n`;
  const nombreCliente =
    username
      ? `@${username}`
      : firstName
      ? firstName
      : `Cliente ${chatId}`;
  texto += `Cliente: ${nombreCliente}\n\n`;

  let total = 0;
  carrito.forEach((item, i) => {
    texto += `${i + 1}) ${item.nombre} — ${item.cantidad} — ${item.subtotal} ${moneda}\n`;
    total += item.subtotal;
  });

  let envioTexto = "";
  let costoEnvio = 0;

  if (tipoEntrega === "envio" && cfg.usaEnvioDomicilio) {
    costoEnvio = cfg.costoEnvioBase || 0;
    if (costoEnvio > 0) {
      texto += `\nEnvío a domicilio: ${costoEnvio} ${moneda}\n`;
      total += costoEnvio;
    } else {
      texto += `\nEnvío a domicilio (costo a confirmar con el vendedor)\n`;
    }
  } else if (tipoEntrega === "retiro" && cfg.usaRetiroLocal) {
    texto += `\nRetiro en el local\n`;
  }

  texto += `\nTOTAL A PAGAR: ${total} ${moneda}\n\n`;

  if (cfg.permitirPagoOnline) {
    texto += "💳 Métodos de pago:\n";
    texto += `Tipo: ${cfg.tipoPagoOnline}\n`;
    if (cfg.aliasPago) texto += `Alias: ${cfg.aliasPago}\n`;
    if (cfg.cbuPago) texto += `CBU: ${cfg.cbuPago}\n`;
    texto +=
      "\nRealizá el pago y enviá el comprobante por este chat para que podamos confirmar tu pedido.\n";
  } else {
    texto += "Pagás al recibir o retirar tu pedido.\n";
  }

  if (cfg.mensajePostCompra) {
    texto += `\n${cfg.mensajePostCompra}`;
  }

  await bot.sendMessage(chatId, texto);

  // Aviso al vendedor
  const vendedorChatId = cfg.chatIdVendedor || DEFAULT_VENDEDOR_CHAT_ID;
  let textoVendedor = "📦 Nuevo pedido recibido desde el bot\n\n";
  textoVendedor += `Cliente: ${nombreCliente}\n`;
  textoVendedor += `Total: ${total} ${moneda}\n`;
  textoVendedor += `Entrega: ${
    tipoEntrega === "envio"
      ? "Envío a domicilio"
      : "Retiro en el local"
  }\n`;
  textoVendedor +=
    "\nRecordá verificar el pago y luego preparar el pedido. ✅";

  await bot.sendMessage(vendedorChatId, textoVendedor).catch(() => {});

  // Si querés, podés vaciar el carrito después:
  // carritos[chatId] = [];
}

// ==========================
//  SELLOS Y TARJETA
// ==========================

async function mostrarSellos(chatId, from) {
  if (!cfg.usaSellos) {
    await bot.sendMessage(
      chatId,
      "Este comercio todavía no activó el sistema de sellos."
    );
    return;
  }

  const nombreCliente =
    (from && (from.first_name || from.username)) || "Cliente";

  try {
    // Llamamos a Apps Script para ver el estado real de los sellos
    const resp = await axios.get(
      `${BACKEND_URL}?accion=estadoCliente&chatId=${encodeURIComponent(
        chatId
      )}`
    );
    const data = resp.data || {};

    // Si no tiene tarjeta, mostramos solo la tarjeta base y un mensaje motivador
    if (!data.tieneTarjeta) {
      let texto =
        `🏆 Tarjeta de sellos de ${nombreCliente}\n\n` +
        `Todavía no tenés sellos cargados. Comprando en ${cfg.nombre} vas a empezar a sumar y canjear beneficios.`;

      if (cfg.tarjetaURL) {
        try {
          await bot.sendPhoto(chatId, cfg.tarjetaURL, {
            caption: texto
          });
          return;
        } catch (e) {
          console.error("Error enviando tarjeta de sellos:", e.message);
        }
      }

      await bot.sendMessage(chatId, texto);
      return;
    }

    // Si tiene datos de cliente
    const nivel = data.nivelActual || "Sin nivel";
    const sellosNivel = data.sellosNivelActual || 0;
    const sellosActuales = data.sellosActuales || 0;
    const totalSellos = data.sellosTotalesAcumulados || 0;
    const beneficioProx = data.beneficioProximo || "";
    const beneficioDisponible = data.beneficioDisponible === true;
    const descBenef = data.descripcionBeneficio || "";
    const venceEl = data.venceEl || "";
    const codigoCanje = data.codigoCanje || "";
    const tarjetaImagenUrl =
      data.tarjetaImagenUrl || cfg.tarjetaURL || cfg.logoUrl || "";

    let texto =
      `🏆 Tarjeta de sellos de ${data.nombreCliente || nombreCliente}\n\n` +
      `Nivel actual: ${nivel}\n` +
      `Sellos en este nivel: ${sellosActuales} / ${sellosNivel}\n` +
      `Sellos totales acumulados: ${totalSellos}\n\n`;

    if (beneficioProx) {
      texto += `Próximo beneficio: ${beneficioProx}\n\n`;
    }

    if (beneficioDisponible) {
      texto += `🎁 Tenés un beneficio disponible: ${descBenef || "Beneficio listo para canjear"}\n`;
      if (codigoCanje) texto += `Código de canje: ${codigoCanje}\n`;
      if (venceEl) texto += `Vence el: ${venceEl}\n`;
      texto += `\nMostrá este mensaje en el local para canjear tu beneficio.`;
    } else {
      texto += `Seguí sumando sellos para desbloquear tu próximo beneficio 🎉`;
    }

    if (tarjetaImagenUrl) {
      try {
        await bot.sendPhoto(chatId, tarjetaImagenUrl, {
          caption: texto
        });
        return;
      } catch (e) {
        console.error("Error enviando tarjeta de sellos cliente:", e.message);
      }
    }

    await bot.sendMessage(chatId, texto);
  } catch (err) {
    console.error("Error en mostrarSellos:", err.message);
    // fallback simple
    let simple =
      `🏆 Tarjeta de sellos de ${nombreCliente}\n\n` +
      `No pude leer tus datos de sellos en este momento, pero el sistema está activo.\n` +
      `Consultá con el vendedor para que verifique tu tarjeta.`;
    if (cfg.tarjetaURL) {
      try {
        await bot.sendPhoto(chatId, cfg.tarjetaURL, {
          caption: simple
        });
        return;
      } catch (e) {}
    }
    await bot.sendMessage(chatId, simple);
  }
}

// ==========================
//  INFORMACIÓN DEL LOCAL
// ==========================

async function mostrarInfoLocal(chatId) {
  const nombre = cfg.nombre || "Tu tienda";
  const direccion = cfg.direccion || "Dirección no configurada";
  const horarios = cfg.horarios || "";
  const tel = cfg.telefono || "";
  const insta = cfg.instagram || "";
  const face = cfg.facebook || "";
  const whats = cfg.whatsappLink || "";

  let texto = `🏬 ${nombre}\n\n`;
  texto += `📍 Dirección: ${direccion}\n`;
  if (horarios) texto += `🕒 Horarios: ${horarios}\n`;
  if (tel) texto += `📞 Teléfono: ${tel}\n`;
  if (insta) texto += `📸 Instagram: ${insta}\n`;
  if (face) texto += `📘 Facebook: ${face}\n`;
  if (whats) texto += `💬 WhatsApp: ${whats}\n`;

  texto += `\nGracias por elegir productos frescos y de calidad 💛`;

  if (cfg.logoUrl) {
    try {
      await bot.sendPhoto(chatId, cfg.logoUrl, {
        caption: texto
      });
      return;
    } catch (e) {
      console.error("Error enviando logo en InfoLocal:", e.message);
    }
  }

  await bot.sendMessage(chatId, texto);
}

// ==========================
//  COMPARTIR EL BOT
// ==========================

async function compartirBot(chatId) {
  if (!cfg.compartirBotActivo) {
    await bot.sendMessage(
      chatId,
      "Pronto vas a poder compartir este bot con tus contactos y ganar sellos extra 🧀✨"
    );
    return;
  }

  const nombre = cfg.nombre || "este comercio";
  const textoConfig = cfg.textoCompartirBot || "";
  const linkBot = botUsername ? `https://t.me/${botUsername}` : "";

  let texto =
    (textoConfig ||
      `📣 Compartí este bot con tus contactos para que también aprovechen las promos y sumen sellos.\n\n` +
        `🧀 Sumate a ${nombre} y disfrutá de productos frescos, combos y beneficios.`) +
    (linkBot ? `\n\n👉 Entrá al bot: ${linkBot}` : "");

  texto +=
    "\n\nPodés copiar este mensaje y pegarlo en WhatsApp, Instagram, email o donde quieras para invitar a tus contactos.";

  await bot.sendMessage(chatId, texto);
}

// ==========================
//  HABLAR CON EL VENDEDOR
// ==========================

async function hablarConVendedor(chatId) {
  const nombre = cfg.nombre || "el local";
  const whats = cfg.whatsappLink || "";
  let texto =
    `💬 Hola, soy el asistente de ${nombre}.\n\n` +
    "Escribí tu consulta por este chat y un vendedor real te va a responder.\n";

  if (whats) {
    texto += `\nSi preferís, también podés escribirnos por WhatsApp:\n${whats}`;
  }

  await bot.sendMessage(chatId, texto);
}

// ==========================
//  MANEJO DE MENSAJES
// ==========================

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const firstName = msg.from.first_name || "";
  const username = msg.from.username || "";

  // 1) Si está ingresando cantidad
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

  // 2) Comando /start
  if (text === "/start") {
    await enviarBienvenida(chatId, firstName);
    return;
  }

  // 3) Botones de texto del menú
  if (text === "🛍 Catálogo") {
    await mostrarCategorias(chatId);
    return;
  }
  if (text === "🛒 Mi carrito") {
    await mostrarCarrito(chatId);
    return;
  }
  if (text === "🏆 Mis sellos") {
    await mostrarSellos(chatId, msg.from);
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

  // 4) Cualquier otra cosa: tratamos como "hola" para simplificar la vida del cliente
  if (!text.startsWith("/")) {
    await enviarBienvenida(chatId, firstName);
    return;
  }
});

// ==========================
//  MANEJO DE CALLBACKS
// ==========================

bot.on("callback_query", async (query) => {
  const data = query.data || "";
  const msg = query.message;
  if (!msg || !msg.chat) {
    try {
      await bot.answerCallbackQuery(query.id);
    } catch (e) {}
    return;
  }

  const chatId = msg.chat.id;
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
      const codigo = data.slice(6);
      const producto = obtenerProductoPorCodigo(codigo);
      if (!producto) {
        await bot.sendMessage(
          chatId,
          "No encontré ese producto para compartir."
        );
      } else {
        const nombreNegocio = cfg.nombre || "este comercio";
        const moneda = getMoneda();
        const nombre = producto.nombre || producto.NOMBRE || "";
        const precio = producto.precio || producto.PRECIO || 0;
        const linkBot = botUsername ? `https://t.me/${botUsername}` : "";

        const textoShare =
          `Mirá esta promo de ${nombreNegocio}:\n` +
          `${nombre} — ${precio} ${moneda}\n` +
          (linkBot ? `Pedilo directo en el bot: ${linkBot}` : "");

        await bot.sendMessage(chatId, textoShare);
      }
    } else if (data === "confirmar_pedido") {
      const teclas = [];

      if (cfg.usaEnvioDomicilio) {
        const textoEnv =
          cfg.textoEnvioDomicilio || "Envío a domicilio";
        teclas.push([
          {
            text: `🚚 ${textoEnv}`,
            callback_data: "entrega:envio"
          }
        ]);
      }
      if (cfg.usaRetiroLocal) {
        const textoRet =
          cfg.textoRetiroLocal || "Retiro en el local";
        teclas.push([
          {
            text: `🏬 ${textoRet}`,
            callback_data: "entrega:retiro"
          }
        ]);
      }

      if (!teclas.length) {
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
      await bot.sendMessage(
        chatId,
        "Vacié tu carrito. Podés volver al catálogo para seguir comprando."
      );
    } else if (data.startsWith("entrega:")) {
      const tipo = data.split(":")[1]; // 'envio' o 'retiro'
      await enviarTicketPedido(chatId, tipo, username, firstName);
    }
  } catch (err) {
    console.error("Error en callback_query:", err.message);
  }

  try {
    await bot.answerCallbackQuery(query.id);
  } catch (e) {
    // ignorar
  }
});

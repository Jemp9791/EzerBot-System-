// index.js - EzerBot System para TODO QUESO (cliente)

import express from "express";
import axios from "axios";
import TelegramBot from "node-telegram-bot-api";

// 🔐 CONFIGURACIÓN DEL NEGOCIO (por ahora hardcodeado para TODO QUESO)
const BOT_TOKEN =
  "8130447159:AAHxzp5S1lcgYOemw5dgF5V1DGh141dHmkA";

const BACKEND_URL =
  "https://script.google.com/macros/s/AKfycbxznmXVhDFd45kwrtsO0lORoGDn7AcHVdQIYQkgYy_63jaJCrjumzphVK_N39T_zjK_/exec";

const WEBHOOK_PATH = "/webhook";
const PORT = process.env.PORT || 10000;

// ================== EXPRESS + TELEGRAM ==================

const app = express();
app.use(express.json());

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// ================== CATÁLOGO EN MEMORIA ==================

let catalogo = {
  productos: [],
  config: {
    nombreNegocio: "TODO QUESO CLUB",
    telefonoWhatsApp: "1122538102",
    telegramVendedorId: "7454984023",
    logoUrl: "https://i.postimg.cc/q7WvjsYm/20251206-210311.jpg",
    direccion: "Garín / Escobar",
    horario: "Lunes a sábados de 9 a 13 y 17 a 20 hs",
  },
};

async function cargarCatalogo() {
  try {
    console.log("Cargando catálogo desde backend…");
    const res = await axios.get(BACKEND_URL);
    const data = res.data || {};

    if (data.ok && Array.isArray(data.productos)) {
      catalogo.productos = data.productos;
      if (data.config) {
        catalogo.config = { ...catalogo.config, ...data.config };
      }
      console.log(
        `Catálogo cargado: ${catalogo.productos.length} productos.`
      );
    } else {
      console.error(
        "Backend respondió pero sin ok/productos:",
        JSON.stringify(data).slice(0, 200)
      );
    }
  } catch (err) {
    console.error(
      "Error cargando catálogo:",
      err.message || String(err)
    );
  }
}

// cargar una vez al inicio
cargarCatalogo();

// ================== SESIONES (CARRITOS) ==================

const sesiones = new Map(); // chatId -> { items, estado, productoPendiente }

function getSesion(chatId) {
  if (!sesiones.has(chatId)) {
    sesiones.set(chatId, {
      items: [],
      estado: "IDLE",
      productoPendiente: null,
    });
  }
  return sesiones.get(chatId);
}

// ================== MENÚ PRINCIPAL ==================

function menuPrincipalKeyboard() {
  return {
    keyboard: [
      ["🛍️ Catálogo", "🛒 Mi carrito"],
      ["🏆 Mis sellos", "💬 Hablar con el vendedor"],
      ["🏬 Información del local", "📢 Compartir el bot"],
    ],
    resize_keyboard: true,
  };
}

async function enviarBienvenida(chat) {
  const cfg = catalogo.config || {};
  const nombreChat = chat.first_name || chat.username || "¡Hola!";
  const texto =
    `🧀 ${nombreChat}, ¡bienvenido a ${cfg.nombreNegocio || "TODO QUESO"}!\n\n` +
    "Desde este bot podés:\n" +
    "• Ver el catálogo con fotos.\n" +
    "• Armar tu pedido paso a paso.\n" +
    "• Hablar con un vendedor.\n" +
    "• Sumar sellos y canjear beneficios.\n\n" +
    "Elegí una opción del menú de abajo para empezar 👇";

  // Logo primero (si hay)
  if (cfg.logoUrl) {
    try {
      await bot.sendPhoto(chat.id, cfg.logoUrl, {
        caption: cfg.nombreNegocio || "TODO QUESO",
      });
    } catch (e) {
      console.error("No se pudo enviar el logo:", e.message);
    }
  }

  await bot.sendMessage(chat.id, texto, {
    reply_markup: menuPrincipalKeyboard(),
  });
}

// ================== UTILIDADES DE CATÁLOGO ==================

function getCategorias() {
  const productos = Array.isArray(catalogo.productos)
    ? catalogo.productos
    : [];
  const set = new Set();
  for (const p of productos) {
    set.add(p.categoria || "General");
  }
  return [...set];
}

function emojiCategoria(cat) {
  const c = String(cat || "").toLowerCase();
  if (c.includes("queso")) return "🧀";
  if (c.includes("fiambre") || c.includes("embutido")) return "🥓";
  if (c.includes("pan")) return "🥖";
  if (c.includes("lácte") || c.includes("leche") || c.includes("yogur"))
    return "🥛";
  if (c.includes("bebida")) return "🥤";
  if (c.includes("promo") || c.includes("oferta")) return "💥";
  return "📦";
}

function encontrarProductoPorCodigo(cod) {
  const productos = Array.isArray(catalogo.productos)
    ? catalogo.productos
    : [];
  return productos.find(
    (p) => String(p.codigo).trim().toUpperCase() === String(cod).trim().toUpperCase()
  );
}

// ================== FLUJO: CATÁLOGO ==================

async function mostrarCategorias(chatId) {
  const categorias = getCategorias();
  if (!categorias.length) {
    await bot.sendMessage(
      chatId,
      "Todavía no hay productos cargados en el catálogo. Probá de nuevo en unos minutos."
    );
    await cargarCatalogo();
    return;
  }

  const botones = categorias.map((cat) => [
    { text: `${emojiCategoria(cat)} ${cat}` },
  ]);

  await bot.sendMessage(chatId, "Elegí una categoría:", {
    reply_markup: {
      keyboard: [
        ...botones,
        ["⬅️ Volver al menú principal"],
      ],
      resize_keyboard: true,
    },
  });
}

async function mostrarProductosDeCategoria(chatId, categoriaElegida) {
  const productos = catalogo.productos.filter((p) => {
    const cat = p.categoria || "General";
    return String(cat).toLowerCase() ===
      String(categoriaElegida).toLowerCase()
      || (categoriaElegida === "General" && !p.categoria);
  });

  if (!productos.length) {
    await bot.sendMessage(
      chatId,
      "No encontré productos en esa categoría. Probá con otra."
    );
    return;
  }

  await bot.sendMessage(
    chatId,
    `Te muestro algunas opciones de ${categoriaElegida}:`
  );

  for (const p of productos) {
    const precioStr = `${p.precio} ARS`;
    const codigoStr = p.codigo || "";
    const desc = p.descripcion ? `\n${p.descripcion}` : "";

    const texto =
      `🧀 <b>${p.nombre}</b>\n` +
      `Código: <code>${codigoStr}</code>\n` +
      `Precio: ${precioStr}${p.unidad ? " / " + p.unidad : ""}` +
      desc;

    const opts = {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🛒 Comprar",
              callback_data: `BUY_${codigoStr}`,
            },
            {
              text: "📤 Compartir promo",
              callback_data: `SHARE_${codigoStr}`,
            },
          ],
        ],
      },
    };

    if (p.imagen) {
      await bot.sendPhoto(chatId, p.imagen, {
        caption: texto,
        parse_mode: "HTML",
        reply_markup: opts.reply_markup,
      });
    } else {
      await bot.sendMessage(chatId, texto, opts);
    }
  }

  await bot.sendMessage(
    chatId,
    "Cuando quieras revisar tu pedido, usá el botón 🛒 *Mi carrito*.",
    { parse_mode: "Markdown" }
  );
}

// ================== FLUJO: CARRITO ==================

function calcularTotal(items) {
  return items.reduce((acc, it) => acc + (it.subtotal || 0), 0);
}

async function mostrarCarrito(chatId) {
  const sesion = getSesion(chatId);
  if (!sesion.items.length) {
    await bot.sendMessage(
      chatId,
      "🧺 Tu carrito está vacío por ahora.\nUsá *🛍️ Catálogo* para agregar productos.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  let texto = "🛍️ *Tu carrito*\n\n";
  sesion.items.forEach((it, idx) => {
    texto += `${idx + 1}) ${it.nombre} – ${it.cantidadTexto} – ${it.subtotal} ARS\n`;
  });

  const total = calcularTotal(sesion.items);
  texto += `\n*Total: ${total} ARS*\n\n`;
  texto +=
    "Si todo está bien, tocá *Confirmar pedido*.\n" +
    "Si querés empezar de cero, tocá *Vaciar carrito*.";

  await bot.sendMessage(chatId, texto, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Confirmar pedido", callback_data: "CONFIRM_ORDER" },
          { text: "🧹 Vaciar carrito", callback_data: "CLEAR_CART" },
        ],
      ],
    },
  });
}

// ================== FLUJO: SELLOS ==================

async function mostrarSellos(chat) {
  const cfg = catalogo.config || {};
  const nombre = chat.first_name || chat.username || "cliente";

  const texto =
    `🏆 Tarjeta de sellos de ${cfg.nombreNegocio || "TODO QUESO"}\n\n` +
    `${nombre}, muy pronto vas a ver aquí tus sellos acumulados.\n\n` +
    "Por ahora, cada compra que hagas desde el bot queda registrada para futuros beneficios.\n" +
    "Mostrá este mensaje en el local para que sepan que comprás desde el bot 💛";

  if (cfg.logoUrl) {
    await bot.sendPhoto(chat.id, cfg.logoUrl, {
      caption: texto,
    });
  } else {
    await bot.sendMessage(chat.id, texto);
  }
}

// ================== FLUJO: INF0 + HABLAR + COMPARTIR ==================

async function mostrarInfoLocal(chatId) {
  const cfg = catalogo.config || {};
  let texto =
    `🏬 *${cfg.nombreNegocio || "TODO QUESO"}*\n\n` +
    `📍 Dirección: ${cfg.direccion || "Escobar"}\n` +
    `🕒 Horario: ${cfg.horario || "Horarios a confirmar"}\n` +
    `☎️ Contacto: ${cfg.telefonoWhatsApp || "1122538102"}\n\n` +
    "Gracias por elegir productos frescos y de calidad 💛";

  const opts = {
    parse_mode: "Markdown",
    reply_markup: menuPrincipalKeyboard(),
  };

  if (cfg.logoUrl) {
    await bot.sendPhoto(chatId, cfg.logoUrl, {
      caption: texto,
      parse_mode: "Markdown",
      reply_markup: opts.reply_markup,
    });
  } else {
    await bot.sendMessage(chatId, texto, opts);
  }
}

async function hablarConVendedor(chatId) {
  const cfg = catalogo.config || {};
  const tel = cfg.telefonoWhatsApp || "1122538102";
  const linkWhatsApp = `https://wa.me/54${tel}?text=Hola%20soy%20cliente%20del%20bot%20TODO%20QUESO`;

  const texto =
    "💬 Escribí tu consulta y un vendedor te responderá.\n\n" +
    `También podés escribir directo por WhatsApp:\n${linkWhatsApp}`;

  await bot.sendMessage(chatId, texto, {
    reply_markup: menuPrincipalKeyboard(),
  });
}

async function compartirBot(chatId) {
  const texto =
    "Compartí este mensaje para que tus contactos también ganen sellos 🧀👇\n\n" +
    "🧀 *Sumate a TODO QUESO CLUB*\n" +
    "Comprá directo desde el bot, sumá sellos y canjeá beneficios.\n\n" +
    "👉 https://t.me/Ezer_IABot";

  await bot.sendMessage(chatId, texto, { parse_mode: "Markdown" });
}

// ================== FLUJO: COMPRA ==================

async function iniciarCompra(chatId, codigoProd) {
  const producto = encontrarProductoPorCodigo(codigoProd);
  if (!producto) {
    await bot.sendMessage(
      chatId,
      "No encontré ese producto. Probá desde el catálogo nuevamente."
    );
    return;
  }

  const sesion = getSesion(chatId);
  const unidad = String(producto.unidad || "").toLowerCase();
  const esPorKg =
    unidad.includes("kg") || unidad.includes("kilo") || unidad.includes("gram");

  sesion.estado = "ESPERA_CANTIDAD";
  sesion.productoPendiente = {
    codigo: producto.codigo,
    esPorKg,
  };

  if (esPorKg) {
    await bot.sendMessage(
      chatId,
      `¿Cuántos gramos de *${producto.nombre}* querés?\nEjemplo: 250, 500, 1000`,
      { parse_mode: "Markdown" }
    );
  } else {
    await bot.sendMessage(
      chatId,
      `¿Cuántas unidades de *${producto.nombre}* querés?`,
      { parse_mode: "Markdown" }
    );
  }
}

async function procesarCantidad(chat, texto) {
  const chatId = chat.id;
  const sesion = getSesion(chatId);
  const pendiente = sesion.productoPendiente;

  if (!pendiente) {
    sesion.estado = "IDLE";
    return;
  }

  const cantidadNum = parseInt(texto.trim(), 10);
  if (isNaN(cantidadNum) || cantidadNum <= 0) {
    await bot.sendMessage(
      chatId,
      "Necesito un número válido. Probá de nuevo 🙂"
    );
    return;
  }

  const producto = encontrarProductoPorCodigo(pendiente.codigo);
  if (!producto) {
    sesion.estado = "IDLE";
    sesion.productoPendiente = null;
    await bot.sendMessage(
      chatId,
      "El producto ya no está disponible. Probá desde el catálogo."
    );
    return;
  }

  let cantidadTexto = "";
  let subtotal = 0;

  if (pendiente.esPorKg) {
    cantidadTexto = `${cantidadNum} g`;
    const precioKg = Number(producto.precioporkg || producto.precio || 0);
    subtotal = Math.round((precioKg * cantidadNum) / 1000);
  } else {
    cantidadTexto = `${cantidadNum} un.`;
    const precioUnidad = Number(producto.precio || 0);
    subtotal = precioUnidad * cantidadNum;
  }

  sesion.items.push({
    codigo: producto.codigo,
    nombre: producto.nombre,
    cantidadTexto,
    subtotal,
  });

  sesion.estado = "IDLE";
  sesion.productoPendiente = null;

  await bot.sendMessage(
    chatId,
    `🛒 Agregué ${cantidadTexto} de *${producto.nombre}*.\nSubtotal: *${subtotal} ARS*`,
    { parse_mode: "Markdown" }
  );

  await bot.sendMessage(
    chatId,
    "¿Querés seguir comprando? Usá *🛍️ Catálogo*.\n" +
      "Cuando estés listo, revisá *🛒 Mi carrito* para confirmar tu pedido.",
    { parse_mode: "Markdown" }
  );
}

async function confirmarPedido(chatId, tipoEntrega) {
  const sesion = getSesion(chatId);
  if (!sesion.items.length) {
    await bot.sendMessage(
      chatId,
      "Tu carrito está vacío. Primero agregá productos desde el catálogo."
    );
    return;
  }

  const cfg = catalogo.config || {};
  const total = calcularTotal(sesion.items);

  let detalle = "";
  sesion.items.forEach((it, idx) => {
    detalle += `${idx + 1}) ${it.nombre} – ${it.cantidadTexto} – ${it.subtotal} ARS\n`;
  });

  const textoCliente =
    "🎉 *Pedido confirmado*\n\n" +
    `Tipo: *${tipoEntrega}*\n` +
    `Total: *${total} ARS*\n\n` +
    "Un vendedor va a contactarte para coordinar pago y entrega.\n" +
    "¡Gracias por tu compra! 💛";

  await bot.sendMessage(chatId, textoCliente, { parse_mode: "Markdown" });

  // Aviso al vendedor por Telegram
  try {
    const vendedorId = Number(cfg.telegramVendedorId);
    if (vendedorId) {
      const aviso =
        "📥 *Nuevo pedido desde el bot*\n\n" +
        `Cliente chatId: ${chatId}\n` +
        `Tipo entrega: ${tipoEntrega}\n` +
        `Total: ${total} ARS\n\n` +
        "Detalle:\n" +
        detalle;
      await bot.sendMessage(vendedorId, aviso, {
        parse_mode: "Markdown",
      });
    }
  } catch (e) {
    console.error("Error avisando al vendedor:", e.message);
  }

  // Limpiar carrito
  sesion.items = [];
}

// ================== MANEJO DE MENSAJES ==================

bot.on("message", async (msg) => {
  try {
    const chatId = msg.chat.id;
    const texto = (msg.text || "").trim();

    // Si está esperando cantidad, procesar primero
    const sesion = getSesion(chatId);
    if (sesion.estado === "ESPERA_CANTIDAD" && texto) {
      await procesarCantidad(msg.chat, texto);
      return;
    }

    // /start o cualquier texto que no coincida con nada => bienvenida
    if (!texto || texto === "/start") {
      await enviarBienvenida(msg.chat);
      return;
    }

    // Botones principales
    if (texto === "🛍️ Catálogo") {
      await mostrarCategorias(chatId);
      return;
    }

    if (texto === "🛒 Mi carrito") {
      await mostrarCarrito(chatId);
      return;
    }

    if (texto === "🏆 Mis sellos") {
      await mostrarSellos(msg.chat);
      return;
    }

    if (texto === "💬 Hablar con el vendedor") {
      await hablarConVendedor(chatId);
      return;
    }

    if (texto === "🏬 Información del local") {
      await mostrarInfoLocal(chatId);
      return;
    }

    if (texto === "📢 Compartir el bot") {
      await compartirBot(chatId);
      return;
    }

    if (texto === "⬅️ Volver al menú principal") {
      await enviarBienvenida(msg.chat);
      return;
    }

    // Si el texto coincide con una categoría (por si el usuario toca el botón)
    const categorias = getCategorias();
    const catEncontrada = categorias.find((c) =>
      texto.endsWith(c)
    );
    if (catEncontrada) {
      await mostrarProductosDeCategoria(chatId, catEncontrada);
      return;
    }

    // Cualquier otra cosa => recordatorio suave + menú
    await bot.sendMessage(
      chatId,
      "Te muestro el menú principal para que sigamos 👇"
    );
    await enviarBienvenida(msg.chat);
  } catch (err) {
    console.error("Error en on(message):", err.message || err);
  }
});

// ================== CALLBACK QUERIES (botones inline) ==================

bot.on("callback_query", async (query) => {
  try {
    const data = query.data || "";
    const chatId = query.message.chat.id;

    if (data.startsWith("BUY_")) {
      const codigo = data.substring(4);
      await iniciarCompra(chatId, codigo);
    } else if (data.startsWith("SHARE_")) {
      const codigo = data.substring(6);
      const prod = encontrarProductoPorCodigo(codigo);
      if (prod) {
        const texto =
          "Mirá esta promo de TODO QUESO 🧀\n\n" +
          `${prod.nombre}\n` +
          `Precio: ${prod.precio} ARS` +
          (prod.unidad ? " / " + prod.unidad : "") +
          "\n\n" +
          "Podés comprar directo desde el bot:\n" +
          "👉 https://t.me/Ezer_IABot";
        await bot.sendMessage(chatId, texto);
      }
    } else if (data === "CONFIRM_ORDER") {
      // Pedir tipo de entrega
      await bot.sendMessage(
        chatId,
        "¿Cómo querés recibir tu pedido?",
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🏬 Retiro en local",
                  callback_data: "DELIVERY_LOCAL",
                },
                {
                  text: "🚚 Envío a domicilio",
                  callback_data: "DELIVERY_DELIVERY",
                },
              ],
            ],
          },
        }
      );
    } else if (data === "CLEAR_CART") {
      const sesion = getSesion(chatId);
      sesion.items = [];
      await bot.sendMessage(chatId, "Vacié tu carrito 🧺");
    } else if (data === "DELIVERY_LOCAL") {
      await confirmarPedido(chatId, "Retiro en local");
    } else if (data === "DELIVERY_DELIVERY") {
      await confirmarPedido(chatId, "Envío a domicilio");
    }

    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    console.error("Error en callback_query:", err.message || err);
  }
});

// ================== EXPRESS: WEBHOOK ==================

app.get("/", (req, res) => {
  res.send("EzerBot backend activo");
});

app.post(WEBHOOK_PATH, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Servidor iniciado en puerto ${PORT}`);
});

import express from "express";
import TelegramBot from "node-telegram-bot-api";
import axios from "axios";

// ================== CONFIG BÁSICA ==================
const TOKEN =
  "8130447159:AAHxzp5S1lcgYOemw5dgF5V1DGh141dHmkA";

const SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbyxm5E2Y7t0hgqh48-AVWpiru2MBXM3E-53T5WgnljMZb_CXZx-F-akgIJVJ4j76MjE/exec";

const LOGO_URL =
  "https://i.postimg.cc/q7WvjsYm/20251206-210311.jpg";

// WhatsApp del vendedor (por ahora sos vos)
const WHATSAPP_VENDEDOR = "1122538102";

const bot = new TelegramBot(TOKEN, { polling: false });

const app = express();
app.use(express.json());

// ================== ESTADO EN MEMORIA (CARRITOS) ==================
/*
  carts = {
    [chatId]: {
      items: [ { codigo, nombre, cantidad, unidad, precio, subtotal } ],
      state: 'idle' | 'waiting_qty' | 'waiting_delivery',
      pendingProduct: null
    }
  }
*/
const carts = {};

function getCart(chatId) {
  if (!carts[chatId]) {
    carts[chatId] = {
      items: [],
      state: "idle",
      pendingProduct: null,
    };
  }
  return carts[chatId];
}

// ================== MENÚ PRINCIPAL ==================
function mainMenu() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🛍️ Catálogo" }],
        [{ text: "🛒 Mi carrito" }],
        [{ text: "🏆 Mis sellos" }],
        [{ text: "💬 Hablar con el vendedor" }],
        [{ text: "ℹ️ Información del local" }],
        [{ text: "📣 Compartir el bot" }],
      ],
      resize_keyboard: true,
    },
  };
}

// ================== PRESENTACIÓN ==================
async function sendWelcome(chatId) {
  await bot.sendPhoto(chatId, LOGO_URL, {
    caption:
      "🧀 *¡Bienvenido a TODO QUESO CLUB!* 🧀\n\n" +
      "Tu fiambrería y quesería favorita ahora tiene su *asistente inteligente* 🤖💛\n\n" +
      "Desde este bot podés:\n" +
      "• Ver el catálogo con fotos\n" +
      "• Armar tu pedido y enviarlo\n" +
      "• Sumar sellos y canjear beneficios\n" +
      "• Hablar directo con el vendedor\n\n" +
      "Elegí una opción del menú de abajo para empezar 👇",
    parse_mode: "Markdown",
    ...mainMenu(),
  });
}

// ================== CATÁLOGO DESDE APPS SCRIPT ==================
async function getCatalog() {
  const url = `${SCRIPT_URL}?accion=catalogo`;
  const res = await axios.get(url);
  const data = res.data || {};
  const items = data.items || [];

  // Normalizamos para asegurarnos de tener todo
  return items.map((it, idx) => {
    // Soportar mayúsculas/minúsculas o nombres anteriores
    const codigo =
      it.codigo || it.CODIGO || `P${idx + 1}`;
    const nombre =
      it.nombre || it.NOMBRE || `Producto ${idx + 1}`;
    const precio = Number(it.precio || it.PRECIO || 0);
    const descripcion =
      it.descripcion || it.DESCRIPCION || "";
    const imagen =
      it.imagenUrl || it.IMAGEN || LOGO_URL;
    const categoria =
      it.categoria || it.CATEGORIA || "General";
    const unidad =
      it.unidad || it.UNIDAD || "unidad";

    return {
      codigo,
      nombre,
      precio,
      descripcion,
      imagen,
      categoria,
      unidad,
    };
  });
}

async function showCategories(chatId) {
  try {
    const catalog = await getCatalog();
    const categorias = [
      ...new Set(catalog.map((p) => p.categoria)),
    ];

    await bot.sendMessage(chatId, "Elegí una categoría:", {
      reply_markup: {
        inline_keyboard: categorias.map((c) => [
          {
            text: `📦 ${c}`,
            callback_data: `cat_${c}`,
          },
        ]),
      },
    });
  } catch (err) {
    console.error("Error showCategories:", err);
    await bot.sendMessage(
      chatId,
      "Ups, el catálogo no se pudo cargar en este momento. Probá de nuevo en unos minutos 🙏"
    );
  }
}

async function showCategoryProducts(chatId, category) {
  try {
    const catalog = await getCatalog();
    const filtered = catalog.filter(
      (p) => p.categoria === category
    );

    if (filtered.length === 0) {
      await bot.sendMessage(
        chatId,
        "Por ahora no hay productos en esta categoría."
      );
      return;
    }

    for (const p of filtered) {
      await bot.sendPhoto(chatId, p.imagen, {
        caption:
          `*${p.nombre}*\n\n` +
          `Código: *${p.codigo}*\n` +
          `Precio: *$${p.precio}* por ${p.unidad}\n\n` +
          `${p.descripcion}`,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🛍️ Comprar",
                callback_data: `buy_${p.codigo}`,
              },
            ],
            [
              {
                text: "📣 Compartir promo",
                callback_data: `share_${p.codigo}`,
              },
            ],
          ],
        },
      });
    }
  } catch (err) {
    console.error("Error showCategoryProducts:", err);
    await bot.sendMessage(
      chatId,
      "No pude mostrar los productos de esa categoría. Intentá más tarde 🙏"
    );
  }
}

// ================== COMPARTIR PROMO ==================
async function shareProduct(chatId, productCode) {
  try {
    const catalog = await getCatalog();
    const p = catalog.find(
      (it) => it.codigo === productCode
    );
    if (!p) {
      await bot.sendMessage(
        chatId,
        "No encontré ese producto para compartir."
      );
      return;
    }

    const msg =
      `📣 *Recomendación de TODO QUESO CLUB*\n\n` +
      `Probá *${p.nombre}* por solo *$${p.precio}* 😍🧀\n` +
      `¡Pedilo desde el bot y ganá sellos!\n\n` +
      `👉 https://t.me/Ezer_IA_Bot`;

    await bot.sendMessage(chatId, msg, {
      parse_mode: "Markdown",
    });
  } catch (err) {
    console.error("Error shareProduct:", err);
    await bot.sendMessage(
      chatId,
      "No se pudo generar el mensaje para compartir la promo."
    );
  }
}

// ================== TARJETA DE SELLOS ==================
async function showLoyaltyCard(chatId) {
  try {
    const url = `${SCRIPT_URL}?accion=estadoCliente&chatId=${chatId}`;
    const res = await axios.get(url);
    const data = res.data || {};

    if (!data.tieneTarjeta) {
      await bot.sendPhoto(chatId, LOGO_URL, {
        caption:
          "🏆 *Tu tarjeta TODO QUESO CLUB*\n\n" +
          "Todavía no tenés sellos cargados.\n" +
          "Hacé tu primer compra desde el bot y empezás a sumar automáticamente 💛",
        parse_mode: "Markdown",
      });
      return;
    }

    const nombre = data.nombreCliente || "";
    const sellos = data.sellosTotalesAcumulados || 0;
    const nivel = data.nivelActual || "";
    const beneficioProx = data.beneficioProximo || "";

    let texto =
      `🏆 *Tu tarjeta TODO QUESO CLUB*\n\n` +
      `Cliente: *${nombre}*\n` +
      `Sellos acumulados: *${sellos}*\n` +
      `Nivel actual: *${nivel}*\n\n`;

    if (beneficioProx) {
      texto +=
        `Próximo beneficio: *${beneficioProx}*\n\n`;
    }

    texto +=
      "Seguí comprando desde el bot para seguir sumando y canjear beneficios 😍";

    await bot.sendPhoto(chatId, LOGO_URL, {
      caption: texto,
      parse_mode: "Markdown",
    });
  } catch (err) {
    console.error("Error showLoyaltyCard:", err);
    await bot.sendPhoto(chatId, LOGO_URL, {
      caption:
        "🏆 *Tu tarjeta TODO QUESO CLUB*\n\n" +
        "El módulo de sellos está conectándose. Si ya tenés compras cargadas se verán pronto.\n\n" +
        "Mientras tanto, podés seguir comprando y las iremos sumando 💛",
      parse_mode: "Markdown",
    });
  }
}

// ================== COMPRA / CARRITO ==================
async function startPurchase(chatId, productCode) {
  try {
    const catalog = await getCatalog();
    const p = catalog.find(
      (it) => it.codigo === productCode
    );
    if (!p) {
      await bot.sendMessage(
        chatId,
        "No encontré ese producto."
      );
      return;
    }

    const cart = getCart(chatId);
    cart.state = "waiting_qty";
    cart.pendingProduct = p;

    const unidadTxt =
      p.unidad === "kg" ? "gramos (ej: 100, 250, 500)" : "unidades (ej: 1, 2, 3)";

    await bot.sendMessage(
      chatId,
      `🛍️ ¿Cuánta cantidad querés de *${p.nombre}*?\n` +
        `Escribí solo el número en ${unidadTxt}.`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error("Error startPurchase:", err);
    await bot.sendMessage(
      chatId,
      "No pude iniciar la compra de ese producto."
    );
  }
}

async function handleQuantityMessage(chatId, text) {
  const cart = getCart(chatId);
  const p = cart.pendingProduct;
  if (!p) return;

  const cantidad = Number(
    (text || "").toString().replace(",", ".")
  );
  if (isNaN(cantidad) || cantidad <= 0) {
    await bot.sendMessage(
      chatId,
      "Decime una cantidad válida (solo números)."
    );
    return;
  }

  let cantidadReal = cantidad;
  if (p.unidad === "kg") {
    // suponemos que ingresa gramos
    cantidadReal = cantidad / 1000;
  }

  const subtotal = Math.round(
    cantidadReal * p.precio
  );

  cart.items.push({
    codigo: p.codigo,
    nombre: p.nombre,
    cantidad:
      p.unidad === "kg"
        ? `${cantidad} g`
        : `${cantidad} un.`,
    unidad: p.unidad,
    precio: p.precio,
    subtotal,
  });

  cart.state = "idle";
  cart.pendingProduct = null;

  await bot.sendMessage(
    chatId,
    `✅ Agregué *${p.nombre}* al carrito.\n` +
      `Subtotal de este producto: *$${subtotal}*`,
    { parse_mode: "Markdown" }
  );

  await bot.sendMessage(
    chatId,
    "¿Querés seguir viendo el catálogo o revisar tu carrito?",
    mainMenu()
  );
}

function getCartText(cart) {
  if (!cart.items.length) {
    return "Tu carrito está vacío por ahora 🛒";
  }

  let total = 0;
  let txt = "🛒 *Tu carrito*\n\n";
  cart.items.forEach((it, idx) => {
    total += it.subtotal;
    txt +=
      `${idx + 1}) ${it.nombre} – ${it.cantidad} – $${it.subtotal}\n`;
  });
  txt += `\nTotal: *$${total}*`;
  return txt;
}

async function showCart(chatId) {
  const cart = getCart(chatId);
  const txt = getCartText(cart);

  await bot.sendMessage(chatId, txt, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: cart.items.length
        ? [
            [
              {
                text: "✅ Confirmar pedido",
                callback_data: "confirm_order",
              },
            ],
            [
              {
                text: "🗑️ Vaciar carrito",
                callback_data: "empty_cart",
              },
            ],
          ]
        : [],
    },
  });
}

async function confirmOrder(chatId) {
  const cart = getCart(chatId);
  if (!cart.items.length) {
    await bot.sendMessage(
      chatId,
      "Tu carrito está vacío."
    );
    return;
  }

  cart.state = "waiting_delivery";

  await bot.sendMessage(
    chatId,
    "¿Cómo querés recibir tu pedido?",
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🏪 Retiro en local",
              callback_data: "delivery_local",
            },
          ],
          [
            {
              text: "🚚 Envío a domicilio",
              callback_data: "delivery_envio",
            },
          ],
        ],
      },
    }
  );
}

async function finalizeOrder(chatId, tipo) {
  const cart = getCart(chatId);
  const txt = getCartText(cart);
  let total = 0;
  cart.items.forEach((it) => (total += it.subtotal));

  const tipoTxt =
    tipo === "local" ? "Retiro en local" : "Envío a domicilio";

  await bot.sendMessage(
    chatId,
    "🎉 *Pedido confirmado*\n\n" +
      `${txt}\n\n` +
      `Tipo de entrega: *${tipoTxt}*\n\n` +
      "Un vendedor va a contactarte para coordinar *pago y horario de entrega* 💛",
    { parse_mode: "Markdown" }
  );

  // Sugerencia sutil para escribir por WhatsApp
  await bot.sendMessage(
    chatId,
    `Si querés adelantar el contacto, podés escribir al WhatsApp del local:\n` +
      `📲 https://wa.me/${WHATSAPP_VENDEDOR}?text=Hola%20soy%20cliente%20del%20bot%20TODO%20QUESO%20y%20ya%20hice%20mi%20pedido.`
  );

  // Limpiamos carrito
  carts[chatId] = {
    items: [],
    state: "idle",
    pendingProduct: null,
  };
}

// ================== INFO DEL LOCAL / COMPARTIR / VENDEDOR ==================
async function sendInfoLocal(chatId) {
  await bot.sendPhoto(chatId, LOGO_URL, {
    caption:
      "🏪 *TODO QUESO CLUB*\n\n" +
      "📍 Garín, zona centro\n" +
      "🕒 Lun a Sáb 9 a 20 hs\n" +
      "📞 11 2253-8102\n\n" +
      "Gracias por elegir productos frescos y de calidad 💛",
    parse_mode: "Markdown",
  });
}

async function shareBot(chatId) {
  await bot.sendMessage(
    chatId,
    "Compartí este mensaje para que tus contactos también ganen sellos 🧀👇\n\n" +
      "🧀 *Sumate a TODO QUESO CLUB*\n" +
      "Comprá directo desde el bot, sumá sellos y canjeá beneficios.\n\n" +
      "👉 https://t.me/Ezer_IABot",
    { parse_mode: "Markdown" }
  );
}

// ================== CALLBACK QUERY ==================
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const data = q.data || "";

  try {
    if (data.startsWith("cat_")) {
      const cat = data.substring(4);
      await showCategoryProducts(chatId, cat);
      return;
    }

    if (data.startsWith("buy_")) {
      const code = data.substring(4);
      await startPurchase(chatId, code);
      return;
    }

    if (data.startsWith("share_")) {
      const code = data.substring(6);
      await shareProduct(chatId, code);
      return;
    }

    if (data === "confirm_order") {
      await confirmOrder(chatId);
      return;
    }

    if (data === "empty_cart") {
      carts[chatId] = {
        items: [],
        state: "idle",
        pendingProduct: null,
      };
      await bot.sendMessage(
        chatId,
        "Vacié tu carrito 🗑️",
        mainMenu()
      );
      return;
    }

    if (data === "delivery_local") {
      await finalizeOrder(chatId, "local");
      return;
    }

    if (data === "delivery_envio") {
      await finalizeOrder(chatId, "envio");
      return;
    }
  } catch (err) {
    console.error("Error en callback_query:", err);
    await bot.sendMessage(
      chatId,
      "Ocurrió un error procesando tu acción. Probá de nuevo."
    );
  }
});

// ================== MENSAJES ==================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  // Si está esperando cantidad para un producto
  const cart = getCart(chatId);
  if (cart.state === "waiting_qty") {
    return handleQuantityMessage(chatId, text);
  }

  // Normalizamos saludos para disparar la bienvenida
  const lower = text.toLowerCase();
  if (
    text === "/start" ||
    ["hola", "buenas", "menu", "menú"].includes(lower)
  ) {
    return sendWelcome(chatId);
  }

  try {
    switch (text) {
      case "🛍️ Catálogo":
        await showCategories(chatId);
        break;

      case "🛒 Mi carrito":
        await showCart(chatId);
        break;

      case "🏆 Mis sellos":
        await showLoyaltyCard(chatId);
        break;

      case "💬 Hablar con el vendedor":
        await bot.sendMessage(
          chatId,
          "Escribí tu consulta y un vendedor te responderá 💛"
        );
        break;

      case "ℹ️ Información del local":
        await sendInfoLocal(chatId);
        break;

      case "📣 Compartir el bot":
        await shareBot(chatId);
        break;

      default:
        // Cualquier otra cosa: recordamos el menú
        await bot.sendMessage(
          chatId,
          "Elegí una opción del menú 👇",
          mainMenu()
        );
        break;
    }
  } catch (err) {
    console.error("Error en on(message):", err);
    await bot.sendMessage(
      chatId,
      "Ups, algo falló. Probá de nuevo en un momento."
    );
  }
});

// ================== WEBHOOK ==================
app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ================== SERVER ==================
app.listen(10000, () => {
  console.log("EzerBot escuchando en puerto 10000");
});

// index.js - EzerBot Todo Queso (Render + GitHub)

const express = require("express");
const app = express();

app.use(express.json());

// === CONFIGURACIÓN DE ENTORNO ===
const BOT_TOKEN = process.env.BOT_TOKEN;          // poné tu token en Render
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // tu chat ID (7454984023)
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// === CONFIG DEL NEGOCIO ===
const BUSINESS = {
  name: "Todo Queso Club",
  address: "Carlos Pellegrini 526, Garín",
  phone: "3484230184",
  instagram: "@todoqueso.club",
  hours: "LUN a SAB 08:30-14:00 / 16:30-21:00",
  logoUrl: "https://i.ibb.co/BVjqHgK/todoqueso-logo.png", // CAMBIAR si querés
  shareBotLink: "https://t.me/EzerBot", // link del bot para compartir
  transferInfo:
    "Alias: TODOQUESO.CLUB\nBanco: Banco Ejemplo\nTitular: Todo Queso Club\nCUIT: 20-12345678-9",
  stampsToReward: 10,
  stampRewardText:
    "2 prepizzas, 400 g de queso, 200 g de paleta | Picada para 2 + Coca Cola 1,5 L | Picada premium para 4 + 4 cervezas lata + 500 g de pan fresco",
};

// === CATALOGO (ejemplo, cambialo con tus datos reales) ===
const CATEGORIES = [
  {
    id: "promos",
    name: "Promos",
    products: [],
  },
  {
    id: "quesos",
    name: "Quesos",
    products: [
      {
        id: "cremon",
        name: "CREMON",
        price: 11500,
        description: "Queso Cremón por pieza",
        photo: "https://i.ibb.co/0Z2MBS7/cremon.png",
      },
      {
        id: "muzza-barraza",
        name: "MUZZA BARRAZA",
        price: 8500,
        description: "Muzzarella BARRAZA",
        photo: "https://i.ibb.co/9ZFkSXF/muzza-barraza.png",
      },
      {
        id: "queso-maquina",
        name: "QUESO DE MAQUINA",
        price: 9800,
        description: "Queso de máquina en fetas",
        photo: "https://i.ibb.co/PggrM6v/queso-maquina.png",
      },
    ],
  },
  {
    id: "panificados",
    name: "Panificados",
    products: [
      {
        id: "pan-fresco",
        name: "PAN FRESCO",
        price: 2200,
        description: "Pan fresco del día",
        photo: "https://i.ibb.co/5Gh4Lpm/pan-fresco.png",
      },
    ],
  },
  {
    id: "lacteos",
    name: "Lácteos",
    products: [],
  },
  {
    id: "fiambres",
    name: "Fiambres",
    products: [],
  },
];

// === MEMORIA EN RAM (por chat) ===
const carts = new Map();     // chatId -> [{ productId, name, price, qty }]
const stamps = new Map();    // chatId -> number
const flows = new Map();     // chatId -> checkout flow
const carousels = new Map(); // chatId -> { categoryId, index }

// === HELPERS TELEGRAM ===
async function tgCall(method, body) {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error("Telegram error", method, data);
  }
  return data;
}

function sendMessage(chat_id, text, extra = {}) {
  return tgCall("sendMessage", {
    chat_id,
    text,
    parse_mode: "Markdown",
    ...extra,
  });
}

function sendPhoto(chat_id, photo, caption, extra = {}) {
  return tgCall("sendPhoto", {
    chat_id,
    photo,
    caption,
    parse_mode: "Markdown",
    ...extra,
  });
}

function answerCallbackQuery(id, text, show_alert = false) {
  return tgCall("answerCallbackQuery", {
    callback_query_id: id,
    text,
    show_alert,
  });
}

// === MAIN WEBHOOK ===
app.post("/webhook", async (req, res) => {
  const update = req.body;

  try {
    if (update.message) {
      await handleMessage(update.message);
    } else if (update.callback_query) {
      await handleCallback(update.callback_query);
    }
  } catch (e) {
    console.error("Error handling update", e);
  }

  res.sendStatus(200);
});

// Root simple
app.get("/", (req, res) => {
  res.send("EzerBot TodoQueso (Render)");
});

// === LOGICA DEL BOT ===
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  const flow = flows.get(chatId);
  if (flow) {
    await continueCheckoutFlow(msg, flow);
    return;
  }

  if (text === "/start") {
    await sendWelcome(chatId);
    return;
  }

  switch (text) {
    case "🛍️ Catálogo":
    case "Catálogo":
      await showCategories(chatId);
      break;

    case "🛒 Mi carrito":
    case "Mi carrito":
      await showCart(chatId);
      break;

    case "✅ Finalizar compra":
    case "Finalizar compra":
      await startCheckout(chatId);
      break;

    case "🎟️ Tarjeta de sellos":
    case "Tarjeta de sellos":
      await showStamps(chatId);
      break;

    case "📢 Compartir el bot":
    case "Compartir el bot":
      await shareBot(chatId);
      break;

    case "📋 Menú":
    case "Menú":
    default:
      await showMainMenu(chatId, "Elegí una opción del menú:");
      break;
  }
}

async function handleCallback(cq) {
  const data = cq.data || "";
  const chatId = cq.message.chat.id;
  const msgId = cq.message.message_id;

  // categorías
  if (data.startsWith("cat:")) {
    const categoryId = data.split(":")[1];
    await showCategoryCarousel(chatId, msgId, categoryId, 0, true);
    return;
  }

  // carrusel
  if (data.startsWith("car_prev:") || data.startsWith("car_next:")) {
    const [, direction, categoryId, idxStr] = data.split(":");
    let index = parseInt(idxStr, 10) || 0;
    const cat = CATEGORIES.find((c) => c.id === categoryId);
    if (!cat || !cat.products.length) return;
    const count = cat.products.length;

    if (direction === "prev") index = (index - 1 + count) % count;
    else index = (index + 1) % count;

    await showCategoryCarousel(chatId, msgId, categoryId, index, false);
    return;
  }

  // agregar al carrito
  if (data.startsWith("add:")) {
    const [, categoryId, productId] = data.split(":");
    const product = findProduct(categoryId, productId);
    if (!product) {
      await answerCallbackQuery(cq.id, "Producto no encontrado");
      return;
    }
    addToCart(chatId, product);
    await answerCallbackQuery(cq.id, `Agregado al carrito: ${product.name}`);
    await sendMessage(chatId, `✅ Agregado: *${product.name}*`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🛍️ Seguir viendo", callback_data: "keepBrowsing" },
            { text: "🛒 Ver carrito", callback_data: "viewCart" },
          ],
        ],
      },
    });
    return;
  }

  if (data === "keepBrowsing") {
    await answerCallbackQuery(cq.id, "Seguí mirando el catálogo");
    return;
  }
  if (data === "viewCart") {
    await answerCallbackQuery(cq.id);
    await showCart(chatId);
    return;
  }

  // compartir producto
  if (data.startsWith("share:")) {
    const [, categoryId, productId] = data.split(":");
    const product = findProduct(categoryId, productId);
    if (!product) {
      await answerCallbackQuery(cq.id, "Producto no encontrado");
      return;
    }
    await answerCallbackQuery(cq.id);
    await sendShareLinks(chatId, product);
    return;
  }

  // checkout: tipo de entrega
  if (data === "checkout_delivery") {
    const flow = flows.get(chatId);
    if (!flow) return;
    flow.deliveryType = "delivery";
    flows.set(chatId, flow);
    await answerCallbackQuery(cq.id);
    await sendMessage(
      chatId,
      "📍 Pasame tu *dirección completa* (calle + número + entre calles / referencia)."
    );
    return;
  }

  if (data === "checkout_pickup") {
    const flow = flows.get(chatId);
    if (!flow) return;
    flow.deliveryType = "pickup";
    flows.set(chatId, flow);
    await answerCallbackQuery(cq.id);
    await sendMessage(chatId, "📛 Decime tu *nombre* para el pedido.");
    return;
  }

  // checkout: métodos de pago
  if (data === "pay_cash") {
    const flow = flows.get(chatId);
    if (!flow) return;
    flow.paymentMethod = "Efectivo";
    flows.set(chatId, flow);
    await answerCallbackQuery(cq.id);
    await finalizeOrder(chatId, flow, false);
    return;
  }

  if (data === "pay_transfer") {
    const flow = flows.get(chatId);
    if (!flow) return;
    flow.paymentMethod = "Transferencia";
    flows.set(chatId, flow);
    await answerCallbackQuery(cq.id);
    await sendMessage(
      chatId,
      `💳 *Datos para transferencia:*\n\n${BUSINESS.transferInfo}\n\nCuando hagas la transferencia, enviá el comprobante por WhatsApp o Telegram.`
    );
    await finalizeOrder(chatId, flow, true);
    return;
  }

  if (data === "cancel_checkout") {
    flows.delete(chatId);
    await answerCallbackQuery(cq.id, "Pedido cancelado");
    await sendMessage(chatId, "❌ Pedido cancelado.");
    return;
  }

  // confirmación del vendedor
  if (data.startsWith("admin_confirm:")) {
    const [, userChatIdStr] = data.split(":");
    const userChatId = Number(userChatIdStr);
    await answerCallbackQuery(cq.id, "Pago confirmado ✅");

    await sendMessage(
      userChatId,
      "✅ *Tu pago fue confirmado.*\nTu pedido está en preparación."
    );
    await sendMessage(
      cq.message.chat.id,
      "Aviso enviado al cliente. Podés preparar el pedido. 🧀"
    );

    addStamp(userChatId);
    await showStamps(userChatId);
    return;
  }
}

// === WELCOME & MENÚ ===
async function sendWelcome(chatId) {
  const caption =
    `🧀 *¡Bienvenido/a a ${BUSINESS.name}!* ✨\n\n` +
    `📍 *Dirección:* ${BUSINESS.address}\n` +
    `⏰ *Horarios:* ${BUSINESS.hours}\n` +
    `📞 *Teléfono:* ${BUSINESS.phone}\n` +
    `📸 *Instagram:* ${BUSINESS.instagram}\n\n` +
    `Elegí una opción del menú de abajo para empezar 👇`;

  await sendPhoto(chatId, BUSINESS.logoUrl, caption, {
    reply_markup: mainMenuKeyboard(),
  });
}

function mainMenuKeyboard() {
  return {
    keyboard: [
      ["🛍️ Catálogo", "🛒 Mi carrito"],
      ["✅ Finalizar compra", "🎟️ Tarjeta de sellos"],
      ["📢 Compartir el bot"],
    ],
    resize_keyboard: true,
  };
}

async function showMainMenu(chatId, msg) {
  await sendMessage(chatId, msg, {
    reply_markup: mainMenuKeyboard(),
  });
}

// === CATALOGO Y CARRUSEL ===
async function showCategories(chatId) {
  const buttons = CATEGORIES.map((c) => [
    { text: c.name, callback_data: `cat:${c.id}` },
  ]);
  await sendMessage(chatId, "🛍️ Elegí una categoría:", {
    reply_markup: { inline_keyboard: buttons },
  });
}

function findProduct(categoryId, productId) {
  const cat = CATEGORIES.find((c) => c.id === categoryId);
  if (!cat) return null;
  return cat.products.find((p) => p.id === productId) || null;
}

async function showCategoryCarousel(
  chatId,
  messageId,
  categoryId,
  index,
  newMessage
) {
  const cat = CATEGORIES.find((c) => c.id === categoryId);
  if (!cat || !cat.products.length) {
    if (newMessage) {
      await sendMessage(
        chatId,
        "Todavía no hay productos cargados en esta categoría."
      );
    }
    return;
  }

  const count = cat.products.length;
  const product = cat.products[index];

  const caption =
    `*${cat.name}* — producto ${index + 1}/${count}\n\n` +
    `*${product.name}*\n` +
    `💲 $${product.price.toLocaleString("es-AR")}\n` +
    `${product.description || ""}`;

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: "➕ Agregar",
          callback_data: `add:${cat.id}:${product.id}`,
        },
        {
          text: "📤 Compartir",
          callback_data: `share:${cat.id}:${product.id}`,
        },
      ],
      [
        {
          text: "⬅️ Anterior",
          callback_data: `car_prev:prev:${cat.id}:${index}`,
        },
        {
          text: `${index + 1}/${count}`,
          callback_data: "noop",
        },
        {
          text: "Siguiente ➡️",
          callback_data: `car_next:next:${cat.id}:${index}`,
        },
      ],
      [
        { text: "⬅️ Categorías", callback_data: "back_categories" },
        { text: "🛒 Ver carrito", callback_data: "viewCart" },
      ],
    ],
  };

  carousels.set(chatId, { categoryId, index });

  if (newMessage) {
    await sendPhoto(chatId, product.photo, caption, {
      reply_markup: keyboard,
    });
  } else {
    // edit media
    await tgCall("editMessageMedia", {
      chat_id: chatId,
      message_id: messageId,
      media: {
        type: "photo",
        media: product.photo,
        caption,
        parse_mode: "Markdown",
      },
      reply_markup: keyboard,
    });
  }
}

// === CARRITO ===
function getCart(chatId) {
  if (!carts.has(chatId)) carts.set(chatId, []);
  return carts.get(chatId);
}

function addToCart(chatId, product, qty = 1) {
  const cart = getCart(chatId);
  const existing = cart.find((i) => i.productId === product.id);
  if (existing) existing.qty += qty;
  else
    cart.push({
      productId: product.id,
      name: product.name,
      price: product.price,
      qty,
    });
}

function clearCart(chatId) {
  carts.set(chatId, []);
}

function cartText(cart) {
  if (!cart.length) return "Tu carrito está vacío.";

  let text = "🛒 *Tu carrito:*\n\n";
  let total = 0;
  for (const item of cart) {
    const lineTotal = item.price * item.qty;
    total += lineTotal;
    text += `• ${item.qty} × ${item.name} — $${lineTotal.toLocaleString(
      "es-AR"
    )}\n`;
  }
  text += `\nSubtotal: *$${total.toLocaleString("es-AR")}*`;
  return text;
}

async function showCart(chatId) {
  const cart = getCart(chatId);
  if (!cart.length) {
    await sendMessage(
      chatId,
      "🛒 Tu carrito está vacío. ¿Querés que te muestre el catálogo? 🙂"
    );
    return;
  }
  await sendMessage(chatId, cartText(cart));
}

// === CHECKOUT ===
async function startCheckout(chatId) {
  const cart = getCart(chatId);
  if (!cart.length) {
    await sendMessage(
      chatId,
      "Tu carrito está vacío. Primero agregá algo del catálogo 🙂"
    );
    return;
  }

  flows.set(chatId, {
    step: "delivery",
    deliveryType: null,
    address: null,
    name: null,
    phone: null,
    paymentMethod: null,
  });

  await sendMessage(
    chatId,
    cartText(cart) +
      "\n\n✅ *Finalizar compra*\nElegí cómo querés recibir tu pedido:",
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🚚 Envío a domicilio",
              callback_data: "checkout_delivery",
            },
            {
              text: "🏪 Retiro en el local",
              callback_data: "checkout_pickup",
            },
          ],
          [{ text: "⬅️ Cancelar", callback_data: "cancel_checkout" }],
        ],
      },
    }
  );
}

async function continueCheckoutFlow(msg, flow) {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  if (flow.step === "delivery" && flow.deliveryType === "delivery") {
    flow.address = text;
    flow.step = "name";
    flows.set(chatId, flow);
    await sendMessage(chatId, "📛 Decime tu *nombre* para el pedido.");
    return;
  }

  if (
    (flow.step === "delivery" && flow.deliveryType === "pickup") ||
    flow.step === "name"
  ) {
    flow.name = text;
    flow.step = "phone";
    flows.set(chatId, flow);
    await sendMessage(
      chatId,
      "📞 Pasame tu *teléfono* (así coordinamos si hace falta)."
    );
    return;
  }

  if (flow.step === "phone") {
    flow.phone = text;
    flow.step = "payment";
    flows.set(chatId, flow);
    await sendMessage(chatId, "💳 Elegí método de pago:", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Efectivo", callback_data: "pay_cash" },
            { text: "Transferencia", callback_data: "pay_transfer" },
          ],
          [{ text: "⬅️ Cancelar", callback_data: "cancel_checkout" }],
        ],
      },
    });
    return;
  }
}

async function finalizeOrder(chatId, flow, isTransfer) {
  const cart = getCart(chatId);
  let total = 0;
  for (const item of cart) total += item.price * item.qty;

  const deliveryText =
    flow.deliveryType === "delivery"
      ? `🚚 *Entrega:* Envío a domicilio\n📍 *Dirección:* ${flow.address}`
      : "🏪 *Entrega:* Retiro en el local";

  const ticket =
    `🧾 *Ticket de compra*\n${BUSINESS.name}\n` +
    `──────────────────────\n` +
    `👤 *Cliente:* ${flow.name}\n` +
    `📞 *Tel:* ${flow.phone}\n` +
    `🆔 *ChatID:* ${chatId}\n` +
    `──────────────────────\n` +
    `*Detalle:*\n` +
    cart
      .map(
        (i) =>
          `• ${i.qty} × ${i.name} — $${(i.price * i.qty).toLocaleString(
            "es-AR"
          )}`
      )
      .join("\n") +
    `\n\nSubtotal:  *$${total.toLocaleString("es-AR")}*\n` +
    `Envío:      *$0*\n` +
    `TOTAL:      *$${total.toLocaleString("es-AR")}*\n\n` +
    `${deliveryText}\n` +
    `💳 *Pago:* ${
      isTransfer ? "Transferencia (pendiente de confirmar)" : "Efectivo"
    }`;

  // ticket al cliente
  await sendMessage(chatId, ticket);

  // ticket al vendedor
  if (ADMIN_CHAT_ID) {
    const extraButtons = isTransfer
      ? {
          inline_keyboard: [
            [
              {
                text: "✅ Confirmar pago",
                callback_data: `admin_confirm:${chatId}`,
              },
            ],
          ],
        }
      : undefined;

    await sendMessage(
      ADMIN_CHAT_ID,
      `📥 *Nuevo pedido de ${BUSINESS.name}*\n\n${ticket}`,
      { reply_markup: extraButtons }
    );
  }

  if (!isTransfer) {
    await sendMessage(
      chatId,
      "Gracias. Tu compra fue confirmada y está en preparación. ✅"
    );
    addStamp(chatId);
    await showStamps(chatId);
  } else {
    await sendMessage(
      chatId,
      "Tu pedido fue registrado. Apenas confirmemos la transferencia, te avisamos y preparamos tu pedido. ✅"
    );
  }

  clearCart(chatId);
  flows.delete(chatId);
}

// === TARJETA DE SELLOS ===
function addStamp(chatId) {
  const current = stamps.get(chatId) || 0;
  stamps.set(chatId, current + 1);
}

async function showStamps(chatId) {
  const total = stamps.get(chatId) || 0;
  const goal = BUSINESS.stampsToReward;

  const filled = "🟩".repeat(Math.min(total, goal));
  const empty = "⬜".repeat(Math.max(goal - total, 0));

  const text =
    "🎟️ *Tarjeta de sellos*\n\n" +
    filled +
    empty +
    `\n\nSellos: *${total} / ${goal}*\n` +
    `Premio al completar: ${BUSINESS.stampRewardText}\n\n` +
    "Tip: al finalizar una compra, se suma 1 sello automáticamente (configurable).";

  await sendMessage(chatId, text);
}

// === COMPARTIR ===
async function shareBot(chatId) {
  const text =
    "📢 *Compartí Todo Queso Bot*\n\n" +
    "Pasale este link a tus contactos para que también puedan hacer pedidos y sumar sellos:\n\n" +
    BUSINESS.shareBotLink;
  await sendMessage(chatId, text);
}

async function sendShareLinks(chatId, product) {
  const baseText = `Mirá este producto de ${BUSINESS.name}: ${product.name} - $${product.price.toLocaleString(
    "es-AR"
  )}.`;

  const whatsappUrl =
    "https://wa.me/?text=" + encodeURIComponent(baseText);
  const telegramUrl =
    "https://t.me/share/url?url=" +
    encodeURIComponent(BUSINESS.shareBotLink) +
    "&text=" +
    encodeURIComponent(baseText);
  const emailUrl =
    "mailto:?subject=" +
    encodeURIComponent(`Producto ${product.name}`) +
    "&body=" +
    encodeURIComponent(baseText + "\n\n" + BUSINESS.shareBotLink);

  await sendMessage(chatId, `📤 *Compartir ${product.name}*`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "WhatsApp", url: whatsappUrl }],
        [{ text: "Telegram", url: telegramUrl }],
        [{ text: "Email", url: emailUrl }],
      ],
    },
  });
}

// === INICIAR SERVIDOR ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Bot server running on port", PORT);
});

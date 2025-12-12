// index.js (UN SOLO BLOQUE) — Render + Telegram Webhook + Catálogo desde GAS (hoja: Catalogo)
// ✅ Sin node-fetch (Node 18+ trae fetch global) -> evita ERR_MODULE_NOT_FOUND
// ✅ Sin puerto extra en TelegramBot -> evita EADDRINUSE
// ✅ Menú único (borra el anterior) -> evita “2 menús”
// ✅ Catálogo tolerante (items/data/catalogo/productos) -> evita “no pude leer Catalogo”
// ✅ Botón 🏠 Menú siempre
// ✅ Sugerencias “modo vendedor” SIN agregar al carrito automáticamente

import express from "express";
import TelegramBot from "node-telegram-bot-api";

// ===============================
// CONFIG (podés pasar a ENV cuando quieras)
// ===============================
const TOKEN =
  process.env.TELEGRAM_TOKEN ||
  "8130447159:AAHxzp5S1lcgYOemw5dgF5V1DGh141dHmkA";

const BACKEND =
  process.env.GAS_BACKEND ||
  "https://script.google.com/macros/s/AKfycbxznmXVhDFd45kwrtsO0lORoGDn7AcHVdQIYQkgYy_63jaJCrjumzphVK_N39T_zjK_/exec";

const URL_BASE =
  process.env.URL_BASE ||
  "https://ezerbot-system.onrender.com"; // tu dominio render

const LOGO =
  process.env.LOGO_URL ||
  "https://i.postimg.cc/q7WvjsYm/20251206-210311.jpg";

// ===============================
// EXPRESS
// ===============================
const app = express();
app.use(express.json());

// ===============================
// TELEGRAM BOT (WEBHOOK)
// ===============================
// IMPORTANTE: No le pases { webHook: { port: ... } } porque Render ya escucha el puerto y da EADDRINUSE
const bot = new TelegramBot(TOKEN, { webHook: true });

// ===============================
// ESTADOS EN MEMORIA (MENÚ ÚNICO + CARRITO SIMPLE)
// ===============================
const lastMenuMsgId = new Map(); // chatId -> message_id (para borrar menú anterior)
const lastFirstName = new Map(); // chatId -> first_name
const carts = new Map(); // chatId -> [{codigo,nombre,precio,cantidad}]

// ===============================
// HELPERS
// ===============================
function safeText(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  const s = String(v).trim();
  return s.length ? s : fallback;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function moneyARS(n) {
  const x = Number(n);
  if (Number.isFinite(x)) return x.toLocaleString("es-AR");
  return safeText(n, "0");
}

async function safeDeleteMessage(chatId, msgId) {
  try {
    await bot.deleteMessage(chatId, msgId);
  } catch (_) {}
}

function calcCartTotal(items) {
  let t = 0;
  for (const it of items) t += (Number(it.precio) || 0) * (Number(it.cantidad) || 0);
  return t;
}

// ===============================
// UTILIDAD REQUEST AL BACKEND GAS
// ===============================
async function GAS(action, params = {}) {
  const url = new URL(BACKEND);
  url.searchParams.append("accion", action);
  for (const k in params) url.searchParams.append(k, params[k]);

  const r = await fetch(url.toString(), {
    method: "GET",
    headers: { "Accept": "application/json" },
  });

  // Si GAS devuelve HTML por error, esto ayuda a diagnosticar
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    return { ok: false, error: "GAS no devolvió JSON", raw: text?.slice(0, 400) };
  }
}

async function getCatalogItems() {
  const r = await GAS("catalogo").catch(() => ({}));
  const items =
    Array.isArray(r.items) ? r.items :
    Array.isArray(r.data) ? r.data :
    Array.isArray(r.catalogo) ? r.catalogo :
    Array.isArray(r.productos) ? r.productos :
    [];
  return { items, raw: r };
}

// ===============================
// MENÚ PRINCIPAL (UNO SOLO)
// ===============================
async function sendHome(chatId, firstName = "amiga") {
  lastFirstName.set(chatId, firstName);

  // borra el menú anterior para que no queden 2
  const prev = lastMenuMsgId.get(chatId);
  if (prev) await safeDeleteMessage(chatId, prev);

  const cfg = await GAS("config").catch(() => ({}));
  const negocio = safeText(cfg.NegocioNombre, "TODO QUESO CLUB");
  const slogan = safeText(cfg.Slogan, "Productos frescos, promos y beneficios exclusivos.");

  const caption =
`*${negocio}*
${slogan}

Hola ${firstName} 👋
Soy el asistente de *${negocio}*.
Desde acá podés ver el catálogo, armar tu pedido, sumar sellos y hablar con el vendedor.

👇 Elegí una opción para empezar`;

  const menu = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🛍️ Catálogo", callback_data: "CATALOGO" },
          { text: "🛒 Mi carrito", callback_data: "CARRITO" }
        ],
        [{ text: "🏆 Mis sellos", callback_data: "SELLOS" }],
        [{ text: "💬 Hablar con el vendedor", callback_data: "HABLAR" }],
        [
          { text: "🏪 Información del local", callback_data: "INFO" },
          { text: "📣 Compartir el bot", callback_data: "COMPARTIR" }
        ]
      ]
    }
  };

  const m = await bot.sendPhoto(chatId, LOGO, {
    caption,
    parse_mode: "Markdown",
    ...menu
  });

  lastMenuMsgId.set(chatId, m.message_id);
}

// ===============================
// START / SALUDO
// ===============================
bot.onText(/\/start|hola|hola!|buenas|buen día|buenas!/i, async (msg) => {
  const chatId = msg.chat.id;
  const nombre = msg.chat.first_name || "amiga";
  await sendHome(chatId, nombre);
});

// ===============================
// BOTONES PRINCIPALES
// ===============================
bot.on("callback_query", async (query) => {
  const chatId = query.message?.chat?.id;
  const data = query.data || "";
  if (!chatId) return;

  // saca el “cargando…” del botón
  try { await bot.answerCallbackQuery(query.id); } catch (_) {}

  if (data === "HOME") return sendHome(chatId, lastFirstName.get(chatId) || "amiga");

  if (data === "INFO") return infoLocal(chatId);
  if (data === "CATALOGO") return mostrarCategorias(chatId);
  if (data === "COMPARTIR") return compartirBot(chatId);
  if (data === "SELLOS") return mostrarSellos(chatId);
  if (data === "HABLAR") return hablarVendedor(chatId);
  if (data === "CARRITO") return verCarrito(chatId);

  // categoría seleccionada
  if (data.startsWith("CAT_")) {
    const categoria = data.replace("CAT_", "");
    return mostrarProductos(chatId, categoria, 0);
  }

  // paginación
  if (data.startsWith("PAGE_")) {
    const parts = data.split("_");
    const categoria = parts[1];
    const page = Number(parts[2] || "0");
    return mostrarProductos(chatId, categoria, page);
  }

  // comprar
  if (data.startsWith("BUY_")) {
    const codigo = data.replace("BUY_", "");
    return comprar(chatId, codigo);
  }

  // compartir promo (simple)
  if (data.startsWith("SHARE_")) {
    const codigo = data.replace("SHARE_", "");
    return compartirProducto(chatId, codigo);
  }

  // sugerencia -> abre el catálogo directamente en una categoría
  if (data.startsWith("SUGCAT_")) {
    const cat = data.replace("SUGCAT_", "");
    return mostrarProductos(chatId, cat, 0);
  }

  // vaciar carrito
  if (data === "CLEAR_CART") {
    carts.set(chatId, []);
    return bot.sendMessage(chatId, "🧺 Listo, vacié tu carrito.", {
      reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "HOME" }]] }
    });
  }

  // finalizar -> manda ticket al cliente (y deja link para hablar con vendedor)
  if (data === "CHECKOUT") {
    return finalizarCompra(chatId);
  }
});

// ===============================
// INFO DEL LOCAL
// ===============================
async function infoLocal(chatId) {
  const cfg = await GAS("config").catch(() => ({}));
  const negocio = safeText(cfg.NegocioNombre, "TODO QUESO CLUB");

  const msg =
`🏪 *${negocio}*
📍 Dirección: ${safeText(cfg.Dirección, "Dirección no configurada")}
🕒 Horarios: ${safeText(cfg.Horarios, "Horarios no configurados")}
📞 Teléfono: ${safeText(cfg.TeléfonoNegocio, "No configurado")}
📸 Instagram: ${safeText(cfg.Instagram, "No configurado")}

💛 Gracias por elegir productos frescos y de calidad`;

  await bot.sendPhoto(chatId, LOGO, { caption: msg, parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "HOME" }]] }
  });
}

// ===============================
// HABLAR CON VENDEDOR
// ===============================
async function hablarVendedor(chatId) {
  const cfg = await GAS("config").catch(() => ({}));
  const w = safeText(cfg.WhatsAppLink, "https://wa.me/5493484230184");

  await bot.sendMessage(chatId,
`💬 *¿Querés que te atienda alguien real?*
Escribinos por WhatsApp 👇`,
{
  parse_mode: "Markdown",
  reply_markup: {
    inline_keyboard: [
      [{ text: "📞 Abrir WhatsApp", url: w }],
      [{ text: "🏠 Menú", callback_data: "HOME" }]
    ]
  }
});
}

// ===============================
// COMPARTIR BOT
// ===============================
async function compartirBot(chatId) {
  const cfg = await GAS("config").catch(() => ({}));
  const negocio = safeText(cfg.NegocioNombre, "TODO QUESO CLUB");
  const share = safeText(cfg.BotLink, "https://t.me/Ezer_IA_Bot");

  await bot.sendMessage(chatId,
`📣 *Compartí este bot*
Así tus contactos también aprovechan promos y suman sellos.

🧀 Sumate a *${negocio}* y disfrutá de productos frescos, combos y beneficios.

👉 Entrá al bot: ${share}

Podés copiar este mensaje y pegarlo en WhatsApp, Instagram o donde quieras.`,
{ parse_mode: "Markdown",
  reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "HOME" }]] }
});
}

// ===============================
// MOSTRAR CATEGORÍAS (desde hoja Catalogo)
// ===============================
async function mostrarCategorias(chatId) {
  const { items } = await getCatalogItems();

  if (!items.length) {
    return bot.sendMessage(
      chatId,
      "⚠️ No pude leer *Catalogo*.\nRevisá que el GAS esté devolviendo el catálogo (items/data/catalogo).",
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "HOME" }]] } }
    );
  }

  // categorías únicas
  const cats = [...new Set(items.map(i => safeText(i.categoria, "General")))];

  // emojis por categoría (si no matchea, deja 📦)
  const emojiFor = (c) => {
    const s = c.toLowerCase();
    if (s.includes("ques")) return "🧀";
    if (s.includes("fiamb") || s.includes("jam") || s.includes("sal")) return "🥓";
    if (s.includes("pan")) return "🥖";
    if (s.includes("lact")) return "🥛";
    if (s.includes("dulc") || s.includes("merm") || s.includes("batata") || s.includes("memb")) return "🍯";
    if (s.includes("beb")) return "🥤";
    if (s.includes("promo") || s.includes("combo")) return "🔥";
    return "📦";
  };

  // botones 2 por fila (más prolijo)
  const catBtns = cats.map(c => ({ text: `${emojiFor(c)} ${c}`, callback_data: "CAT_" + c }));
  const rows = chunkArray(catBtns, 2);
  rows.push([{ text: "🏠 Menú", callback_data: "HOME" }]);

  await bot.sendMessage(chatId, "🛍️ *Elegí una categoría:*", {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: rows }
  });
}

// ===============================
// MOSTRAR PRODUCTOS POR CATEGORÍA (3 por página)
// ===============================
async function mostrarProductos(chatId, categoria, page = 0) {
  const { items } = await getCatalogItems();
  const list = (items || []).filter(p => safeText(p.categoria, "General") === categoria);

  const porPagina = 3;
  const inicio = page * porPagina;
  const slice = list.slice(inicio, inicio + porPagina);

  if (!slice.length) {
    return bot.sendMessage(chatId, "No hay productos en esta categoría.", {
      reply_markup: { inline_keyboard: [[{ text: "⬅️ Volver a categorías", callback_data: "CATALOGO" }], [{ text: "🏠 Menú", callback_data: "HOME" }]] }
    });
  }

  for (const p of slice) {
    const nombre = safeText(p.nombre, "Producto");
    const desc = safeText(p.descripcion, "");
    const precio = moneyARS(p.precio);
    const codigo = safeText(p.codigo, "SIN-CODIGO");
    const img = safeText(p.imagenUrl, LOGO);

    await bot.sendPhoto(chatId, img, {
      caption:
`*${nombre}*
${desc ? desc + "\n" : ""}💲 ${precio} ARS
🆔 Código: *${codigo}*`,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🛒 Comprar", callback_data: "BUY_" + codigo },
            { text: "📣 Compartir", callback_data: "SHARE_" + codigo }
          ],
          [
            { text: "⬅️ Categorías", callback_data: "CATALOGO" },
            { text: "🏠 Menú", callback_data: "HOME" }
          ]
        ]
      }
    });
  }

  // navegación de páginas
  const nav = [];
  if (inicio > 0) nav.push({ text: "⬅️ Anterior", callback_data: `PAGE_${categoria}_${page - 1}` });
  if (inicio + porPagina < list.length) nav.push({ text: "Siguiente ➡️", callback_data: `PAGE_${categoria}_${page + 1}` });
  nav.push({ text: "🏠 Menú", callback_data: "HOME" });

  if (nav.length) {
    await bot.sendMessage(chatId, `📍 Categoría: *${categoria}* (pág. ${page + 1})`, {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [nav] }
    });
  }
}

// ===============================
// COMPARTIR PRODUCTO (texto listo)
// ===============================
async function compartirProducto(chatId, codigo) {
  const { items } = await getCatalogItems();
  const p = (items || []).find(x => safeText(x.codigo, "") === codigo);

  if (!p) {
    return bot.sendMessage(chatId, "No encontré ese producto para compartir.", {
      reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "HOME" }]] }
    });
  }

  const cfg = await GAS("config").catch(() => ({}));
  const negocio = safeText(cfg.NegocioNombre, "TODO QUESO CLUB");
  const botLink = safeText(cfg.BotLink, "https://t.me/Ezer_IA_Bot");

  const txt =
`🧀 *${negocio}* — *${safeText(p.nombre, "Producto")}*
💲 ${moneyARS(p.precio)} ARS

📲 Pedilo por el bot:
${botLink}`;

  await bot.sendMessage(chatId, txt, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "HOME" }]] }
  });
}

// ===============================
// COMPRAR (agrega SOLO el producto elegido) + SUGERENCIAS “modo vendedor” (sin agregar)
// ===============================
async function comprar(chatId, codigo) {
  const { items } = await getCatalogItems();
  const p = (items || []).find(x => safeText(x.codigo, "") === codigo);

  if (!p) {
    return bot.sendMessage(chatId, "No encontré ese producto.", {
      reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "HOME" }]] }
    });
  }

  // carrito simple: suma 1 unidad (SIN complicar pesos/kilos)
  const cart = carts.get(chatId) || [];
  const nombre = safeText(p.nombre, "Producto");
  const precio = Number(p.precio) || 0;

  const existing = cart.find(x => x.codigo === codigo);
  if (existing) existing.cantidad += 1;
  else cart.push({ codigo, nombre, precio, cantidad: 1 });

  carts.set(chatId, cart);

  await bot.sendMessage(chatId, `✅ Listo. Agregué *${nombre}* a tu carrito.`, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🛒 Ver carrito", callback_data: "CARRITO" },
          { text: "🛍️ Seguir comprando", callback_data: "CATALOGO" }
        ],
        [{ text: "🏠 Menú", callback_data: "HOME" }]
      ]
    }
  });

  // sugerencias estilo “Jenny vendedora”, pero SOLO guía (no agrega)
  await sugerenciasVendedoras(chatId, p);
}

async function sugerenciasVendedoras(chatId, producto) {
  const cat = safeText(producto.categoria, "General").toLowerCase();

  // sugerencias por “familia”
  // (si no existe la categoría sugerida en tu Catalogo, igual queda como guía)
  let sugerencias = [];
  let texto = "💡 Ya que estás… ¿te llevo algo para acompañar?";

  if (cat.includes("ques")) {
    sugerencias = ["Pan", "Fiambres", "Dulces/Untables", "Promos/Combos"];
    texto = "💡 Con ese queso queda mortal un pancito… ¿querés que te muestre panes o fiambres para armar algo completo?";
  } else if (cat.includes("fiamb") || cat.includes("jam") || cat.includes("sal")) {
    sugerencias = ["Pan", "Quesos", "Mayonesa / Aderezos", "Promos/Combos"];
    texto = "💡 Con fiambre siempre va bien: pan + queso + algún aderezo. ¿Te muestro opciones?";
  } else if (cat.includes("lact") || cat.includes("leche")) {
    sugerencias = ["Dulces/Untables", "Pan", "Café / Infusiones"];
    texto = "💡 Para esa leche… ¿te muestro algo rico para acompañar? (pan, dulces, algo para el mate/café)";
  } else if (cat.includes("pan")) {
    sugerencias = ["Quesos", "Fiambres", "Dulces/Untables"];
    texto = "💡 Ese pan con un buen queso o dulce… ¿te muestro opciones para acompañar?";
  } else if (cat.includes("dulc") || cat.includes("merm") || cat.includes("batata") || cat.includes("memb")) {
    sugerencias = ["Quesos", "Pan"];
    texto = "💡 Eso con un queso (tipo postre) queda tremendo… ¿querés que te muestre quesos y panes?";
  } else {
    sugerencias = ["Promos/Combos", "Quesos", "Pan", "Fiambres"];
    texto = "💡 ¿Querés que te muestre algo que suele salir mucho con eso? (promos, quesos, pan, fiambres)";
  }

  // armamos botones (guía al catálogo)
  const rows = chunkArray(
    sugerencias.map(s => ({ text: `➕ Ver ${s}`, callback_data: "SUGCAT_" + s })),
    2
  );

  rows.push([
    { text: "🛍️ Ir al Catálogo", callback_data: "CATALOGO" },
    { text: "🛒 Mi carrito", callback_data: "CARRITO" }
  ]);

  await bot.sendMessage(chatId, texto, {
    reply_markup: { inline_keyboard: rows }
  });
}

// ===============================
// CARRITO
// ===============================
async function verCarrito(chatId) {
  const cart = carts.get(chatId) || [];
  if (!cart.length) {
    return bot.sendMessage(chatId, "🧺 Tu carrito está vacío por ahora.", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🛍️ Ir al Catálogo", callback_data: "CATALOGO" }],
          [{ text: "🏠 Menú", callback_data: "HOME" }]
        ]
      }
    });
  }

  const lines = cart.map(it => `• ${it.cantidad} x ${it.nombre} — $${moneyARS(it.precio * it.cantidad)}`);
  const total = calcCartTotal(cart);

  await bot.sendMessage(chatId,
`🛒 *Tu carrito:*
${lines.join("\n")}

💰 *Total estimado:* $${moneyARS(total)} ARS

¿Querés finalizar o seguir comprando?`,
{
  parse_mode: "Markdown",
  reply_markup: {
    inline_keyboard: [
      [
        { text: "✅ Finalizar", callback_data: "CHECKOUT" },
        { text: "🛍️ Seguir comprando", callback_data: "CATALOGO" }
      ],
      [
        { text: "🧹 Vaciar carrito", callback_data: "CLEAR_CART" },
        { text: "🏠 Menú", callback_data: "HOME" }
      ]
    ]
  }
});
}

// ===============================
// FINALIZAR (ticket simple + link vendedor)
// ===============================
async function finalizarCompra(chatId) {
  const cart = carts.get(chatId) || [];
  if (!cart.length) return verCarrito(chatId);

  const cfg = await GAS("config").catch(() => ({}));
  const negocio = safeText(cfg.NegocioNombre, "TODO QUESO CLUB");
  const alias = safeText(cfg.Alias, "jennyocampos.mp");
  const cbu = safeText(cfg.CBU, "0000003100014980639781");
  const envio = safeText(cfg.EnvioCosto, "");
  const w = safeText(cfg.WhatsAppLink, "https://wa.me/5493484230184");

  const lines = cart.map(it => `${it.cantidad} x ${it.nombre} — $${moneyARS(it.precio * it.cantidad)}`);
  const total = calcCartTotal(cart);

  const ticket =
`🧾 *${negocio}* — Ticket
🗓️ ${new Date().toLocaleString("es-AR")}

${lines.join("\n")}

💰 *Total estimado:* $${moneyARS(total)} ARS
${envio ? `🚚 Envío: ${envio}\n` : ""}

💳 *Pago*
Alias: *${alias}*
CBU: \`${cbu}\`

📸 Cuando pagues, mandanos el comprobante por WhatsApp así lo preparamos 🙌`;

  await bot.sendMessage(chatId, ticket, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📞 Enviar comprobante por WhatsApp", url: w }],
        [
          { text: "🛍️ Seguir comprando", callback_data: "CATALOGO" },
          { text: "🏠 Menú", callback_data: "HOME" }
        ]
      ]
    }
  });
}

// ===============================
// MOSTRAR SELLOS
// ===============================
async function mostrarSellos(chatId) {
  const r = await GAS("estadoCliente", { chatId }).catch(() => ({}));

  if (!r || r.ok === false) {
    return bot.sendMessage(chatId, "Todavía no pude leer tus sellos. Si ya compraste, probá de nuevo en un ratito 🙂", {
      reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "HOME" }]] }
    });
  }

  if (!r.tieneTarjeta) {
    return bot.sendMessage(chatId, "Este comercio todavía no activó el sistema de sellos o aún no tenés tarjeta.", {
      reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "HOME" }]] }
    });
  }

  await bot.sendPhoto(chatId, safeText(r.tarjetaImagenUrl, LOGO), {
    caption: `🎉 *Tus sellos:* ${safeText(r.sellosTotalesAcumulados, "0")}\n🏅 Nivel: ${safeText(r.nivelActual, "—")}`,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [[{ text: "🏠 Menú", callback_data: "HOME" }]] }
  });
}

// ===============================
// WEBHOOK ENDPOINTS
// ===============================
app.post("/webhook", (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// debug básico
app.get("/", (_, res) => res.send({ ok: true, msg: "EzerBot corriendo" }));

// debug catálogo (para ver qué devuelve el GAS)
app.get("/debugCatalogo", async (req, res) => {
  try {
    const raw = await GAS("catalogo");
    const { items } = await getCatalogItems();
    res.json({ ok: true, count: items.length, sample: items.slice(0, 3), raw });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ===============================
// START SERVER + SET WEBHOOK
// ===============================
const PORT = Number(process.env.PORT || 10000);

app.listen(PORT, async () => {
  console.log("Servidor activo en puerto", PORT);

  // setWebhook SIEMPRE después de que el server está escuchando
  const hook = `${URL_BASE}/webhook`;
  try {
    await bot.setWebHook(hook);
    console.log("Webhook seteado:", hook);
  } catch (e) {
    console.log("Error seteando webhook:", e?.message || e);
  }
});
```0


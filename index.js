import express from "express";
import fetch from "node-fetch";
import TelegramBot from "node-telegram-bot-api";

const BOT_TOKEN = process.env.BOT_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL;        // ej: https://ezerbot-system.onrender.com
const GAS_URL = process.env.GAS_URL;              // tu webapp de Apps Script (termina en /exec)

if (!BOT_TOKEN) throw new Error("Falta BOT_TOKEN");
if (!PUBLIC_URL) throw new Error("Falta PUBLIC_URL");
if (!GAS_URL) throw new Error("Falta GAS_URL");

const app = express();
app.use(express.json({ limit: "2mb" }));

const bot = new TelegramBot(BOT_TOKEN);

let cache = {
  bootedAt: new Date().toISOString(),
  bot: null,
  config: null,
  catalogo: [],
  configLoadedAt: null,
  catalogoLoadedAt: null,
  lastUpdateAt: null,
  lastChatId: null,
  lastText: null,
  lastError: null
};

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeProduct(p) {
  const precio = safeNum(p.precio);
  const unidad = String(p.unidad || "unidad").toLowerCase().trim();
  const ppk = safeNum(p.precioporkilo ?? p.precioporkg ?? p.precioporkgilo ?? 0);

  return {
    codigo: String(p.codigo || "").trim(),
    nombre: String(p.nombre || "").trim(),
    precio,
    unidad, // "unidad" o "kg"
    precioporkilo: ppk,
    codigobarras: String(p.codigobarras || "").trim(),
    descripcion: String(p.descripcion || "").trim(),
    imagen: String(p.imagen || "").trim(),
    categoria: String(p.categoria || "Sin categoría").trim()
  };
}

async function loadConfig() {
  const url = `${GAS_URL}?op=config`;
  const r = await fetch(url);
  const j = await r.json();
  if (!j.ok) throw new Error(`GAS config error: ${j.error || "unknown"}`);
  cache.config = j.data || {};
  cache.configLoadedAt = new Date().toISOString();
  return cache.config;
}

async function loadCatalogo() {
  const url = `${GAS_URL}?op=catalogo`;
  const r = await fetch(url);
  const j = await r.json();
  if (!j.ok) throw new Error(`GAS catalogo error: ${j.error || "unknown"}`);

  const arr = Array.isArray(j.productos) ? j.productos : [];
  cache.catalogo = arr.map(normalizeProduct).filter(p => p.codigo && p.nombre);
  cache.catalogoLoadedAt = new Date().toISOString();
  return cache.catalogo;
}

async function warmUp() {
  try {
    cache.bot = await bot.getMe();
  } catch {}

  try { await loadConfig(); } catch (e) { cache.lastError = String(e); }
  try { await loadCatalogo(); } catch (e) { cache.lastError = String(e); }
}

function cfg(key, fallback = "") {
  return (cache.config && cache.config[key] !== undefined && cache.config[key] !== null && String(cache.config[key]).trim() !== "")
    ? String(cache.config[key]).trim()
    : fallback;
}

function buildWarmWelcome(name) {
  const brand = cfg("BRAND_NOMBRE", "Todo Queso");
  const slogan = cfg("BRAND_SLOGAN", "¡Gracias por escribirnos!");
  const insta = cfg("INSTAGRAM", "@todoqueso.club");
  const horario = cfg("HORARIO", "Lun a Sáb 08:30–14:00 / 16:30–21:00");
  const direccion = cfg("DIRECCION", "Fructuoso Díaz 893, Garín");
  const tel = cfg("TELEFONO", "5493484230184");

  return `Hola ${name || "😊"} 👋
Soy el asistente de *${brand}* 🧀

_${slogan}_

📍 *Dirección:* ${direccion}
🕒 *Horario:* ${horario}
📞 *Tel:* ${tel}
📸 *Instagram:* ${insta}

👇 Elegí una opción del menú`;
}

function mainMenu() {
  return {
    reply_markup: {
      keyboard: [
        ["🛍️ Catálogo", "🛒 Mi carrito"],
        ["📍 Información del local", "💬 Hablar con el vendedor"],
        ["📣 Compartir el bot", "🔄 Recargar catálogo"]
      ],
      resize_keyboard: true
    },
    parse_mode: "Markdown"
  };
}

function pickCategories() {
  const set = new Set(cache.catalogo.map(p => p.categoria).filter(Boolean));
  return Array.from(set).sort((a,b)=>a.localeCompare(b));
}

function findByCategory(cat) {
  return cache.catalogo.filter(p => (p.categoria || "").toLowerCase() === cat.toLowerCase());
}

const carts = new Map(); // chatId -> {items:[{codigo,nombre,cantidad,subtotal,unidad,precio,precioporkilo}]}

function getCart(chatId) {
  if (!carts.has(chatId)) carts.set(chatId, { items: [] });
  return carts.get(chatId);
}

function cartTotal(cart) {
  return cart.items.reduce((a, it) => a + safeNum(it.subtotal), 0);
}

function addToCart(chatId, prod, qty, isKg) {
  const cart = getCart(chatId);
  const existing = cart.items.find(i => i.codigo === prod.codigo);
  const cantidad = safeNum(qty);

  let subtotal = 0;
  if (isKg) {
    subtotal = (safeNum(prod.precioporkilo) || safeNum(prod.precio)) * cantidad;
  } else {
    subtotal = safeNum(prod.precio) * cantidad;
  }

  if (existing) {
    existing.cantidad += cantidad;
    existing.subtotal += subtotal;
  } else {
    cart.items.push({
      codigo: prod.codigo,
      nombre: prod.nombre,
      cantidad,
      subtotal,
      unidad: prod.unidad,
      precio: prod.precio,
      precioporkilo: prod.precioporkilo
    });
  }
}

function shippingCost(total) {
  // leemos de Config
  // ENVIO_TIPO = "fijo" | "gratis_desde" | "porcentaje"
  // ENVIO_FIJO = 2000
  // ENVIO_GRATIS_DESDE = 50000
  // ENVIO_PORCENTAJE = 0.05
  const tipo = cfg("ENVIO_TIPO", "fijo").toLowerCase();
  if (tipo === "gratis_desde") {
    const desde = safeNum(cfg("ENVIO_GRATIS_DESDE", "0"));
    return total >= desde ? 0 : safeNum(cfg("ENVIO_FIJO", "2000"));
  }
  if (tipo === "porcentaje") {
    return Math.round(total * safeNum(cfg("ENVIO_PORCENTAJE", "0.05")));
  }
  return safeNum(cfg("ENVIO_FIJO", "2000"));
}

async function ensureDataFresh() {
  // si no cargó nada, recarga
  if (!cache.config) await loadConfig();
  if (!cache.catalogo || cache.catalogo.length === 0) await loadCatalogo();
}

/** WEBHOOK */
app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;
    cache.lastUpdateAt = new Date().toISOString();

    if (update.message) {
      const chatId = update.message.chat.id;
      const text = (update.message.text || "").trim();
      const firstName = update.message.from?.first_name || "";

      cache.lastChatId = chatId;
      cache.lastText = text;

      await ensureDataFresh();

      // Responder /start y CUALQUIER TEXTO (fallback humano)
      if (text === "/start" || text === "/menu" || text === "Menú" || text === "menu") {
        await bot.sendMessage(chatId, buildWarmWelcome(firstName), mainMenu());
        return res.sendStatus(200);
      }

      // Botones
      if (text.includes("Recargar")) {
        await loadConfig();
        await loadCatalogo();
        await bot.sendMessage(chatId, "✅ Listo. Recargué Config y Catálogo.", mainMenu());
        return res.sendStatus(200);
      }

      if (text.includes("Información del local")) {
        const brand = cfg("BRAND_NOMBRE", "Todo Queso");
        const dir = cfg("DIRECCION", "Fructuoso Díaz 893, Garín");
        const horario = cfg("HORARIO", "Lun a Sáb 08:30–14:00 / 16:30–21:00");
        const tel = cfg("TELEFONO", "5493484230184");
        const logo = cfg("BRAND_LOGO", "");

        if (logo) {
          await bot.sendPhoto(chatId, logo, { caption: `*${brand}*\n📍 ${dir}\n🕒 ${horario}\n📞 ${tel}`, parse_mode: "Markdown" });
        } else {
          await bot.sendMessage(chatId, `*${brand}*\n📍 ${dir}\n🕒 ${horario}\n📞 ${tel}`, { parse_mode: "Markdown" });
        }
        return res.sendStatus(200);
      }

      if (text.includes("Hablar con el vendedor")) {
        const wa = cfg("WHATSAPP_VENDEDOR", "");
        if (!wa) {
          await bot.sendMessage(chatId, "⚠️ Todavía no está configurado el WhatsApp del vendedor en Config (WHATSAPP_VENDEDOR).");
        } else {
          await bot.sendMessage(chatId, `💬 Hablá con nosotros por WhatsApp 👉 ${wa}`);
        }
        return res.sendStatus(200);
      }

      if (text.includes("Catálogo")) {
        const cats = pickCategories();
        if (!cats.length) {
          await bot.sendMessage(chatId, "⚠️ No hay categorías. Revisá que la hoja Catalogo tenga datos.");
          return res.sendStatus(200);
        }
        const keyboard = cats.map(c => [c]);
        await bot.sendMessage(chatId, "📁 Elegí una categoría:", {
          reply_markup: { keyboard: keyboard.concat([["⬅️ Menú"]]), resize_keyboard: true }
        });
        return res.sendStatus(200);
      }

      if (text === "⬅️ Menú") {
        await bot.sendMessage(chatId, "👌 Dale. Elegí una opción del menú 👇", mainMenu());
        return res.sendStatus(200);
      }

      // Si el usuario toca una categoría
      const cats = pickCategories();
      if (cats.map(c => c.toLowerCase()).includes(text.toLowerCase())) {
        const prods = findByCategory(text);
        if (!prods.length) {
          await bot.sendMessage(chatId, "⚠️ Esa categoría no tiene productos.");
          return res.sendStatus(200);
        }

        // Mostramos los primeros 5 como mensajes simples (rápido)
        for (const p of prods.slice(0, 5)) {
          const priceTxt = p.unidad === "kg"
            ? `$${p.precioporkilo || p.precio} / kg`
            : `$${p.precio}`;

          if (p.imagen) {
            await bot.sendPhoto(chatId, p.imagen, {
              caption: `*${p.nombre}*\n🆔 ${p.codigo}\n💰 ${priceTxt}\n\n${p.descripcion || ""}\n\nEscribí: *${p.codigo}* para agregar`,
              parse_mode: "Markdown"
            });
          } else {
            await bot.sendMessage(chatId, `*${p.nombre}*\n🆔 ${p.codigo}\n💰 ${priceTxt}\n${p.descripcion || ""}\n\nEscribí: *${p.codigo}* para agregar`, { parse_mode: "Markdown" });
          }
        }

        await bot.sendMessage(chatId, "🛒 Para agregar, escribí el *CÓDIGO* (ej: TQ03).", { parse_mode: "Markdown" });
        return res.sendStatus(200);
      }

      // Agregar por código (y preguntar gramos si es KG)
      const prod = cache.catalogo.find(p => p.codigo.toLowerCase() === text.toLowerCase());
      if (prod) {
        if (prod.unidad === "kg") {
          await bot.sendMessage(chatId, `👌 *${prod.nombre}* se vende por kilo.\n\n¿Cuántos *gramos* querés? (ej: 250, 500, 1000)`, { parse_mode: "Markdown" });
          // guardamos “modo espera gramos”
          carts.set(chatId, { ...(getCart(chatId)), pendingKgCode: prod.codigo });
          return res.sendStatus(200);
        } else {
          addToCart(chatId, prod, 1, false);
          await bot.sendMessage(chatId, `✅ Agregado: *${prod.nombre}*\nCantidad: 1`, { parse_mode: "Markdown" });
          await bot.sendMessage(chatId, "¿Sumamos algo más? 😋", mainMenu());
          return res.sendStatus(200);
        }
      }

      // Si estaba esperando gramos
      const cart = getCart(chatId);
      if (cart.pendingKgCode) {
        const grams = safeNum(text);
        const p = cache.catalogo.find(x => x.codigo === cart.pendingKgCode);
        cart.pendingKgCode = null;

        if (!p || grams <= 0) {
          await bot.sendMessage(chatId, "⚠️ Decime los gramos como número (ej: 250, 500, 1000).");
          return res.sendStatus(200);
        }

        const kg = grams / 1000;
        addToCart(chatId, p, kg, true);
        await bot.sendMessage(chatId, `✅ Agregado: *${p.nombre}*\nCantidad: ${grams}g`, { parse_mode: "Markdown" });

        // sugerencia simple (cross-sell)
        const sameCat = cache.catalogo.filter(x => x.categoria === p.categoria && x.codigo !== p.codigo).slice(0, 2);
        if (sameCat.length) {
          await bot.sendMessage(chatId, `💡 Sugerencia para acompañar: ${sameCat.map(x => `*${x.nombre}* (${x.codigo})`).join(" • ")}`, { parse_mode: "Markdown" });
        }

        await bot.sendMessage(chatId, "¿Sumamos algo más? 😋", mainMenu());
        return res.sendStatus(200);
      }

      // Mi carrito / Finalizar
      if (text.includes("Mi carrito")) {
        const c = getCart(chatId);
        if (!c.items.length) {
          await bot.sendMessage(chatId, "🛒 Tu carrito está vacío.", mainMenu());
          return res.sendStatus(200);
        }
        const lines = c.items.map((it, i) => {
          const qtyTxt = it.unidad === "kg" ? `${Math.round(it.cantidad*1000)}g` : `${it.cantidad}`;
          return `${i+1}) ${it.nombre} (${it.codigo})\n   Cantidad: ${qtyTxt}\n   Subtotal: $${Math.round(it.subtotal)}`;
        });

        const total = cartTotal(c);
        await bot.sendMessage(chatId, `🧾 *Tu carrito:*\n\n${lines.join("\n\n")}\n\n💰 *Total:* $${Math.round(total)}`, { parse_mode: "Markdown" });
        return res.sendStatus(200);
      }

      if (text.includes("Finalizar")) {
        const c = getCart(chatId);
        if (!c.items.length) {
          await bot.sendMessage(chatId, "🛒 Tu carrito está vacío.", mainMenu());
          return res.sendStatus(200);
        }
        const total = cartTotal(c);
        const envio = shippingCost(total);
        const totalFinal = total + envio;

        await bot.sendMessage(chatId,
          `✅ *Finalizar compra*\n\n💰 Subtotal: $${Math.round(total)}\n🚚 Envío: $${Math.round(envio)}\n🧾 *TOTAL:* $${Math.round(totalFinal)}\n\n¿Cómo querés recibir tu pedido?\n1) 🚚 Envío\n2) 🏬 Retiro`,
          { parse_mode: "Markdown" }
        );
        return res.sendStatus(200);
      }

      // Fallback humano: responder a cualquier mensaje con guía
      await bot.sendMessage(
        chatId,
        `Te leí 😊\n\n👉 Para ver productos tocá *Catálogo*.\n👉 Para ver lo que llevás, *Mi carrito*.\n👉 Para terminar, *Finalizar compra*.\n\nSi querés, escribime el *código* de un producto (ej: TQ03) y lo agrego.`,
        { parse_mode: "Markdown" , ...mainMenu() }
      );

      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (err) {
    cache.lastError = String(err && err.stack ? err.stack : err);
    return res.sendStatus(200);
  }
});

/** DEBUG */
app.get("/", (req, res) => res.send("ok"));
app.get("/debug", (req, res) => {
  res.json({
    ok: true,
    bootedAt: cache.bootedAt,
    bot: cache.bot,
    gasUrlSet: !!GAS_URL,
    configLoadedAt: cache.configLoadedAt,
    configKeysCount: cache.config ? Object.keys(cache.config).length : 0,
    sampleKeys: cache.config ? Object.keys(cache.config).slice(0, 20) : [],
    catalogoLoadedAt: cache.catalogoLoadedAt,
    catalogoCount: cache.catalogo ? cache.catalogo.length : 0,
    lastUpdateAt: cache.lastUpdateAt,
    lastChatId: cache.lastChatId,
    lastText: cache.lastText,
    lastError: cache.lastError
  });
});

const PORT = process.env.PORT || 10000;

(async () => {
  await warmUp();

  const webhookUrl = `${PUBLIC_URL}/webhook`;
  await bot.setWebHook(webhookUrl);

  console.log("✅ Webhook seteado:", webhookUrl);
  app.listen(PORT, () => console.log("Server up on", PORT));
})();

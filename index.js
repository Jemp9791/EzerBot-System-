// index.js
// EzerBot – Bot de Telegram para fidelización + catálogo + carrito + POS básico
// Funciona en Render con BOT_TOKEN y SHEETS_URL como variables de entorno

const express = require('express');
const fetch = require('node-fetch');

const app = express();

// ====== CONFIG BÁSICA ======
const BOT_TOKEN = process.env.BOT_TOKEN;
const SHEETS_URL = process.env.SHEETS_URL;
const PORT = process.env.PORT || 10000;

if (!BOT_TOKEN || !SHEETS_URL) {
  console.error('❌ Faltan BOT_TOKEN o SHEETS_URL en las variables de entorno');
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Para recibir JSON (webhook Telegram) y formularios (POS)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ====== ESTADO EN MEMORIA ======
const carts = new Map();       // chatId -> [items]
const lastCatalog = new Map(); // chatId -> catálogo
const pendingQty = new Map();  // chatId -> { index, unidad }

// ====== RAÍZ ======
app.get('/', (_req, res) => {
  res.send('EzerBot server running – POS en /pos');
});


// =====================================
//  POS DEL VENDEDOR EN /pos
// =====================================

app.get('/pos', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Ezer POS</title>
<style>
body{font-family:Arial;background:#f4f7fb;margin:0;padding:0;}
.wrap{max-width:480px;margin:20px auto;background:#fff;padding:20px;border-radius:12px;
box-shadow:0 2px 6px rgba(0,0,0,0.1);}
label{display:block;margin-top:10px;font-weight:bold;}
input{width:100%;padding:10px;margin-top:5px;border:1px solid #ccc;border-radius:6px;}
button{width:100%;margin-top:15px;padding:12px;background:#0b84ff;color:#fff;border:none;
border-radius:8px;font-size:16px;}
</style>
</head>
<body>
<div class="wrap">
<h2>Ezer POS – Venta Rápida</h2>
<form method="POST" action="/pos">
<label>Chat ID del cliente</label>
<input name="chatId" required placeholder="Ej: 7454984023"/>

<label>Nombre del cliente</label>
<input name="nombre" placeholder="Ej: Jenny"/>

<label>Monto total</label>
<input name="monto" type="number" required placeholder="Ej: 35000"/>

<button type="submit">Registrar compra</button>
</form>
</div>
</body>
</html>`);
});

app.post('/pos', async (req, res) => {
  try {
    const { chatId, nombre, monto } = req.body;

    if (!chatId || !monto) {
      res.send(`<p>Error: faltan datos.</p><a href="/pos">Volver</a>`);
      return;
    }

    const result = await callSheets('registrarCompra', {
      chatId,
      nombre,
      monto
    });

    res.send(`<h2>Compra registrada</h2>
<p>Sellos ganados: ${result?.sellosGanados || 0}</p>
<p>Total acumulado: ${result?.sellosTotales || 0}</p>
<a href="/pos">Registrar otra</a>`);
  } catch (e) {
    res.send(`<p>Error interno.</p><a href="/pos">Volver</a>`);
  }
});


// =====================================
// WEBHOOK DE TELEGRAM
// =====================================

app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
  res.sendStatus(200);
  await handleUpdate(req.body);
});


// =====================================
// PROCESAR UPDATE
// =====================================

async function handleUpdate(update) {
  try {
    if (update.callback_query) {
      await handleCallback(update.callback_query);
      return;
    }

    const msg = update.message;
    if (!msg) return;
    const chatId = msg.chat.id;
    const text = msg.text?.trim() || "";

    const mainKeyboard = {
      keyboard: [
        ['🛒 Ver catálogo', '🏆 Mis sellos y puntos'],
        ['🎁 Canjear beneficio', '🏬 Información del local'],
        ['🛍 Mi carrito', '📲 Hablar con el vendedor']
      ],
      resize_keyboard: true
    };

    // -------------------------
    // Si estamos esperando cantidad
    // -------------------------
    const pending = pendingQty.get(chatId);
    if (pending) {
      const catalog = lastCatalog.get(chatId) || [];
      const item = catalog[pending.index];

      if (!item) {
        pendingQty.delete(chatId);
        await sendMessage(chatId, "No se encontró el producto. Intentalo de nuevo.", mainKeyboard);
        return;
      }

      const unidad = (pending.unidad || "").toLowerCase() === "kg" ? "kg" : "unidad";
      const num = parseInt(text, 10);
      if (isNaN(num)) {
        await sendMessage(chatId, "Escribí un número válido.", mainKeyboard);
        return;
      }

      if (unidad === "kg" && num < 100) {
        await sendMessage(chatId, "Mínimo 100 gramos.", mainKeyboard);
        return;
      }
      if (unidad === "unidad" && num < 1) {
        await sendMessage(chatId, "Mínimo 1 unidad.", mainKeyboard);
        return;
      }

      const precio = Number(item.precio || 0);
      let subtotal =
        unidad === "kg" ? Math.round((num / 1000) * precio) : precio * num;

      const cart = carts.get(chatId) || [];
      cart.push({
        nombre: item.nombre,
        cantidad: num,
        unidadTipo: unidad,
        precioBase: precio,
        subtotal,
        moneda: item.moneda || "ARS"
      });
      carts.set(chatId, cart);

      pendingQty.delete(chatId);

      const cantidadTxt = unidad === "kg" ? `${num} g` : `${num} un.`;

      await sendMessage(
        chatId,
        `🛒 Agregué *${cantidadTxt} de ${item.nombre}*\nSubtotal: *${subtotal} ARS*`,
        mainKeyboard
      );
      return;
    }

    // ------------------------------------------
    // /start — bienvenida con logo del negocio
    // ------------------------------------------
    if (text === "/start" || text.toLowerCase() === "start") {
      const config = await getConfigFromSheets();

      const nombre = config?.NegocioNombre || "Tu tienda";
      const desc = config?.Descripcion || "Bienvenido a nuestro bot 🎉";

      const logo =
        config?.LogoURL || config?.TarjetaURL || config?.SelloURL;

      if (logo) {
        await sendPhoto(chatId, logo, "");
      }

      await sendMessage(
        chatId,
        `🧀 *${nombre}*\n\n${desc}\n\nUsá el menú para navegar.`,
        mainKeyboard
      );
      return;
    }

    // ------------------------------
    // Información del local
    // ------------------------------
    if (text.startsWith("🏬")) {
      const config = await getConfigFromSheets();

      const logo =
        config?.LogoURL || config?.TarjetaURL || config?.SelloURL;

      if (logo) await sendPhoto(chatId, logo, "");

      await sendMessage(
        chatId,
        `🏬 *${config?.NegocioNombre}*\n\n📍 ${config?.Direccion}\n🕒 ${config?.Horarios}\n📞 ${config?.TelefonoNegocio}\n📷 ${config?.Instagram}`,
        mainKeyboard
      );
      return;
    }

    // ------------------------------
    // Sellos del cliente
    // ------------------------------
    if (text.startsWith("🏆")) {
      const estado = await getEstadoClienteFromSheets(chatId);
      const config = await getConfigFromSheets();

      if (!estado?.tieneTarjeta) {
        await sendMessage(chatId, "Aún no tenés tarjeta. Comprá algo para comenzar.", mainKeyboard);
        return;
      }

      const barra = "🧀".repeat(estado.sellosActuales) +
                    "⬜".repeat(estado.sellosNivelActual - estado.sellosActuales);

      await sendMessage(
        chatId,
        `🏆 *Tu tarjeta de sellos*\n\n${barra}\nNivel: *${estado.nivelActual}*\nSiguente beneficio: ${estado.beneficioProximo}`,
        mainKeyboard
      );

      if (estado.tarjetaImagenUrl) {
        await sendPhoto(chatId, estado.tarjetaImagenUrl, "");
      }

      return;
    }

    // ------------------------------
    // Canjear beneficio
    // ------------------------------
    if (text.startsWith("🎁")) {
      const estado = await getEstadoClienteFromSheets(chatId);

      if (!estado?.beneficioDisponible) {
        await sendMessage(chatId, "Todavía no tenés beneficios disponibles.", mainKeyboard);
        return;
      }

      await sendMessage(
        chatId,
        `🎁 *Beneficio disponible*\n${estado.descripcionBeneficio}\nVence el: ${estado.venceEl}\nCódigo: *${estado.codigoCanje}*`,
        mainKeyboard
      );

      await callSheets("marcarBeneficioVisto", { chatId });
      return;
    }

    // ------------------------------
    // Ver catálogo
    // ------------------------------
    if (text.startsWith("🛒")) {
      const catalogo = await getCatalogoFromSheets();
      lastCatalog.set(chatId, catalogo.items || []);

      if (!catalogo.items?.length) {
        await sendMessage(chatId, "No hay productos cargados.", mainKeyboard);
        return;
      }

      for (let i = 0; i < catalogo.items.length; i++) {
        const item = catalogo.items[i];
        const unidad = item.unidad?.toLowerCase() === "kg" ? "por kilo" : "por unidad";

        const caption =
          `🛒 *${item.nombre}*\n` +
          `💰 ${item.precio} ARS (${unidad})\n` +
          `${item.descripcion || ""}`;

        await sendPhoto(chatId, item.imagenUrl, caption, {
          inline_keyboard: [[{ text: "Agregar al carrito", callback_data: `ADD:${i}` }]]
        });
      }

      return;
    }

    // ------------------------------
    // Mi carrito
    // ------------------------------
    if (text.startsWith("🛍")) {
      const cart = carts.get(chatId) || [];

      if (!cart.length) {
        await sendMessage(chatId, "Tu carrito está vacío.", mainKeyboard);
        return;
      }

      let total = 0;
      let detalle = "";

      cart.forEach((item, i) => {
        total += item.subtotal;
        detalle += `${i + 1}) ${item.nombre} – ${item.subtotal} ARS\n`;
      });

      await sendMessage(
        chatId,
        `🛍 *Tu carrito*\n\n${detalle}\nTotal: *${total} ARS*`,
        {
          inline_keyboard: [[{ text: "Confirmar pedido", callback_data: "CHECKOUT" }]]
        }
      );
      return;
    }

    // ------------------------------
    // Hablar con el vendedor
    // ------------------------------
    if (text.startsWith("📲")) {
      const config = await getConfigFromSheets();
      const tel = config.TelefonoNegocio?.replace(/\D/g, "");
      const link = config.WhatsAppLink || (tel ? `https://wa.me/${tel}` : "");

      await sendMessage(chatId, `📲 Contactá al vendedor:\n${link || "No configurado"}`, mainKeyboard);
      return;
    }

    // ------------------------------
    // Respuesta por defecto
    // ------------------------------
    await sendMessage(chatId, "Usá el menú para navegar 😊", mainKeyboard);

  } catch (err) {
    console.error("❌ Error general:", err);
  }
}


// =====================================
// CALLBACKS – botones inline
// =====================================

async function handleCallback(callback) {
  try {
    const chatId = callback.message.chat.id;
    const data = callback.data;

    // Agregar producto
    if (data.startsWith("ADD:")) {
      const index = Number(data.split(":")[1]);
      const catalog = lastCatalog.get(chatId) || [];
      const item = catalog[index];

      if (!item) {
        await answerCallback(callback.id, "Error");
        return;
      }

      const unidad = item.unidad?.toLowerCase() || "unidad";
      pendingQty.set(chatId, { index, unidad });

      await answerCallback(callback.id, "");
      await sendMessage(
        chatId,
        unidad === "kg"
          ? `¿Cuántos gramos de ${item.nombre} querés?`
          : `¿Cuántas unidades de ${item.nombre} querés?`
      );
      return;
    }

    // Confirmar pedido
    if (data === "CHECKOUT") {
      const cart = carts.get(chatId) || [];
      if (!cart.length) {
        await answerCallback(callback.id, "");
        await sendMessage(chatId, "Carrito vacío.");
        return;
      }

      let total = 0;
      let detalle = "";
      cart.forEach((p, i) => {
        total += p.subtotal;
        detalle += `${i + 1}) ${p.nombre} – ${p.subtotal} ARS\n`;
      });

      const config = await getConfigFromSheets();
      const alias = config.AliasPago || "";
      const tel = config.TelefonoNegocio?.replace(/\D/g, "");
      const linkVendedor = config.WhatsAppLink || (tel ? `https://wa.me/${tel}` : "");

      let msg =
        `🧾 *Pedido confirmado*\n\n${detalle}\nTotal: *${total} ARS*\n\n` +
        (alias ? `Alias de pago: *${alias}*\n` : "") +
        (linkVendedor ? `Enviá comprobante al vendedor:\n${linkVendedor}` : "");

      await sendMessage(chatId, msg);
      carts.delete(chatId);
      await answerCallback(callback.id, "");
      return;
    }

  } catch (e) {
    console.error("❌ Callback error:", e);
  }
}


// =====================================
// SHEETS HELPERS
// =====================================

async function callSheets(accion, params) {
  const url = `${SHEETS_URL}?accion=${accion}&` + new URLSearchParams(params).toString();
  const res = await fetch(url);
  return await res.json();
}

async function getConfigFromSheets() {
  return await callSheets("config", {});
}

async function getEstadoClienteFromSheets(chatId) {
  return await callSheets("estadoCliente", { chatId });
}

async function getCatalogoFromSheets() {
  return await callSheets("catalogo", {});
}


// =====================================
// TELEGRAM HELPERS
// =====================================

async function sendMessage(chatId, text, keyboard) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      reply_markup: keyboard
    })
  });
}

async function sendPhoto(chatId, photo, caption, keyboard) {
  await fetch(`${TELEGRAM_API}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      photo,
      caption,
      parse_mode: "Markdown",
      reply_markup: keyboard
    })
  });
}

async function answerCallback(id, text) {
  await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: id, text })
  });
}


// =====================================
// INICIAR SERVIDOR
// =====================================

app.listen(PORT, () => {
  console.log(`🚀 EzerBot escuchando en puerto ${PORT}`);
});

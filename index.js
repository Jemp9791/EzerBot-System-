// index.js
// EzerBot – Bot de Telegram para fidelización + sellos + catálogo + carrito
// Servidor para Render (Node + Express)

const express = require('express');
const fetch = require('node-fetch');

const app = express();

// ==== CONFIGURACIÓN BÁSICA ====
const BOT_TOKEN = process.env.BOT_TOKEN;
const SHEETS_URL = process.env.SHEETS_URL;
const PORT = process.env.PORT || 10000;

if (!BOT_TOKEN || !SHEETS_URL) {
  console.error('❌ Faltan BOT_TOKEN o SHEETS_URL en las variables de entorno');
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Para recibir JSON de Telegram
app.use(express.json());

// Carritos en memoria: chatId -> array de items
const carts = new Map();
// Último catálogo enviado: chatId -> array de items
const lastCatalog = new Map();

// Endpoint simple para probar que Render está vivo
app.get('/', (_req, res) => {
  res.send('EzerBot server running');
});

// Endpoint de Webhook de Telegram
app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
  try {
    const update = req.body;
    res.sendStatus(200); // responder rápido a Telegram
    await handleUpdate(update);
  } catch (err) {
    console.error('❌ Error procesando update:', err);
    res.sendStatus(500);
  }
});

// =====================
//   LÓGICA PRINCIPAL
// =====================

async function handleUpdate(update) {
  try {
    // 1) Callbacks (botones inline: agregar al carrito, etc.)
    if (update.callback_query) {
      await handleCallback(update.callback_query);
      return;
    }

    // 2) Mensajes normales
    const message = update.message;
    if (!message) return;

    const chatId = message.chat.id;
    const text = (message.text || '').trim();

    // Menú principal (botones abajo)
    const mainKeyboard = {
      keyboard: [
        ['🛒 Ver catálogo', '🏆 Mis sellos y puntos'],
        ['🎁 Canjear beneficio', '🏬 Información del local'],
        ['🛍 Mi carrito', '📲 Hablar con el vendedor']
      ],
      resize_keyboard: true
    };

    // /start o inicio
    if (!text || text === '/start' || text.toLowerCase() === 'start') {
      const config = await getConfigFromSheets();
      const nombre = config?.NegocioNombre || 'Tu local favorito';
      const descripcion = config?.Descripcion ||
        'Bienvenido a nuestro sistema de sellos, beneficios y compras.';

      const bienvenida = [
        `🧀 *${nombre}*`,
        '',
        descripcion,
        '',
        'Desde este bot podés:',
        '• Ver el 🛒 *catálogo* con productos',
        '• Ver tu 🏆 *tarjeta de sellos y puntos*',
        '• Consultar y 🎁 *canjear beneficios*',
        '• Ver info del 🏬 *local* (horarios, dirección, etc.)',
        '• Revisar tu 🛍 *carrito* antes de confirmar el pedido',
        '• 📲 *Hablar con el vendedor* por WhatsApp'
      ].join('\n');

      await sendMessage(chatId, bienvenida, mainKeyboard);
      return;
    }

    // ====================
    //   RUTAS DEL MENÚ
    // ====================

    // Información del local (con logo)
    if (text.startsWith('🏬') || /información del local/i.test(text)) {
      const config = await getConfigFromSheets();
      const nombre = config?.NegocioNombre || 'Negocio';
      const direccion = config?.Direccion || 'Dirección no configurada';
      const horarios = config?.Horarios || 'Horarios no configurados';
      const insta = config?.Instagram || '';
      const tel = config?.TelefonoNegocio || '';
      const logoUrl = config?.LogoURL || config?.SelloURL || '';

      let msg = `🏬 *${nombre}*\n\n`;
      msg += `📍 *Dirección:* ${direccion}\n`;
      msg += `🕒 *Horarios:* ${horarios}\n`;
      if (tel) msg += `📞 *Teléfono:* ${tel}\n`;
      if (insta) msg += `📷 *Instagram:* ${insta}\n`;
      msg += `\nGracias por ser parte de *${nombre} Club* 🧀`;

      if (logoUrl) {
        await sendPhoto(chatId, logoUrl, msg, mainKeyboard);
      } else {
        await sendMessage(chatId, msg, mainKeyboard);
      }
      return;
    }

    // Mis sellos y puntos
    if (text.startsWith('🏆') || /mis sellos/i.test(text)) {
      const estado = await getEstadoClienteFromSheets(chatId);
      const config = await getConfigFromSheets();

      if (!estado || !estado.tieneTarjeta) {
        const msg = 'No encontré tu tarjeta todavía.\n' +
          'Hacé una compra en el local para empezar a sumar sellos 🧾✨';
        await sendMessage(chatId, msg, mainKeyboard);
        return;
      }

      const nombre = estado.nombreCliente || '';
      const sellosActuales = Number(estado.sellosActuales || 0);
      const sellosNivelActual = Number(estado.sellosNivelActual || 10);
      const nivelActual = estado.nivelActual || 'Nivel inicial';
      const beneficioProximo = estado.beneficioProximo || '';
      const totales = Number(estado.sellosTotalesAcumulados || sellosActuales);
      const faltan = Math.max(sellosNivelActual - sellosActuales, 0);

      const maxCirculos = Math.min(sellosNivelActual, 10);
      const llenos = Math.min(sellosActuales, maxCirculos);
      const vacios = maxCirculos - llenos;
      const barra = `${'🧀'.repeat(llenos)}${'⬜'.repeat(vacios)}`;

      let msg = '';
      if (nombre) msg += `Hola *${nombre}* 👋\n\n`;
      msg += `🏆 *Tu tarjeta de sellos*\n\n`;
      msg += `${barra}  \n`;
      msg += `Sellos en este nivel: *${sellosActuales}/${sellosNivelActual}*\n`;
      msg += `Sellos acumulados totales: *${totales}*\n`;
      msg += `Nivel actual: *${nivelActual}*\n\n`;

      if (faltan > 0 && beneficioProximo) {
        msg += `Te faltan *${faltan} sellos* para tu próximo beneficio:\n`;
        msg += `🎁 _${beneficioProximo}_\n`;
      } else if (beneficioProximo) {
        msg += `🎉 ¡Completaste este nivel! Tenés un beneficio listo para canjear:\n`;
        msg += `🎁 _${beneficioProximo}_\n`;
        msg += `Usá el botón *“Canjear beneficio”* para reclamarlo.`;
      }

      await sendMessage(chatId, msg, mainKeyboard);

      const tarjetaUrl = estado.tarjetaImagenUrl || config?.TarjetaURL;
      if (tarjetaUrl) {
        await sendPhoto(chatId, tarjetaUrl, 'Tu tarjeta de sellos 🧀', mainKeyboard);
      }

      return;
    }

    // Canjear beneficio
    if (text.startsWith('🎁') || /canjear/i.test(text)) {
      const estado = await getEstadoClienteFromSheets(chatId);

      if (!estado || !estado.tieneTarjeta) {
        await sendMessage(
          chatId,
          'Todavía no encontré tu tarjeta. Empezá haciendo una compra en el local 🧾✨',
          mainKeyboard
        );
        return;
      }

      if (!estado.beneficioDisponible) {
        await sendMessage(
          chatId,
          'Por ahora no tenés ningún beneficio listo para canjear. ' +
          'Seguí sumando sellos y pronto vas a desbloquear un premio 🎁',
          mainKeyboard
        );
        return;
      }

      const desc = estado.descripcionBeneficio || 'Beneficio disponible';
      const vence = estado.venceEl ? `\n📅 Vence el: *${estado.venceEl}*` : '';
      const codigo = estado.codigoCanje ? `\n🔐 Código de canje: *${estado.codigoCanje}*` : '';

      let msg = `🎁 *Tenés un beneficio para canjear*\n\n`;
      msg += `${desc}\n`;
      msg += vence;
      msg += codigo;
      msg += `\n\nMostrá este mensaje en el local para validar el beneficio.`;

      await sendMessage(chatId, msg, mainKeyboard);
      await callSheets('marcarBeneficioVisto', { chatId });

      return;
    }

    // Ver catálogo (ahora con "Agregar al carrito")
    if (text.startsWith('🛒') || /catálogo/i.test(text)) {
      const catalogo = await getCatalogoFromSheets();

      if (!catalogo || !Array.isArray(catalogo.items) || catalogo.items.length === 0) {
        await sendMessage(
          chatId,
          'Por ahora el catálogo no tiene productos cargados. Volvé a intentar más tarde 🧀',
          mainKeyboard
        );
        return;
      }

      lastCatalog.set(chatId, catalogo.items);

      const items = catalogo.items.slice(0, 20); // límite para no spamear

      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const nombre = item.nombre || 'Producto';
        const desc = item.descripcion || '';
        const moneda = item.moneda || catalogo.moneda || 'ARS';
        const precio = item.precio != null ? `${item.precio} ${moneda}` : '';
        const img = item.imagenUrl || item.imagen || '';

        let caption = `🛒 *${nombre}*\n`;
        if (precio) caption += `💰 *Precio:* ${precio}\n`;
        if (desc) caption += `\n${desc}\n`;

        const inlineKb = {
          inline_keyboard: [[
            { text: '🛒 Agregar al carrito', callback_data: `ADD:${index}` }
          ]]
        };

        if (img) {
          await sendPhoto(chatId, img, caption, inlineKb);
        } else {
          await sendMessage(chatId, caption, inlineKb);
        }
      }

      await sendMessage(
        chatId,
        'Cuando quieras ver lo que llevás, tocá *“🛍 Mi carrito”*.',
        mainKeyboard
      );

      return;
    }

    // Mi carrito
    if (text.startsWith('🛍') || /mi carrito/i.test(text)) {
      const cart = carts.get(chatId) || [];
      if (cart.length === 0) {
        await sendMessage(
          chatId,
          '🛍 Tu carrito está vacío.\nUsá *“Ver catálogo”* para agregar productos.',
          mainKeyboard
        );
        return;
      }

      let total = 0;
      let lineas = cart.map((item, i) => {
        const precioNum = Number(item.precio || 0);
        total += precioNum;
        return `${i + 1}) *${item.nombre}* - ${precioNum} ${item.moneda || 'ARS'}`;
      });

      let msg = '🛍 *Tu carrito*\n\n';
      msg += lineas.join('\n');
      msg += `\n\n💰 *Total:* ${total} ARS\n`;
      msg += `\nPor ahora este carrito es informativo.\n` +
        `En la próxima versión vas a poder confirmar el pedido y recibir el alias para el pago.`;

      await sendMessage(chatId, msg, mainKeyboard);
      return;
    }

    // 📲 Hablar con el vendedor
    if (text.startsWith('📲') || /vendedor/i.test(text)) {
      const config = await getConfigFromSheets();
      let link = config?.WhatsAppLink || '';

      if (!link) {
        const tel = (config?.TelefonoNegocio || '').replace(/\D/g, '');
        if (tel) {
          link = `https://wa.me/${tel}`;
        }
      }

      if (!link) {
        await sendMessage(
          chatId,
          'Por ahora no tengo configurado el enlace de contacto con el vendedor.',
          mainKeyboard
        );
        return;
      }

      const msg = [
        '📲 Para hablar con el vendedor, tocá este enlace:',
        '',
        link
      ].join('\n');

      await sendMessage(chatId, msg, mainKeyboard);
      return;
    }

    // Mensaje por defecto
    const ayuda = [
      'Usá el menú de abajo para navegar 😊',
      '',
      '• 🛒 *Ver catálogo*',
      '• 🏆 *Mis sellos y puntos*',
      '• 🎁 *Canjear beneficio*',
      '• 🏬 *Información del local*',
      '• 🛍 *Mi carrito*',
      '• 📲 *Hablar con el vendedor*'
    ].join('\n');

    await sendMessage(chatId, ayuda, mainKeyboard);

  } catch (err) {
    console.error('❌ Error en handleUpdate:', err);
  }
}

// =====================
//   CALLBACKS INLINE
// =====================

async function handleCallback(callback) {
  try {
    const chatId = callback.message.chat.id;
    const data = callback.data || '';

    if (data.startsWith('ADD:')) {
      const idxStr = data.split(':')[1];
      const index = parseInt(idxStr, 10);

      const catalog = lastCatalog.get(chatId) || [];
      const item = catalog[index];

      if (!item) {
        await answerCallbackQuery(callback.id, 'No encontré el producto 😕');
        return;
      }

      const cart = carts.get(chatId) || [];
      cart.push({
        nombre: item.nombre || 'Producto',
        precio: item.precio || 0,
        moneda: item.moneda || 'ARS'
      });
      carts.set(chatId, cart);

      await answerCallbackQuery(callback.id, 'Producto agregado al carrito 🛒');

      await sendMessage(
        chatId,
        `🛒 Agregué *${item.nombre}* a tu carrito.\n` +
        `Ahora tenés *${cart.length}* producto(s).\n\n` +
        `Tocá *“🛍 Mi carrito”* para ver el detalle.`,
      );
      return;
    }

    await answerCallbackQuery(callback.id, '');
  } catch (err) {
    console.error('❌ Error en handleCallback:', err);
  }
}

// =====================
//   LLAMADAS A SHEETS
// =====================

async function callSheets(accion, extraParams = {}) {
  try {
    const params = new URLSearchParams({ accion, ...extraParams });
    const url = `${SHEETS_URL}?${params.toString()}`;

    const res = await fetch(url);
    if (!res.ok) {
      console.error(`❌ Error llamando a Sheets (${accion}):`, res.status, await res.text());
      return null;
    }

    const data = await res.json();
    return data;
  } catch (err) {
    console.error(`❌ Excepción llamando a Sheets (${accion}):`, err);
    return null;
  }
}

async function getConfigFromSheets() {
  return await callSheets('config');
}

async function getEstadoClienteFromSheets(chatId) {
  return await callSheets('estadoCliente', { chatId });
}

async function getCatalogoFromSheets() {
  return await callSheets('catalogo');
}

// =====================
//   HELPERS TELEGRAM
// =====================

async function sendMessage(chatId, text, keyboard) {
  try {
    const body = {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      reply_markup: keyboard ? keyboard : undefined
    };

    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      console.error('❌ Error sendMessage:', res.status, await res.text());
    }
  } catch (err) {
    console.error('❌ Excepción sendMessage:', err);
  }
}

async function sendPhoto(chatId, photoUrl, caption, keyboard) {
  try {
    const body = {
      chat_id: chatId,
      photo: photoUrl,
      caption,
      parse_mode: 'Markdown',
      reply_markup: keyboard ? keyboard : undefined
    };

    const res = await fetch(`${TELEGRAM_API}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      console.error('❌ Error sendPhoto:', res.status, await res.text());
    }
  } catch (err) {
    console.error('❌ Excepción sendPhoto:', err);
  }
}

async function answerCallbackQuery(callbackId, text) {
  try {
    const body = {
      callback_query_id: callbackId,
      text: text || undefined,
      show_alert: false
    };

    const res = await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      console.error('❌ Error answerCallbackQuery:', res.status, await res.text());
    }
  } catch (err) {
    console.error('❌ Excepción answerCallbackQuery:', err);
  }
}

// =====================
//   ARRANQUE SERVIDOR
// =====================

app.listen(PORT, () => {
  console.log(`🚀 EzerBot escuchando en puerto ${PORT}`);
});

// index.js
// EzerBot – Bot de Telegram para fidelización + sellos + catálogo
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

// Endpoint simple para probar que Render está vivo
app.get('/', (_req, res) => {
  res.send('EzerBot server running');
});

// Endpoint de Webhook de Telegram
// URL configurada: /webhook/<BOT_TOKEN>
app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
  try {
    const update = req.body;
    // Respondemos rápido a Telegram
    res.sendStatus(200);
    // Procesamos el mensaje aparte
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
    const message = update.message || update.callback_query?.message;
    if (!message) return;

    const chatId = message.chat.id;
    const text = (update.message?.text || '').trim();

    // Menú principal
    const mainKeyboard = {
      keyboard: [
        ['🛒 Ver catálogo', '🏆 Mis sellos y puntos'],
        ['🎁 Canjear beneficio', '🏬 Información del local']
      ],
      resize_keyboard: true
    };

    // /start o inicio
    if (!text || text === '/start' || text.toLowerCase() === 'start') {
      const config = await getConfigFromSheets();
      const nombre = config?.NegocioNombre || 'Tu local favorito';
      const descripcion = config?.Descripcion ||
        'Bienvenido a nuestro sistema de sellos y beneficios.';

      const bienvenida = [
        `🧀 *${nombre}*`,
        '',
        descripcion,
        '',
        'Desde este bot podés:',
        '• Ver el 🛒 *catálogo* con productos',
        '• Ver tu 🏆 *tarjeta de sellos y puntos*',
        '• Consultar y 🎁 *canjear beneficios*',
        '• Ver info del 🏬 *local* (horarios, dirección, etc.)'
      ].join('\n');

      await sendMessage(chatId, bienvenida, mainKeyboard);
      return;
    }

    // ====================
    //   RUTAS DEL MENÚ
    // ====================

    // Información del local
    if (text.startsWith('🏬') || /información del local/i.test(text)) {
      const config = await getConfigFromSheets();
      const nombre = config?.NegocioNombre || 'Negocio';
      const direccion = config?.Direccion || 'Dirección no configurada';
      const horarios = config?.Horarios || 'Horarios no configurados';
      const insta = config?.Instagram || '';
      const tel = config?.TelefonoNegocio || '';

      let msg = `🏬 *${nombre}*\n\n`;
      msg += `📍 *Dirección:* ${direccion}\n`;
      msg += `🕒 *Horarios:* ${horarios}\n`;
      if (tel) msg += `📞 *Teléfono:* ${tel}\n`;
      if (insta) msg += `📷 *Instagram:* ${insta}\n`;
      msg += `\nGracias por ser parte de *Todo Queso Club* 🧀`;

      await sendMessage(chatId, msg, mainKeyboard);
      return;
    }

    // Mis sellos y puntos
    if (text.startsWith('🏆') || /mis sellos/i.test(text)) {
      const estado = await getEstadoClienteFromSheets(chatId);

      if (!estado || !estado.tieneTarjeta) {
        const msg = 'No encontré tu tarjeta todavía.\n' +
          'Hacé una compra en el local para empezar a sumar sellos 🧾✨';
        await sendMessage(chatId, msg, mainKeyboard);
        return;
      }

      // Estructura esperada desde Sheets (ajustá Apps Script si hace falta):
      // {
      //   tieneTarjeta: true,
      //   nombreCliente: 'Jenny',
      //   sellosActuales: 3,
      //   sellosNivelActual: 10,
      //   nivelActual: 'TQ Bronce',
      //   sellosTotalesAcumulados: 25,
      //   beneficioProximo: '2 prepizzas, 400 grs de queso...',
      //   tarjetaImagenUrl: 'https://...'  // opcional
      // }

      const nombre = estado.nombreCliente || '';
      const sellosActuales = Number(estado.sellosActuales || 0);
      const sellosNivelActual = Number(estado.sellosNivelActual || 10);
      const nivelActual = estado.nivelActual || 'Nivel inicial';
      const beneficioProximo = estado.beneficioProximo || '';
      const totales = Number(estado.sellosTotalesAcumulados || sellosActuales);

      const faltan = Math.max(sellosNivelActual - sellosActuales, 0);

      // Dibujamos la “barra” de sellos con emojis 🧀⬜
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

      // Si tuvieras una imagen de la tarjeta fija
      if (estado.tarjetaImagenUrl) {
        await sendPhoto(chatId, estado.tarjetaImagenUrl, 'Tu tarjeta de sellos');
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

      // Estructura esperada:
      // beneficioDisponible: true,
      // descripcionBeneficio: 'Picada para 2 + Coca 1.5L',
      // venceEl: '2025-01-10',
      // codigoCanje: 'TQ-ABCD1234'

      const desc = estado.descripcionBeneficio || 'Beneficio disponible';
      const vence = estado.venceEl ? `\n📅 Vence el: *${estado.venceEl}*` : '';
      const codigo = estado.codigoCanje ? `\n🔐 Código de canje: *${estado.codigoCanje}*` : '';

      let msg = `🎁 *Tenés un beneficio para canjear*\n\n`;
      msg += `${desc}\n`;
      msg += vence;
      msg += codigo;
      msg += `\n\nMostrá este mensaje en el local para validar el beneficio.`;

      await sendMessage(chatId, msg, mainKeyboard);

      // Aviso opcional a Sheets de que el cliente vio el beneficio
      await callSheets('marcarBeneficioVisto', { chatId });

      return;
    }

    // Ver catálogo
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

      // Estructura esperada desde Sheets:
      // {
      //   items: [
      //     { nombre, descripcion, precio, moneda, imagenUrl }
      //   ]
      // }

      for (const item of catalogo.items.slice(0, 20)) { // límite de 20 por consulta
        const nombre = item.nombre || 'Producto';
        const desc = item.descripcion || '';
        const moneda = item.moneda || catalogo.moneda || 'ARS';
        const precio = item.precio != null ? `${item.precio} ${moneda}` : '';
        const img = item.imagenUrl || item.imagen || '';

        let caption = `🛒 *${nombre}*\n`;
        if (precio) caption += `💰 *Precio:* ${precio}\n`;
        if (desc) caption += `\n${desc}\n`;

        if (img) {
          await sendPhoto(chatId, img, caption);
        } else {
          await sendMessage(chatId, caption);
        }
      }

      // Mensaje final recordando el menú
      await sendMessage(
        chatId,
        'Para hacer un pedido, escribí qué productos querés o usá el menú de abajo.',
        mainKeyboard
      );

      return;
    }

    // Mensaje por defecto
    const ayuda = [
      'Usá el menú de abajo para navegar 😊',
      '',
      '• 🛒 *Ver catálogo*',
      '• 🏆 *Mis sellos y puntos*',
      '• 🎁 *Canjear beneficio*',
      '• 🏬 *Información del local*'
    ].join('\n');

    await sendMessage(chatId, ayuda, mainKeyboard);

  } catch (err) {
    console.error('❌ Error en handleUpdate:', err);
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
  // En Apps Script podés usar el chatId como identificador temporal
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

async function sendPhoto(chatId, photoUrl, caption) {
  try {
    const body = {
      chat_id: chatId,
      photo: photoUrl,
      caption,
      parse_mode: 'Markdown'
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

// =====================
//   ARRANQUE SERVIDOR
// =====================

app.listen(PORT, () => {
  console.log(`🚀 EzerBot escuchando en puerto ${PORT}`);
});

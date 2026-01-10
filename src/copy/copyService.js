// src/modules/copy/copyService.js

const config = require("../config/configService");

function randomFrom(array) {
  return array[Math.floor(Math.random() * array.length)];
}

async function welcome() {
  const negocio = await config.get("NegocioNombre");
  const abierto = await config.get("Estado");
  const horario = await config.get("HorarioAtencion");
  const emojis = await config.list("EmojisBienvenida");

  let texto = `${randomFrom(emojis)} *¡Hola! Bienvenido a ${negocio}*\n\n`;

  if (abierto === "Abierto") {
    texto += `🟢 Estamos *abiertos* hoy hasta las *${horario}*\n\n`;
    texto += `¿Qué te gustaría hacer ahora?\n`;
    texto += `🛒 Ver productos\n🚚 Hacer un pedido\n🏬 Retirar en el local`;
  } else {
    texto += `🔴 En este momento estamos *cerrados*\n`;
    texto += `⏰ Nuestro horario es: *${horario}*`;
  }

  return texto;
}

async function afterAddToCart(producto) {
  const frases = await config.list("FrasesPostProducto");

  return (
    `🧀 *${producto}* agregado al carrito.\n\n` +
    randomFrom(frases) +
    `\n\n👉 ¿Seguimos comprando o avanzamos al pago?`
  );
}

async function showCart(cart) {
  if (!cart.length) {
    return "🛒 Tu carrito está vacío.\n¿Querés que te muestre el catálogo?";
  }

  let texto = "🛒 *Tu carrito hasta ahora:*\n\n";
  cart.forEach((item, i) => {
    texto += `${i + 1}. ${item}\n`;
  });

  texto += `\n💳 Cuando quieras podemos avanzar al pago 😉`;
  return texto;
}

async function paymentOptions() {
  const efectivo = await config.isEnabled("PagoEfectivo");
  const transferencia = await config.isEnabled("PagoTransferencia");

  let texto = "💳 *¿Cómo preferís pagar?*\n\n";

  if (efectivo) texto += "💵 Efectivo\n";
  if (transferencia) texto += "🏦 Transferencia\n";

  texto += "\nDecime y seguimos 👌";
  return texto;
}

async function confirmPayment(method) {
  const gracias = await config.text("TextoGraciasCompra");

  return (
    `✅ Pago seleccionado: *${method}*\n\n` +
    gracias +
    `\n\n📦 En breve coordinamos entrega o retiro.`
  );
}

module.exports = {
  welcome,
  afterAddToCart,
  showCart,
  paymentOptions,
  confirmPayment,
};

// src/handlers/catalogHandler.js

const catalogService = require("../modules/catalog/catalogService");
const config = require("../modules/config/configService");

async function show(phone) {
  const categorias = await catalogService.obtenerCategorias();
  const gif = await config.get("GifCatalogo");

  let texto = "🧀 *Nuestro catálogo*\n\n";

  categorias.forEach(cat => {
    texto += `• ${cat}\n`;
  });

  texto += "\n👉 Decime qué categoría te interesa y te muestro opciones";

  const mensajes = [
    {
      to: phone,
      type: "text",
      text: { body: texto },
    },
  ];

  if (gif) {
    mensajes.push({
      to: phone,
      type: "image",
      image: {
        link: gif,
        caption: "👆 Elegí tranquilo, te ayudo a armar el pedido 😉",
      },
    });
  }

  return mensajes;
}

module.exports = {
  show,
};

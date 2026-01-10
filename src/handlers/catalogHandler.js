// src/handlers/catalogHandler.js

const config = require("../modules/config/configService");

async function show(phone) {
  const categorias = await config.list("CategoriasCatalogo");
  const gif = await config.get("GifCatalogo");

  let texto = "🧀 *Nuestro catálogo*\n\n";
  categorias.forEach(cat => {
    texto += `• ${cat}\n`;
  });

  texto += `\n👉 Decime qué categoría te interesa`;

  return [
    {
      to: phone,
      type: "text",
      text: { body: texto },
    },
    gif
      ? {
          to: phone,
          type: "image",
          image: {
            link: gif,
            caption: "👆 Elegí tranquilo, te ayudo a armar el pedido 😉",
          },
        }
      : null,
  ].filter(Boolean);
}

module.exports = {
  show,
};

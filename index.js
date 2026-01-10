require('dotenv').config();

// 👉 Arranca el bot (esto es CLAVE)
require('./src/bot');

// 👉 Servidor dummy para Render (solo para mantener vivo el proceso)
const express = require('express');
const app = express();

const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.send('EzerBot activo');
});

app.listen(PORT, () => {
  console.log('Puerto dummy escuchando en', PORT);
});

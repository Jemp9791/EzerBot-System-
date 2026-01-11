require('dotenv').config();

// 🔥 ARRANQUE FORZADO DEL BOT
console.log('🚀 Iniciando bot...');
require('./src/bot');

// 🌐 Servidor dummy para Render
const express = require('express');
const app = express();

const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.send('EzerBot activo');
});

app.listen(PORT, () => {
  console.log('🌐 Puerto dummy escuchando en', PORT);
});

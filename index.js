require('dotenv').config();
require('./src/bot');

const express = require('express');
const app = express();

const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.send('EzerBot activo');
});

app.listen(PORT, () => {
  console.log('Puerto dummy escuchando en', PORT);
});

// src/modules/pos/posService.js

const config = require("../config/configService");

async function calcularSellosPorMonto(monto) {
  const montoPorSello = await config.number("MontoPorSello");
  if (!montoPorSello || montoPorSello <= 0) return 0;
  return Math.floor(monto / montoPorSello);
}

async function procesarVenta({ phone, monto, medioPago, referidoA }) {
  const usaSellos = await config.isEnabled("UsaSellos");

  let sellosCompra = 0;
  let sellosReferido = 0;

  if (usaSellos) {
    sellosCompra = await calcularSellosPorMonto(monto);

    // 🆕 sello por referido (SIEMPRE 1)
    if (referidoA) {
      sellosReferido = 1;
    }
  }

  return {
    phone,
    monto,
    medioPago,
    sellosCompra,
    sellosReferido,
    referidoA,
    fecha: new Date().toISOString(),
  };
}

module.exports = {
  procesarVenta,
};

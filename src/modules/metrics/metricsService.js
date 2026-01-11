// src/modules/metrics/metricsService.js

async function registrarVentaMetrica(venta) {
  /**
   * venta = {
   *  phone,
   *  monto,
   *  medioPago,
   *  sellosCompra,
   *  sellosReferido,
   *  referidoA,
   *  vendedor
   * }
   */

  // 👉 acá va la escritura real en Google Sheets (hoja Metricas)
  // appendRow([fecha, telefonoCliente, telefonoReferidor, ...])

  console.log("📊 Métrica registrada:", venta);
}

module.exports = {
  registrarVentaMetrica,
};

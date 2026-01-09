
// src/modules/handlers/quieroEsteHandler.js

module.exports = function quieroEsteHandler(req, res) {
  try {
    const { productoId, cantidad, usuario } = req.body;

    if (!productoId || !cantidad || !usuario) {
      return res.status(400).json({ error: "Datos incompletos para registrar pedido" });
    }

    // Aquí iría la lógica de registrar el pedido
    // Por ejemplo, insertar en base de datos
    console.log(`Pedido registrado: ${cantidad} x ${productoId} para ${usuario}`);

    return res.status(201).json({ mensaje: "Pedido registrado correctamente" });
  } catch (error) {
    console.error("Error en quieroEsteHandler:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
};


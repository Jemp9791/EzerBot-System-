
// src/modules/handlers/compartirHandler.js

module.exports = function compartirHandler(req, res) {
  try {
    const { recurso, destinatario } = req.body;

    if (!recurso || !destinatario) {
      return res.status(400).json({ error: "Faltan datos para compartir" });
    }

    // Aquí iría la lógica de compartir el recurso
    // Por ejemplo, guardar en base de datos o enviar notificación
    console.log(`Compartiendo ${recurso} con ${destinatario}`);

    return res.status(200).json({ mensaje: "Recurso compartido con éxito" });
  } catch (error) {
    console.error("Error en compartirHandler:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
};


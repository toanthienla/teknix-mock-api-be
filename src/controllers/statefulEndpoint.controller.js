// src/controllers/statefulEndpoint.controller.js
const statefulService = require("../services/statefulEndpoint.service");

async function convertToStateful(req, res) {
  const { id } = req.params;

  try {
    const result = await statefulService.convertToStateful(id);

    return res.status(201).json({
      message: "Endpoint converted to stateful successfully",
      stateless: result.stateless,
      stateful: result.stateful,
      responses: result.responses,
    });
  } catch (err) {
    console.error("Error convertToStateful:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = {
  convertToStateful,
};

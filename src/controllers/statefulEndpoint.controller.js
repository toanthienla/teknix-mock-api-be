const statefulService = require("../services/statefulEndpoint.service");

async function convertToStateful(req, res) {
  const { id } = req.params;

  try {
    const result = await statefulService.convertToStateful(id);
    return res.status(200).json({
      message: "Endpoint converted to stateful successfully",
      data: result,
    });
  } catch (err) {
    console.error("Error convertToStateful:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function updateEndpointResponse(req, res) {
  try {
    const { id } = req.params;
    // Hỗ trợ cả responseBody và response_body
    const response_body = req.body.response_body ?? req.body.responseBody;
    const delay = req.body.delay ?? req.body.delay_ms;

    const updated = await statefulService.updateEndpointResponse(id, { response_body, delay });

    return res.status(200).json({
      message: "Response updated successfully",
      data: updated,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

module.exports = {
  convertToStateful,
  updateEndpointResponse,
};

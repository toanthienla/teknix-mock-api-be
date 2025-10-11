const ResponseStatefulService = require("../services/endpoint_responses_ful.service");
const ResponseSvc = require('../services/endpoint_response.service');

exports.listResponsesForEndpoint = async (req, res) => {
  const { endpoint_id } = req.query;
  if (!endpoint_id) {
    return res.status(400).json({ error: "endpoint_id là bắt buộc." });
  }

  const responses = await ResponseStatefulService.findByEndpointId(
    parseInt(endpoint_id, 10)
  );
  const result = responses.map((r) => ({ ...r, is_stateful: true }));

  res.status(200).json(result);
};

exports.getResponseById = async (req, res) => {
  const { id } = req.params;
  const response = await ResponseStatefulService.findById(parseInt(id, 10));
  if (!response) {
    return res.status(404).json({ error: "Không tìm thấy response." });
  }

  const result = { ...response, is_stateful: true };
  res.status(200).json(result);
};

// PUT /endpoint_responses_ful/:id
exports.updateById = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id))
      return res.status(400).json({ error: "id must be an integer" });

    const { name, response_body, delay_ms } = req.body ?? {};
    const updated = await ResponseSvc.update(
      req.db.stateless, // pool stateless
      req.db.stateful, // pool stateful
      id,
      { name, response_body, delay_ms }
    );

    if (!updated) return res.status(404).json({ error: "Response not found" });
    return res.status(200).json(updated);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
};

// HÀM MỚI: Xóa một stateful response
exports.deleteResponseById = async (req, res) => {
  try {
    const { id } = req.params;
    const success = await ResponseStatefulService.deleteById(parseInt(id, 10));

    if (!success) {
      return res.status(404).json({ error: "Không tìm thấy response." });
    }

    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: "Lỗi máy chủ nội bộ." });
  }
};

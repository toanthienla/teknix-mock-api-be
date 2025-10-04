// src/controllers/endpoints_ful.controller.js
const EndpointStatefulService = require("../services/endpoints_ful.service");

// --- Định nghĩa tất cả các hàm xử lý ---

async function listEndpoints(req, res) {
  const { folder_id } = req.query;
  if (!folder_id) {
    return res.status(400).json({ error: "folder_id là bắt buộc." });
  }

  const endpoints = await EndpointStatefulService.findByFolderId(folder_id);
  const result = endpoints.map((ep) => ({ ...ep, is_stateful: true }));

  res.status(200).json(result);
};

async function getEndpointById(req, res) {
  const { id } = req.params;
  const endpointDetail = await EndpointStatefulService.getFullDetailById(id);

  if (!endpointDetail) {
    return res.status(404).json({ error: "Không tìm thấy stateful endpoint." });
  }

  res.status(200).json(endpointDetail);
};

async function deleteEndpointById(req, res) {
  try {
    const { id } = req.params;
    const result = await EndpointStatefulService.deleteById(parseInt(id, 10));

    if (result.notFound) {
      return res.status(404).json({ error: 'Không tìm thấy stateful endpoint.' });
    }

    res.status(204).send(); 
  } catch (err) {
    res.status(500).json({ error: 'Lỗi máy chủ nội bộ.' });
  }
};

async function convertToStateful(req, res) {
  const { id } = req.params;
  try {
    // Sửa lỗi: Dùng biến EndpointStatefulService đã được khai báo ở trên
    const result = await EndpointStatefulService.convertToStateful(id); 
    return res.status(200).json({
      message: "Endpoint converted to stateful successfully",
      data: result,
    });
  } catch (err) {
    console.error("Error convertToStateful:", err.message);
    return res.status(500).json({ error: err.message });
  }
};

async function updateEndpointResponse(req, res) {
  try {
    const { id } = req.params;
    const response_body = req.body.response_body ?? req.body.responseBody;
    const delay = req.body.delay ?? req.body.delay_ms;

    // Sửa lỗi: Dùng biến EndpointStatefulService đã được khai báo ở trên
    const updated = await EndpointStatefulService.updateEndpointResponse(id, { response_body, delay });

    return res.status(200).json({
      message: "Response updated successfully",
      data: updated,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
};

// --- Export tất cả các hàm ra ngoài tại một nơi duy nhất ---

module.exports = {
  listEndpoints,
  getEndpointById,
  deleteEndpointById,
  convertToStateful,
  updateEndpointResponse,
};
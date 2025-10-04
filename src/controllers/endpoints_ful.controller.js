const EndpointStatefulService = require("../services/endpoints_ful.service");

exports.listEndpoints = async (req, res) => {
  const { folder_id } = req.query;
  if (!folder_id) {
    return res.status(400).json({ error: "folder_id là bắt buộc." });
  }

  const endpoints = await EndpointStatefulService.findByFolderId(folder_id);
  // Vẫn thêm is_stateful cho nhất quán
  const result = endpoints.map((ep) => ({ ...ep, is_stateful: true }));

  res.status(200).json(result);
};

exports.getEndpointById = async (req, res) => {
  const { id } = req.params;

  // Gọi hàm service mới để lấy dữ liệu tổng hợp
  const endpointDetail = await EndpointStatefulService.getFullDetailById(id);

  if (!endpointDetail) {
    return res.status(404).json({ error: "Không tìm thấy stateful endpoint." });
  }

  res.status(200).json(endpointDetail);
};

exports.deleteEndpointById = async (req, res) => {
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
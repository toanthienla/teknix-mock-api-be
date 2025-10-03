// src/controllers/dataStateful.controller.js
const DataStatefulService = require("../services/endpoint_data_ful.service");

exports.getDataByPath = async (req, res) => {
  const { path } = req.query;
  if (!path) {
    return res.status(400).json({ error: "path là bắt buộc." });
  }

  const data = await DataStatefulService.findByPath(path);

  if (!data) {
    return res
      .status(404)
      .json({ error: "Không tìm thấy dữ liệu cho path này." });
  }

  res.status(200).json(data);


};
  // Xóa dữ liệu stateful theo path
 exports.deleteDataByPath = async (req, res) => {
    try {
        const { path } = req.query;
        if (!path) {
            return res.status(400).json({ error: 'Query parameter "path" là bắt buộc.' });
        }
        
        const success = await DataStatefulService.deleteByPath(path);

        if (!success) {
            return res.status(404).json({ error: 'Không tìm thấy dữ liệu cho path này.' });
        }

        res.status(204).send();
    } catch (err) {
        res.status(500).json({ error: 'Lỗi máy chủ nội bộ.' });
    }
};
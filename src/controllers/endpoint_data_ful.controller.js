const EndpointStatefulService = require("../services/endpoints_ful.service");
const DataStatefulService = require("../services/endpoint_data_ful.service");

/**
 * Lấy dữ liệu stateful theo path
 */
exports.getDataByPath = async (req, res) => {
  try {
    const { path } = req.query;
    if (!path) {
      return res.status(400).json({ error: "Tham số 'path' là bắt buộc." });
    }
    // KÍCH HOẠT: Gọi hàm findByPath từ service
    const data = await DataStatefulService.findByPath(path);
    // XỬ LÝ KẾT QUẢ: Kiểm tra xem có dữ liệu trả về không
    if (data) {
      return res.status(200).json(data);
    } else {
      return res
        .status(404)
        .json({ error: `Không tìm thấy dữ liệu với path: '${path}'` });
    }
  } catch (err) {
    console.error("Error in getDataByPath:", err.message);
    res.status(500).json({ error: "Lỗi máy chủ nội bộ." });
  }
};

/**
 * Xóa dữ liệu stateful theo path
 * Chức năng này cũng chưa có trong service, cần bổ sung
 */
exports.deleteDataByPath = async (req, res) => {
  try {
    const { path } = req.query;
    if (!path) {
      return res.status(400).json({ error: "Tham số 'path' là bắt buộc." });
    }

    const ok = await DataStatefulService.deleteByPath(path);
    if (!ok)
      return res
        .status(404)
        .json({ error: `Không tìm thấy dữ liệu với path: '${path}'` });
    return res.status(204).send();
  } catch (err) {
    console.error("Error in deleteDataByPath:", err.message);
    res.status(500).json({ error: "Lỗi máy chủ nội bộ." });
  }
};

/**
 * Cập nhật dữ liệu (schema và data_default) cho một endpoint
 */
exports.updateEndpointData = async (req, res) => {
  try {
    const { path } = req.query;
    if (!path) {
      return res.status(400).json({ error: "Tham số 'path' là bắt buộc." });
    }

    if (!req.body || Object.keys(req.body).length === 0) {
      return res
        .status(400)
        .json({ error: "Request body không được để trống." });
    }

    const { schema, data_default } = req.body;

    const result = await EndpointStatefulService.updateEndpointData(path, {
      schema,
      data_default,
    });

    return res.status(200).json({
      message: "Cập nhật dữ liệu endpoint thành công.",
      data: result,
    });
  } catch (err) {
    console.error("Error in updateEndpointData:", err.message);
    // Trả về lỗi 500 nếu là lỗi server, 400 nếu là lỗi từ client
    const statusCode = err.message.includes("Không tìm thấy") ? 404 : 500;
    return res.status(statusCode).json({ error: err.message });
  }
};

/**
 * Thiết lập dữ liệu hiện tại làm dữ liệu mặc định
 */
exports.setDefaultEndpointData = async (req, res) => {
  try {
    const { path } = req.query;
    const { data_default } = req.body || {};

    if (!path) return res.status(400).json({ error: "Thiếu query 'path'." });
    if (data_default === undefined)
      return res
        .status(400)
        .json({ error: "Thiếu 'data_default' trong payload." });

    const result = await DataStatefulService.upsertDefaultAndCurrentByPath(
      path,
      data_default
    );

    return res.status(200).json({
      message: "Cập nhật data_default và đồng bộ data_current thành công.",
      data: result,
    });
  } catch (err) {
    console.error("Error in setDefaultEndpointData:", err);
    const status = /không tìm thấy/i.test(err.message) ? 404 : 500;
    return res.status(status).json({ error: err.message });
  }
};

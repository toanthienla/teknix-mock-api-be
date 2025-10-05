// src/controllers/endpoint_data_ful.controller.js

// SỬA Ở ĐÂY: Đổi tên biến import cho đúng với đối tượng được export
const EndpointStatefulService = require("../services/endpoints_ful.service");
const DataStatefulService = require("../services/endpoint_data_ful.service");

/**
 * Lấy dữ liệu stateful theo path
 * Chức năng này có vẻ chưa có trong service của bạn, bạn cần thêm hàm findByPath vào service nếu muốn dùng
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
      return res.status(404).json({ error: `Không tìm thấy dữ liệu với path: '${path}'` });
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
        
        // LƯU Ý: Hàm deleteByPath chưa tồn tại trong EndpointStatefulService bạn gửi.
        // Bạn cần phải tự định nghĩa nó.
        // const success = await EndpointStatefulService.deleteByPath(path);

        // Tạm thời trả về lỗi để bạn biết cần bổ sung
        return res.status(501).json({ error: "Chức năng 'deleteByPath' chưa được cài đặt trong service." });

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

    const result = await EndpointStatefulService.updateEndpointData(
      req.db.stateful,
      path,
      { schema, data_default }
    );

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
     if (!path) {
        return res.status(400).json({ error: "Tham số 'path' là bắt buộc." });
    }

    // SỬA Ở ĐÂY: Gọi hàm từ EndpointStatefulService
    const result = await EndpointStatefulService.setDefaultEndpointData(
      req.db.stateful,
      path
    );

    return res.status(200).json({
      message: "Thiết lập dữ liệu mặc định thành công.",
      data: result,
    });
  } catch (err) {
    console.error("Error in setDefaultEndpointData:", err.message);
    const statusCode = err.message.includes("Không tìm thấy") ? 404 : 500;
    return res.status(statusCode).json({ error: err.message });
  }
};
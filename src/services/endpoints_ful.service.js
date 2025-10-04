// src/services/endpoints_ful.service.js
const { statefulPool } = require("../config/db");
// Import service của response để lấy dữ liệu liên quan
const ResponseStatefulService = require("./endpoint_responses_ful.service");

const EndpointStatefulService = {
  async findById(id) {
    const query = "SELECT * FROM endpoints_ful WHERE id = $1;";
    const { rows } = await statefulPool.query(query, [id]);
    return rows[0] || null;
  },

  async findByFolderId(folderId) {
    const query =
      "SELECT * FROM endpoints_ful WHERE folder_id = $1 ORDER BY created_at DESC;";
    const { rows } = await statefulPool.query(query, [folderId]);
    return rows;
  },

  /**
   * HÀM MỚI: Lấy đầy đủ thông tin của một stateful endpoint,
   * bao gồm cả các response liên quan.
   * @param {number} id - ID của stateful endpoint
   * @returns {Object | null} - Object chi tiết hoặc null nếu không tìm thấy
   */
  async getFullDetailById(id) {
    // Sử dụng Promise.all để chạy 2 truy vấn song song
    const [endpoint, responses] = await Promise.all([
      this.findById(id),
      ResponseStatefulService.findByEndpointId(id),
    ]);

    // Nếu không tìm thấy endpoint gốc, trả về null
    if (!endpoint) {
      return null;
    }

    // Gộp kết quả lại thành một object hoàn chỉnh
    return {
      ...endpoint,
      is_stateful: true, // Thêm cờ để nhận biết
      responses: responses || [], // Thêm danh sách các response liên quan
    };
  },

  /**
   * HÀM MỚI: Xóa một stateful endpoint và tất cả các dữ liệu liên quan
   * (responses, data) trong một transaction.
   * @param {number} id - ID của stateful endpoint
   * @returns {Object} - Object chứa { success: true } hoặc { success: false, notFound: true }
   */
  async deleteById(id) {
    const client = await statefulPool.connect(); // Lấy client để dùng transaction

    try {
      await client.query("BEGIN");

      // Bước 1: Lấy thông tin endpoint để kiểm tra tồn tại và lấy path
      const { rows: endpointRows } = await client.query(
        "SELECT path FROM endpoints_ful WHERE id = $1",
        [id]
      );
      const endpoint = endpointRows[0];

      if (!endpoint) {
        await client.query("ROLLBACK");
        return { success: false, notFound: true };
      }

      // Bước 2: Xóa tất cả các response liên quan
      await client.query(
        "DELETE FROM endpoint_responses_ful WHERE endpoint_id = $1",
        [id]
      );

      // Bước 3: Xóa dữ liệu stateful liên quan dựa trên path
      if (endpoint.path) {
        await client.query("DELETE FROM endpoint_data_ful WHERE path = $1", [
          endpoint.path,
        ]);
      }

      // Bước 4: Xóa bản ghi endpoint gốc
      await client.query("DELETE FROM endpoints_ful WHERE id = $1", [id]);

      await client.query("COMMIT"); // Hoàn tất transaction
      return { success: true };
    } catch (err) {
      await client.query("ROLLBACK"); // Hoàn tác nếu có lỗi
      console.error(
        `Transaction failed for deleting stateful endpoint ${id}:`,
        err
      );
      throw err; // Ném lỗi để controller bắt và trả về 500
    } finally {
      client.release(); // Luôn trả client về pool
    }
  },
  
  async findByOriginId(originId) {
    const query = "SELECT id FROM endpoints_ful WHERE origin_id = $1 LIMIT 1;";
    const { rows } = await statefulPool.query(query, [originId]);

    const statefulEndpoint = rows[0];
    if (!statefulEndpoint) {
      return null;
    }

    // Tái sử dụng hàm getFullDetailById để lấy đầy đủ thông tin
    return this.getFullDetailById(statefulEndpoint.id);
  },
};

module.exports = EndpointStatefulService;

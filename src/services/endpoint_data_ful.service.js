const { statefulPool } = require('../config/db');

const DataStatefulService = {
    async findByPath(path) {
        const query = 'SELECT * FROM endpoint_data_ful WHERE path = $1;';
        const { rows } = await statefulPool.query(query, [path]);
        return rows[0] || null;
    },

     /**
     * Xóa dữ liệu theo path
     * @param {string} path - Path của dữ liệu cần xóa
     * @returns {boolean} - Trả về true nếu xóa thành công, false nếu không tìm thấy
     */
    async deleteByPath(path) {
        const query = 'DELETE FROM endpoint_data_ful WHERE path = $1;';
        const result = await statefulPool.query(query, [path]);
        return result.rowCount > 0;
    }
};

module.exports = DataStatefulService;
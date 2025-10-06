const { statefulPool } = require("../config/db");
const ResponseStatefulService = require("./endpoint_responses_ful.service");

const DataStatefulService = {
  async findByPath(path) {
    const query = "SELECT * FROM endpoint_data_ful WHERE path = $1;";
    const { rows } = await statefulPool.query(query, [path]);
    return rows[0] || null;
  },

  /**
   * Xóa dữ liệu theo path
   * @param {string} path - Path của dữ liệu cần xóa
   * @returns {boolean} - Trả về true nếu xóa thành công, false nếu không tìm thấy
   */
  async deleteByPath(path) {
    const query = "DELETE FROM endpoint_data_ful WHERE path = $1;";
    const result = await statefulPool.query(query, [path]);
    return result.rowCount > 0;
  },

  async upsertDefaultAndCurrentByPath(pool, path, dataDefault) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Tạo/ghi đè theo path (cần unique index trên endpoint_data_ful(path))
      const sql = `
        INSERT INTO endpoint_data_ful (path, data_default, data_current, updated_at)
        VALUES ($1, $2::jsonb, $2::jsonb, NOW())
        ON CONFLICT (path)
        DO UPDATE SET
          data_default = EXCLUDED.data_default,
          data_current = EXCLUDED.data_current,
          updated_at = NOW()
        RETURNING id, path, schema, data_default, data_current, created_at, updated_at
      `;

      const payload =
        typeof dataDefault === "string"
          ? dataDefault
          : JSON.stringify(dataDefault ?? null); // tránh undefined
      const {
        rows: [row],
      } = await client.query(sql, [path, payload]);

      await client.query("COMMIT");
      return row;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  },

  async upsertDefaultAndCurrentByPath(pool, path, dataDefault) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Chuẩn hoá input thành chuỗi JSON hợp lệ (tránh invalid input syntax for type json)
    const payload =
      typeof dataDefault === "string"
        ? dataDefault
        : JSON.stringify(dataDefault ?? null);

    // 1) UPDATE trước
    const up = await client.query(
      `UPDATE endpoint_data_ful
         SET data_default = $2::jsonb,
             data_current = $2::jsonb,
             updated_at   = NOW()
       WHERE path = $1
       RETURNING id, path, schema, data_default, data_current, created_at, updated_at`,
      [path, payload]
    );

    let row = up.rows[0];

    // 2) Nếu chưa có hàng nào, INSERT
    if (!row) {
      const ins = await client.query(
        `INSERT INTO endpoint_data_ful (path, data_default, data_current, updated_at)
         VALUES ($1, $2::jsonb, $2::jsonb, NOW())
         RETURNING id, path, schema, data_default, data_current, created_at, updated_at`,
        [path, payload]
      );
      row = ins.rows[0];
    }

    await client.query("COMMIT");
    return row;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

};

module.exports = DataStatefulService;

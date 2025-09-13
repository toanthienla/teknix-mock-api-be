// test-db.js
const db = require('./src/config/db');

async function test() {
  try {
    const result = await db.query('SELECT NOW()');
    console.log('✅ Kết nối DB thành công:', result.rows[0]);
  } catch (err) {
    console.error('❌ Lỗi kết nối DB:', err.message);
  } finally {
    db.pool.end();
  }
}

test();

// db.js
const { Pool } = require('pg');  // 1. import pg
const path = require('path');    // 2. import path
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// Pool 1: Kết nối đến DB STATELESS (bảng chỉ dẫn)
const dbPool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// Pool 2: Kết nối đến DB STATEFUL
const dbPoolfull = new Pool({
  host: process.env.STATEFUL_DB_HOST,
  port: process.env.STATEFUL_DB_PORT,
  user: process.env.STATEFUL_DB_USER,
  password: process.env.STATEFUL_DB_PASSWORD,
  database: process.env.STATEFUL_DB_NAME,
});

// Hàm kiểm tra kết nối (tùy chọn nhưng nên có)
const checkConnections = async () => {
    try {
        await dbPool.query('SELECT NOW()');
        console.log('✅ Kết nối đến Stateless DB thành công!');
        await dbPoolfull.query('SELECT NOW()');
        console.log('✅ Kết nối đến Statefull DB thành công!');
    } catch (error) {
        console.error('❌ Lỗi khi kiểm tra kết nối database:', error);
        throw error; // Ném lỗi để server có thể bắt và dừng lại
    }
};

// Export cả hai pool để các module khác có thể sử dụng
module.exports = { dbPool, dbPoolfull, checkConnections };

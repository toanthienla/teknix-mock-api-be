// db.js
const { Pool } = require('pg');
const { MongoClient } = require('mongodb');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// =====================
//  PostgreSQL POOLS
// =====================

// Pool 1: Stateless
const statelessPool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// Pool 2: Stateful
const statefulPool = new Pool({
  host: process.env.STATEFUL_DB_HOST,
  port: process.env.STATEFUL_DB_PORT,
  user: process.env.STATEFUL_DB_USER,
  password: process.env.STATEFUL_DB_PASSWORD,
  database: process.env.STATEFUL_DB_NAME,
});

// =====================
//  MongoDB CONNECTION
// =====================

let mongoClient;
let mongoDB;

const connectMongo = async () => {
  if (mongoDB) return mongoDB; // tránh reconnect
  try {
    mongoClient = new MongoClient(process.env.MONGO_URI);
    await mongoClient.connect();
    mongoDB = mongoClient.db(process.env.MONGO_DB_NAME);
    console.log('✅ Kết nối MongoDB thành công!');
    return mongoDB;
  } catch (err) {
    console.error('❌ Lỗi khi kết nối MongoDB:', err);
    throw err;
  }
};

// Trả về collection theo tên (ví dụ: "users", "cars")

// ⚙️ Hàm cũ — vẫn giữ nguyên cho các phần code legacy
const getCollection = (name) => {
  if (!mongoDB) throw new Error('MongoDB chưa được kết nối. Hãy gọi connectMongo() trước.');
  const clean = name.replace(/^\//, ''); // bỏ dấu "/" đầu
  return mongoDB.collection(clean);
};

// ⚙️ Hàm mới — dành cho resetMongoCollectionsByFolder và các logic nâng cao
const getCollection2 = (path, workspaceName, projectName) => {
  if (!mongoDB) throw new Error('MongoDB chưa được kết nối. Hãy gọi connectMongo() trước.');

  // Chuẩn hóa tên collection (Mongo không cho phép dấu /, dấu cách, ...)
  const cleanPath = path.replace(/^\//, '').replace(/[^\w\-]/g, '_');
  const collectionName = `${cleanPath}.${workspaceName}.${projectName}`;
  
  return mongoDB.collection(collectionName);
};

// =====================
//  Kiểm tra tất cả kết nối
// =====================
const checkConnections = async () => {
  try {
    await statelessPool.query('SELECT NOW()');
    console.log('✅ Kết nối đến Stateless DB thành công!');

    await statefulPool.query('SELECT NOW()');
    console.log('✅ Kết nối đến Stateful DB thành công!');

    await connectMongo();

  } catch (error) {
    console.error('❌ Lỗi khi kiểm tra kết nối database:', error);
    throw error;
  }
};

// =====================
//  Export tất cả
// =====================
module.exports = {
  statelessPool,
  statefulPool,
  mongoClient,
  mongoDB,
  getCollection,
  connectMongo,
  checkConnections
};

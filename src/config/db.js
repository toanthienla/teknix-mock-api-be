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
let endpointDataCollection;

const connectMongo = async () => {
  try {
    mongoClient = new MongoClient(process.env.MONGO_URI);
    await mongoClient.connect();
    mongoDB = mongoClient.db(process.env.MONGO_DB_NAME);

    // Collection mặc định cho dữ liệu stateful
    endpointDataCollection = mongoDB.collection('endpoint_data_ful');

    console.log('✅ Kết nối đến MongoDB (stateful) thành công!');
  } catch (err) {
    console.error('❌ Lỗi khi kết nối MongoDB:', err);
    throw err;
  }
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
  endpointDataCollection,
  connectMongo,
  checkConnections
};

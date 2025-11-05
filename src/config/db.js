// db.js
const { Pool } = require("pg");
const { MongoClient } = require("mongodb");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

// =====================
//  PostgreSQL POOLS
// =====================

// Helper: build PG config from ENV (allow DATABASE_URL)
function buildPgConfig(prefix = "DB") {
  const URL = process.env[`${prefix}_DATABASE_URL`] || (prefix === "DB" ? process.env.DATABASE_URL : undefined);
  if (URL) return { connectionString: URL };
  const H = process.env[`${prefix}_HOST`];
  const P = process.env[`${prefix}_PORT`];
  const U = process.env[`${prefix}_USER`];
  const PW = process.env[`${prefix}_PASSWORD`];
  const DB = process.env[`${prefix}_NAME`];
  return {
    host: H || process.env.DB_HOST || "127.0.0.1",
    port: Number(P || process.env.DB_PORT || 5432),
    user: U || process.env.DB_USER || "postgres",
    password: PW ?? process.env.DB_PASSWORD ?? "",
    database: DB || process.env.DB_NAME || "postgres",
  };
}

// Primary pool (hợp nhất)
const pool = new Pool(buildPgConfig("DB"));
// Backward-compat: statelessPool = pool
const statelessPool = pool;

// Optional stateful pool (nếu ENV STATEFUL_* không set → alias về pool)
let statefulPool;
const hasStatefulEnv = !!(process.env.STATEFUL_DATABASE_URL || process.env.STATEFUL_DB_HOST || process.env.STATEFUL_DB_NAME);
statefulPool = hasStatefulEnv ? new Pool(buildPgConfig("STATEFUL_DB")) : pool;

// =====================
//  MongoDB CONNECTION
// =====================

let mongoClient;
let mongoDB;

function isMongoEnabled() {
  return !!(process.env.MONGO_URI && process.env.MONGO_DB_NAME);
}

const connectMongo = async () => {
  if (mongoDB) return mongoDB; // tránh reconnect
  if (!isMongoEnabled()) {
    console.warn("ℹ️ MongoDB không được cấu hình (bỏ qua kết nối).");
    return null;
  }
  try {
    mongoClient = new MongoClient(process.env.MONGO_URI);
    await mongoClient.connect();
    mongoDB = mongoClient.db(process.env.MONGO_DB_NAME);
    console.log("✅ Kết nối MongoDB thành công!");
    return mongoDB;
  } catch (err) {
    console.error("❌ Lỗi khi kết nối MongoDB:", err);
    throw err;
  }
};

// Trả về collection theo tên (ví dụ: "users", "cars")

// ⚙️ Hàm cũ — vẫn giữ nguyên cho các phần code legacy
const getCollection = (name) => {
  if (!mongoDB) throw new Error("MongoDB chưa được kết nối. Hãy gọi connectMongo() trước.");
  const clean = name.replace(/^\//, ""); // bỏ dấu "/" đầu
  return mongoDB.collection(clean);
};

// ⚙️ Hàm mới — dành cho resetMongoCollectionsByFolder và các logic nâng cao
const getCollection2 = (path, workspaceName, projectName) => {
  if (!mongoDB) throw new Error("MongoDB chưa được kết nối. Hãy gọi connectMongo() trước.");

  // Chuẩn hóa tên collection (Mongo không cho phép dấu /, dấu cách, ...)
  const cleanPath = path.replace(/^\//, "").replace(/[^\w\-]/g, "_");
  const collectionName = `${cleanPath}.${workspaceName}.${projectName}`;

  return mongoDB.collection(collectionName);
};

// =====================
//  Kiểm tra tất cả kết nối
// =====================
const checkConnections = async () => {
  try {
    await statelessPool.query("SELECT NOW()");
    console.log("✅ Kết nối đến DB (stateless/primary) thành công!");

    if (statefulPool !== statelessPool) {
      await statefulPool.query("SELECT NOW()");
      console.log("✅ Kết nối đến Stateful DB thành công!");
    } else {
      console.log("ℹ️ Stateful DB alias → dùng chung pool hợp nhất (bỏ qua kiểm tra riêng).");
    }

    await connectMongo(); // nếu không cấu hình → chỉ cảnh báo, không throw
  } catch (error) {
    console.error("❌ Lỗi khi kiểm tra kết nối database:", error);
    throw error;
  }
};

// =====================
//  Export tất cả
// =====================
module.exports = {
  pool,
  statelessPool,
  statefulPool,
  mongoClient,
  mongoDB,
  getCollection,
  connectMongo,
  checkConnections,
  getCollection2,
  isMongoEnabled,
};

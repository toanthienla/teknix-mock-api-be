// services/endpoint_data_ful.service.js
// Quản lý dữ liệu stateful lưu ở MongoDB, mỗi endpoint path ↔ 1 collection
// Ví dụ: "/users" -> collection "users"

const { getCollection } = require("../config/db");

/**
 * Chuẩn hoá path -> tên collection
 * "/users"  -> "users"
 * "cars"    -> "cars"
 */
function toCollectionName(path) {
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new Error("Invalid path for Mongo collection.");
  }
  return path.replace(/^\//, "").trim();
}

/**
 * Lấy 1 document duy nhất của collection (mô hình: 1 collection ~ 1 document)
 * @param {string} path
 * @returns {Promise<object|null>}
 */
async function findByPath(path) {
  const colName = toCollectionName(path);
  const col = getCollection(colName);
  return await col.findOne({});
}

/**
 * Xoá toàn bộ dữ liệu (document) của collection theo path
 * @param {string} path
 * @returns {Promise<boolean>} true nếu có xoá dữ liệu
 */
async function deleteByPath(path) {
  const colName = toCollectionName(path);
  const col = getCollection(colName);
  // Dọn rỗng collection (vẫn giữ collection để tái sử dụng)
  const result = await col.deleteMany({});
  return result.deletedCount > 0;
}

/**
 * Upsert: ghi đè data_default và data_current theo path
 * - Nếu chưa có document nào: insert { data_default, data_current }
 * - Nếu đã có: set lại cả 2 mảng
 * @param {string} path
 * @param {Array|Object} dataDefault
 * @returns {Promise<object>} tài liệu sau cập nhật
 */
async function upsertDefaultAndCurrentByPath(path, dataDefault = []) {
  const colName = toCollectionName(path);
  const col = getCollection(colName);

  // Ép kiểu về array nếu dev truyền object lẻ
  const payload =
    Array.isArray(dataDefault) ? dataDefault : [dataDefault];

  await col.updateOne(
    {},
    { $set: { data_default: payload, data_current: payload } },
    { upsert: true }
  );

  return await col.findOne({});
}

/**
 * Lấy danh sách hiện tại (data_current) theo path
 * @param {string} path
 * @returns {Promise<Array>}
 */
async function getCurrentList(path) {
  const doc = await findByPath(path);
  return doc?.data_current || [];
}

/**
 * Thêm 1 item vào data_current
 * @param {string} path
 * @param {object} item
 * @returns {Promise<object>} tài liệu sau khi thêm
 */
async function pushToCurrent(path, item) {
  const colName = toCollectionName(path);
  const col = getCollection(colName);
  await col.updateOne({}, { $push: { data_current: item } }, { upsert: true });
  return await col.findOne({});
}

/**
 * Cập nhật 1 item trong data_current theo predicate (ví dụ theo id)
 * @param {string} path
 * @param {(it: object)=>boolean} matchFn - hàm xác định item cần sửa
 * @param {(it: object)=>object} updateFn - hàm trả về item đã cập nhật
 * @returns {Promise<object>} tài liệu sau khi cập nhật
 */
async function updateInCurrent(path, matchFn, updateFn) {
  const colName = toCollectionName(path);
  const col = getCollection(colName);
  const doc = await col.findOne({}) || { data_current: [] };

  const updated = Array.from(doc.data_current || []).map((it) =>
    matchFn(it) ? updateFn({ ...it }) : it
  );

  await col.updateOne({}, { $set: { data_current: updated } }, { upsert: true });
  return await col.findOne({});
}

/**
 * Xoá 1 item trong data_current theo predicate (ví dụ theo id)
 * @param {string} path
 * @param {(it: object)=>boolean} matchFn
 * @returns {Promise<object>} tài liệu sau khi xoá
 */
async function removeFromCurrent(path, matchFn) {
  const colName = toCollectionName(path);
  const col = getCollection(colName);
  const doc = await col.findOne({}) || { data_current: [] };

  const filtered = Array.from(doc.data_current || []).filter((it) => !matchFn(it));

  await col.updateOne({}, { $set: { data_current: filtered } }, { upsert: true });
  return await col.findOne({});
}

/**
 * Drop toàn bộ collection ứng với 1 endpoint path trên Mongo.
 * Sử dụng chính quy ước đặt tên hiện tại của hệ thống qua getCollection(path),
 * để luôn khớp với cách bạn đang lưu (ví dụ: '/users' -> 'users', 'WP_3/pj_3/cat' -> 'cat', v.v.).
 */
async function dropCollectionByPath(path) {
  const db = await getDb();
  const coll = await getCollection(path); // phải trả về một đối tượng Collection
  const name = coll.collectionName;

  // Kiểm tra tồn tại trước khi drop để idempotent
  const exists = (await db.listCollections({ name }).toArray()).length > 0;
  if (!exists) {
    return { dropped: false, name, reason: 'not_exists' };
  }

  // Dùng db.dropCollection để đảm bảo drop theo tên đúng
  await db.dropCollection(name);
  return { dropped: true, name };
}


module.exports = {
  findByPath,
  deleteByPath,
  upsertDefaultAndCurrentByPath,
  getCurrentList,
  pushToCurrent,
  updateInCurrent,
  dropCollectionByPath,
  removeFromCurrent,
};

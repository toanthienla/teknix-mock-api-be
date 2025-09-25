const express = require("express");
const router = express.Router();
const projectStateController = require("../controllers/project_state.controller");

// 📌 Lấy tất cả state của 1 project
router.get("/", projectStateController.getAllStates);

// 📌 Lấy state theo id
router.get("/id/:id", projectStateController.getStateById);

// 📌 Lấy state theo key
router.get("/:project_id/:key", projectStateController.getStateByKey);

// 📌 Tạo mới state
router.post("/", projectStateController.createState);

// 📌 Cập nhật state theo id
router.put("/id/:id", projectStateController.updateStateById);

// 📌 Cập nhật state theo key
router.put("/:project_id/:key", projectStateController.updateState);

// 📌 Xóa state theo id
router.delete("/id/:id", projectStateController.deleteStateById);

// 📌 Xóa state
router.delete("/:project_id/:key", projectStateController.deleteState);

// 📌 Reset state theo id
router.post("/id/:id/reset", projectStateController.resetStateById);

// 📌 Reset state theo key
router.post("/:project_id/:key/reset", projectStateController.resetStateByKey);

// 📌 Reset toàn bộ state của project
router.post("/:project_id/reset", projectStateController.resetStates);


module.exports = router;
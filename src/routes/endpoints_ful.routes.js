const express = require("express");
const router = express.Router();
const EndpointFulController = require("../controllers/endpoints_ful.controller");

// Danh sách endpoint stateful (có phân trang, filter, sort, query)
router.get("/", EndpointFulController.listEndpoints);

// Lấy chi tiết endpoint
router.get("/:id", EndpointFulController.getEndpointById);

// Xoá endpoint stateful
router.delete("/:id", EndpointFulController.deleteEndpointById);

// Chuyển stateless → stateful
router.post("/:id/convert", EndpointFulController.convertToStateful);

// Chuyển stateful → stateless
router.post("/:id/revert", EndpointFulController.revertToStateless);

// Cập nhật response body/delay
router.put("/response/:id", EndpointFulController.updateEndpointResponse);

// Lấy schema của endpoint stateful
router.get("/schema_get/:id", EndpointFulController.getEndpointSchema);

// Lấy base_schema theo endpoint gốc (stateless)
router.get("/base_schema/:id", EndpointFulController.getBaseSchemaByEndpoint);

// Lấy & cập nhật advanced_config
router.get("/advanced/:id", EndpointFulController.getAdvancedConfig);
router.put("/advanced/:id", EndpointFulController.updateAdvancedConfig);

module.exports = router;

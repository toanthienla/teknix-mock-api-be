const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/endpoint.controller');
const asyncHandler = require('../middlewares/asyncHandler');
const validateEndpoint = require('../middlewares/validateEndpoint');
const ctrlEndpointFul = require('../controllers/endpoints_ful.controller');

// Get all endpoints (filter by project_id nếu có query param)
// GET /endpoints
router.get('/', asyncHandler(ctrl.listEndpoints));

// (Optional) Nếu muốn giữ get by id riêng, nhưng contract không định nghĩa
// GET /endpoints/:id
 router.get('/:id', asyncHandler(ctrl.getEndpointById));

// Create endpoint (body phải có project_id, name, method, path)
// POST /endpoints
router.post('/', validateEndpoint, asyncHandler(ctrl.createEndpoint));

// Update endpoint
// PUT /endpoints/:id
router.put('/:id', validateEndpoint, asyncHandler(ctrl.updateEndpoint));

// Delete endpoint
// DELETE /endpoints/:id
router.delete('/:id', asyncHandler(ctrl.deleteEndpoint));

// 2 Routes mới về chức năng AdvancedConfig gồm GET và PUT
router.get("/advanced/:id", ctrlEndpointFul.getAdvancedConfig);
router.put("/advanced/:id", ctrlEndpointFul.updateAdvancedConfig);

module.exports = router;

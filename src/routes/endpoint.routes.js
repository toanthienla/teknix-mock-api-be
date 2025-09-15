const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/endpoint.controller');
const asyncHandler = require('../middlewares/asyncHandler');

// CRUD endpoints theo project
// Lấy danh sách endpoints theo query (vd: ?project_id=1)
router.get('/endpoints', asyncHandler(ctrl.listEndpointsByQuery));
router.get('/projects/:projectId/endpoints', asyncHandler(ctrl.listEndpoints));
router.get('/projects/:projectId/endpoints/:id', asyncHandler(ctrl.getEndpointById));
router.post('/projects/:projectId/endpoints', asyncHandler(ctrl.createEndpoint));
router.put('/projects/:projectId/endpoints/:id', asyncHandler(ctrl.updateEndpoint));
router.delete('/projects/:projectId/endpoints/:id', asyncHandler(ctrl.deleteEndpoint));

module.exports = router;

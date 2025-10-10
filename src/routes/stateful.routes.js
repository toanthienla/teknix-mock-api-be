// src/routes/stateful.routes.js
const express = require('express');
const router = express.Router();

// Import các controller riêng lẻ
const endpointController = require('../controllers/endpoints_ful.controller');
const responseController = require('../controllers/endpoint_responses_ful.controller');
const dataController = require('../controllers/endpoint_data_ful.controller');
const asyncHandler = require('../middlewares/asyncHandler');


// --- Định nghĩa routes cho Endpoints ---
router.get('/endpoints', endpointController.listEndpoints);
router.get('/endpoints/:id', endpointController.getEndpointById);
router.delete('/endpoints/:id', endpointController.deleteEndpointById);

// Route mới để convert endpoint sang stateful
router.post('/endpoints/:id/convert-to-stateful', asyncHandler(endpointController.convertToStateful));
// Route mới để convert endpoint sang stateless
router.post('/endpoints/:id/convert-to-stateless', asyncHandler(endpointController.revertToStateless));


// --- Định nghĩa routes cho Endpoint Responses ---
router.get('/endpoint_responses', responseController.listResponsesForEndpoint);
router.get('/endpoint_responses/:id', responseController.getResponseById);
router.delete('/endpoint_responses/:id', responseController.deleteResponseById);

//Định nghĩa routes cho Endpoint Responses ful
router.get('/endpoint_responses_ful/:id', responseController.getResponseById);
router.get('/endpoint_responses_ful/:id', asyncHandler(responseController.getById));
router.put('/endpoint_responses_ful/:id', asyncHandler(responseController.updateById));

// --- Định nghĩa routes cho Endpoint Data ---
router.get('/endpoint_data', dataController.getDataByPath);
router.delete('/endpoint_data', dataController.deleteDataByPath);
router.put("/endpoint_data", dataController.updateEndpointData);
//router.put("/endpoint_data", dataController.setDefaultEndpointData);

module.exports = router;
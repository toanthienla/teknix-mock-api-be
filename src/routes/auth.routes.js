// src/routes/auth.routes.js
// Định nghĩa route cho Auth

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/auth.controller');
const asyncHandler = require('../middlewares/asyncHandler');

router.post('/register', asyncHandler(ctrl.register));
router.post('/login', asyncHandler(ctrl.login));

module.exports = router;

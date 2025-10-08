// src/routes/auth.routes.js
const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');

// POST /auth/register
router.post('/register', authController.register);

// POST /auth/login
router.post('/login', authController.login);

// POST /auth/refresh
router.post('/refresh', authController.refreshToken);

// POST /auth/logout
router.post('/logout', authController.logout);

module.exports = router;

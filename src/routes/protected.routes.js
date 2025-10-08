const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/authMiddleware'); // dùng middleware hợp nhất

// Route bảo vệ
router.get('/', authMiddleware, (req, res) => {
  res.json({
    message: 'Protected route accessed successfully!',
    user: req.user
  });
});

module.exports = router;

// src/middlewares/asyncHandler.js
// Wrapper để tránh phải viết try/catch lặp lại trong controller

module.exports = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

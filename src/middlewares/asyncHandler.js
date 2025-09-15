// asyncHandler.js
// Middleware để bắt lỗi async/await và forward cho Express

module.exports = function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

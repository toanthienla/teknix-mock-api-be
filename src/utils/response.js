function success(res, data) {
  return res.json(data);
}

function error(res, status = 400, message = 'Something went wrong') {
  return res.status(status).json({ error: { message } });
}

// Dùng riêng cho validation errors
function validationError(res, errors, status = 400) {
  return res.status(status).json({
    success: false,
    errors
  });
}

module.exports = { success, error, validationError };

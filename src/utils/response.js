function success(res, data, message = '') {
  return res.json({ success: true, message, data });
}

function error(res, status = 400, message = 'Có lỗi xảy ra') {
  return res.status(status).json({ success: false, error: { message } });
}

module.exports = { success, error };

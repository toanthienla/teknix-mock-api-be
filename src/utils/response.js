function success(res, data) {
  return res.json(data);
}

function error(res, status = 400, message = 'Có lỗi xảy ra') {
  return res.status(status).json({ error: { message } });
}

module.exports = { success, error };

// src/controllers/auth.controller.js
// Controller xử lý logic cho Auth (đăng ký, đăng nhập)

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const authService = require('../services/auth.service');
const { error, success } = require('../utils/response');

const SALT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || '10', 10);

async function register(req, res) {
  const { email, password } = req.body;
  if (!email || !password) return error(res, 400, 'Email và password là bắt buộc');

  const existing = await authService.findUserByEmail(email);
  if (existing) return error(res, 400, 'Email đã tồn tại');

  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = await authService.createUser(email, hash);
  return success(res, { user }, 'Đăng ký thành công');
}

async function login(req, res) {
  const { email, password } = req.body;
  if (!email || !password) return error(res, 400, 'Email và password là bắt buộc');

  const user = await authService.findUserByEmail(email);
  if (!user) return error(res, 401, 'Sai email hoặc mật khẩu');

  const match = await bcrypt.compare(password, user.password);
  if (!match) return error(res, 401, 'Sai email hoặc mật khẩu');

  const token = jwt.sign(
    { id: user.id, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  return success(res, { token }, 'Đăng nhập thành công');
}

module.exports = { register, login };

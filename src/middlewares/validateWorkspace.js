// middlewares/validateWorkspace.js

// Regex: chỉ cho phép A-Z, a-z, 0-9 và dấu gạch dưới (_)
const NAME_RE = /^[A-Za-z0-9_-]+$/;

module.exports = function validateWorkspace(req, res, next) {
  const { name } = req.body;
  const errors = [];

  // Không được để trống
  if (!name || name.trim() === "") {
    errors.push({ field: "name", message: "Workspace name cannot be empty" });
  } else {
    // Giới hạn độ dài
    if (name.length > 50) {
      errors.push({ field: "name", message: "Workspace name cannot exceed 50 characters" });
    }

    // Kiểm tra định dạng
    if (!NAME_RE.test(name)) {
      errors.push({
        field: "name",
        message: "Workspace name can only contain letters (A–Z, a–z), numbers (0–9), and underscores (_)",
      });
    }
  }

  // Nếu có lỗi thì trả về luôn
  if (errors.length > 0) {
    return res.status(400).json({ success: false, errors });
  }

  next();
};

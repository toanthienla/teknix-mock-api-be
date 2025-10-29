// middlewares/validateProject.js

// Regex: chỉ cho phép A-Z, a-z, 0-9, gạch dưới (_), gạch ngang (-)
const NAME_RE = /^[A-Za-z0-9_-]+$/;

module.exports = function validateProject(req, res, next) {
  const { name, workspace_id } = req.body;
  const errors = [];

  // workspace_id bắt buộc khi tạo project
  if (req.method === "POST" && !workspace_id) {
    errors.push({ field: "workspace_id", message: "workspace_id is required" });
  }

  // Kiểm tra trống
  if (!name || name.trim() === "") {
    errors.push({ field: "name", message: "Project name cannot be empty" });
  } else {
    // Giới hạn độ dài
    if (name.length > 50) {
      errors.push({ field: "name", message: "Project name cannot exceed 50 characters" });
    }

    // Kiểm tra định dạng
    if (!NAME_RE.test(name)) {
      errors.push({
        field: "name",
        message: "Project name can only contain letters (A–Z, a–z), numbers (0–9), underscores (_) or hyphens (-)",
      });
    }
  }

  // Nếu có lỗi thì trả về luôn
  if (errors.length > 0) {
    return res.status(400).json({ success: false, errors });
  }

  next();
};

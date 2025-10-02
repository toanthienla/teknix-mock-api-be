// Regex: Bắt đầu bằng ký tự chữ Unicode, sau đó cho phép chữ, số, khoảng trắng, gạch dưới, gạch ngang
const isValidName = (name) => /^\p{L}[\p{L}\d _-]*$/u.test(name);

module.exports = function validateFolder(req, res, next) {
  const { name, project_id } = req.body;
  const errors = [];

  // project_id là bắt buộc khi tạo mới (POST)
  if (req.method === 'POST') {
    if (typeof project_id === 'undefined') {
      errors.push({ field: "project_id", message: "project_id is required" });
    } else if (Number.isNaN(parseInt(project_id, 10))) {
      errors.push({ field: "project_id", message: "project_id must be an integer" });
    }
  }

  // Validate 'name' (bắt buộc cho cả POST và PUT nếu có)
  if (req.method === 'POST' || (req.method === 'PUT' && typeof name !== 'undefined')) {
    if (typeof name !== 'string' || name.trim() === "") {
      errors.push({ field: "name", message: "Folder name cannot be empty" });
    } else {
      if (name.length > 50) {
        errors.push({ field: "name", message: "Folder name cannot exceed 50 characters" });
      }
      if (!isValidName(name)) {
        errors.push({
          field: "name",
          message: "Folder name must start with a letter and can only contain letters, numbers, spaces, - or _"
        });
      }
    }
  }

  if (errors.length > 0) {
    return res.status(400).json({ success: false, errors });
  }

  next();
};
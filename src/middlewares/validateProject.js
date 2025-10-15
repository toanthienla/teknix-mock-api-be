// middlewares/validateProject.js

// Regex: Bắt đầu bằng ký tự chữ Unicode, sau đó có thể chứa chữ, số, khoảng trắng, gạch dưới, gạch ngang
const isValidName = (name) => /^\p{L}[\p{L}\d _-]*$/u.test(name);

module.exports = function validateProject(req, res, next) {
  const { name, workspace_id } = req.body;
  const errors = [];

  // workspace_id is required when creating a project
  if (req.method === "POST" && !workspace_id) {
    errors.push({ field: "workspace_id", message: "workspace_id is required" });
  }

  // Check empty
  if (!name || name.trim() === "") {
    errors.push({ field: "name", message: "Project name cannot be empty" });
  }

  // Check length
  if (name && name.length > 50) {
    errors.push({ field: "name", message: "Project name cannot exceed 50 characters" });
  }

  // Check format: phải bắt đầu bằng chữ cái Unicode
  if (name && !isValidName(name)) {
    errors.push({
      field: "name",
      message: "Project name must start with a letter (Unicode supported) and can only contain letters, numbers, spaces, - or _",
    });
  }

  if (errors.length > 0) {
    return res.status(400).json({ success: false, errors });
  }

  next();
};

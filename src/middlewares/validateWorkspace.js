// middlewares/validateWorkspace.js

// Regex: bắt đầu bằng ký tự chữ (Unicode), sau đó cho phép chữ, số, khoảng trắng, gạch ngang (-), gạch dưới (_)
const isValidName = (name) => /^\p{L}[\p{L}\d _-]*$/u.test(name);

module.exports = function validateWorkspace(req, res, next) {
  const { name } = req.body;
  const errors = [];

  if (!name || name.trim() === "") {
    errors.push({ field: "name", message: "Workspace name cannot be empty" });
  } else {
    if (name.length > 50) {
      errors.push({ field: "name", message: "Workspace name cannot exceed 50 characters" });
    }

    if (!isValidName(name)) {
      errors.push({
        field: "name",
        message: "Workspace name must start with a letter and can only contain letters, numbers, spaces, - or _",
      });
    }
  }

  if (errors.length > 0) {
    return res.status(400).json({ success: false, errors });
  }

  next();
};

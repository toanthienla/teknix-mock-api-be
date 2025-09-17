// middlewares/validateWorkspace.js

const isValidName = (name) => /^[a-zA-Z][\w\s-]*$/.test(name);

module.exports = function validateWorkspace(req, res, next) {
  const { name } = req.body;
  const errors = [];

  // Check empty
  if (!name || name.trim() === "") {
    errors.push({ field: "name", message: "Workspace name cannot be empty" });
  }

  // Check length
  if (name && name.length > 20) {
    errors.push({ field: "name", message: "Workspace name cannot exceed 20 characters" });
  }

  // Check format: phải bắt đầu bằng chữ cái
  if (name && !isValidName(name)) {
    errors.push({
      field: "name",
      message: "Workspace name must start with a letter and cannot start with a number or special character"
    });
  }

  if (errors.length > 0) {
    return res.status(400).json({ success: false, errors });
  }

  next();
};

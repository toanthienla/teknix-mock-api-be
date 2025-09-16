// middlewares/validateWorkspace.js

module.exports = function validateWorkspace(req, res, next) {
  const { name } = req.body;

  if (!name || name.trim() === "") {
    return res.status(400).json({
      success: false,
      errors: [{ field: "name", message: "Workspace name cannot be empty" }]
    });
  }

  if (name.length > 20) {
    return res.status(400).json({
      success: false,
      errors: [{ field: "name", message: "Workspace name cannot exceed 20 characters" }]
    });
  }

  next();
};

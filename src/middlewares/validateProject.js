// middlewares/validateProject.js

module.exports = function validateProject(req, res, next) {
  const { name, workspace_id } = req.body;

  // workspace_id is required when creating a project
  if (req.method === 'POST' && !workspace_id) {
    return res.status(400).json({
      success: false,
      errors: [{ field: "workspace_id", message: "workspace_id is required" }]
    });
  }

  if (!name || name.trim() === "") {
    return res.status(400).json({
      success: false,
      errors: [{ field: "name", message: "Project name cannot be empty" }]
    });
  }

  if (name.length > 50) {
    return res.status(400).json({
      success: false,
      errors: [{ field: "name", message: "Project name cannot exceed 50 characters" }]
    });
  }

  next();
};

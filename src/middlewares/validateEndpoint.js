// middlewares/validateEndpoint.js

module.exports = function validateEndpoint(req, res, next) {
  const { name, method, path, project_id } = req.body;
  const errors = [];

  // project_id is required when creating an endpoint
  if (req.method === 'POST' && !project_id) {
    errors.push({ field: "project_id", message: "Project ID is required" });
  }

  // validate name
  if (!name || name.trim() === "") {
    errors.push({ field: "name", message: "Endpoint name cannot be empty" });
  } else if (name.length > 50) {
    errors.push({ field: "name", message: "Endpoint name must not exceed 50 characters" });
  }

  // validate method
  if (!method) {
    errors.push({ field: "method", message: "Method is required" });
  }

  // validate path
  if (!path) {
    errors.push({ field: "path", message: "Path is required" });
  }

  // return errors if any
  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      errors
    });
  }

  next();
};

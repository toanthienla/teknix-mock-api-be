// middlewares/validateEndpoint.js

module.exports = function validateEndpoint(req, res, next) {
  const { name, method, path, folder_id } = req.body;
  const errors = [];

  // folder_id is required when creating an endpoint
   if (req.method === 'POST' && (folder_id === undefined || folder_id === null)) {
    errors.push({ field: "folder_id", message: "Folder ID is required" });
  }

  // validate name
  if (!name || name.trim() === "") {
    errors.push({ field: "name", message: "Endpoint name cannot be empty" });
  } else {
    if (name.length > 20) {
      errors.push({
        field: "name",
        message: "Endpoint name must not exceed 20 characters",
      });
    }

    // Must start with a letter (a-zA-Z)
    if (!/^[a-zA-Z]/.test(name)) {
      errors.push({
        field: "name",
        message:
          "Endpoint name must start with a letter and cannot start with a number or special character",
      });
    }
  }

  // validate method
  if (!method) {
    errors.push({ field: "method", message: "Method is required" });
  }

  // validate path
  if (!path) {
    errors.push({ field: "path", message: "Path is required" });
  } else {
    // 1. Must start with /
    if (!path.startsWith("/")) {
      errors.push({ field: "path", message: "Path must start with /" });
    }

    // 2. Must not end with / (except for root '/')
    if (path.length > 1 && path.endsWith("/")) {
      errors.push({ field: "path", message: "Path must not end with /" });
    }

    // 3. Check route parameters like /users/:id
    const routePart = path.split("?")[0];
    const routeParamRegex =
      /^\/(?:[a-zA-Z0-9_-]+|:[a-zA-Z][\w]*)(?:\/(?:[a-zA-Z0-9_-]+|:[a-zA-Z][\w]*))*$/;
    if (!routeParamRegex.test(routePart)) {
      errors.push({ field: "path", message: "Invalid route parameter format" });
    }

    // 4. Check query parameters if exist
    const queryPart = path.split("?")[1];
    if (queryPart) {
      const queryParamRegex = /^[a-zA-Z0-9_]+=[^&]*(&[a-zA-Z0-9_]+=[^&]*)*$/;
      if (!queryParamRegex.test(queryPart)) {
        errors.push({
          field: "path",
          message: "Invalid query parameter format",
        });
      }
    }
  }

  // return errors if any
  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      errors,
    });
  }

  next();
};

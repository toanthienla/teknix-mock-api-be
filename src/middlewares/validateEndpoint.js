// validateEndpoint.js
module.exports = function validateEndpoint(req, res, next) {
  const body = req.body || {};
  const { name, method, path, folder_id, schema, fields } = body;
  const errors = [];

  // --- Helpers ---
  const onlyHas = (k) => Object.keys(body).length === 1 && Object.prototype.hasOwnProperty.call(body, k);
  const isStringArray = (arr) => Array.isArray(arr) && arr.every((v) => typeof v === "string" && v.trim() !== "");
  const isRulesMap = (obj) => obj && typeof obj === "object" && !Array.isArray(obj) && Object.values(obj).some((v) => v && typeof v === "object" && ("type" in v || "required" in v));

  // --- CREATE: giữ nguyên rule cũ ---
  if (req.method === "POST") {
    if (folder_id === undefined || folder_id === null) {
      errors.push({ field: "folder_id", message: "Folder ID is required" });
    }

    // name
    if (!name || typeof name !== "string" || name.trim() === "") {
      errors.push({ field: "name", message: "Endpoint name cannot be empty" });
    } else {
      if (name.length > 20) {
        errors.push({ field: "name", message: "Endpoint name must not exceed 20 characters" });
      }
      if (!/^[a-zA-Z]/.test(name)) {
        errors.push({
          field: "name",
          message: "Endpoint name must start with a letter and cannot start with a number or special character",
        });
      }
    }

    // method
    if (!method || typeof method !== "string" || method.trim() === "") {
      errors.push({ field: "method", message: "Method is required" });
    }

    // path
    if (!path || typeof path !== "string" || path.trim() === "") {
      errors.push({ field: "path", message: "Path is required" });
    } else {
      if (!path.startsWith("/")) errors.push({ field: "path", message: "Path must start with /" });
      if (path.length > 1 && path.endsWith("/")) errors.push({ field: "path", message: "Path must not end with /" });

      const routePart = path.split("?")[0];
      const routeParamRegex = /^\/(?:[a-zA-Z0-9_-]+|:[a-zA-Z][\w]*)(?:\/(?:[a-zA-Z0-9_-]+|:[a-zA-Z][\w]*))*$/;
      if (!routeParamRegex.test(routePart)) {
        errors.push({ field: "path", message: "Invalid route parameter format" });
      }

      const queryPart = path.split("?")[1];
      if (queryPart) {
        const queryParamRegex = /^[a-zA-Z0-9_]+=[^&]*(&[a-zA-Z0-9_]+=[^&]*)*$/;
        if (!queryParamRegex.test(queryPart)) {
          errors.push({ field: "path", message: "Invalid query parameter format" });
        }
      }
    }

    if (errors.length) return res.status(400).json({ success: false, errors });
    return next();
  }

  // --- UPDATE (PUT): 2 “shape” được phép ---
  if (req.method === "PUT") {
    const hasSchemaOnly = onlyHas("schema");
    const hasFieldsOnly = onlyHas("fields");

    // chặn payload "lẫn lộn"
    const forbiddenKeys = ["name", "method", "path", "folder_id"];
    if (Object.keys(body).some((k) => forbiddenKeys.includes(k))) {
      return res.status(400).json({
        success: false,
        errors: [{ field: "body", message: "PUT schema update must not include name/method/path/folder_id" }],
      });
    }

    // CASE A: { fields: [...] } (dành cho endpoint GET)
    if (hasFieldsOnly) {
      if (!isStringArray(fields)) {
        return res.status(400).json({
          success: false,
          errors: [{ field: "fields", message: "fields must be a non-empty array of non-empty strings" }],
        });
      }
      return next(); // để service kiểm tra method thực tế (GET) & xử lý tiếp
    }

    // CASE B: { schema: { ... } } (dành cho endpoint POST/PUT)
    if (hasSchemaOnly) {
      if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
        return res.status(400).json({
          success: false,
          errors: [{ field: "schema", message: "schema must be an object" }],
        });
      }
      // sơ bộ: phải là rules-map (ít nhất 1 field có type/required) hoặc { fields:[...] } cũng được (service sẽ phân loại)
      const looksLikeRules = isRulesMap(schema);
      const looksLikeGet = "fields" in schema && isStringArray(schema.fields) && Object.keys(schema).length === 1;
      if (!looksLikeRules && !looksLikeGet) {
        return res.status(400).json({
          success: false,
          errors: [{ field: "schema", message: "schema must be a rules map or {fields:[...]}" }],
        });
      }
      return next();
    }

    // Không thuộc 2 shape hợp lệ
    return res.status(400).json({
      success: false,
      errors: [{ field: "body", message: "PUT payload must be either {fields:[...]} or {schema:{...}}" }],
    });
  }

  // Các method khác -> để qua
  next();
};

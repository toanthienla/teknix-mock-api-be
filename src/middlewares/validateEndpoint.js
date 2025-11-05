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
      if (name.length > 255) {
        errors.push({ field: "name", message: "Endpoint name must not exceed 255 characters" });
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

  // --- UPDATE (PUT): cho phép cập nhật name hoặc schema ---
  if (req.method === "PUT") {
    const hasNameOnly = onlyHas("name");
    const hasSchemaOnly = onlyHas("schema");
    const hasFieldsOnly = onlyHas("fields");
    const hasWsConfigOnly = onlyHas("websocket_config");

    // ❌ Chặn các key không hợp lệ
    const forbiddenKeys = ["method", "path", "folder_id", "is_stateful", "is_active"];
    if (Object.keys(body).some((k) => forbiddenKeys.includes(k))) {
      return res.status(400).json({
        success: false,
        errors: [{ field: "body", message: "PUT update only allows name or schema" }],
      });
    }

    // ✅ CASE 1: { name: "..." }
    if (hasNameOnly) {
      if (typeof name !== "string" || name.trim() === "") {
        return res.status(400).json({
          success: false,
          errors: [{ field: "name", message: "Name must be a non-empty string" }],
        });
      }
      return next();
    }

    // ✅ CASE 2: { fields: [...] } (GET schema)
    if (hasFieldsOnly) {
      if (!isStringArray(fields)) {
        return res.status(400).json({
          success: false,
          errors: [{ field: "fields", message: "fields must be a non-empty array of non-empty strings" }],
        });
      }
      return next();
    }

    // ✅ CASE 3: { schema: {...} } (POST/PUT schema)
    if (hasSchemaOnly) {
      if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
        return res.status(400).json({
          success: false,
          errors: [{ field: "schema", message: "schema must be an object" }],
        });
      }
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
    // ✅ CASE 4: { websocket_config: {...} }
    if (hasWsConfigOnly) {
      const cfg = body.websocket_config || {};
      if (typeof cfg.enabled !== "boolean") {
        return res.status(400).json({ success: false, errors: [{ field: "websocket_config.enabled", message: "enabled must be boolean" }] });
      }
      // Cho phép message là string | object | null (theo tài liệu)
      if (!(cfg.message === null || typeof cfg.message === "string" || (typeof cfg.message === "object" && !Array.isArray(cfg.message)))) {
        return res.status(400).json({
          success: false,
          errors: [{ field: "websocket_config.message", message: "message must be string, object, or null" }],
        });
      }
      if (!Number.isInteger(cfg.delay_ms) || cfg.delay_ms < 0) {
        return res.status(400).json({ success: false, errors: [{ field: "websocket_config.delay_ms", message: "delay_ms must be a non-negative integer" }] });
      }
      if (!Number.isInteger(cfg.condition) || cfg.condition < 100 || cfg.condition > 599) {
        return res.status(400).json({ success: false, errors: [{ field: "websocket_config.condition", message: "condition must be 100..599" }] });
      }
      return next();
    }

    // ❌ Không hợp lệ (trộn nhiều field hoặc thiếu key)
    return res.status(400).json({
      success: false,
      errors: [{ field: "body", message: "PUT payload must be one of {name}, {fields}, {schema}, or {websocket_config}" }],
    });
  }

  next();
};

function getByPath(obj, path) {
  if (!obj || !path) return undefined;
  return path.split(".").reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), obj);
}

/**
 * Render chuỗi template theo cú pháp {{request.xxx}} / {{response.xxx}}
 * - Ví dụ: "Order {{request.body.id}} → {{response.status_code}}"
 */
function render(template, ctx) {
  if (typeof template !== "string" || !template.includes("{{")) return template;
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, key) => {
    const val = getByPath(ctx, key);
    if (val === undefined || val === null) return "";
    if (typeof val === "object") {
      try {
        return JSON.stringify(val);
      } catch {
        return "";
      }
    }
    return String(val);
  });
}

module.exports = { render };

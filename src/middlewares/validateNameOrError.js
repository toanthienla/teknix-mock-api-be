// middlewares/validateNameOrError.js

const NAME_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Dùng cho logic service (validate trước khi query DB)
 */
function validateNameOrError(name) {
  if (!name || typeof name !== "string" || name.trim() === "") {
    return { success: false, errors: [{ field: "name", message: "Name cannot be empty" }] };
  }

  if (name.length > 50) {
    return { success: false, errors: [{ field: "name", message: "Name cannot exceed 50 characters" }] };
  }

  if (!NAME_RE.test(name)) {
    return {
      success: false,
      errors: [
        {
          field: "name",
          message: "Name can only contain letters (A–Z, a–z), numbers (0–9), and underscores (_)",
        },
      ],
    };
  }

  return null;
}

module.exports = { validateNameOrError, NAME_RE };

const express = require('express');
const db = require('../config/db');
const { match } = require('path-to-regexp');
const router = express.Router();

// Robust matcher using path-to-regexp with simple cache
const matcherCache = new Map(); // key: pattern string, value: match function
function getMatcher(pattern) {
  let fn = matcherCache.get(pattern);
  if (!fn) {
    fn = match(pattern, { decode: decodeURIComponent, strict: true, end: true });
    matcherCache.set(pattern, fn);
  }
  return fn;
}

// Catch-all after admin routes; resolves mock responses from DB

router.use(async (req, res, next) => {
  try {
    const method = req.method.toUpperCase();

    // Fetch endpoints for method
    const { rows: endpoints } = await db.query(
      'SELECT id, method, path FROM endpoints WHERE UPPER(method) = $1 ORDER BY id DESC',
      [method]
    );

    const ep = endpoints.find((e) => {
      try {
        const fn = getMatcher(e.path);
        return Boolean(fn(req.path));
      } catch (_) {
        return false;
      }
    });
    if (!ep) return next();

    // Prefer default response; fallback to latest
    const { rows: responses } = await db.query(
      `SELECT id, endpoint_id, name, status_code, response_body, is_default, created_at, updated_at
       FROM endpoint_responses
       WHERE endpoint_id = $1
       ORDER BY is_default DESC, updated_at DESC NULLS LAST, created_at DESC
       LIMIT 1`,
      [ep.id]
    );

    if (responses.length === 0) {
      return res
        .status(501)
        .json({ error: { message: 'No response configured for this endpoint' } });
    }

    const r = responses[0];
    const status = r.status_code || 200;
    const body = r.response_body ?? null;

    if (body && typeof body === 'object') return res.status(status).json(body);
    return res.status(status).send(body ?? '');
  } catch (err) {
    return next(err);
  }
});

module.exports = router;

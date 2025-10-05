const express = require("express");
const router = express.Router();

const statefulHandler = require("./statefulHandler");
const statelessHandler = require("./mock.routes");

const normalizePath = (p) => (p.startsWith("/") ? p : `/${p}`);

router.use(async (req, res, next) => {
    try {
        const method = req.method.toUpperCase();
        const path = req.path;

        // 1️⃣ Lấy tất cả endpoints stateful cho method hiện tại
        const { rows: endpoints } = await req.db.stateful.query(
            `SELECT id, path, method FROM endpoints_ful WHERE UPPER(method) = $1`,
            [method]
        );

        // 2️⃣ Match path bằng cách cắt chuỗi
        let matchedEndpoint = null;
        let paramId = null;

        for (const ep of endpoints) {
            const basePath = normalizePath(ep.path);

            // Nếu path request === basePath → match toàn bộ
            if (path === basePath) {
                matchedEndpoint = ep;
                break;
            }

            // Nếu path request bắt đầu bằng basePath + "/" → thử cắt id
            if (path.startsWith(basePath + "/")) {
                const idPart = path.slice(basePath.length + 1); // cắt phần phía sau "/"
                if (/^\d+$/.test(idPart)) {
                    matchedEndpoint = ep;
                    paramId = Number(idPart);
                    break;
                }
            }
        }

        if (matchedEndpoint) {
            console.log(`➡️ Route khớp DB STATEFUL: ${path} (${method})`);
            req.endpoint = matchedEndpoint;
            req.params = {};
            if (paramId !== null) req.params.id = paramId;
            return statefulHandler.handle(req, res);
        }

        // 3️⃣ Nếu không match stateful → thử stateless
        const { rows: statelessEndpoints } = await req.db.stateless.query(
            `SELECT id, path, method FROM endpoints WHERE UPPER(method) = $1`,
            [method]
        );

        let matchedStateless = null;
        let statelessId = null;

        for (const ep of statelessEndpoints) {
            const basePath = normalizePath(ep.path);

            if (path === basePath) {
                matchedStateless = ep;
                break;
            }
            if (path.startsWith(basePath + "/")) {
                const idPart = path.slice(basePath.length + 1);
                if (/^\d+$/.test(idPart)) {
                    matchedStateless = ep;
                    statelessId = Number(idPart);
                    break;
                }
            }
        }

        if (matchedStateless) {
            console.log(`➡️ Route khớp DB STATELESS: ${path} (${method})`);
            req.endpoint = matchedStateless;
            req.params = {};
            if (statelessId !== null) req.params.id = statelessId;
            return statelessHandler(req, res, next);
        }

        return next();
    } catch (err) {
        console.error("❌ universalHandler error:", err);
        res.status(500).json({ error: "Internal Server Error", message: err.message });
    }
});

module.exports = router;

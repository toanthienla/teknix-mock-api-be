// app.js
const express = require('express');
const cookieParser = require('cookie-parser');
const app = express();
const cors = require('cors');
const auth = require('./middlewares/authMiddleware');

app.use(express.json());
app.use(cookieParser());

// Import DB pools
const { statelessPool, statefulPool } = require('./config/db');

// Inject DB vào request
app.use((req, res, next) => {
    req.db = {
        stateless: statelessPool,
        stateful: statefulPool,
    };
    next();
});

app.use(
  cors(
    {
      origin: "http://localhost:5173",
      credentials: true,
    },
  )
);

// ===== IMPORT ROUTES JWT =====
const authRoutes = require('./routes/auth.routes');
const protectedRoutes = require('./routes/protected.routes');

// ===== MOUNT JWT ROUTES =====
app.use('/auth', authRoutes);
app.use('/protected', protectedRoutes);

// ===== ROUTES CŨ TEKNIX =====
const workspaceRoutes = require('./routes/workspace.routes');
const projectRoutes = require('./routes/project.routes');
const endpointRoutes = require('./routes/endpoint.routes');
const endpointResponseRoutes = require('./routes/endpoint_response.routes');
const folderRoutes = require('./routes/folder.routes');
const projectRequestLogRoutes = require('./routes/project_request_log.routes');
const mockRoutes = require('./routes/mock.routes');
const statefulRoutes = require('./routes/stateful.routes');
const adminResponseLogger = require('./middlewares/adminResponseLogger');

app.use('/workspaces', workspaceRoutes);
app.use('/projects', projectRoutes);
app.use('/endpoints', endpointRoutes);
app.use('/folders', folderRoutes);
app.use('/', endpointResponseRoutes);
app.use('/', statefulRoutes);
app.use('/', projectRequestLogRoutes);
app.use('/', auth, require("./routes/universalHandler"));

module.exports = app;

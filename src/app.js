const express = require('express');
const app = express();

app.use(express.json());

// Import routes
const workspaceRoutes = require('./routes/workspace.routes');
const projectRoutes = require('./routes/project.routes');
const endpointRoutes = require('./routes/endpoint.routes');
const endpointResponseRoutes = require('./routes/endpoint_response.routes');
const folderRoutes = require('./routes/folder.routes');
// Routes xem log request/response theo project
const projectRequestLogRoutes = require('./routes/project_request_log.routes');
const mockRoutes = require('./routes/mock.routes');
const adminResponseLogger = require('./middlewares/adminResponseLogger');
//stateful
const statefulRoutes = require('./routes/stateful.routes'); 

// Import DB pools
const { statelessPool, statefulPool } = require('./config/db'); 

// Thêm Middleware để inject DB pools vào mỗi request
// Đoạn code này phải nằm TRƯỚC khi bạn mount các routes
app.use((req, res, next) => {
    req.db = {
        stateless: statelessPool,
        stateful: statefulPool,
    };
    next();
});

// Mount routes
app.use('/workspaces', workspaceRoutes);
app.use('/projects', projectRoutes);
app.use('/endpoints', endpointRoutes);
app.use('/folders', folderRoutes); 

// MOUNT STATEFUL ROUTES
app.use('/stateful-data', statefulRoutes);

app.use('/', endpointResponseRoutes);
// Mount logs route TRƯỚC router mock catch-all để không bị nuốt
app.use('/', projectRequestLogRoutes);
// Catch-all mock router MUST be last to avoid shadowing admin routes
app.use('/', mockRoutes);

module.exports = app;

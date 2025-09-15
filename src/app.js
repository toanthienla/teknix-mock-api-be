const express = require('express');
const app = express();

app.use(express.json());

// Import routes
const workspaceRoutes = require('./routes/workspace.routes');
const projectRoutes = require('./routes/project.routes');
const endpointRoutes = require('./routes/endpoint.routes');
const endpointResponseRoutes = require('./routes/endpoint_response.routes');
const mockRoutes = require('./routes/mock.routes');

// Mount routes
app.use('/workspaces', workspaceRoutes);
app.use('/', projectRoutes);
app.use('/', endpointRoutes);
app.use('/', endpointResponseRoutes);
// Catch-all mock router MUST be last to avoid shadowing admin routes
app.use('/', mockRoutes);

module.exports = app;

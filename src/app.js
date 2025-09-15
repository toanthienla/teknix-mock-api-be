const express = require('express');
const app = express();

app.use(express.json());

const workspaceRoutes = require('./routes/workspace.routes');
const projectRoutes = require('./routes/project.routes');

app.use('/api/workspaces', workspaceRoutes);
app.use('/api', projectRoutes);

module.exports = app;

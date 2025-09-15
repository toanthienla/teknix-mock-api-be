const svc = require('../services/workspace.service');
const { success, error } = require('../utils/response');

async function listWorkspaces(req, res) {
  const data = await svc.getAllWorkspaces();
  return success(res, data);
}

async function getWorkspace(req, res) {
  const data = await svc.getWorkspaceById(req.params.id);
  if (!data) return error(res, 404, 'Workspace không tồn tại');
  return success(res, data);
}

async function createWorkspace(req, res) {
  if (!req.body.name) return error(res, 400, 'Tên workspace là bắt buộc');
  const data = await svc.createWorkspace(req.body);
  return success(res, data);
}

async function updateWorkspace(req, res) {
  const data = await svc.updateWorkspace(req.params.id, req.body);
  if (!data) return error(res, 404, 'Workspace không tồn tại');
  return success(res, data);
}

async function deleteWorkspace(req, res) {
  await svc.deleteWorkspace(req.params.id);
  return success(res, {});
}

module.exports = { 
  listWorkspaces, 
  getWorkspace, 
  createWorkspace, 
  updateWorkspace, 
  deleteWorkspace 
};

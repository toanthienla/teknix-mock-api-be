// src/controllers/workspace.controller.js
const svc = require('../services/workspace.service');
const { success, error } = require('../utils/response');

async function listWorkspaces(req, res) {
  const userId = req.user.id;
  const workspaces = await svc.getWorkspacesByUser(userId);
  return success(res, workspaces);
}

async function createWorkspace(req, res) {
  try {
    const userId = req.user.id;
    const { name, description } = req.body;
    if (!name) return error(res, 400, 'Tên workspace là bắt buộc');

    const workspace = await svc.createWorkspace(userId, { name, description });
    return success(res, workspace, 'Tạo workspace thành công');
  } catch (err) {
    return error(res, 400, err.message);
  }
}

async function updateWorkspace(req, res) {
  try {
    const userId = req.user.id;
    const workspaceId = req.params.id;
    const { name, description } = req.body;

    const updated = await svc.updateWorkspace(userId, workspaceId, { name, description });
    return success(res, updated, 'Cập nhật workspace thành công');
  } catch (err) {
    return error(res, 400, err.message);
  }
}

async function deleteWorkspace(req, res) {
  try {
    const userId = req.user.id;
    const workspaceId = req.params.id;

    await svc.deleteWorkspace(userId, workspaceId);
    return success(res, null, 'Xóa workspace thành công');
  } catch (err) {
    return error(res, 400, err.message);
  }
}

module.exports = { listWorkspaces, createWorkspace, updateWorkspace, deleteWorkspace };

// src/controllers/project.controller.js
const svc = require('../services/project.service');
const { success, error } = require('../utils/response');

async function listProjects(req, res) {
  try {
    const userId = req.user.id;
    const { workspaceId } = req.params;
    const projects = await svc.getProjectsByWorkspace(userId, workspaceId);
    return success(res, projects);
  } catch (err) {
    return error(res, 400, err.message);
  }
}

async function createProject(req, res) {
  try {
    const userId = req.user.id;
    const { workspaceId } = req.params;
    const { name, description } = req.body;
    if (!name) return error(res, 400, 'Tên project là bắt buộc');

    const project = await svc.createProject(userId, workspaceId, { name, description });
    return success(res, project, 'Tạo project thành công');
  } catch (err) {
    return error(res, 400, err.message);
  }
}

async function updateProject(req, res) {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { name, description } = req.body;

    const updated = await svc.updateProject(userId, id, { name, description });
    return success(res, updated, 'Cập nhật project thành công');
  } catch (err) {
    return error(res, 400, err.message);
  }
}

async function deleteProject(req, res) {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    await svc.deleteProject(userId, id);
    return success(res, null, 'Xóa project thành công');
  } catch (err) {
    return error(res, 400, err.message);
  }
}

module.exports = { listProjects, createProject, updateProject, deleteProject };

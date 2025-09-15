const svc = require('../services/project.service');
const { success, error } = require('../utils/response');

async function listProjects(req, res) {
  const data = await svc.getProjectsByWorkspace(req.params.workspaceId);
  return success(res, data);
}

async function getProjectById(req, res) {
  const data = await svc.getProjectById(req.params.workspaceId, req.params.id);
  if (!data) return error(res, 404, 'Project không tồn tại');
  return success(res, data);
}

async function createProject(req, res) {
  try {
    const { workspaceId } = req.params;
    const { name, description } = req.body;
    if (!name) return error(res, 400, 'Tên project là bắt buộc');

    const project = await svc.createProject(workspaceId, { name, description });
    return success(res, project, 'Tạo project thành công');
  } catch (err) {
    return error(res, 400, err.message);
  }
}

async function updateProject(req, res) {
  try {
    const { workspaceId, id } = req.params;
    const { name, description } = req.body;

    const updated = await svc.updateProject(workspaceId, id, { name, description });
    return success(res, updated, 'Cập nhật project thành công');
  } catch (err) {
    return error(res, 400, err.message);
  }
}


async function deleteProject(req, res) {
  await svc.deleteProject(req.params.workspaceId, req.params.id);
  return success(res, null, 'Xóa project thành công');
}

module.exports = { listProjects, getProjectById, createProject, updateProject, deleteProject };

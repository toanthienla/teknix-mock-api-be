// src/controllers/folder.controller.js
const svc = require('../services/folder.service');

// List all folders by project_id
async function listFolders(req, res) {
  try {
    const { project_id } = req.query;
    if (!project_id) {
      return res.status(400).json({ message: 'project_id is required' });
    }
    const pid = parseInt(project_id, 10);
    if (Number.isNaN(pid)) {
      return res.status(400).json({ message: 'project_id must be an integer' });
    }

    const data = await svc.getFolders(pid);
    return res.status(200).json(data); // array object trần
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// Get folder by id
async function getFolderById(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ message: 'id must be an integer' });
    }

    const folder = await svc.getFolderById(id);
    if (!folder) {
      return res.status(404).json({ message: 'Folder does not exist' });
    }

    return res.status(200).json(folder);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// Create new folder
async function createFolder(req, res) {
  try {
    const { project_id, name, description } = req.body;
    if (!project_id || !name) {
      return res.status(400).json({ message: 'project_id and name are required' });
    }

    const pid = parseInt(project_id, 10);
    if (Number.isNaN(pid)) {
      return res.status(400).json({ message: 'project_id must be an integer' });
    }

    if (typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ message: 'name must not be empty' });
    }

    const row = await svc.createFolder({
      project_id: pid,
      name: name.trim(),
      description: description ?? null,
    });

    return res.status(201).json(row);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// Update folder
async function updateFolder(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ message: 'id must be an integer' });
    }

    const { name, description } = req.body;
    if (name && (typeof name !== 'string' || name.trim().length === 0)) {
      return res.status(400).json({ message: 'invalid name' });
    }

    const updated = await svc.updateFolder(id, {
      name: name?.trim(),
      description: description ?? null,
    });

    if (!updated) {
      return res.status(404).json({ message: 'Folder does not exist' });
    }

    return res.status(200).json(updated);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

// Delete folder
async function deleteFolder(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ message: 'id must be an integer' });
    }

    const deleted = await svc.deleteFolder(id);
    if (!deleted) {
      return res.status(404).json({ message: 'Folder does not exist' });
    }

    return res.status(200).json({ id });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

module.exports = {
  listFolders,
  getFolderById,
  createFolder,
  updateFolder,
  deleteFolder,
};

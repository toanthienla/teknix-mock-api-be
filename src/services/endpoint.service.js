const db = require('../config/db');

async function getEndpointsByProject(projectId) {
  const { rows } = await db.query(
    'SELECT * FROM endpoints WHERE project_id=$1 ORDER BY created_at DESC',
    [projectId]
  );
  return rows;
}

async function getEndpointById(projectId, endpointId) {
  const { rows } = await db.query(
    'SELECT * FROM endpoints WHERE project_id=$1 AND id=$2 LIMIT 1',
    [projectId, endpointId]
  );
  return rows[0] || null;
}

async function createEndpoint(projectId, { name, method, path }) {
  const { rows } = await db.query(
    'INSERT INTO endpoints(project_id, name, method, path) VALUES($1,$2,$3,$4) RETURNING *',
    [projectId, name, method, path]
  );
  return rows[0];
}

async function updateEndpoint(projectId, endpointId, { name, method, path }) {
  const { rows } = await db.query(
    `UPDATE endpoints 
     SET name=COALESCE($1,name), 
         method=COALESCE($2,method), 
         path=COALESCE($3,path), 
         updated_at=NOW() 
     WHERE id=$4 AND project_id=$5 
     RETURNING *`,
    [name, method, path, endpointId, projectId]
  );
  return rows[0];
}

async function deleteEndpoint(projectId, endpointId) {
  await db.query('DELETE FROM endpoints WHERE id=$1 AND project_id=$2', [
    endpointId,
    projectId
  ]);
  return true;
}

module.exports = {
  getEndpointsByProject,
  getEndpointById,
  createEndpoint,
  updateEndpoint,
  deleteEndpoint
};

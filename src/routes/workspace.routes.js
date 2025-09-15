const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/workspace.controller');

router.get('/', ctrl.listWorkspaces);
router.get('/:id', ctrl.getWorkspace);
router.post('/', ctrl.createWorkspace);
router.put('/:id', ctrl.updateWorkspace);
router.delete('/:id', ctrl.deleteWorkspace);

module.exports = router;

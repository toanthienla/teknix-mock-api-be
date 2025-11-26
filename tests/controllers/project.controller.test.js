// tests/controllers/project.controller.test.js

const projectController = require('../../src/controllers/project.controller');
const projectService = require('../../src/services/project.service');

// --- MOCK DEPENDENCIES ---
jest.mock('../../src/services/project.service');

// Mock utils/response
jest.mock('../../src/utils/response', () => ({
  success: jest.fn((res, data) => res.status(200).json(data)),
  error: jest.fn((res, code, msg) => res.status(code).json({ error: msg }))
}));

describe('Project Controller', () => {
    let req, res, mockDb;

    beforeEach(() => {
        jest.clearAllMocks();
        mockDb = {}; // Mock DB connection
        req = {
            query: {},
            params: {},
            body: {},
            db: { stateless: mockDb }
        };
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn()
        };
    });

    // ==========================================
    // 3.1 LIST PROJECTS
    // ==========================================
    describe('listProjects', () => {
        it('should return list of projects filtered by workspace_id', async () => {
            req.query.workspace_id = '10';
            const mockData = [{ id: 1, name: 'Project A' }];
            projectService.getProjects.mockResolvedValue({ success: true, data: mockData });

            await projectController.listProjects(req, res);

            expect(projectService.getProjects).toHaveBeenCalledWith(mockDb, '10');
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(mockData);
        });

        it('should return 500 on service error', async () => {
            projectService.getProjects.mockRejectedValue(new Error('DB Error'));
            await projectController.listProjects(req, res);
            expect(res.status).toHaveBeenCalledWith(500);
        });
    });

    // ==========================================
    // 3.2 GET PROJECT BY ID
    // ==========================================
    describe('getProjectById', () => {
        it('should return project data if found', async () => {
            req.params.id = 1;
            const mockData = { id: 1, name: 'Project A' };
            projectService.getProjectById.mockResolvedValue({ success: true, data: mockData });

            await projectController.getProjectById(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(mockData);
        });

        it('should return 404 if project not found', async () => {
            req.params.id = 999;
            projectService.getProjectById.mockResolvedValue({ success: true, data: null });

            await projectController.getProjectById(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
            expect(res.json).toHaveBeenCalledWith({ error: 'Project not found' });
        });
    });

    // ==========================================
    // 3.3 CREATE PROJECT
    // ==========================================
    describe('createProject', () => {
        it('should create project successfully', async () => {
            req.body = { workspace_id: 1, name: 'New Project' };
            const mockResult = { success: true, data: { id: 1, name: 'New Project' } };
            projectService.createProject.mockResolvedValue(mockResult);

            await projectController.createProject(req, res);

            expect(projectService.createProject).toHaveBeenCalledWith(mockDb, req.body);
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(mockResult.data);
        });

        it('should return 400 if validation fails (duplicate name)', async () => {
            req.body = { workspace_id: 1, name: 'Exist Project' };
            const errorResult = { 
                success: false, 
                errors: [{ field: "name", message: "Project already exists" }] 
            };
            projectService.createProject.mockResolvedValue(errorResult);

            await projectController.createProject(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(errorResult);
        });
    });

    // ==========================================
    // 3.4 UPDATE PROJECT
    // ==========================================
    describe('updateProject', () => {
        // Case A: Update only WebSocket flag (Branch 1)
        it('should update ONLY websocket_enabled if that is the only field', async () => {
            req.params.id = 1;
            req.body = { websocket_enabled: true }; // Only WS toggle
            
            const mockResult = { success: true, data: { id: 1, websocket_enabled: true } };
            projectService.updateProjectWebsocketEnabled.mockResolvedValue(mockResult);

            await projectController.updateProject(req, res);

            expect(projectService.updateProjectWebsocketEnabled).toHaveBeenCalledWith(mockDb, 1, true);
            // Ensure standard update was NOT called
            expect(projectService.updateProject).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(200);
        });

        // Case B: Standard Update (Branch 2)
        it('should perform standard update if name/description provided', async () => {
            req.params.id = 1;
            req.body = { name: 'Updated Name', websocket_enabled: true }; // Mixed fields
            
            const mockResult = { success: true, data: { id: 1, name: 'Updated Name' } };
            projectService.updateProject.mockResolvedValue(mockResult);

            await projectController.updateProject(req, res);

            expect(projectService.updateProject).toHaveBeenCalledWith(mockDb, 1, req.body);
            expect(res.status).toHaveBeenCalledWith(200);
        });

        it('should return 404 if project not found (Standard Update)', async () => {
            req.params.id = 999;
            req.body = { name: 'Ghost' };
            projectService.updateProject.mockResolvedValue({ success: false, notFound: true });

            await projectController.updateProject(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
            expect(res.json).toHaveBeenCalledWith({ error: 'Project not found' });
        });
        
        it('should return 404 if project not found (WS Toggle)', async () => {
            req.params.id = 999;
            req.body = { websocket_enabled: true };
            projectService.updateProjectWebsocketEnabled.mockResolvedValue({ notFound: true });

            await projectController.updateProject(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
        });

        it('should return 400 if validation fails (Standard Update)', async () => {
            req.params.id = 1;
            req.body = { name: 'Duplicate Name' };
            projectService.updateProject.mockResolvedValue({ 
                success: false, 
                errors: [{ message: 'Exists' }] 
            });

            await projectController.updateProject(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
        });
    });

    // ==========================================
    // 3.5 DELETE PROJECT
    // ==========================================
    describe('deleteProject', () => {
        it('should delete project successfully', async () => {
            req.params.id = '1';
            projectService.deleteProjectAndHandleLogs.mockResolvedValue({ success: true });

            await projectController.deleteProject(req, res);

            expect(projectService.deleteProjectAndHandleLogs).toHaveBeenCalledWith(mockDb, 1);
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('deleted') }));
        });

        it('should return 404 if project not found', async () => {
            req.params.id = '999';
            projectService.deleteProjectAndHandleLogs.mockResolvedValue({ notFound: true });

            await projectController.deleteProject(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
        });

        it('should return 500 on server error', async () => {
            projectService.deleteProjectAndHandleLogs.mockRejectedValue(new Error('Fatal'));
            await projectController.deleteProject(req, res);
            expect(res.status).toHaveBeenCalledWith(500);
        });
    });
});
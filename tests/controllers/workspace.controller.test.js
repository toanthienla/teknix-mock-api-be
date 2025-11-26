// tests/controllers/workspace.controller.test.js

const workspaceController = require('../../src/controllers/workspace.controller');
const workspaceService = require('../../src/services/workspace.service');
const { success, error } = require('../../src/utils/response');

// --- MOCK DEPENDENCIES ---
jest.mock('../../src/services/workspace.service');

// Mock utils/response để kiểm soát output chuẩn xác hơn (hoặc để nguyên nếu muốn integration test nhỏ)
// Ở đây tôi chọn mock implementation thực tế của response utils để spy vào res
jest.mock('../../src/utils/response', () => ({
  success: jest.fn((res, data) => res.status(200).json(data)),
  error: jest.fn((res, code, msg) => res.status(code).json({ error: msg }))
}));

describe('Workspace Controller', () => {
    let req, res, mockDb;

    beforeEach(() => {
        jest.clearAllMocks();

        // Mock DB (được truyền vào từ middleware)
        mockDb = {};

        req = {
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
    // 2.1 LIST WORKSPACES
    // ==========================================
    describe('listWorkspaces', () => {
        it('should return list of workspaces on success', async () => {
            const mockData = [{ id: 1, name: 'WS1' }, { id: 2, name: 'WS2' }];
            // Mock Service
            workspaceService.getAllWorkspaces.mockResolvedValue({ success: true, data: mockData });

            await workspaceController.listWorkspaces(req, res);

            expect(workspaceService.getAllWorkspaces).toHaveBeenCalledWith(mockDb);
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(mockData);
        });

        it('should return 500 if service throws error', async () => {
            workspaceService.getAllWorkspaces.mockRejectedValue(new Error('DB Error'));

            await workspaceController.listWorkspaces(req, res);

            expect(res.status).toHaveBeenCalledWith(500);
            expect(res.json).toHaveBeenCalledWith({ error: 'DB Error' });
        });
    });

    // ==========================================
    // 2.2 GET WORKSPACE
    // ==========================================
    describe('getWorkspace', () => {
        it('should return workspace data if found', async () => {
            req.params.id = 1;
            const mockData = { id: 1, name: 'WS1' };
            workspaceService.getWorkspaceById.mockResolvedValue({ success: true, data: mockData });

            await workspaceController.getWorkspace(req, res);

            expect(workspaceService.getWorkspaceById).toHaveBeenCalledWith(mockDb, 1);
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(mockData);
        });

        it('should return 404 if workspace not found (data is null)', async () => {
            req.params.id = 999;
            // Service trả về data: null
            workspaceService.getWorkspaceById.mockResolvedValue({ success: true, data: null });

            await workspaceController.getWorkspace(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
            expect(res.json).toHaveBeenCalledWith({ error: 'Workspace not found' });
        });

        it('should return 500 on service error', async () => {
            req.params.id = 1;
            workspaceService.getWorkspaceById.mockRejectedValue(new Error('Service Fail'));
            await workspaceController.getWorkspace(req, res);
            expect(res.status).toHaveBeenCalledWith(500);
        });
    });

    // ==========================================
    // 2.3 CREATE WORKSPACE
    // ==========================================
    describe('createWorkspace', () => {
        it('should create workspace successfully', async () => {
            req.body = { name: 'New WS' };
            const mockResult = { success: true, data: { id: 1, name: 'New WS' } };
            workspaceService.createWorkspace.mockResolvedValue(mockResult);

            await workspaceController.createWorkspace(req, res);

            expect(workspaceService.createWorkspace).toHaveBeenCalledWith(mockDb, req.body);
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(mockResult);
        });

        it('should return 400 if validation fails (e.g. Duplicate Name)', async () => {
            req.body = { name: 'Existing WS' };
            const errorResult = { 
                success: false, 
                errors: [{ field: "name", message: "Workspace already exists" }] 
            };
            workspaceService.createWorkspace.mockResolvedValue(errorResult);

            await workspaceController.createWorkspace(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(errorResult);
        });

        it('should return 400 on unexpected service exception handled by catch block', async () => {
            req.body = { name: 'Error WS' };
            // Controller catch block returns 400 with specific format
            workspaceService.createWorkspace.mockRejectedValue(new Error('Unexpected logic error'));

            await workspaceController.createWorkspace(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith({
                success: false,
                errors: [{ field: "general", message: 'Unexpected logic error' }]
            });
        });
    });

    // ==========================================
    // 2.4 UPDATE WORKSPACE
    // ==========================================
    describe('updateWorkspace', () => {
        it('should update workspace successfully', async () => {
            req.params.id = 1;
            req.body = { name: 'Updated WS' };
            const mockResult = { success: true, data: { id: 1, name: 'Updated WS' } };
            workspaceService.updateWorkspace.mockResolvedValue(mockResult);

            await workspaceController.updateWorkspace(req, res);

            expect(workspaceService.updateWorkspace).toHaveBeenCalledWith(mockDb, 1, req.body);
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(mockResult);
        });

        it('should return 400 (as per current code logic) if workspace not found', async () => {
            req.params.id = 999;
            req.body = { name: 'Ghost WS' };
            // Service returns notFound: true, success: false
            workspaceService.updateWorkspace.mockResolvedValue({ success: false, notFound: true });

            await workspaceController.updateWorkspace(req, res);

            // Code hiện tại: if (result.success === false) return 400
            expect(res.status).toHaveBeenCalledWith(400); 
            expect(res.json).toHaveBeenCalledWith({ success: false, notFound: true });
        });
        
        it('should return 404 if result is null (Dead code path check)', async () => {
             // Case này chỉ xảy ra nếu service return null/undefined explicitly
             req.params.id = 999;
             workspaceService.updateWorkspace.mockResolvedValue(null);
             
             await workspaceController.updateWorkspace(req, res);
             
             expect(res.status).toHaveBeenCalledWith(404);
        });

        it('should return 400 on service exception', async () => {
            req.params.id = 1;
            workspaceService.updateWorkspace.mockRejectedValue(new Error('Update failed'));
            await workspaceController.updateWorkspace(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
        });
    });

    // ==========================================
    // 2.5 DELETE WORKSPACE
    // ==========================================
    describe('deleteWorkspace', () => {
        it('should delete workspace successfully', async () => {
            req.params.id = '1'; // params usually strings
            const mockResult = { success: true, data: { id: 1 } };
            workspaceService.deleteWorkspaceAndHandleLogs.mockResolvedValue(mockResult);

            await workspaceController.deleteWorkspace(req, res);

            expect(workspaceService.deleteWorkspaceAndHandleLogs).toHaveBeenCalledWith(mockDb, 1);
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith({ message: "Workspace with ID: 1 has been deleted." });
        });

        it('should return 404 if workspace not found', async () => {
            req.params.id = '999';
            // Service returns notFound: true
            workspaceService.deleteWorkspaceAndHandleLogs.mockResolvedValue({ notFound: true });

            await workspaceController.deleteWorkspace(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
            expect(res.json).toHaveBeenCalledWith({ error: "Workspace not found" });
        });

        it('should return 500 on server error during delete', async () => {
            req.params.id = '1';
            workspaceService.deleteWorkspaceAndHandleLogs.mockRejectedValue(new Error('Delete fatal error'));
            await workspaceController.deleteWorkspace(req, res);
            expect(res.status).toHaveBeenCalledWith(500);
        });
    });
});
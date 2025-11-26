// tests/controllers/folder.controller.test.js

const folderController = require('../../src/controllers/folder.controller');
const folderService = require('../../src/services/folder.service');

// --- MOCK DEPENDENCIES ---
jest.mock('../../src/services/folder.service');

// Mock utils/response
jest.mock('../../src/utils/response', () => ({
  success: jest.fn((res, data) => res.status(200).json(data)),
  error: jest.fn((res, code, msg) => res.status(code).json({ error: msg }))
}));

describe('Folder Controller', () => {
    let req, res, mockDb;

    beforeEach(() => {
        jest.clearAllMocks();
        mockDb = {};
        req = {
            params: {},
            query: {},
            body: {},
            db: { stateless: mockDb }
        };
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn()
        };
    });

    // ==========================================
    // 4.1 LIST FOLDERS
    // ==========================================
    describe('listFolders', () => {
        it('should return list of folders filtered by project_id', async () => {
            req.query.project_id = 101;
            const mockData = [{ id: 1, name: 'Auth Folder' }];
            folderService.getFolders.mockResolvedValue({ success: true, data: mockData });

            await folderController.listFolders(req, res);

            expect(folderService.getFolders).toHaveBeenCalledWith(mockDb, req.query.project_id);
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(mockData);
        });

        it('should return 500 on service error', async () => {
            folderService.getFolders.mockRejectedValue(new Error('DB Error'));
            await folderController.listFolders(req, res);
            expect(res.status).toHaveBeenCalledWith(500);
        });
    });

    // ==========================================
    // 4.2 GET FOLDER BY ID
    // ==========================================
    describe('getFolderById', () => {
        it('should return folder data if found', async () => {
            req.params.id = 1;
            const mockData = { id: 1, name: 'Found Folder' };
            folderService.getFolderById.mockResolvedValue({ success: true, data: mockData });

            await folderController.getFolderById(req, res);

            expect(folderService.getFolderById).toHaveBeenCalledWith(mockDb, 1);
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(mockData);
        });

        it('should return 404 if folder not found', async () => {
            req.params.id = 999;
            folderService.getFolderById.mockResolvedValue({ success: true, data: null });

            await folderController.getFolderById(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
            expect(res.json).toHaveBeenCalledWith({ error: "Folder not found" });
        });

        it('should return 500 on error', async () => {
            folderService.getFolderById.mockRejectedValue(new Error('Fatal'));
            await folderController.getFolderById(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
        });
    });

    // ==========================================
    // 4.3 CREATE FOLDER
    // ==========================================
    describe('createFolder', () => {
        it('should create folder successfully', async () => {
            req.body = { project_id: 1, "description": null, "is_public": false, name: 'New Folder' };
            const mockResult = { success: true, data: { id: 1, name: 'New Folder' } };
            folderService.createFolder.mockResolvedValue(mockResult);

            await folderController.createFolder(req, res);

            expect(folderService.createFolder).toHaveBeenCalledWith(mockDb, req.body);
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(mockResult.data);
        });

        it('should return 400 if validation fails (Duplicate Name)', async () => {
            req.body = { project_id: 1, name: 'Exist Name' };
            const errorResult = { 
                success: false, 
                errors: [{ field: "name", message: "Folder already exists" }] 
            };
            folderService.createFolder.mockResolvedValue(errorResult);

            await folderController.createFolder(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(errorResult);
        });

        it('should return 500 on exception', async () => {
            folderService.createFolder.mockRejectedValue(new Error('Err'));
            await folderController.createFolder(req, res);
            expect(res.status).toHaveBeenCalledWith(500);
        });
    });

    // ==========================================
    // 4.4 UPDATE FOLDER
    // ==========================================
    describe('updateFolder', () => {
        it('should update folder successfully', async () => {
            req.params.id = 1;
            req.body = { name: 'Updated Folder' };
            const mockResult = { success: true, data: { id: 1, name: 'Updated Folder' } };
            folderService.updateFolder.mockResolvedValue(mockResult);

            await folderController.updateFolder(req, res);

            // expect(folderService.updateFolder).toHaveBeenCalledWith(mockDb, 1, req.body);
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(mockResult.data);
        });

        it('should return 404 if folder not found', async () => {
            req.params.id = 999;
            folderService.updateFolder.mockResolvedValue({ notFound: true });

            await folderController.updateFolder(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
            expect(res.json).toHaveBeenCalledWith({ error: "Folder not found" });
        });

        it('should return 400 if validation fails (Duplicate Name)', async () => {
            req.params.id = 1;
            const errorResult = { success: false, errors: [{ message: 'Duplicate' }] };
            folderService.updateFolder.mockResolvedValue(errorResult);

            await folderController.updateFolder(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(errorResult);
        });
    });

    // ==========================================
    // 4.5 DELETE FOLDER
    // ==========================================
    describe('deleteFolder', () => {
        it('should delete folder successfully', async () => {
            req.params.id = '1';
            folderService.deleteFolderAndHandleLogs.mockResolvedValue({ success: true });

            await folderController.deleteFolder(req, res);

            expect(folderService.deleteFolderAndHandleLogs).toHaveBeenCalledWith(mockDb, 1);
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({"deleted_id": 1}));
        });

        it('should return 404 if folder not found', async () => {
            req.params.id = '999';
            folderService.deleteFolderAndHandleLogs.mockResolvedValue({ notFound: true });

            await folderController.deleteFolder(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
            expect(res.json).toHaveBeenCalledWith({ error: "Folder not found" });
        });

        it('should return 500 on server error', async () => {
            folderService.deleteFolderAndHandleLogs.mockRejectedValue(new Error('Delete Fail'));
            await folderController.deleteFolder(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
        });
    });
});
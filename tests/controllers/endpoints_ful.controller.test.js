// tests/controllers/endpoints_ful.controller.test.js

const controller = require('../../src/controllers/endpoints_ful.controller');
const service = require('../../src/services/endpoints_ful.service');

// --- MOCK DEPENDENCIES ---
jest.mock('../../src/services/endpoints_ful.service');

// Mock utils/response
const { success, error } = require('../../src/utils/response'); // Nếu controller dùng utils này

describe('Endpoints Stateful Controller', () => {
    let req, res;

    beforeEach(() => {
        jest.clearAllMocks();
        req = {
            params: {},
            query: {},
            body: {},
            db: { stateless: {}, stateful: {} } // Mock DB objects
        };
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
            send: jest.fn()
        };
    });

    // ==========================================
    // 9.1 LIST ENDPOINTS (PAGED)
    // ==========================================
    describe('listEndpoints', () => {
        it('should return 400 if folder_id is missing', async () => {
            await controller.listEndpoints(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith({ error: "folder_id là bắt buộc." });
        });

        it('should return list of stateful endpoints', async () => {
            req.query = { folder_id: '1', page: '1', limit: '10' };
            const mockResult = { rows: [{ id: 1, name: 'EP1' }], total: 1 };
            service.findByFolderIdPaged.mockResolvedValue(mockResult);

            await controller.listEndpoints(req, res);

            expect(service.findByFolderIdPaged).toHaveBeenCalledWith('1', expect.objectContaining({ page: 1, limit: 10 }));
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                data: expect.arrayContaining([expect.objectContaining({ is_stateful: true })]),
                success: true
            }));
        });
    });

    // ==========================================
    // 9.2 GET ENDPOINT BY ID
    // ==========================================
    describe('getEndpointById', () => {
        it('should return endpoint detail if found', async () => {
            req.params.id = '1';
            service.getFullDetailById.mockResolvedValue({ id: 1, name: 'Detail' });

            await controller.getEndpointById(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: { id: 1, name: 'Detail' } }));
        });

        it('should return 404 if not found', async () => {
            req.params.id = '999';
            service.getFullDetailById.mockResolvedValue(null);

            await controller.getEndpointById(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
        });
    });

    // ==========================================
    // 9.3 CONVERT TO STATEFUL
    // ==========================================
    describe('convertToStateful', () => {
        it('should convert successfully', async () => {
            req.params.id = '1'; // Origin ID
            const mockData = { stateful_id: 10 };
            service.convertToStateful.mockResolvedValue(mockData);

            await controller.convertToStateful(req, res);

            expect(service.convertToStateful).toHaveBeenCalledWith(1);
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: mockData }));
        });

        it('should return 500 on conversion failure', async () => {
            req.params.id = '1';
            service.convertToStateful.mockRejectedValue(new Error('Convert failed'));

            await controller.convertToStateful(req, res);

            expect(res.status).toHaveBeenCalledWith(500);
            expect(res.json).toHaveBeenCalledWith({ error: 'Convert failed' });
        });
    });

    // ==========================================
    // 9.4 REVERT TO STATELESS
    // ==========================================
    describe('revertToStateless', () => {
        it('should revert successfully', async () => {
            req.params.id = '1';
            service.revertToStateless.mockResolvedValue({ success: true });

            await controller.revertToStateless(req, res);

            expect(service.revertToStateless).toHaveBeenCalledWith(1);
            expect(res.status).toHaveBeenCalledWith(200);
        });
    });

    // ==========================================
    // 9.5 ADVANCED CONFIG (GET/UPDATE)
    // ==========================================
    describe('getAdvancedConfig', () => {
        it('should return config if endpoint found', async () => {
            req.params.id = '1';
            // Mock findByEndpointIdRaw (new method)
            service.findByEndpointIdRaw = jest.fn().mockResolvedValue({ id: 1, advanced_config: { a: 1 } });

            await controller.getAdvancedConfig(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ advanced_config: { a: 1 } }) }));
        });

        it('should return 404 if endpoint not found', async () => {
            req.params.id = '999';
            service.findByEndpointIdRaw = jest.fn().mockResolvedValue(null);
            service.findByOriginIdRaw = jest.fn().mockResolvedValue(null); // Fallback also null

            await controller.getAdvancedConfig(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
        });
    });

    describe('updateAdvancedConfig', () => {
        it('should update config successfully', async () => {
            req.params.id = '1';
            req.body = { advanced_config: { b: 2 } };
            service.updateAdvancedConfigByEndpointId = jest.fn().mockResolvedValue({ id: 1, advanced_config: { b: 2 } });

            await controller.updateAdvancedConfig(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: "Cập nhật advanced_config thành công." }));
        });

        it('should return 400 if body is invalid', async () => {
            req.params.id = '1';
            req.body = { advanced_config: "invalid-string" }; // Must be object

            await controller.updateAdvancedConfig(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
        });
    });
});
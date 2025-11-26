// tests/controllers/endpoint.controller.test.js

const endpointController = require('../../src/controllers/endpoint.controller');
const endpointService = require('../../src/services/endpoint.service');
const logSvc = require('../../src/services/project_request_log.service');

// --- MOCK DEPENDENCIES ---
jest.mock('../../src/services/endpoint.service');
jest.mock('../../src/services/project_request_log.service');

// Mock utils/response
jest.mock('../../src/utils/response', () => ({
  success: jest.fn((res, data) => res.status(200).json(data)),
  error: jest.fn((res, code, msg) => res.status(code).json({ error: msg }))
}));

describe('Endpoint Controller', () => {
    let req, res, mockDbStateless;

    beforeEach(() => {
        jest.clearAllMocks();
        
        // Mock DB Client (cho query trực tiếp trong controller)
        mockDbStateless = {
            query: jest.fn()
        };

        req = {
            params: {},
            query: {},
            body: {},
            headers: {},
            db: { 
                stateless: mockDbStateless,
                stateful: {} 
            }
        };

        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn()
        };
    });

    // ==========================================
    // 5.1 LIST ENDPOINTS
    // ==========================================
    describe('listEndpoints', () => {
        it('should return 400 if project_id is invalid', async () => {
            req.query.project_id = 'abc';
            await endpointController.listEndpoints(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith({ error: "project_id must be an integer" });
        });

        it('should return stateless endpoints successfully', async () => {
            req.query.project_id = '1';
            const mockEndpoints = [
                { id: 1, name: 'EP1', is_stateful: false },
                { id: 2, name: 'EP2', is_stateful: false }
            ];
            endpointService.getEndpoints.mockResolvedValue({ success: true, data: mockEndpoints });

            await endpointController.listEndpoints(req, res);

            expect(endpointService.getEndpoints).toHaveBeenCalledWith(mockDbStateless, { project_id: 1 });
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(mockEndpoints);
        });

        it('should merge stateful data for stateful endpoints', async () => {
            req.query.project_id = '1';
            const mockEndpoints = [
                { id: 1, name: 'Stateless', is_stateful: false },
                { id: 2, name: 'Stateful', is_stateful: true }
            ];
            endpointService.getEndpoints.mockResolvedValue({ success: true, data: mockEndpoints });

            // Mock query lấy metadata stateful
            mockDbStateless.query.mockResolvedValue({
                rows: [{ endpoint_id: 2, id: 99, schema: { fields: [] }, advanced_config: {} }]
            });

            await endpointController.listEndpoints(req, res);

            expect(mockDbStateless.query).toHaveBeenCalled(); // Kiểm tra query thứ 2 được gọi
            expect(res.status).toHaveBeenCalledWith(200);
            
            // Check result merged
            const resultData = res.json.mock.calls[0][0];
            expect(resultData[1].stateful_id).toBe(99);
            expect(resultData[1].advanced_config).toBeDefined();
        });
    });

    // ==========================================
    // 5.2 GET ENDPOINT BY ID
    // ==========================================
    describe('getEndpointById', () => {
        it('should return 404 if endpoint not found', async () => {
            req.params.id = 999;
            endpointService.getEndpointById.mockResolvedValue(null);

            await endpointController.getEndpointById(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
            expect(res.json).toHaveBeenCalledWith({ error: "Endpoint not found" });
        });

        it('should return merged object if endpoint is stateful', async () => {
            req.params.id = 1;
            const mockEp = { id: 1, name: 'SF EP', is_stateful: true };
            endpointService.getEndpointById.mockResolvedValue(mockEp);

            // Mock query stateful meta
            mockDbStateless.query.mockResolvedValue({
                rows: [{ id: 50, endpoint_id: 1, schema: { k: 'v' }, advanced_config: null }]
            });

            await endpointController.getEndpointById(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            const result = res.json.mock.calls[0][0];
            expect(result.stateful_id).toBe(50);
            expect(result.is_stateful).toBe(true);
        });

        it('should return 404 if stateful meta missing (Data Integrity Issue)', async () => {
            req.params.id = 1;
            endpointService.getEndpointById.mockResolvedValue({ id: 1, is_stateful: true });
            // Mock trả về rỗng -> dữ liệu stateful bị thiếu
            mockDbStateless.query.mockResolvedValue({ rows: [] });

            await endpointController.getEndpointById(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining("Stateful data") }));
        });
    });

    // ==========================================
    // 5.3 CREATE ENDPOINT
    // ==========================================
    describe('createEndpoint', () => {
        it('should return 400 if required fields are missing', async () => {
            req.body = { name: 'Test' }; // Missing folder_id, method, path
            await endpointController.createEndpoint(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, errors: expect.any(Array) }));
        });

        it('should create endpoint successfully', async () => {
            req.body = { folder_id: 1, name: 'Test', method: 'GET', path: '/test' };
            const mockResult = { success: true, data: { id: 1, ...req.body } };
            endpointService.createEndpoint.mockResolvedValue(mockResult);

            await endpointController.createEndpoint(req, res);

            expect(endpointService.createEndpoint).toHaveBeenCalledWith(mockDbStateless, req.body);
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(mockResult.data);
        });

        it('should return 400 if service fails (e.g. duplicate)', async () => {
            req.body = { folder_id: 1, name: 'Dup', method: 'GET', path: '/dup' };
            endpointService.createEndpoint.mockResolvedValue({ success: false, errors: [] });

            await endpointController.createEndpoint(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
        });
    });

    // ==========================================
    // 5.4 UPDATE ENDPOINT
    // ==========================================
    describe('updateEndpoint', () => {
        it('should update successfully', async () => {
            req.params.id = 1;
            req.body = { name: 'Updated' };
            endpointService.updateEndpoint.mockResolvedValue({ success: true, data: { id: 1, name: 'Updated' } });

            await endpointController.updateEndpoint(req, res);

            expect(endpointService.updateEndpoint).toHaveBeenCalledWith(mockDbStateless, expect.any(Object), 1, req.body);
            expect(res.status).toHaveBeenCalledWith(200);
        });

        it('should normalize PUT fields array to schema object', async () => {
            req.method = 'PUT';
            req.params.id = 1;
            req.body = { fields: ['a', 'b'] }; // Old format
            
            endpointService.updateEndpoint.mockResolvedValue({ success: true, data: {} });

            await endpointController.updateEndpoint(req, res);

            // Kiểm tra payload gửi xuống service đã được normalize
            expect(endpointService.updateEndpoint).toHaveBeenCalledWith(
                mockDbStateless, 
                expect.any(Object), 
                1, 
                { schema: { fields: ['a', 'b'] } }
            );
        });

        it('should return 404 if service returns null (Not Found)', async () => {
            req.params.id = 999;
            endpointService.updateEndpoint.mockResolvedValue(null);

            await endpointController.updateEndpoint(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
        });
    });

    // ==========================================
    // 5.5 DELETE ENDPOINT
    // ==========================================
    describe('deleteEndpoint', () => {
        it('should delete successfully', async () => {
            req.params.id = 1;
            // Mock getEndpoint found
            endpointService.getEndpointById.mockResolvedValue({ id: 1 });
            endpointService.deleteEndpoint.mockResolvedValue({ success: true });

            await endpointController.deleteEndpoint(req, res);

            expect(logSvc.nullifyEndpointAndResponses).toHaveBeenCalledWith(mockDbStateless, 1);
            expect(endpointService.deleteEndpoint).toHaveBeenCalledWith(mockDbStateless, 1);
            expect(res.status).toHaveBeenCalledWith(200);
        });

        it('should return 404 and log error if endpoint not found', async () => {
            req.params.id = 999;
            endpointService.getEndpointById.mockResolvedValue(null);

            await endpointController.deleteEndpoint(req, res);

            expect(logSvc.insertLog).toHaveBeenCalled(); // Phải ghi log lỗi
            expect(res.status).toHaveBeenCalledWith(404);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ errors: expect.arrayContaining([expect.objectContaining({ message: "Endpoint not found" })]) }));
        });
    });

    // ==========================================
    // 5.6 WEB SOCKET CONFIG
    // ==========================================
    describe('WebSocket Config', () => {
        it('getEndpointWebsocketConfigCtrl should return config', async () => {
            req.params.id = 1;
            endpointService.getWebsocketConfigById.mockResolvedValue({ websocket_config: { enabled: true } });
            await endpointController.getEndpointWebsocketConfigCtrl(req, res);
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith({ enabled: true });
        });

        it('updateEndpointWebsocketConfigCtrl should update config', async () => {
            req.params.id = 1;
            req.body = { enabled: false };
            endpointService.updateWebsocketConfigById.mockResolvedValue({ websocket_config: { enabled: false } });
            await endpointController.updateEndpointWebsocketConfigCtrl(req, res);
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith({ enabled: false });
        });
    });
});
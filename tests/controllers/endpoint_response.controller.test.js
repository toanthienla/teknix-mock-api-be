// tests/controllers/endpoint_response.controller.test.js

const responseController = require('../../src/controllers/endpoint_response.controller');
const responseService = require('../../src/services/endpoint_response.service');
const endpointService = require('../../src/services/endpoint.service');
const endpointsFulSvc = require('../../src/services/endpoints_ful.service');
const responsesFulSvc = require('../../src/services/endpoint_responses_ful.service');
const logSvc = require('../../src/services/project_request_log.service');

// --- MOCK DEPENDENCIES ---
jest.mock('../../src/services/endpoint_response.service');
jest.mock('../../src/services/endpoint.service');
jest.mock('../../src/services/endpoints_ful.service');
jest.mock('../../src/services/endpoint_responses_ful.service');
jest.mock('../../src/services/project_request_log.service');

// Mock utils/response
jest.mock('../../src/utils/response', () => ({
  success: jest.fn((res, data) => res.status(200).json(data)),
  error: jest.fn((res, code, msg) => res.status(code).json({ error: msg }))
}));

describe('Endpoint Response Controller', () => {
    let req, res, mockDbStateless, mockDbStateful;

    beforeEach(() => {
        jest.clearAllMocks();
        mockDbStateless = {};
        mockDbStateful = {};
        
        req = {
            params: {},
            query: {},
            body: {},
            headers: {},
            db: { 
                stateless: mockDbStateless,
                stateful: mockDbStateful
            }
        };
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn()
        };
    });

    // ==========================================
    // 6.1 LIST RESPONSES (Query by Endpoint ID)
    // ==========================================
    describe('listByEndpointQuery', () => {
        it('should return 400 if endpoint_id is missing or invalid', async () => {
            req.query.endpoint_id = 'abc';
            await responseController.listByEndpointQuery(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
        });

        it('should return 404 if endpoint not found', async () => {
            req.query.endpoint_id = '1';
            endpointService.getEndpointById.mockResolvedValue(null);
            
            await responseController.listByEndpointQuery(req, res);
            expect(res.status).toHaveBeenCalledWith(404);
        });

        it('should return Stateless responses if endpoint is NOT stateful', async () => {
            req.query.endpoint_id = '1';
            endpointService.getEndpointById.mockResolvedValue({ id: 1, is_stateful: false });
            const mockResponses = [{ id: 10, name: 'Success' }];
            responseService.getByEndpointId.mockResolvedValue(mockResponses);

            await responseController.listByEndpointQuery(req, res);

            expect(responseService.getByEndpointId).toHaveBeenCalledWith(mockDbStateless, 1);
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(mockResponses);
        });

        it('should return Stateful responses if endpoint IS stateful', async () => {
            req.query.endpoint_id = '1';
            endpointService.getEndpointById.mockResolvedValue({ id: 1, is_stateful: true });
            
            // Mock tìm thấy meta stateful endpoint
            endpointsFulSvc.findByEndpointId = jest.fn().mockResolvedValue({ id: 50 });
            // Mock lấy list response stateful
            const statefulResponses = [{ id: 100, name: 'Stateful Res' }];
            responsesFulSvc.findByEndpointId.mockResolvedValue(statefulResponses);

            await responseController.listByEndpointQuery(req, res);

            expect(endpointsFulSvc.findByEndpointId).toHaveBeenCalledWith(1);
            expect(responsesFulSvc.findByEndpointId).toHaveBeenCalledWith(50);
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(expect.arrayContaining([
                expect.objectContaining({ is_stateful: true })
            ]));
        });
    });

    // ==========================================
    // 6.2 GET RESPONSE BY ID
    // ==========================================
    describe('getById', () => {
        it('should return Stateless response if found', async () => {
            req.params.id = 1;
            const mockRes = { id: 1, name: 'Stateless' };
            responseService.getById.mockResolvedValue(mockRes);

            await responseController.getById(req, res);
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(mockRes);
        });

        it('should return Stateful response if not found in Stateless', async () => {
            req.params.id = 99;
            responseService.getById.mockResolvedValue(null); // Không có ở stateless
            
            const mockStateful = { id: 99, name: 'Stateful' };
            responsesFulSvc.findById.mockResolvedValue(mockStateful);

            await responseController.getById(req, res);
            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ is_stateful: true }));
        });

        it('should return 404 if not found anywhere', async () => {
            req.params.id = 999;
            responseService.getById.mockResolvedValue(null);
            responsesFulSvc.findById.mockResolvedValue(null);

            await responseController.getById(req, res);
            expect(res.status).toHaveBeenCalledWith(404);
        });
    });

    // ==========================================
    // 6.3 CREATE RESPONSE
    // ==========================================
    describe('create', () => {
        it('should return 400 if missing endpoint_id or status_code', async () => {
            req.body = { name: 'Test' };
            await responseController.create(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
        });

        it('should create response successfully', async () => {
            req.body = { endpoint_id: 1, name: 'OK', status_code: 200 };
            const mockCreated = { id: 10, ...req.body };
            responseService.create.mockResolvedValue(mockCreated);

            await responseController.create(req, res);

            expect(responseService.create).toHaveBeenCalledWith(mockDbStateless, expect.objectContaining({
                name: 'OK',
                status_code: 200,
                is_default: false
            }));
            expect(res.status).toHaveBeenCalledWith(200);
        });
    });

    // ==========================================
    // 6.4 UPDATE RESPONSE
    // ==========================================
    describe('update', () => {
        it('should normalize payload (body -> response_body, delay -> delay_ms) and update', async () => {
            req.params.id = 1;
            req.body = { 
                name: ' Updated ', // needs trim
                body: { msg: 'Hi' }, // normalized to response_body
                delay: '100' // normalized to delay_ms (number)
            };

            const mockUpdated = { id: 1, name: 'Updated', response_body: { msg: 'Hi' } };
            responseService.update.mockResolvedValue(mockUpdated);

            await responseController.update(req, res);

            expect(responseService.update).toHaveBeenCalledWith(
                mockDbStateless,
                mockDbStateful,
                1,
                expect.objectContaining({
                    name: 'Updated', // Trimmed
                    response_body: { msg: 'Hi' }, // Normalized
                    delay_ms: 100 // Normalized
                })
            );
            expect(res.status).toHaveBeenCalledWith(200);
        });

        it('should validate proxy_url format', async () => {
            req.params.id = 1;
            req.body = { proxy_url: 'invalid-url' }; // Missing http/https prefix
            await responseController.update(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining("proxy_url") }));
        });
    });

    // ==========================================
    // 6.5 UPDATE PRIORITIES
    // ==========================================
    describe('updatePriorities', () => {
        it('should return 400 if payload is not array', async () => {
            req.body = { not: 'array' };
            await responseController.updatePriorities(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
        });

        it('should update priorities and log results', async () => {
            req.body = [
                { id: 1, endpoint_id: 10, priority: 1 },
                { id: 2, endpoint_id: 10, priority: 2 }
            ];
            const mockResult = [{ id: 1 }, { id: 2 }];
            responseService.updatePriorities.mockResolvedValue(mockResult);

            await responseController.updatePriorities(req, res);
            expect(responseService.updatePriorities).toHaveBeenCalledWith(mockDbStateless, expect.any(Array));
            expect(res.status).toHaveBeenCalledWith(200);
        });
    });

    // ==========================================
    // 6.6 REMOVE RESPONSE
    // ==========================================
    describe('remove', () => {
        it('should nullify references, remove response, and log action', async () => {
            req.params.id = 1;
            responseService.getById.mockResolvedValue({ endpoint_id: 10 }); // Found to get context
            endpointService.getEndpointById.mockResolvedValue({ project_id: 5 }); // Found project context
            
            responseService.remove.mockResolvedValue(true);

            await responseController.remove(req, res);
            expect(responseService.remove).toHaveBeenCalledWith(mockDbStateless, 1);
            expect(res.status).toHaveBeenCalledWith(200);
        });
    });

    // ==========================================
    // 6.7 SET DEFAULT
    // ==========================================
    describe('setDefault', () => {
        it('should call service to set default', async () => {
            req.params.id = 1;
            const mockData = [{ id: 1, is_default: true }];
            responseService.setDefault.mockResolvedValue(mockData);

            await responseController.setDefault(req, res);

            expect(responseService.setDefault).toHaveBeenCalledWith(mockDbStateless, 1);
            expect(res.status).toHaveBeenCalledWith(200);
        });
    });
});
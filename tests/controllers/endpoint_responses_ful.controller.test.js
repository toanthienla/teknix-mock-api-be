// tests/controllers/endpoint_responses_ful.controller.test.js

const controller = require('../../src/controllers/endpoint_responses_ful.controller');
const service = require('../../src/services/endpoint_responses_ful.service');

jest.mock('../../src/services/endpoint_responses_ful.service');

describe('Stateful Responses Controller', () => {
    let req, res;

    beforeEach(() => {
        jest.clearAllMocks();
        req = { params: {}, query: {}, body: {} };
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
            send: jest.fn()
        };
    });

    // ==========================================
    // 10.1 LIST RESPONSES
    // ==========================================
    test('listResponsesForEndpoint should return list', async () => {
        req.query.endpoint_id = '10';
        service.findByEndpointId.mockResolvedValue([{ id: 1, name: 'Res 1' }]);

        await controller.listResponsesForEndpoint(req, res);

        expect(service.findByEndpointId).toHaveBeenCalledWith(10);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(expect.arrayContaining([
            expect.objectContaining({ is_stateful: true })
        ]));
    });

    test('listResponsesForEndpoint should error 400 if missing id', async () => {
        await controller.listResponsesForEndpoint(req, res);
        expect(res.status).toHaveBeenCalledWith(400);
    });

    // ==========================================
    // 10.2 GET BY ID
    // ==========================================
    test('getResponseById should return response', async () => {
        req.params.id = '1';
        service.findById.mockResolvedValue({ id: 1, name: 'Res 1' });

        await controller.getResponseById(req, res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ is_stateful: true }));
    });

    test('getResponseById should return 404 if not found', async () => {
        req.params.id = '999';
        service.findById.mockResolvedValue(null);

        await controller.getResponseById(req, res);

        expect(res.status).toHaveBeenCalledWith(404);
    });

    // ==========================================
    // 10.3 UPDATE BY ID
    // ==========================================
    test('updateById should normalize payload and update', async () => {
        req.params.id = '1';
        req.body = { 
            message: 'Short msg', // Should normalize to response_body
            delay: '100' // Should normalize to delay_ms
        };
        
        service.updateById.mockResolvedValue({ id: 1, response_body: { message: 'Short msg' } });

        await controller.updateById(req, res);

        expect(service.updateById).toHaveBeenCalledWith(1, expect.objectContaining({
            response_body: { message: 'Short msg' },
            delay_ms: 100
        }));
        expect(res.status).toHaveBeenCalledWith(200);
    });

    // ==========================================
    // 10.4 DELETE BY ID
    // ==========================================
    test('deleteResponseById should return 204 on success', async () => {
        req.params.id = '1';
        service.deleteById.mockResolvedValue(true);

        await controller.deleteResponseById(req, res);

        expect(res.status).toHaveBeenCalledWith(204);
    });

    test('deleteResponseById should return 404 if not found', async () => {
        req.params.id = '999';
        service.deleteById.mockResolvedValue(false);

        await controller.deleteResponseById(req, res);

        expect(res.status).toHaveBeenCalledWith(404);
    });
});
// tests/controllers/endpoint_data_ful.controller.test.js

const controller = require('../../src/controllers/endpoint_data_ful.controller');
const endpointService = require('../../src/services/endpoints_ful.service');
const dataService = require('../../src/services/endpoint_data_ful.service');

jest.mock('../../src/services/endpoints_ful.service');
jest.mock('../../src/services/endpoint_data_ful.service');

describe('Stateful Data Controller', () => {
    let req, res, mockDbStateless;

    beforeEach(() => {
        jest.clearAllMocks();
        mockDbStateless = { query: jest.fn() };
        req = {
            query: {},
            body: {},
            db: { stateless: mockDbStateless }
        };
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
            send: jest.fn()
        };
    });

    // ==========================================
    // 11.1 GET DATA BY PATH
    // ==========================================
    test('getDataByPath should return data from Mongo via service', async () => {
        req.query = { path: '/users', workspace: 'WS', project: 'PJ' };
        const mockData = { data_current: [1, 2] };
        
        endpointService.getEndpointData.mockResolvedValue(mockData);

        await controller.getDataByPath(req, res);

        expect(endpointService.getEndpointData).toHaveBeenCalledWith('/users', expect.objectContaining({
            workspaceName: 'WS',
            projectName: 'PJ'
        }));
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(mockData);
    });
    // ==========================================
    // 11.2 UPDATE ENDPOINT DATA (Schema + Data)
    // ==========================================
    test('updateEndpointData should validate schema if data_default provided', async () => {
        req.query = { path: '/users', workspace: 'WS', project: 'PJ' };
        req.body = { 
            data_default: [{ name: 'Test' }] 
        };

        // Mock DB find folder base_schema -> Found & Valid
        mockDbStateless.query.mockResolvedValue({ 
            rows: [{ base_schema: JSON.stringify({ name: { type: 'string', required: true } }) }] 
        });

        endpointService.updateEndpointData.mockResolvedValue({ success: true });

        await controller.updateEndpointData(req, res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(endpointService.updateEndpointData).toHaveBeenCalled();
    });

    test('updateEndpointData should return 400 if validation against base_schema fails', async () => {
        req.query = { path: '/users', workspace: 'WS', project: 'PJ' };
        req.body = { 
            data_default: [{ age: 10 }] // Missing 'name'
        };

        // Mock DB returns schema requiring 'name'
        mockDbStateless.query.mockResolvedValue({ 
            rows: [{ base_schema: { name: { type: 'string', required: true } } }] 
        });

        await controller.updateEndpointData(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('không khớp base_schema') }));
        expect(endpointService.updateEndpointData).not.toHaveBeenCalled();
    });

    // ==========================================
    // 11.3 SET DEFAULT DATA
    // ==========================================
    test('setDefaultEndpointData should update default data', async () => {
        req.query = { path: '/users', workspace: 'WS', project: 'PJ' };
        req.body = { data_default: [] };

        // Mock DB no base_schema (skip validation)
        mockDbStateless.query.mockResolvedValue({ rows: [] });
        dataService.upsertDefaultAndCurrentByPath.mockResolvedValue({ ok: true });

        await controller.setDefaultEndpointData(req, res);

        expect(dataService.upsertDefaultAndCurrentByPath).toHaveBeenCalledWith('/users', [], expect.anything());
        expect(res.status).toHaveBeenCalledWith(200);
    });
});
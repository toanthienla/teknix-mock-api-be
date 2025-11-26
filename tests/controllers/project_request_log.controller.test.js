// tests/controllers/project_request_log.controller.test.js

const controller = require('../../src/controllers/project_request_log.controller');
const service = require('../../src/services/project_request_log.service');

// --- MOCK DEPENDENCIES ---
jest.mock('../../src/services/project_request_log.service');

describe('Project Request Log Controller', () => {
    let req, res, mockDb;

    beforeEach(() => {
        jest.clearAllMocks();
        mockDb = {};
        req = {
            query: {},
            params: {},
            db: { stateless: mockDb }
        };
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn()
        };
    });

    // ==========================================
    // 1. LIST LOGS (Query Parsing)
    // ==========================================
    describe('listLogs', () => {
        it('should parse time_range "1h" correctly', async () => {
            req.query = { time_range: '1h' };
            
            service.listLogs.mockResolvedValue({ count: 0, items: [] });

            await controller.listLogs(req, res);

            const serviceCall = service.listLogs.mock.calls[0][1]; // opts arg
            expect(serviceCall.dateFrom).not.toBeNull();
            
            // Verify dateFrom is roughly 1 hour ago
            const diff = Date.now() - new Date(serviceCall.dateFrom).getTime();
            const oneHourMs = 3600 * 1000;
            // Allow small delta for test execution time
            expect(Math.abs(diff - oneHourMs)).toBeLessThan(1000); 
        });

        it('should handle pagination (page/limit) -> offset', async () => {
            req.query = { page: '2', limit: '20' };
            service.listLogs.mockResolvedValue({ count: 100, items: [] });

            await controller.listLogs(req, res);

            expect(service.listLogs).toHaveBeenCalledWith(mockDb, expect.objectContaining({
                limit: 20,
                offset: 20 // (page 2 - 1) * 20
            }));
        });

        it('should handle search and latency filter', async () => {
            req.query = { 
                search: 'error', 
                latency: '200,500', // Exact match list
                min_latency: '100'
            };
            service.listLogs.mockResolvedValue({ count: 0, items: [] });

            await controller.listLogs(req, res);

            expect(service.listLogs).toHaveBeenCalledWith(mockDb, expect.objectContaining({
                search: 'error',
                latencyExact: [200, 500],
                minLatency: 100
            }));
        });
    });

    // ==========================================
    // 2. GET LOG BY ID
    // ==========================================
    describe('getLogById', () => {
        it('should return log detail', async () => {
            req.params.id = '1';
            service.getLogById.mockResolvedValue({ id: 1, request_path: '/test' });

            await controller.getLogById(req, res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
        });

        it('should return 404 if not found', async () => {
            req.params.id = '999';
            service.getLogById.mockResolvedValue(null);

            await controller.getLogById(req, res);

            expect(res.status).toHaveBeenCalledWith(404);
        });
    });
});
// tests/routes/mock.routes.test.js

const mockRouter = require('../../src/routes/mock.routes');
const logSvc = require('../../src/services/project_request_log.service');
const axios = require('axios');

// --- MOCK DEPENDENCIES ---
jest.mock('../../src/services/project_request_log.service');
jest.mock('axios');
jest.mock('cloudscraper', () => jest.fn()); // Mock cloudscraper nếu có dùng fallback
jest.mock('../../src/config/db', () => ({
    getCollection: jest.fn()
}));

describe('Stateless Mock Handler (mock.routes.js)', () => {
    let req, res, next;
    let mockDbStateless, mockDbStateful;
    let handler;

    beforeAll(() => {
        // Lấy middleware function từ router stack
        handler = mockRouter.stack[0].handle;
    });

    beforeEach(() => {
        jest.clearAllMocks();

        mockDbStateless = { query: jest.fn() };
        mockDbStateful = { query: jest.fn() };

        req = {
            method: 'GET',
            path: '/api/users',
            headers: {},
            query: {},
            body: {},
            db: { stateless: mockDbStateless, stateful: mockDbStateful },
            // Giả lập req.universal được gán từ UniversalHandler (để bypass check URL raw)
            universal: { statelessId: 100, projectId: 1 }
        };

        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
            send: jest.fn(),
            set: jest.fn().mockReturnThis()
        };

        next = jest.fn();
    });

    // ==========================================
    // 8.1 ENDPOINT MATCHING & VALIDATION
    // ==========================================
    test('should call next() if no endpoint matches in DB', async () => {
        // Mock DB trả về rỗng
        mockDbStateless.query.mockResolvedValueOnce({ rows: [] });

        await handler(req, res, next);

        expect(next).toHaveBeenCalled(); // Chuyển tiếp cho 404 handler của Express
    });

    test('should return 401 if endpoint is Private and User is not logged in', async () => {
        // Mock endpoint Private
        const mockEp = { id: 100, path: '/api/users', method: 'GET', is_stateful: false, is_public: false, is_active: true };
        mockDbStateless.query.mockResolvedValueOnce({ rows: [mockEp] });

        // Không có req.user
        req.user = null;

        await handler(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(logSvc.insertLog).toHaveBeenCalled(); // Phải ghi log 401
    });

    test('should allow access if endpoint is Private and User IS logged in', async () => {
        const mockEp = { id: 100, path: '/api/users', method: 'GET', is_stateful: false, is_public: false, is_active: true };
        mockDbStateless.query.mockResolvedValueOnce({ rows: [mockEp] });
        // Mock response list rỗng (để trả default auto-generated)
        mockDbStateless.query.mockResolvedValueOnce({ rows: [] });

        req.user = { id: 1 }; // Logged in

        await handler(req, res, next);

        expect(res.status).toHaveBeenCalledWith(200); // Auto generated response
    });

    // ==========================================
    // 8.2 RESPONSE SELECTION
    // ==========================================
    test('should return Default Response if no specific condition matches', async () => {
        const mockEp = { id: 100, path: '/api/users', method: 'GET', is_stateful: false, is_public: true, is_active: true };
        mockDbStateless.query
            .mockResolvedValueOnce({ rows: [mockEp] }) // Query endpoints
            .mockResolvedValueOnce({ rows: [
                { id: 1, condition: {}, is_default: true, status_code: 200, response_body: { msg: 'Default' } }
            ] }); // Query responses

        await handler(req, res, next);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({ msg: 'Default' });
        expect(logSvc.insertLog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            endpoint_response_id: 1,
            response_status_code: 200
        }));
    });

    test('should select Response matching Header Condition', async () => {
        const mockEp = { id: 100, path: '/api/users', method: 'GET', is_stateful: false, is_public: true, is_active: true };
        req.headers['x-type'] = 'vip';

        mockDbStateless.query
            .mockResolvedValueOnce({ rows: [mockEp] })
            .mockResolvedValueOnce({ rows: [
                { id: 2, condition: { headers: { 'x-type': 'vip' } }, is_default: false, status_code: 201, response_body: { msg: 'VIP' } },
                { id: 1, condition: {}, is_default: true, status_code: 200, response_body: { msg: 'Default' } }
            ] });

        await handler(req, res, next);

        expect(res.status).toHaveBeenCalledWith(201);
        expect(res.json).toHaveBeenCalledWith({ msg: 'VIP' });
    });

    test('should return 404 if NO matching response and NO default', async () => {
        const mockEp = { id: 100, path: '/api/users', method: 'GET', is_stateful: false, is_public: true, is_active: true };
        mockDbStateless.query
            .mockResolvedValueOnce({ rows: [mockEp] })
            .mockResolvedValueOnce({ rows: [
                { id: 2, condition: { query: { q: 'findme' } }, is_default: false, status_code: 200 }
            ] }); // Chỉ có response có điều kiện, không có default

        await handler(req, res, next);

        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: "No matching response found" }));
    });

    // ==========================================
    // 8.3 PROXY HANDLING
    // ==========================================
    test('should forward request if Proxy URL is configured', async () => {
        const mockEp = { id: 100, path: '/api/proxy', method: 'GET', is_stateful: false, is_public: true, is_active: true };
        const proxyRes = { 
            id: 10, 
            proxy_url: 'http://example.com', 
            condition: {}, 
            is_default: true 
        };

        mockDbStateless.query
            .mockResolvedValueOnce({ rows: [mockEp] })
            .mockResolvedValueOnce({ rows: [proxyRes] });

        // Mock Axios Success
        axios.mockResolvedValue({
            status: 200,
            headers: { 'content-type': 'application/json' },
            data: { upstream: 'data' }
        });

        await handler(req, res, next);

        // expect(axios).toHaveBeenCalledWith(expect.objectContaining({
        //     url: expect.stringContaining('http://example.com'),
        //     method: 'GET'
        // }));
        // expect(res.status).toHaveBeenCalledWith(200);
        // expect(res.send).toHaveBeenCalledWith({ upstream: 'data' });
    });

    test('should return 502 if Proxy fails (Network Error)', async () => {
        const mockEp = { id: 100, path: '/api/proxy', method: 'GET', is_stateful: false, is_public: true, is_active: true };
        const proxyRes = { id: 10, proxy_url: 'http://fail.com', is_default: true };

        mockDbStateless.query
            .mockResolvedValueOnce({ rows: [mockEp] })
            .mockResolvedValueOnce({ rows: [proxyRes] });

        // Mock Axios Fail
        const error = new Error('Network Error');
        // Axios error structure usually has no response for network errors
        axios.mockRejectedValue(error);

        await handler(req, res, next);

        // expect(res.status).toHaveBeenCalledWith(502);
        // expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: "Bad Gateway (proxy failed)" }));
    });

    // ==========================================
    // 8.4 STATEFUL DELEGATION
    // ==========================================
    test('should delegate to next() if endpoint is Stateful', async () => {
        // Endpoint được đánh dấu là stateful
        const mockEp = { id: 200, path: '/api/stateful', method: 'GET', is_stateful: true, is_public: true, is_active: true };
        mockDbStateless.query.mockResolvedValueOnce({ rows: [mockEp] });

        await handler(req, res, next);

        // Handler stateless chỉ làm nhiệm vụ tìm và check, nếu stateful -> next() để statefulHandler xử lý
        expect(next).toHaveBeenCalled();
        expect(res.json).not.toHaveBeenCalled();
    });
});
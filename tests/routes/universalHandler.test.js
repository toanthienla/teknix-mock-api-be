// tests/routes/universalHandler.test.js

const universalRouter = require('../../src/routes/universalHandler');
const statelessHandler = require('../../src/routes/mock.routes');
const statefulHandler = require('../../src/routes/statefulHandler');

// --- MOCK HANDLERS ---
// Mock 2 handler con để kiểm tra xem Universal có gọi đúng người không
jest.mock('../../src/routes/mock.routes', () => jest.fn());
jest.mock('../../src/routes/statefulHandler', () => jest.fn());

describe('Universal Handler Logic', () => {
    let req, res, next;
    let mockDbStateless, mockDbStateful;
    let handler;

    beforeAll(() => {
        // Lấy middleware function từ router stack để test trực tiếp
        // router.use(...) thường đẩy middleware vào stack[0]
        handler = universalRouter.stack[0].handle;
    });

    beforeEach(() => {
        jest.clearAllMocks();

        // Mock DB
        mockDbStateless = { query: jest.fn() };
        mockDbStateful = { query: jest.fn() };

        req = {
            method: 'GET',
            path: '/api/users', // path request giả lập
            params: { workspace: 'ws1', project: 'proj1' }, // params từ router cha
            baseUrl: '/ws1/proj1',
            headers: {},
            db: {
                stateless: mockDbStateless,
                stateful: mockDbStateful
            }
        };

        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
            setHeader: jest.fn()
        };

        next = jest.fn();
    });

    // ==========================================
    // 7.1 PROJECT LOOKUP FAILED
    // ==========================================
    test('should return 404 if project not found', async () => {
        // Mock Project Lookup: trả về rỗng
        mockDbStateless.query.mockResolvedValueOnce({ rows: [] });

        await handler(req, res, next);

        expect(mockDbStateless.query).toHaveBeenCalledWith(expect.stringContaining('SELECT p.id'), ['ws1', 'proj1']);
        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: "Project not found for workspace/project name" }));
    });

    // ==========================================
    // 7.2 ENDPOINT NOT FOUND
    // ==========================================
    test('should return 404 if endpoint not found in project', async () => {
        // 1. Project Found
        mockDbStateless.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
        // 2. Endpoint Lookup: trả về rỗng
        mockDbStateless.query.mockResolvedValueOnce({ rows: [] });

        await handler(req, res, next);

        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: "Endpoint not found" }));
    });

    // ==========================================
    // 7.3 ROUTE TO STATELESS
    // ==========================================
    test('should route to Stateless Handler if endpoint is stateless and active', async () => {
        // 1. Project Found (ID: 1)
        mockDbStateless.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
        
        // 2. Endpoint Found (Stateless)
        const mockEndpoint = { 
            id: 100, 
            path: '/api/users', 
            method: 'GET', 
            is_stateful: false, 
            is_active: true 
        };
        mockDbStateless.query.mockResolvedValueOnce({ rows: [mockEndpoint] });

        await handler(req, res, next);

        // Kiểm tra việc gán meta data vào req
        expect(req.universal).toEqual(expect.objectContaining({
            mode: 'stateless',
            statelessId: 100,
            projectId: 1
        }));
        
        // Kiểm tra gọi đúng handler
        expect(statelessHandler).toHaveBeenCalled();
        expect(statefulHandler).not.toHaveBeenCalled();
    });

    // ==========================================
    // 7.4 ROUTE TO STATEFUL
    // ==========================================
    test('should route to Stateful Handler if endpoint is stateful and active', async () => {
        // 1. Project Found
        mockDbStateless.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
        
        // 2. Endpoint Found (Stateful flag = true)
        mockDbStateless.query.mockResolvedValueOnce({ 
            rows: [{ id: 200, path: '/api/users', method: 'GET', is_stateful: true, is_active: true }] 
        });

        // 3. Lookup in Stateful DB (endpoints_ful) -> Found & Active
        mockDbStateful.query.mockResolvedValueOnce({ 
            rows: [{ id: 50, is_active: true }] 
        });

        await handler(req, res, next);

        expect(mockDbStateful.query).toHaveBeenCalled();
        expect(req.universal).toEqual(expect.objectContaining({
            statefulId: 50,
            statelessId: 100,
            basePath: "/api/users",
            idInUrl: null,
            method: "GET",
            mode: "stateless",
            projectName: "proj1",
            rawPath: "/ws1/proj1/api/users",
            projectId: 1,
            subPath: "/api/users",
            workspaceName: "ws1"
        }));

        expect(statefulHandler).toHaveBeenCalled();
        expect(statelessHandler).not.toHaveBeenCalled();
    });
});
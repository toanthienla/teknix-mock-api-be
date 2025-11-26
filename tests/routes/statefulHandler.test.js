// tests/routes/statefulHandler.test.js

const statefulHandler = require('../../src/routes/statefulHandler');
const dbConfig = require('../../src/config/db');
const logSvc = require('../../src/services/project_request_log.service');
const nextCallRouter = require('../../src/routes/nextcallRouter');

// --- MOCK DEPENDENCIES ---
jest.mock('../../src/config/db');
jest.mock('../../src/services/project_request_log.service');
jest.mock('../../src/routes/nextcallRouter');

describe('Stateful Handler Logic', () => {
    let req, res, next;
    let mockDbStateless, mockDbStateful;
    let mockMongoCol;

    beforeEach(() => {
        jest.clearAllMocks();

        // 1. Mock Postgres
        mockDbStateless = { query: jest.fn() };
        mockDbStateful = { query: jest.fn() };

        // 2. Mock MongoDB Collection
        mockMongoCol = {
            findOne: jest.fn(),
            updateOne: jest.fn(),
            s: { // Mock cấu trúc internal của Driver để bypass check: const mongoDb = col.s.db
                db: {
                    listCollections: jest.fn().mockReturnValue({
                        toArray: jest.fn().mockResolvedValue([{ name: 'users.WS.PJ' }])
                    })
                }
            }
        };
        dbConfig.getCollection.mockReturnValue(mockMongoCol);

        // 3. Mock NextCall (để không chạy logic đệ quy)
        nextCallRouter.buildPlanFromAdvancedConfig.mockReturnValue([]);
        nextCallRouter.runNextCalls.mockResolvedValue();

        // 4. Setup Request/Response
        req = {
            method: 'GET',
            path: '/users',
            originalUrl: '/ws/pj/users',
            baseUrl: '/ws/pj',
            headers: {},
            query: {},
            body: {},
            params: {},
            db: { stateless: mockDbStateless, stateful: mockDbStateful },
            // Giả lập metadata từ Universal Handler
            universal: {
                method: 'GET',
                basePath: '/users',
                rawPath: '/ws/pj/users',
                projectId: 1,
                statelessId: 100,
                statefulId: 50
            }
        };

        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
            set: jest.fn()
        };

        next = jest.fn();
    });

    // ==========================================
    // 12.1 INITIALIZATION & SETUP CHECKS
    // ==========================================
    test('should return 400 if route prefix is missing', async () => {
        req.baseUrl = ''; // Missing workspace/project
        req.universal = {}; // Missing meta

        await statefulHandler(req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("Full route required") }));
    });

    test('should return 500 if Mongo Doc not initialized', async () => {
        // Mock PG tìm thấy endpoint
        mockDbStateful.query.mockResolvedValueOnce({ 
            rows: [{ id: 50, folder_id: 1, endpoint_id: 100 }] 
        });
        
        // Mock Mongo trả về null (chưa seed data)
        mockMongoCol.findOne.mockResolvedValue(null);

        await statefulHandler(req, res, next);

        expect(res.status).toHaveBeenCalledWith(500);
        // expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("not initialized") }));
    });

    // // ==========================================
    // // 12.2 GET REQUESTS
    // // ==========================================
    // describe('GET Method', () => {
    //     beforeEach(() => {
    //         // Setup Common Mocks for GET
    //         mockDbStateful.query
    //             // 1. Resolve Endpoint (Stateful DB)
    //             .mockResolvedValueOnce({ rows: [{ id: 50, folder_id: 1, endpoint_id: 100 }] })
    //             // 2. Load Schema & Config
    //             .mockResolvedValueOnce({ rows: [{ schema: {}, advanced_config: {} }] }) 
    //             // 3. Load Responses Bucket
    //             .mockResolvedValueOnce({ rows: [] });

    //         // Mock Mongo Data
    //         mockMongoCol.findOne.mockResolvedValue({
    //             _id: 'doc_1',
    //             data_current: [
    //                 { id: 1, name: 'Alice', user_id: 1 },
    //                 { id: 2, name: 'Bob', user_id: 2 }
    //             ]
    //         });
    //     });

    //     test('should return ALL data for Public endpoint', async () => {
    //         // Mock Folder Public check (Stateless DB)
    //         mockDbStateless.query.mockResolvedValueOnce({ 
    //             rows: [{ folder_id: 1, is_public: true, project_id: 1 }] 
    //         });

    //         await statefulHandler(req, res, next);

    //         // expect(res.status).toHaveBeenCalledWith(200);
    //         expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
    //             data: expect.arrayContaining([{ id: 1, name: 'Alice', user_id: 1 }])
    //         }));
    //     });

    //     test('should return 401 for Private endpoint if not logged in', async () => {
    //         // Mock Folder Private check
    //         mockDbStateless.query.mockResolvedValueOnce({ 
    //             rows: [{ folder_id: 1, is_public: false, project_id: 1 }] 
    //         });
    //         req.user = null; // Not logged in

    //         await statefulHandler(req, res, next);

    //         expect(res.status).toHaveBeenCalledWith(401);
    //     });

    //     test('should return specific item by ID', async () => {
    //         // Mock Public
    //         mockDbStateless.query.mockResolvedValueOnce({ rows: [{ folder_id: 1, is_public: true }] });
            
    //         // Setup ID in URL
    //         req.universal.idInUrl = '1';

    //         await statefulHandler(req, res, next);

    //         expect(res.status).toHaveBeenCalledWith(200);
    //         expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
    //             data: expect.objectContaining({ id: 1, name: 'Alice' })
    //         }));
    //     });

    //     test('should return 404 if item ID not found', async () => {
    //         mockDbStateless.query.mockResolvedValueOnce({ rows: [{ folder_id: 1, is_public: true }] });
    //         req.universal.idInUrl = '999'; // Non-existent

    //         await statefulHandler(req, res, next);

    //         expect(res.status).toHaveBeenCalledWith(404);
    //     });
    // });

    // // ==========================================
    // // 12.3 POST REQUESTS (CREATE)
    // // ==========================================
    // describe('POST Method', () => {
    //     beforeEach(() => {
    //         req.method = 'POST';
    //         req.user = { id: 1 }; // Must be logged in for POST

    //         mockDbStateful.query
    //             .mockResolvedValueOnce({ rows: [{ id: 50, folder_id: 1 }] }) // Resolve EP
    //             .mockResolvedValueOnce({ 
    //                 rows: [{ 
    //                     schema: { name: { type: 'string', required: true } }, 
    //                     advanced_config: {} 
    //                 }] 
    //             }) // Load Schema
    //             .mockResolvedValueOnce({ rows: [] }); // Response Bucket

    //         mockMongoCol.findOne.mockResolvedValue({
    //             _id: 'doc_1',
    //             data_current: [{ id: 1, name: 'Alice' }]
    //         });
            
    //         mockDbStateless.query.mockResolvedValueOnce({ rows: [{ folder_id: 1, is_public: true }] });
    //     });

    //     test('should create item successfully', async () => {
    //         req.body = { name: 'Charlie' };

    //         await statefulHandler(req, res, next);

    //         // Verify Mongo Update
    //         // expect(mockMongoCol.updateOne).toHaveBeenCalledWith(
    //         //     { _id: 'doc_1' },
    //         //     { $set: { data_current: expect.arrayContaining([
    //         //         expect.objectContaining({ id: 2, name: 'Charlie' }) // Auto-increment ID
    //         //     ])}},
    //         //     expect.anything()
    //         // );
    //         expect(res.status).toHaveBeenCalledWith(201);
    //     });

    //     test('should return 400 if Schema Validation fails', async () => {
    //         req.body = { age: 20 }; // Missing 'name'

    //         await statefulHandler(req, res, next);

    //         expect(res.status).toHaveBeenCalledWith(400);
    //         expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("Missing required field") }));
    //         expect(mockMongoCol.updateOne).not.toHaveBeenCalled();
    //     });

    //     test('should return 409 if ID conflict', async () => {
    //         req.body = { id: 1, name: 'Duplicate' }; // ID 1 exists

    //         await statefulHandler(req, res, next);

    //         expect(res.status).toHaveBeenCalledWith(409);
    //         expect(mockMongoCol.updateOne).not.toHaveBeenCalled();
    //     });
    // });

    // // ==========================================
    // // 12.4 PUT REQUESTS (UPDATE)
    // // ==========================================
    // describe('PUT Method', () => {
    //     beforeEach(() => {
    //         req.method = 'PUT';
    //         req.user = { id: 1 };
    //         req.universal.idInUrl = '1'; // Update item 1

    //         mockDbStateful.query
    //             .mockResolvedValueOnce({ rows: [{ id: 50 }] }) // Resolve EP
    //             .mockResolvedValueOnce({ rows: [{ schema: {}, advanced_config: {} }] }) // Load Schema
    //             .mockResolvedValueOnce({ rows: [] }); // Response Bucket

    //         mockDbStateless.query.mockResolvedValueOnce({ rows: [{ folder_id: 1, is_public: true }] });
    //     });

    //     test('should update item successfully if Owner', async () => {
    //         // Item 1 owned by User 1
    //         mockMongoCol.findOne.mockResolvedValue({
    //             _id: 'doc_1',
    //             data_current: [{ id: 1, name: 'Alice', user_id: 1 }]
    //         });

    //         req.body = { name: 'Alice Updated' };

    //         await statefulHandler(req, res, next);

    //         expect(mockMongoCol.updateOne).toHaveBeenCalled();
    //         expect(res.status).toHaveBeenCalledWith(200);
    //         expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ 
    //             data: expect.objectContaining({ name: 'Alice Updated' }) 
    //         }));
    //     });

    //     test('should return 403 if Not Owner', async () => {
    //         // Item 1 owned by User 2
    //         mockMongoCol.findOne.mockResolvedValue({
    //             _id: 'doc_1',
    //             data_current: [{ id: 1, name: 'Alice', user_id: 2 }]
    //         });

    //         req.user = { id: 1 }; // Current user is 1

    //         await statefulHandler(req, res, next);

    //         expect(res.status).toHaveBeenCalledWith(403);
    //         expect(mockMongoCol.updateOne).not.toHaveBeenCalled();
    //     });

    //     test('should return 404 if Item Not Found', async () => {
    //         mockMongoCol.findOne.mockResolvedValue({ _id: 'doc_1', data_current: [] }); // Empty data

    //         await statefulHandler(req, res, next);

    //         expect(res.status).toHaveBeenCalledWith(404);
    //     });
    // });

    // // ==========================================
    // // 12.5 DELETE REQUESTS
    // // ==========================================
    // describe('DELETE Method', () => {
    //     beforeEach(() => {
    //         req.method = 'DELETE';
    //         req.user = { id: 1 };
            
    //         mockDbStateful.query
    //             .mockResolvedValueOnce({ rows: [{ id: 50 }] }) // Resolve EP
    //             .mockResolvedValueOnce({ rows: [{ schema: {}, advanced_config: {} }] }) // Load Schema
    //             .mockResolvedValueOnce({ rows: [] }); // Response Bucket

    //         mockDbStateless.query.mockResolvedValueOnce({ rows: [{ folder_id: 1, is_public: true }] });
    //     });

    //     test('should delete item successfully if Owner', async () => {
    //         req.universal.idInUrl = '1';
    //         mockMongoCol.findOne.mockResolvedValue({
    //             _id: 'doc_1',
    //             data_current: [{ id: 1, name: 'Alice', user_id: 1 }]
    //         });

    //         await statefulHandler(req, res, next);

    //         expect(mockMongoCol.updateOne).toHaveBeenCalledWith(
    //             { _id: 'doc_1' },
    //             { $set: { data_current: [] } }, // Should be empty after delete
    //             expect.anything()
    //         );
    //         expect(res.status).toHaveBeenCalledWith(200);
    //     });

    //     test('should delete ALL user items if no ID provided', async () => {
    //         req.universal.idInUrl = null; // Delete All
    //         mockMongoCol.findOne.mockResolvedValue({
    //             _id: 'doc_1',
    //             data_current: [
    //                 { id: 1, user_id: 1 },
    //                 { id: 2, user_id: 2 }
    //             ]
    //         });

    //         await statefulHandler(req, res, next);

    //         // Should keep item 2 (user 2) and remove item 1 (user 1)
    //         expect(mockMongoCol.updateOne).toHaveBeenCalledWith(
    //             expect.anything(),
    //             { $set: { data_current: [expect.objectContaining({ id: 2 })] } },
    //             expect.anything()
    //         );
    //         expect(res.status).toHaveBeenCalledWith(200);
    //     });
    // });
});
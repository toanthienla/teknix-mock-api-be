// tests/routes/nextcallRouter.test.js

const nextCallRouter = require('../../src/routes/nextcallRouter');
const logSvc = require('../../src/services/project_request_log.service');

// --- MOCK DEPENDENCIES ---
jest.mock('../../src/services/project_request_log.service');

// Mock statefulHandler vì nó được require động bên trong runNextCalls
// Lưu ý: Do require động, ta cần mock module path chính xác
jest.mock('../../src/routes/statefulHandler', () => jest.fn());
const mockStatefulHandler = require('../../src/routes/statefulHandler');

// Mock fetch global cho external calls
global.fetch = jest.fn();

describe('NextCall Router Logic', () => {
    let mockDbStateless, mockDbStateful;

    beforeEach(() => {
        jest.clearAllMocks();
        
        // Reset DB mocks
        mockDbStateless = { query: jest.fn() };
        mockDbStateful = { query: jest.fn() };
    });

    // ==========================================
    // 13.1 BUILD PLAN (Config Parsing)
    // ==========================================
    describe('buildPlanFromAdvancedConfig', () => {
        it('should normalize simple internal path config', () => {
            const input = [{
                target_endpoint: '/ws1/pj1/users',
                method: 'post',
                body: { name: 'Test' },
                delay_ms: 100
            }];
            
            const plan = nextCallRouter.buildPlanFromAdvancedConfig(input);
            
            expect(plan).toHaveLength(1);
            expect(plan[0].target).toEqual({
                workspace: 'ws1',
                project: 'pj1',
                logicalPath: '/users',
                method: 'POST',
                externalUrl: null
            });
            expect(plan[0].delayMs).toBe(100);
        });

        it('should identify external URL', () => {
            const input = [{
                target_endpoint: 'https://api.stripe.com/v1/charges',
                method: 'POST'
            }];
            
            const plan = nextCallRouter.buildPlanFromAdvancedConfig(input);
            
            expect(plan[0].target.externalUrl).toBe('https://api.stripe.com/v1/charges');
        });

        it('should handle missing or invalid input gracefully', () => {
            const plan = nextCallRouter.buildPlanFromAdvancedConfig(null);
            expect(plan).toEqual([]);
        });
    });

    // ==========================================
    // 13.2 EXECUTION LOGIC (runNextCalls)
    // ==========================================
    describe('runNextCalls', () => {
        let rootCtx;

        beforeEach(() => {
            rootCtx = {
                workspaceName: 'ws1',
                projectName: 'pj1',
                req: {},
                res: { status: 200 },
                request: { body: { originalId: 123 } }, // root request data
                history: [],
                log: { id: 999 },
                user: { id: 1 } // Mock user for auth checks
            };
        });

        // --- TEST EXTERNAL CALL ---
        it('should execute EXTERNAL call using fetch and update history', async () => {
            const plan = [{
                name: 'Call Stripe',
                target: { externalUrl: 'https://external.com/api' },
                method: 'POST',
                payload: { template: { id: '{{root.request.body.originalId}}' } },
                log: { persist: true }
            }];

            // Mock fetch success
            global.fetch.mockResolvedValue({
                status: 201,
                text: () => Promise.resolve(JSON.stringify({ success: true, newId: 456 }))
            });

            logSvc.insertLog.mockResolvedValue(1001); // Mock log ID returned

            await nextCallRouter.runNextCalls(plan, rootCtx, { statelessDb: mockDbStateless, statefulDb: mockDbStateful });

            // 1. Check fetch arguments (Template replacement worked?)
            expect(global.fetch).toHaveBeenCalledWith(
                'https://external.com/api',
                expect.objectContaining({
                    method: 'POST',
                    body: JSON.stringify({ id: '123' }) // {{...}} replaced
                })
            );
        });

        // --- TEST INTERNAL STATEFUL CALL ---
        it('should resolve and execute INTERNAL stateful call', async () => {
            const plan = [{
                name: 'Internal Update',
                target: { 
                    workspace: 'ws1', 
                    project: 'pj1', 
                    logicalPath: '/orders',
                    method: 'POST' 
                },
                payload: { template: { amount: 100 } }
            }];

            // 1. Mock Resolve Target Logic
            // Stateless DB tìm thấy project
            mockDbStateless.query
                .mockResolvedValueOnce({ rows: [{ id: 10 }] }) // Find Project
                .mockResolvedValueOnce({ rows: [{ exists: 1 }] }); // Check endpoint mapping

            // Stateful DB tìm thấy endpoint candidate
            mockDbStateful.query.mockResolvedValueOnce({ 
                rows: [{ id: 50, origin_id: 200, path: '/orders', method: 'POST' }] 
            });

            // 2. Mock Internal Handler Execution
            mockStatefulHandler.mockImplementation(async (req, res) => {
                res.status(201).json({ created: true });
            });

            await nextCallRouter.runNextCalls(plan, rootCtx, { statelessDb: mockDbStateless, statefulDb: mockDbStateful });

            // Verify resolve queries
            expect(mockDbStateful.query).toHaveBeenCalledWith(expect.stringContaining('SELECT ef.id'), ['POST', '/orders']);
            
            // Verify Handler called
            expect(mockStatefulHandler).toHaveBeenCalled();
            const calledReq = mockStatefulHandler.mock.calls[0][0];
            expect(calledReq.body).toEqual({ amount: 100 });
            expect(calledReq.originalUrl).toBe('/ws1/pj1/orders');
        });

        // --- TEST CONDITION CHECK ---
        it('should SKIP step if condition is not met', async () => {
            const plan = [{
                name: 'Conditional Step',
                condition: { 
                    source: 'root', 
                    path: 'res.status', 
                    op: 'eq', 
                    value: 400 // Expect 400, but root is 200
                },
                target: { externalUrl: 'http://skip.com' }
            }];

            await nextCallRouter.runNextCalls(plan, rootCtx, {});

            expect(global.fetch).not.toHaveBeenCalled();
        });

        // --- TEST HISTORY CHAINING ---
        it('should use data from previous steps (history chaining)', async () => {
            // Giả lập history đã có 1 step trước đó
            rootCtx.history = [{
                res: { body: { token: 'abc-123' } }
            }];

            const plan = [{
                target: { externalUrl: 'http://api.com' },
                headers: { template: { Authorization: 'Bearer {{1.res.body.token}}' } } // Use history[0]
            }];

            global.fetch.mockResolvedValue({ status: 200, text: () => '{}' });

            await nextCallRouter.runNextCalls(plan, rootCtx, {});

            expect(global.fetch).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        authorization: 'Bearer abc-123' // Value replaced from history
                    })
                })
            );
        });
    });
});
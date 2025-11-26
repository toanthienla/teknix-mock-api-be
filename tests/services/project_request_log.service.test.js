// tests/services/project_request_log.service.test.js

const logSvc = require('../../src/services/project_request_log.service');
const wsNotify = require('../../src/centrifugo/centrifugo.service');

// --- MOCK DEPENDENCIES ---
jest.mock('../../src/centrifugo/centrifugo.service');
jest.mock('../../src/utils/wsTemplate', () => ({
    render: jest.fn((tpl) => tpl) // Mock render đơn giản trả về template
}));

describe('Project Request Log Service', () => {
    let mockPool;

    beforeEach(() => {
        jest.clearAllMocks();
        mockPool = { query: jest.fn() };
    });

    // ==========================================
    // 1. INSERT LOG & WS PUBLISH
    // ==========================================
    describe('insertLog', () => {
        it('should insert log and trigger WS publish if configured', async () => {
            const logData = {
                project_id: 1,
                endpoint_id: 10,
                request_method: 'GET',
                request_path: '/users',
                response_status_code: 200
            };

            // Mock 1: Resolve workspace/project name for path prefix
            mockPool.query.mockResolvedValueOnce({ 
                rows: [{ workspace_name: 'WS', project_name: 'PJ' }] 
            });

            // Mock 2: Insert Log -> Return ID 100
            mockPool.query.mockResolvedValueOnce({ rows: [{ id: 100 }] });

            // Mock 3: WS Config Lookup (Inside maybePublishWsOnLog)
            mockPool.query.mockResolvedValueOnce({
                rows: [{ 
                    project_id: 1, 
                    endpoint_id: 10,
                    ws_project_enabled: true, 
                    ws_config: { enabled: true } 
                }]
            });

            const logId = await logSvc.insertLog(mockPool, logData);

            expect(logId).toBe(100);
            
            // Verify Path Normalization (/users -> /WS/PJ/users)
            expect(mockPool.query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO project_request_logs'),
                expect.arrayContaining(['/WS/PJ/users'])
            );

            // Verify WS Publish called
            expect(wsNotify.publishToProjectChannel).toHaveBeenCalledWith(1, expect.any(Object));
        });

        it('should skip insert if no project/endpoint context provided (Logs Spam Prevention)', async () => {
            const logData = { request_method: 'GET' }; // Missing IDs
            const result = await logSvc.insertLog(mockPool, logData);
            
            expect(result).toBeNull();
            expect(mockPool.query).not.toHaveBeenCalled();
        });
    });

    // ==========================================
    // 2. LIST LOGS & FILTERING
    // ==========================================
    describe('listLogs', () => {
        it('should build correct SQL filters', async () => {
            const opts = {
                projectId: 1,
                method: 'POST',
                statusCode: 201,
                minLatency: 100,
                search: 'findMe'
            };

            // Mock return count and rows
            mockPool.query
                .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // Data query
                .mockResolvedValueOnce({ rows: [{ cnt: 1 }] }); // Count query

            await logSvc.listLogs(mockPool, opts);

            const sqlCall = mockPool.query.mock.calls[0][0];
            const params = mockPool.query.mock.calls[0][1];

            // Check SQL contains conditions
            expect(sqlCall).toContain('l.project_id = $1');
            expect(sqlCall).toContain('UPPER(l.request_method) = $3');
            expect(sqlCall).toContain('l.response_status_code = $2');
            expect(sqlCall).toContain('l.latency_ms >= $4');
            expect(sqlCall).toContain('l.request_method ILIKE $5'); // Search condition

            // Check Params
            expect(params).toEqual(expect.arrayContaining([1, 'POST', 201, 100, '%findMe%']));
        });
    });
});
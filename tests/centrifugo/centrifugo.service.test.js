// tests/centrifugo/centrifugo.service.test.js

const axios = require('axios');

// Setup env vars TRƯỚC khi require service vì service đọc env ngay khi load
process.env.CENTRIFUGO_HTTP = 'http://localhost:8000';
CENTRIFUGO_HTTP = process.env.CENTRIFUGO_HTTP;

process.env.CENTRIFUGO_API_KEY = 'mock-api-key';
CENTRIFUGO_API_KEY = process.env.CENTRIFUGO_API_KEY;

const centrifugoSvc = require('../../src/centrifugo/centrifugo.service');

// --- MOCK AXIOS ---
jest.mock('axios');

describe('Centrifugo Service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // ==========================================
    // 16.1 CORE PUBLISH
    // ==========================================
    describe('publish', () => {
        it('should call Centrifugo HTTP API with correct payload', async () => {
            const mockResponse = { result: {} };
            axios.post.mockResolvedValue({ data: mockResponse });

            const channel = 'news';
            const data = { text: 'hello' };

            await centrifugoSvc.publish(channel, data);

            expect(axios.post).toHaveBeenCalledWith(
                CENTRIFUGO_HTTP + '/api',
                {
                    method: 'publish',
                    params: { channel, data }
                },
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'Authorization': 'apikey mock-api-key',
                        'Content-Type': 'application/json'
                    })
                })
            );
        });

        it('should throw error if axios fails', async () => {
            const error = new Error('Network Error');
            axios.post.mockRejectedValue(error);

            await expect(centrifugoSvc.publish('chan', {})).rejects.toThrow('Network Error');
        });
    });

    // ==========================================
    // 16.2 HELPER FUNCTIONS
    // ==========================================
    describe('publishToProjectChannel', () => {
        it('should format channel as pj:{id}', async () => {
            axios.post.mockResolvedValue({ data: {} });
            
            await centrifugoSvc.publishToProjectChannel(123, { msg: 'hi' });

            expect(axios.post).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    params: expect.objectContaining({ channel: 'pj:123' })
                }),
                expect.any(Object)
            );
        });

        it('should throw if projectId missing', async () => {
            await expect(centrifugoSvc.publishToProjectChannel(null)).rejects.toThrow();
        });
    });

    describe('publishToEndpointChannel', () => {
        it('should format channel as pj:{pid}-ep-{eid}', async () => {
            axios.post.mockResolvedValue({ data: {} });

            await centrifugoSvc.publishToEndpointChannel(1, 10, {});

            expect(axios.post).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    params: expect.objectContaining({ channel: 'pj:1-ep-10' })
                }),
                expect.any(Object)
            );
        });

        it('should fallback to project channel if endpointId is missing', async () => {
            axios.post.mockResolvedValue({ data: {} });

            await centrifugoSvc.publishToEndpointChannel(1, null, {});

            expect(axios.post).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    params: expect.objectContaining({ channel: 'pj:1' })
                }),
                expect.any(Object)
            );
        });
    });
});
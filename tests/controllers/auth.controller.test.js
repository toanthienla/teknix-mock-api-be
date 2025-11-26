// tests/controllers/auth.controller.test.js

const authController = require('../../src/controllers/auth.controller');
const bcrypt = require('bcryptjs');
const jwtUtils = require('../../src/utils/jwt');

// --- MOCK DEPENDENCIES ---
jest.mock('bcryptjs');
jest.mock('../../src/utils/jwt');

describe('Auth Controller', () => {
    let req, res, mockDb;

    beforeEach(() => {
        // Reset mocks trước mỗi test case
        jest.clearAllMocks();

        // Mock Database Query function
        mockDb = {
            query: jest.fn()
        };

        // Mock Request object
        req = {
            body: {},
            cookies: {},
            db: { stateless: mockDb }, // Inject mock DB vào request
            user: {}
        };

        // Mock Response object
        res = {
            status: jest.fn().mockReturnThis(), // Cho phép chain: res.status().json()
            json: jest.fn(),
            cookie: jest.fn(),
            clearCookie: jest.fn()
        };
    });

    // ==========================================
    // TEST CASE: REGISTER
    // ==========================================
    describe('register', () => {
        it('should return 400 if username or password is missing', async () => {
            req.body = { username: 'testuser' }; // Thiếu password
            await authController.register(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith({ error: "Username and password required" });
        });

        it('should return 400 if password is less than 8 characters', async () => {
            req.body = { username: 'testuser', password: '123' };
            await authController.register(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith({ error: "Password must be at least 8 characters long" });
        });

        it('should return 400 if username already exists', async () => {
            req.body = { username: 'existingUser', password: 'password123' };
            // Mock DB trả về 1 dòng (user đã tồn tại)
            mockDb.query.mockResolvedValueOnce({ rows: [{ id: 1, username: 'existingUser' }] });

            await authController.register(req, res);

            expect(mockDb.query).toHaveBeenCalledWith(expect.stringContaining('SELECT'), ['existingUser']);
            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith({ error: "Username already exists" });
        });

        it('should register successfully and return tokens', async () => {
            req.body = { username: 'newUser', password: 'password123' };
            
            // Mock 1: Check user exist -> Trả về rỗng (chưa tồn tại)
            mockDb.query.mockResolvedValueOnce({ rows: [] });
            // Mock 2: Insert user -> Trả về user vừa tạo
            mockDb.query.mockResolvedValueOnce({ rows: [{ id: 10, username: 'newUser' }] });

            // Mock bcrypt & jwt
            bcrypt.hash.mockResolvedValue('hashed_password_123');
            jwtUtils.generateAccessToken.mockReturnValue('mock_access_token');
            jwtUtils.generateRefreshToken.mockReturnValue('mock_refresh_token');

            await authController.register(req, res);

            expect(bcrypt.hash).toHaveBeenCalledWith('password123', 10);
            expect(mockDb.query).toHaveBeenCalledTimes(2); // 1 select, 1 insert
            expect(res.cookie).toHaveBeenCalledTimes(2); // Access & Refresh cookies
            expect(res.status).toHaveBeenCalledWith(201);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: "Registration successful",
                user: { id: 10, username: 'newUser' }
            }));
        });

        it('should handle server errors during registration', async () => {
            req.body = { username: 'errorUser', password: 'password123' };
            mockDb.query.mockRejectedValue(new Error('DB Connection Failed'));

            await authController.register(req, res);

            expect(res.status).toHaveBeenCalledWith(500);
            expect(res.json).toHaveBeenCalledWith({ error: "Server error" });
        });
    });

    // ==========================================
    // TEST CASE: LOGIN
    // ==========================================
    describe('login', () => {
        it('should return 400 if credentials missing', async () => {
            req.body = { username: 'noPass' };
            await authController.login(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
        });

        it('should return 400 if user not found', async () => {
            req.body = { username: 'ghost', password: 'password123' };
            // Mock DB trả về rỗng
            mockDb.query.mockResolvedValue({ rows: [] });

            await authController.login(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith({ error: "Invalid credentials" });
        });

        it('should return 400 if password does not match', async () => {
            req.body = { username: 'validUser', password: 'wrongPassword' };
            // Mock DB tìm thấy user
            mockDb.query.mockResolvedValue({ 
                rows: [{ id: 1, username: 'validUser', password_hash: 'hashed_real_pass' }] 
            });
            // Mock bcrypt compare trả về false
            bcrypt.compare.mockResolvedValue(false);

            await authController.login(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith({ error: "Invalid credentials" });
        });

        it('should login successfully', async () => {
            req.body = { username: 'validUser', password: 'correctPassword' };
            mockDb.query.mockResolvedValue({ 
                rows: [{ id: 1, username: 'validUser', password_hash: 'hashed_real_pass' }] 
            });
            bcrypt.compare.mockResolvedValue(true);
            jwtUtils.generateAccessToken.mockReturnValue('access_token_123');
            
            await authController.login(req, res);

            expect(res.cookie).toHaveBeenCalledTimes(2);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
                message: "Login successful",
                token: 'access_token_123'
            }));
        });
    });

    // ==========================================
    // TEST CASE: REFRESH TOKEN
    // ==========================================
    describe('refreshToken', () => {
        it('should return 401 if no refresh token provided', async () => {
            req.cookies = {}; // Không có token
            await authController.refreshToken(req, res);
            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.json).toHaveBeenCalledWith({ error: "No refresh token" });
        });

        it('should return 401 if refresh token is invalid', async () => {
            req.cookies = { refresh_token: 'invalid_token' };
            jwtUtils.verifyRefreshToken.mockReturnValue(null); // Verify fail

            await authController.refreshToken(req, res);
            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.json).toHaveBeenCalledWith({ error: "Invalid refresh token" });
        });

        it('should refresh tokens successfully', async () => {
            req.cookies = { refresh_token: 'valid_token' };
            // Mock decode thành công
            jwtUtils.verifyRefreshToken.mockReturnValue({ user_id: 1 });
            jwtUtils.generateAccessToken.mockReturnValue('new_access');
            jwtUtils.generateRefreshToken.mockReturnValue('new_refresh');

            await authController.refreshToken(req, res);

            expect(res.cookie).toHaveBeenCalledWith('access_token', 'new_access', expect.any(Object));
            expect(res.json).toHaveBeenCalledWith({ message: "Token refreshed", newAccessToken: 'new_access' });
        });
    });

    // ==========================================
    // TEST CASE: LOGOUT
    // ==========================================
    describe('logout', () => {
        it('should clear cookies and return success', () => {
            authController.logout(req, res);
            expect(res.clearCookie).toHaveBeenCalledWith('access_token', expect.any(Object));
            expect(res.clearCookie).toHaveBeenCalledWith('refresh_token', expect.any(Object));
            expect(res.json).toHaveBeenCalledWith({ message: "Logged out" });
        });
    });

    // ==========================================
    // TEST CASE: GET CURRENT USER
    // ==========================================
    describe('getCurrentUser', () => {
        it('should return 401 if user_id is missing from request', async () => {
            req.user = {}; // Không có user_id do middleware chưa chạy hoặc lỗi
            await authController.getCurrentUser(req, res);
            expect(res.status).toHaveBeenCalledWith(401);
        });

        it('should return 500 if db connection is missing', async () => {
            req.user = { user_id: 1 };
            req.db = {}; // Thiếu stateless client
            await authController.getCurrentUser(req, res);
            expect(res.status).toHaveBeenCalledWith(500);
        });

        it('should return 404 if user not found in DB', async () => {
            req.user = { user_id: 999 };
            mockDb.query.mockResolvedValue({ rows: [] }); // Không tìm thấy

            await authController.getCurrentUser(req, res);
            expect(res.status).toHaveBeenCalledWith(404);
        });

        it('should return user info if found', async () => {
            req.user = { user_id: 1 };
            mockDb.query.mockResolvedValue({ rows: [{ username: 'foundUser' }] });

            await authController.getCurrentUser(req, res);
            expect(res.json).toHaveBeenCalledWith({ user_id: 1, username: 'foundUser' });
        });
    });
});
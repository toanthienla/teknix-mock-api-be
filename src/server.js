require('dotenv').config();
const app = require('./app');
const { checkConnections } = require('./config/db');

const PORT = process.env.PORT || 3000;

const startServer = async () => {
    try {
        // 1. Kiểm tra kết nối DB
        await checkConnections();
        
        // 2. Nếu thành công, khởi động server
        app.listen(PORT, () => {
            console.log();
            console.log(`http://localhost:${PORT}`);
        });
    } catch (error) {
        console.error('Không thể khởi động server, vui lòng kiểm tra kết nối DB.');
        process.exit(1);
    }
};

startServer();
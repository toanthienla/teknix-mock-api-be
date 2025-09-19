# teknix-mock-api-be

Mock API quản lý workspace → project → endpoint → endpoint_response và runtime giả lập API, kèm hệ thống lưu log request/response (PostgreSQL JSONB).

## 1) Yêu cầu hệ thống
- Node.js >= 18
- PostgreSQL >= 13
- Windows PowerShell (khuyến nghị) hoặc CMD

## 2) Cài đặt nhanh (Windows PowerShell)
1. Tạo file môi trường `.env` ở thư mục gốc (cùng cấp `package.json`):

```env
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=your_password
DB_NAME=teknix_mock_api
NODE_ENV=development
```

2. Cài dependency Node:

```powershell
npm install
```

3. Khởi động server ở chế độ dev (tự reload bằng nodemon):

```powershell
$env:NODE_ENV = "development"; npm run dev
```

4. Restart nhanh khi đang chạy nodemon: gõ `rs` rồi Enter trong terminal.

5. Chạy production (không tự reload):

```powershell
npm start
```

Server mặc định chạy tại http://localhost:3000

## 3) Cấu hình package.json (đã có sẵn)
```json
{
	"name": "texnik-mock_api",
	"version": "1.0.0",
	"description": "Simple API quản lý workspace và project",
	"main": "src/server.js",
	"scripts": {
		"start": "node src/server.js",
		"dev": "nodemon src/server.js",
		"test": "echo \"Error: no test specified\" && exit 1"
	},
	"dependencies": {
		"dotenv": "^17.2.2",
		"express": "^5.1.0",
		"pg": "^8.16.3",
		"path-to-regexp": "^6.3.0"
	},
	"devDependencies": {
		"nodemon": "^3.1.10"
	}
}
```

- Scripts dùng nhiều:
	- `npm run dev`: chạy dev bằng nodemon (auto-reload, hỗ trợ `rs` để restart nhanh)
	- `npm start`: chạy bình thường bằng node

## 4) Khởi tạo database (DDL mẫu)
Tối thiểu cần các bảng sau để chạy toàn bộ tính năng. Bạn có thể điều chỉnh tên schema/constraint cho phù hợp hệ thống hiện tại.

```sql
-- Workspaces
CREATE TABLE IF NOT EXISTS workspaces (
	id SERIAL PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	created_at TIMESTAMP DEFAULT NOW(),
	updated_at TIMESTAMP
);

-- Projects
CREATE TABLE IF NOT EXISTS projects (
	id SERIAL PRIMARY KEY,
	workspace_id INT REFERENCES workspaces(id),
	name TEXT NOT NULL,
	description TEXT,
	created_at TIMESTAMP DEFAULT NOW(),
	updated_at TIMESTAMP
);

-- Endpoints
CREATE TABLE IF NOT EXISTS endpoints (
	id SERIAL PRIMARY KEY,
	project_id INT REFERENCES projects(id),
	name TEXT NOT NULL,
	method TEXT NOT NULL,
	path TEXT NOT NULL,
	created_at TIMESTAMP DEFAULT NOW(),
	updated_at TIMESTAMP
);

-- Endpoint Responses
CREATE TABLE IF NOT EXISTS endpoint_responses (
	id SERIAL PRIMARY KEY,
	endpoint_id INT REFERENCES endpoints(id),
	name TEXT NOT NULL,
	status_code INT NOT NULL,
	response_body JSONB DEFAULT '{}'::jsonb,
	condition JSONB DEFAULT '{}'::jsonb,
	priority INT,
	is_default BOOLEAN DEFAULT FALSE,
	delay_ms INT DEFAULT 0,
	created_at TIMESTAMP DEFAULT NOW(),
	updated_at TIMESTAMP
);

-- Project Request Logs (JSONB)
CREATE TABLE IF NOT EXISTS project_request_logs (
	id SERIAL PRIMARY KEY,
	project_id INTEGER REFERENCES projects(id),
	endpoint_id INTEGER REFERENCES endpoints(id),
	endpoint_response_id INTEGER REFERENCES endpoint_responses(id),
	request_method VARCHAR(255),
	request_path TEXT,
	request_headers JSONB,
	request_body JSONB,
	response_status_code INTEGER,
	response_body JSONB,
	ip_address VARCHAR(45),
	latency_ms INTEGER,
	created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

Ghi chú:
- Các cột JSONB (headers/body) dùng kiểu JSONB để query/filter hiệu quả.
- Không dùng ON DELETE CASCADE cho log: khi xoá dữ liệu chính, app sẽ tự `SET NULL` các FK trong log để GIỮ lịch sử log.

## 5) API chính (tóm tắt)
- Workspaces: `GET /workspaces`, `GET /workspaces/:id`, `POST /workspaces`, `PUT /workspaces/:id`, `DELETE /workspaces/:id`
- Projects: `GET /projects`, `GET /projects/:id`, `POST /projects`, `PUT /projects/:id`, `DELETE /projects/:id`
- Endpoints: `GET /endpoints`, `GET /endpoints/:id`, `POST /endpoints`, `PUT /endpoints/:id`, `DELETE /endpoints/:id`
- Endpoint responses:
	- `GET /endpoint_responses?endpoint_id=...`
	- `GET /endpoint_responses/:id`
	- `POST /endpoint_responses`
	- `PUT /endpoint_responses/:id`
	- `PUT /endpoint_responses/:id/set_default`
	- `PUT /endpoint_responses/priority` (payload là MẢNG item)
	- `DELETE /endpoint_responses/:id`
- Mock runtime: định tuyến động dựa theo endpoints + endpoint_responses, render response_body + delay

## 6) Hệ thống ghi log (project_request_logs)
Khi nào ghi log?
- Mock runtime: mọi request thực tế đến endpoint mock (bao gồm latency, response chọn)
- Admin (endpoint_responses):
	- `PUT /endpoint_responses/priority`: nếu response là mảng → ghi N dòng (mỗi phần tử 1 dòng)
	- Trường hợp payload sai định dạng (400) vẫn ghi log để truy vết
	- `PUT /endpoint_responses/:id/set_default`: có log (qua middleware)
- Delete hành động: theo yêu cầu hiện tại
	- KHÔNG ghi log khi xoá endpoint, project, workspace
	- Xoá endpoint_response: cho phép ghi 1 dòng log xoá (endpoint_response_id=null) — có thể tắt nếu bạn cần

Khi nào KHÔNG ghi log (mặc định)?
- `GET /endpoint_responses` và `GET /endpoint_responses/:id` (tránh phình log quản trị)
- `PUT /endpoint_responses/priority` đã bỏ qua ở middleware để tránh TRÙNG vì controller ghi chi tiết
- Có thể cưỡng bức ghi log GET bằng header `x-force-log: 1`

Xử lý khoá ngoại khi xoá (giữ lịch sử log, không sửa schema):
- Xoá endpoint_response: `SET endpoint_response_id = NULL` cho các log đang tham chiếu
- Xoá endpoint: `SET endpoint_id = NULL` và `SET endpoint_response_id = NULL` cho các log thuộc endpoint
- Xoá project: `SET project_id = NULL`, `SET endpoint_id = NULL`, `SET endpoint_response_id = NULL` cho các log thuộc project
- Xoá workspace: `SET project_id/endpoint_id/endpoint_response_id = NULL` cho toàn bộ cây dữ liệu thuộc workspace

## 7) Ví dụ Postman
- Cập nhật priority (mảng item):

```json
[
	{ "id": 11, "endpoint_id": 13, "priority": 100 },
	{ "id": 12, "endpoint_id": 13, "priority": 90 }
]
```

Sai định dạng (ví dụ) sẽ trả 400 và vẫn ghi log:

```json
{ "endpoint_id": 13, "ordered_ids": [12, 11] }
```

## 8) Khắc phục sự cố (Troubleshooting)
- Lỗi Postgres: `invalid input syntax for type json`
	- App đã stringify an toàn trước khi insert JSONB. Đảm bảo các cột là JSONB.
- Không thấy log cho priority:
	- Payload phải là MẢNG item có đủ `id, endpoint_id, priority`.
- Bị log trùng cho priority:
	- Middleware đã bỏ qua `/endpoint_responses/priority`; controller ghi 1 dòng/item.
- Restart nhanh server: trong terminal nodemon gõ `rs`.

## 9) Cấu hình DB kết nối
File `src/config/db.js` đọc .env qua dotenv. Mặc định:

```js
const pool = new Pool({
	host: process.env.DB_HOST || 'localhost',
	port: process.env.DB_PORT || 5432,
	user: process.env.DB_USER || 'postgres',
	password: process.env.DB_PASSWORD || '190804',
	database: process.env.DB_NAME || 'teknix_mock_api',
});
```

Thay đổi trong `.env` để trỏ tới DB của bạn.

---

Gợi ý: Nếu bạn triển khai trên môi trường khác (Linux/Mac), chỉ cần điều chỉnh lệnh thiết lập biến môi trường tương ứng shell. Các phần còn lại giữ nguyên.
# API

Base URL local: `http://localhost:4000`. Định dạng phản hồi và mã lỗi: xem `ARCHITECTURE.md`.

## Health

| Method | Path | Mô tả |
|---|---|---|
| GET | `/health` | Tiến trình đang chạy. `200 { "status": "ok" }` |
| GET | `/health/ready` | DB truy cập được. `200` hoặc `503 { "status": "error", "checks": { "database": "unavailable" } }` |

## Quản trị — xác thực

Frontend gọi với `credentials: 'include'`. Cookie phiên do server đặt; frontend không đọc hay lưu token.

### POST `/api/admin/auth/login`

Body: `{ "email": "owner@shop.vn", "password": "…" }`

- `200` → `{ "data": { "admin": { "id", "email", "displayName" }, "expiresAt": "ISO-8601" } }` + `Set-Cookie: dtt_admin_session=…`
- `400 VALIDATION_ERROR` → `details: [{ "field": "email", "message": "Email không hợp lệ." }]`
- `401 UNAUTHENTICATED` → "Email hoặc mật khẩu không đúng." (giống nhau cho mọi lý do)
- `403 FORBIDDEN` → Origin không nằm trong `CORS_ORIGINS`
- `429 RATE_LIMITED` → quá 10 lần/15 phút từ một IP

### POST `/api/admin/auth/logout`

Thu hồi phiên hiện tại, xóa cookie. Luôn `204`, kể cả khi đã đăng xuất.

### GET `/api/admin/auth/me`

- `200` → `{ "data": { "admin": { "id", "email", "displayName" } } }`
- `401 UNAUTHENTICATED` → chưa đăng nhập, hết hạn, bị thu hồi hoặc tài khoản bị khóa

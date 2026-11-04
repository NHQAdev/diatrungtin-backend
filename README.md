# diatrungtin-backend

Backend MVP cho website Trầm Hương Địa Trung Tín. Node.js 22 + TypeScript, Fastify, PostgreSQL, Kysely.

Tài liệu: [quyết định nghiệp vụ](docs/DECISIONS.md) · [kiến trúc](docs/ARCHITECTURE.md) · [API](docs/API.md) · [tiến độ](docs/PROGRESS.md)

## Chạy local

Cần Node.js ≥ 22.12 và PostgreSQL ≥ 16.

```bash
# 1. Tạo database (ví dụ với psql)
createuser -P dtt                 # đặt mật khẩu cho user dtt
createdb -O dtt dtt_dev
createdb -O dtt dtt_test

# 2. Cấu hình
cp .env.example .env              # sửa DATABASE_URL, TEST_DATABASE_URL

# 3. Cài đặt và migrate
npm install
npm run db:migrate
npm run db:seed                   # danh mục, tag và 2 sản phẩm [Mẫu] để thử

# 4. Tạo tài khoản quản trị (sẽ hỏi mật khẩu, tối thiểu 12 ký tự)
npm run admin -- create --email owner@example.com --name "Chủ cửa hàng"

# 5. Chạy
npm run dev                       # http://localhost:4000/health
```

Có Docker thì có thể thay bước 1 bằng:

```bash
docker run -d --name dtt-postgres -e POSTGRES_USER=dtt -e POSTGRES_PASSWORD=change_me \
  -e POSTGRES_DB=dtt_dev -p 5432:5432 postgres:16
docker exec dtt-postgres createdb -U dtt dtt_test
```

## Sau khi chạy lần đầu

1. Đăng nhập admin, đặt phí giao hàng (bắt buộc trước khi khách đặt được hàng):
   `PUT /api/admin/store-settings` với `{ "shippingFee": 30000, "freeShippingThreshold": null }` (con số ví dụ; điền theo chính sách thật).
2. Khi chưa cấu hình SMTP, email (xác nhận đơn, đặt lại mật khẩu…) được in ra log của `npm run dev`.
3. Ảnh upload được lưu trong thư mục `uploads/` (đã nằm trong `.gitignore`).

Danh sách API đầy đủ: [docs/API.md](docs/API.md).

## Kiểm tra

```bash
npm run typecheck
npm test          # dùng TEST_DATABASE_URL; schema của DB test bị xóa và tạo lại mỗi lần chạy
```

## Quản lý tài khoản quản trị

```bash
npm run admin -- create --email a@b.vn --name "Tên"
npm run admin -- reset-password --email a@b.vn   # thu hồi mọi phiên cũ
npm run admin -- disable --email a@b.vn          # khóa và thu hồi mọi phiên
```

Tự động hóa (CI, lần triển khai đầu): đặt `ADMIN_PASSWORD` trong môi trường thay vì nhập tay. Không ghi mật khẩu vào file hay lịch sử shell.

## Triển khai

Lên VPS bằng Docker Compose (PostgreSQL + API + Caddy HTTPS), kèm sao lưu/khôi phục: xem [docs/DEPLOY.md](docs/DEPLOY.md).

Không dùng Docker: `npm ci && npm run build && npm run db:migrate:prod && npm start` (tạo admin: `npm run admin:prod -- create …`), với `NODE_ENV=production`. Không chạy `db:seed` trên production.

# Kiến trúc backend

## Stack

| Thành phần | Lựa chọn | Lý do |
|---|---|---|
| Runtime | Node.js 22 LTS, TypeScript (ESM) | Một ngôn ngữ với frontend, hỗ trợ dài hạn. |
| HTTP | Fastify 5 | Nhẹ, nhanh, logging pino có sẵn, hệ plugin rõ ràng. |
| Database | PostgreSQL 16 | Transaction nhiều SKU, khóa dòng, `UPDATE … WHERE stock >= n`, ràng buộc unique cho idempotency. |
| Truy vấn | Kysely + `pg` | SQL rõ ràng, có kiểu dữ liệu, không sinh mã ẩn. |
| Migration | File `.sql` thuần trong `db/migrations`, chạy bằng `scripts/migrate.ts` | Dễ đọc và review; có advisory lock và checksum. |
| Validation | Zod (biến môi trường và request) | Một nguồn quy tắc, lỗi theo từng trường. |
| Kiểm thử | Vitest + PostgreSQL thật | Transaction và tranh chấp tồn kho chỉ kiểm chứng được trên DB thật. |
| Mật khẩu | scrypt (`node:crypto`) | Không phụ thuộc thư viện native. |

## Cấu trúc thư mục

```
db/migrations/        SQL migrations, đặt tên NNNN_mo_ta.sql, không sửa file đã áp dụng
scripts/              migrate.ts, admin.ts (tạo/đổi mật khẩu/khóa admin)
src/
  config/env.ts       đọc và kiểm tra biến môi trường
  db/                 client Kysely, kiểu bảng, migrator
  lib/                errors, password, tokens
  modules/<module>/   routes + service theo từng nghiệp vụ
  app.ts              lắp plugin, error handler, route
  server.ts           khởi động, tắt an toàn
tests/                test tích hợp chạy trên DB test
docs/                 tài liệu
```

## Quy ước API

- Prefix: `/api/admin/*` cho quản trị (cookie phiên), `/api/*` cho khách.
- Thành công: `{ "data": … }`. Lỗi: `{ "error": { "code", "message", "details?" } }`. `message` tiếng Việt để hiển thị.
- Mã lỗi: `VALIDATION_ERROR` 400, `BAD_REQUEST` 400, `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409, `RATE_LIMITED` 429, `INTERNAL_ERROR` 500.
- Lỗi 5xx không trả chi tiết nội bộ; chi tiết chỉ ghi vào log.

## Xác thực quản trị

- Token phiên ngẫu nhiên 256 bit, gửi trong cookie `dtt_admin_session` (HttpOnly, SameSite=Strict, Secure ở production, Path=/api/admin).
- DB chỉ lưu SHA-256 của token. Đăng xuất hoặc khóa tài khoản có hiệu lực ngay.
- Request thay đổi dữ liệu vào `/api/admin` từ Origin lạ bị chặn (403).
- Đăng nhập giới hạn 10 lần/15 phút/IP; lỗi đăng nhập trả cùng một thông báo cho email sai và mật khẩu sai.
- Không có đăng ký admin qua API, không có mật khẩu mặc định: tạo bằng `npm run admin -- create`.
- Đăng nhập, đăng nhập lỗi, đăng xuất và thao tác CLI được ghi vào `audit_logs`.

## Module

| Thư mục `src/modules/` | Vai trò |
|---|---|
| `admin-auth` | Đăng nhập quản trị, `requireAdmin` |
| `customer-auth` | Tài khoản khách, phiên, `getOptionalCustomer`, `priceTierFor` |
| `catalog` | Danh mục, bộ sưu tập, tag, sản phẩm, variant, tồn kho; `pricing.ts` là nơi duy nhất quyết định giá |
| `orders` | `cart-pricing.ts` (báo giá), `orders.service.ts` (tạo đơn, hủy, hoàn tồn), `order-state.ts` (bảng chuyển trạng thái) |
| `admin-customers` | Duyệt doanh nghiệp, khóa tài khoản |
| `store` | Thông tin cửa hàng, phí giao hàng, trang nội dung, dashboard |
| `uploads` | Upload và phục vụ ảnh |
| `email` | Outbox + vòng gửi nền + mẫu email |
| `audit`, `health` | Nhật ký thao tác, health check |

## Các quyết định kỹ thuật quan trọng

- **Giá:** frontend không bao giờ gửi giá. `catalog/pricing.ts` chọn giá lẻ hay business (`priceTierFor`: chỉ tài khoản doanh nghiệp đã duyệt). Báo giá và tạo đơn dùng chung `orders/cart-pricing.ts`.
- **Tạo đơn:** một transaction: giữ Idempotency-Key (khóa chính `(scope, key)` khiến request trùng phải chờ) → `SELECT … FOR UPDATE` các variant theo thứ tự id → kiểm tra tồn, tính tiền, so với `expectedTotal` → trừ tồn + ghi `inventory_movements` → ghi đơn, dòng hàng (snapshot), sự kiện, email outbox. Lỗi ở bất kỳ bước nào → không có gì thay đổi.
- **Hoàn tồn đúng 1 lần:** `UPDATE orders SET stock_restored_at = now() WHERE stock_restored_at IS NULL`; chỉ khi câu lệnh này cập nhật được dòng thì mới cộng tồn.
- **Trạng thái:** 3 cột riêng (đơn, thanh toán, giao hàng); mọi chuyển đổi đi qua bảng `TRANSITIONS` trong `order-state.ts`; đơn bị khóa `FOR UPDATE` khi xử lý.
- **Email:** ghi vào `email_outbox` trong cùng transaction; vòng nền gửi mỗi 15 giây, thử lại tối đa 5 lần (`FOR UPDATE SKIP LOCKED` nên chạy nhiều server vẫn an toàn).
- **Tiền:** `bigint` VNĐ trong DB, đọc ra `number` (kiểm tra an toàn số nguyên).
- **Ảnh:** lưu đĩa (`UPLOAD_DIR`), nhận diện loại file bằng byte đầu, tên ngẫu nhiên.
- **Line ending:** `.gitattributes` giữ LF; migrator chuẩn hóa CRLF → LF trước khi tính checksum.

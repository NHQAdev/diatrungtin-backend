# Tiến độ

Cập nhật: 2026-11-04.

## Đã làm

- Khung dự án, cấu hình môi trường có kiểm tra, `.env.example`.
- Migration `0001_admin_auth.sql` và migrator SQL (advisory lock, checksum).
- Health check, error handler thống nhất, logging có che cookie/authorization.
- Đăng nhập/đăng xuất/`me` cho admin; CLI tạo, đổi mật khẩu, khóa admin; audit log.
- Test tích hợp cho xác thực quản trị, test đơn vị cho mật khẩu/token.

## Đã kiểm tra thực tế

- Migration 0001 chạy trên PostgreSQL 16.15; đã thử các ràng buộc: email trùng, email chưa chuẩn hóa, token hash sai độ dài, token trùng → đều bị từ chối.
- Băm/kiểm tra mật khẩu và sinh token: 2/2 test qua bằng `node --test` trên Node 22.

## Chưa kiểm tra được (bị chặn)

- `npm install`, `typecheck`, `npm test`, chạy server: môi trường phát triển hiện chặn `registry.npmjs.org`. Mọi file TypeScript dùng Fastify/Kysely/pg **chưa được biên dịch hay chạy**. Phiên bản thư viện trong `package.json` chưa được xác minh với registry.

## Tiếp theo

1. Mở quyền npm → cài đặt → typecheck → chạy toàn bộ test → sửa lỗi.
2. Module danh mục/bộ sưu tập/sản phẩm/phiên bản (có giá và giới hạn "thêm hạt" theo D2).
3. Checkout khách vãng lai (SĐT + email bắt buộc), đơn hàng COD, tồn kho, idempotency, test đặt hàng đồng thời.
4. Ghi nhận thu tiền COD, giao hàng, cấu hình cửa hàng.

## Ghi chú môi trường

- Thay đổi quyền mạng (npm) chỉ áp dụng cho phiên làm việc mới; phiên hiện tại vẫn bị chặn.

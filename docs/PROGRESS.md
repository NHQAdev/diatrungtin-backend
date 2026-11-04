# Tiến độ

Cập nhật: 2026-11-04.

## Đã có code (backend MVP đầy đủ module)

| Module | Nội dung |
|---|---|
| Nền tảng | Cấu hình môi trường có kiểm tra, migration SQL (checksum chịu được CRLF/LF), health check, lỗi thống nhất, log che cookie, chặn Origin lạ |
| Xác thực quản trị | Đăng nhập/đăng xuất cookie, CLI tạo/đổi mật khẩu/khóa admin, audit log |
| Catalog | Danh mục (cây), bộ sưu tập, tag đối tượng/nhu cầu, sản phẩm, ảnh, thông số, variant/SKU, giá lẻ + giá business, thêm hạt, tồn kho + lịch sử, upload ảnh |
| Tài khoản khách | Đăng ký cá nhân/doanh nghiệp, đăng nhập, quên/đặt lại mật khẩu, đổi mật khẩu, hồ sơ, nâng cấp doanh nghiệp; admin duyệt/từ chối, khóa tài khoản |
| Checkout & đơn hàng | Báo giá server-side theo loại khách, tạo đơn trong 1 transaction (khóa variant, trừ tồn, snapshot), idempotency, kiểm tra tổng tiền khách đã xem, khách vãng lai (SĐT + email), tra cứu, hủy bằng link bí mật hoặc tài khoản |
| Xử lý đơn (admin) | Danh sách/lọc, chi tiết + lịch sử, máy trạng thái 3 lớp, hoàn tồn đúng 1 lần, COD ghi nhận thu tiền riêng |
| Email | Outbox trong DB + vòng gửi nền (SMTP hoặc ghi log khi dev): xác nhận đơn, cập nhật đơn, đặt lại mật khẩu, kết quả duyệt doanh nghiệp |
| Cửa hàng | Thông tin cửa hàng, phí giao hàng đồng giá + ngưỡng miễn phí, trang nội dung/chính sách, dashboard admin |
| Seed | Danh mục, bộ sưu tập, tag và 2 sản phẩm **[Mẫu]** |

## Bổ sung ngày 2026-11-05

- Tìm kiếm không dấu (migration `0006_search.sql`, hàm `vn_unaccent`, cột `products.search_text` do PostgreSQL tự cập nhật); áp dụng cho tìm sản phẩm, tìm đơn theo tên, tìm khách.
- Admin sửa thông tin nhận hàng của đơn (bắt buộc lý do, lưu cũ → mới trong lịch sử).
- Admin xem email gửi lỗi và gửi lại.
- Tác vụ dọn dữ liệu cũ mỗi 6 giờ (phiên, token, khóa chống lặp, email đã gửi).
- Lệnh production `db:migrate:prod`, `admin:prod`; `Dockerfile`; `deploy/` (Compose + Caddy, `backup.sh`, `restore.sh`, `.env.example`); [DEPLOY.md](DEPLOY.md).
- Seed: thông tin cửa hàng và 6 trang chính sách **tạm** (ghi [Cập nhật]), phí giao hàng tạm cho môi trường dev.

## Đã kiểm tra

- **92/92 test qua** trên PostgreSQL 16 thật, dùng `nodemailer` và `@fastify/multipart` thật (lấy từ `node_modules` của máy dev), chạy bằng Node 22 + lớp tương thích vitest trên `node:test`.
- Test có tác dụng: bỏ `FOR UPDATE` → test tranh chấp fail; bỏ điều kiện hoàn tồn 1 lần → test hủy lặp fail.
- `tsc --noEmit` toàn dự án: 0 lỗi. `npm run build` → chạy từ `dist/`: migrate (2 lần, lần 2 không làm gì), tạo admin, khởi động server ở `NODE_ENV=production`, `/health/ready` ok, cookie có `Secure`.
- `docker compose config` hợp lệ; cú pháp `backup.sh`/`restore.sh` hợp lệ.

## Chưa kiểm tra

- Chưa build Docker image và chưa chạy stack Compose (môi trường kiểm tra không có Docker daemon). Lần đầu triển khai cần chạy thử theo DEPLOY.md.
- Chưa gửi email qua SMTP thật.
- Chưa chạy `npm test` bằng vitest thật trên máy dev.

## Ngoài phạm vi / backlog

Chuyển khoản & cổng thanh toán online, voucher, review, wishlist, blog, tích hợp hãng vận chuyển, tìm kiếm không dấu (`unaccent`), sổ địa chỉ khách, phân quyền nhiều cấp cho nhân viên, lưu ảnh trên S3/R2, email HTML.

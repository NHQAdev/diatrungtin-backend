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

## Đã kiểm tra (2026-11-05)

- **81/81 test tích hợp qua** trên PostgreSQL 16 thật (`tests/*.test.ts`): xác thực admin, phân quyền admin, catalog (lọc, ẩn, validation, tồn kho), tài khoản khách (đăng ký, giá business chỉ sau khi duyệt, đặt lại mật khẩu dùng 1 lần), báo giá, tạo đơn, idempotency, 5 khách tranh món cuối, 2 đơn ngược thứ tự không deadlock, hủy lặp chỉ hoàn tồn 1 lần, máy trạng thái COD, quyền xem đơn, email outbox, migrator CRLF/LF.
- Kiểm chứng test có tác dụng: bỏ `FOR UPDATE` → test tranh chấp fail; bỏ điều kiện `stock_restored_at IS NULL` → test hủy lặp fail.
- Cách chạy lúc kiểm tra: Node 22 tự dịch TypeScript + lớp tương thích vitest trên `node:test` (môi trường kiểm tra không có npm). Trên máy dev, chạy bằng `npm test` (vitest thật).
- `tsc --noEmit`: không lỗi ngoài "không tìm thấy module" của `nodemailer`, `@fastify/multipart` (hết sau `npm install`).

## Chưa kiểm tra

- Upload ảnh (`POST /api/admin/uploads`) và gửi email qua SMTP thật: cần `@fastify/multipart`/`nodemailer` đã cài và một SMTP thử nghiệm.
- Chưa chạy `npm test` bằng vitest thật trên máy dev.

## Ngoài phạm vi / backlog

Chuyển khoản & cổng thanh toán online, voucher, review, wishlist, blog, tích hợp hãng vận chuyển, tìm kiếm không dấu (`unaccent`), sổ địa chỉ khách, phân quyền nhiều cấp cho nhân viên, lưu ảnh trên S3/R2, email HTML.

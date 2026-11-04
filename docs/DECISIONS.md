# Quyết định nghiệp vụ và giả định — Backend MVP

Cập nhật: 2026-11-04. Nguồn: bản "Phân tích BA sơ bộ — Trầm Hương Địa Trung Tín" và trao đổi sau đó.

## Đã xác nhận

| # | Quyết định | Ảnh hưởng tới backend |
|---|---|---|
| D1 | Làm lại từ đầu. Hai repo cũ `diatrungtin.api`, `DiaTrungTin-FE` giữ nguyên để đối chiếu, không tái sử dụng module. | Backend mới ở `C:\repos\diatrungtin-backend`. |
| D2 | Vòng tay có số hạt tiêu chuẩn; cổ tay lớn thì thêm hạt, khách được chọn "thêm hạt". Giá mỗi hạt và số hạt thêm tối đa cấu hình theo từng phiên bản. Bản đầu không theo dõi tồn kho hạt lẻ. | SKU theo đường kính hạt. Phiên bản có `extra_bead_price` và `max_extra_beads`; dòng đơn lưu số hạt thêm và giá mỗi hạt tại thời điểm đặt. Server kiểm tra 0 ≤ số hạt ≤ tối đa. |
| D3 | Ngoài phạm vi bản đầu: B2B/giá sỉ, voucher, review, wishlist, blog, cổng thanh toán online, tích hợp vận chuyển tự động. | Không có bảng hay API cho các phần này. |
| D4 | Quy tắc thương mại bắt buộc: SKU duy nhất; tiền VNĐ số nguyên; server tự tính tiền; tạo đơn nguyên tử; không bán vượt tồn; idempotency có ràng buộc DB, cùng khóa khác nội dung bị từ chối; hủy và hoàn tồn đúng một lần; tách trạng thái đơn/thanh toán/giao hàng; "đã giao" không đồng nghĩa "đã nhận tiền"; không có API công khai tự đánh dấu đã thanh toán; lỗi gửi email không làm mất đơn. | Áp dụng khi làm module catalog và order. |
| D5 | Cho phép đặt hàng không cần tài khoản (khách vãng lai). Bắt buộc có **số điện thoại và email**. | Đơn không bắt buộc gắn tài khoản; lưu SĐT và email người đặt. Email dùng để gửi xác nhận đơn. |
| D6 | Thanh toán bản đầu: **chỉ COD**. | Đơn tạo ra ở trạng thái thanh toán `unpaid`; admin ghi nhận đã thu tiền sau khi giao. Không có API công khai đổi trạng thái thanh toán. Chuyển khoản để sau. |

## Đang chờ trả lời (không coi là đã duyệt)

| # | Câu hỏi | Đề xuất | Chặn phần nào |
|---|---|---|---|
| Q4 | Bản đầu có cần tài khoản khách hàng (đăng ký, xem lịch sử đơn) không, hay chỉ khách vãng lai? | Chỉ khách vãng lai. Tra cứu đơn bằng mã đơn + SĐT hoặc email; hủy đơn (khi còn chờ xác nhận) qua liên kết bí mật trong email xác nhận. | API khách, module tài khoản |

## Giả định đang dùng

- Một cửa hàng, một kho, bán lẻ trong nước, giá VNĐ đã gồm thuế.
- Chỉ một vai trò quản trị (`admin`) ở bản đầu; phân quyền chi tiết theo nhân viên để backlog.
- Thông tin doanh nghiệp, chính sách, phí giao hàng cụ thể: **[Cập nhật]**.

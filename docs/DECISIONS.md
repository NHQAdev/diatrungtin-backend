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
| D7 | Có tài khoản khách hàng, gồm hai loại: **khách cá nhân** và **khách business**. Khách vãng lai vẫn đặt được hàng (D5). | Bảng tài khoản khách riêng với admin, có trường loại tài khoản; đơn hàng gắn tài khoản nếu khách đăng nhập. Phần khác biệt của khách business chờ Q5–Q6. |

## Đang chờ trả lời (không coi là đã duyệt)

| # | Câu hỏi | Đề xuất | Chặn phần nào |
|---|---|---|---|
| Q5 | Khách business khác khách cá nhân ở điểm nào: chỉ thông tin xuất hóa đơn (tên công ty, MST), hay có giá sỉ/chiết khấu riêng? | Bản đầu: chỉ thông tin hóa đơn, giá như khách cá nhân. Giá sỉ để giai đoạn sau (đang nằm trong D3). | Model tài khoản, tính giá |
| Q6 | Tài khoản business có cần admin duyệt trước khi dùng không? | Không cần nếu chỉ khác thông tin hóa đơn; cần duyệt nếu có giá riêng. | Luồng đăng ký, API admin |

## Giả định đang dùng

- Một cửa hàng, một kho, bán lẻ trong nước, giá VNĐ đã gồm thuế.
- Chỉ một vai trò quản trị (`admin`) ở bản đầu; phân quyền chi tiết theo nhân viên để backlog.
- Thông tin doanh nghiệp, chính sách, phí giao hàng cụ thể: **[Cập nhật]**.

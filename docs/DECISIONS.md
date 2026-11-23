# Quyết định nghiệp vụ và giả định — Backend MVP

Cập nhật: 2026-11-04. Nguồn: bản "Phân tích BA sơ bộ — Trầm Hương Địa Trung Tín" và trao đổi sau đó.

## Đã xác nhận

| # | Quyết định | Ảnh hưởng tới backend |
|---|---|---|
| D1 | Làm lại từ đầu. Hai repo cũ `diatrungtin.api`, `DiaTrungTin-FE` giữ nguyên để đối chiếu, không tái sử dụng module. | Backend mới ở `C:\repos\diatrungtin-backend`. |
| D2 | Vòng tay có số hạt tiêu chuẩn; cổ tay lớn thì thêm hạt, khách được chọn "thêm hạt". Giá mỗi hạt và số hạt thêm tối đa cấu hình theo từng phiên bản. Bản đầu không theo dõi tồn kho hạt lẻ. | SKU theo đường kính hạt. Phiên bản có `extra_bead_price` và `max_extra_beads`; dòng đơn lưu số hạt thêm và giá mỗi hạt tại thời điểm đặt. Server kiểm tra 0 ≤ số hạt ≤ tối đa. |
| D3 | Ngoài phạm vi bản đầu: voucher, review, wishlist, blog, cổng thanh toán online, tích hợp vận chuyển tự động. (Giá business đã chuyển vào phạm vi, xem D8.) | Không có bảng hay API cho các phần này. |
| D4 | Quy tắc thương mại bắt buộc: SKU duy nhất; tiền VNĐ số nguyên; server tự tính tiền; tạo đơn nguyên tử; không bán vượt tồn; idempotency có ràng buộc DB, cùng khóa khác nội dung bị từ chối; hủy và hoàn tồn đúng một lần; tách trạng thái đơn/thanh toán/giao hàng; "đã giao" không đồng nghĩa "đã nhận tiền"; không có API công khai tự đánh dấu đã thanh toán; lỗi gửi email không làm mất đơn. | Áp dụng khi làm module catalog và order. |
| D5 | Cho phép đặt hàng không cần tài khoản (khách vãng lai). Bắt buộc có **số điện thoại và email**. | Đơn không bắt buộc gắn tài khoản; lưu SĐT và email người đặt. Email dùng để gửi xác nhận đơn. |
| D6 | Thanh toán bản đầu: **chỉ COD**. | Đơn tạo ra ở trạng thái thanh toán `unpaid`; admin ghi nhận đã thu tiền sau khi giao. Không có API công khai đổi trạng thái thanh toán. Chuyển khoản để sau. |
| D7 | Có tài khoản khách hàng, gồm hai loại: **khách cá nhân** và **khách business**. Khách vãng lai vẫn đặt được hàng (D5). | Bảng tài khoản khách riêng với admin, có trường loại tài khoản; đơn hàng gắn tài khoản nếu khách đăng nhập. |
| D8 | Khách business có **thông tin xuất hóa đơn** (tên công ty, mã số thuế, địa chỉ xuất hóa đơn) và **giá sỉ hoặc chiết khấu riêng** theo bảng giá loại khách. | Thêm bảng giá theo loại khách. Backend tự xác định giá theo tài khoản đang đăng nhập; frontend không gửi loại giá. Dòng đơn lưu loại giá đã áp dụng. Đơn lưu bản chụp thông tin xuất hóa đơn tại thời điểm đặt. |
| D9 | Tài khoản business phải được **admin duyệt** (kiểm tra mã số thuế) trước khi được áp giá business. | Trạng thái duyệt: chờ duyệt / đã duyệt / từ chối, có ghi người duyệt, thời điểm, lý do. Giá business chỉ áp dụng khi đã duyệt; mọi thao tác duyệt ghi audit log. |
| D10 | Có bước **xác minh email bằng mã OTP khi đăng ký** tài khoản khách (cá nhân và business). (Xác nhận 05/11/2026.) | Đã làm (migration 0007): mã 6 số, hiệu lực 10 phút, sai tối đa 5 lần, gửi lại sau 60 giây, tối đa 5 mã/giờ; chỉ lưu hash. Tài khoản tạo trước tính năng được coi là đã xác minh. **Giả định:** khách chưa xác minh vẫn đăng nhập và mua hàng được; trang tài khoản nhắc xác minh. Chưa chặn admin duyệt business khi email chưa xác minh. |

## Đề xuất chờ xác nhận (không coi là đã duyệt)

| # | Câu hỏi | Đề xuất | Chặn phần nào |
|---|---|---|---|
| Q7 | Bảng giá business có dạng nào: giá riêng cho từng phiên bản, hay % chiết khấu (toàn cửa hàng / theo danh mục)? | Giá business riêng cho từng phiên bản (không bắt buộc); phiên bản không có giá business thì dùng giá lẻ. Giá "thêm hạt" cũng có thể có bản business. | Model phiên bản, tính giá |
| Q8 | Khi tài khoản business đang chờ duyệt hoặc bị từ chối: có được mua không? | Vẫn mua được với giá lẻ; giao diện báo rõ "chưa được áp giá business". | Checkout, tính giá |
| Q9 | Khi admin thu hồi duyệt hoặc đổi giá business, đơn đang trong giỏ thì sao? | Giá tính lại ở báo giá và lúc tạo đơn (D4); nếu khác giá khách đã xem thì trả kết quả để khách xem lại. | Checkout |

## Giả định đang dùng

- Một cửa hàng, một kho, bán trong nước, giá VNĐ đã gồm thuế.
- Một vai trò quản trị (`admin`) ở bản đầu; phân quyền chi tiết theo nhân viên để backlog.
- Không tra cứu mã số thuế tự động qua dịch vụ ngoài; admin kiểm tra thủ công rồi duyệt.
- Thông tin doanh nghiệp, chính sách, phí giao hàng cụ thể: **[Cập nhật]**.

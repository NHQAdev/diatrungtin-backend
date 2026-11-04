# Cấu hình gửi email

Website tự gửi email cho khách: xác nhận đơn, cập nhật đơn (xác nhận, giao vận chuyển, hủy), đặt lại mật khẩu, kết quả duyệt tài khoản doanh nghiệp. Để gửi được, backend cần một **tài khoản SMTP**, tức "hộp thư gửi đi" mà code đăng nhập vào để gửi.

Khi chưa cấu hình (`SMTP_HOST` để trống), email chỉ được in ra log của `npm run dev`; đơn hàng vẫn tạo bình thường.

## Chọn dịch vụ

| | Gmail + Mật khẩu ứng dụng | Brevo (khuyên dùng khi chạy thật) |
|---|---|---|
| Phù hợp | Thử nghiệm ngay, chưa có tên miền | Bán hàng thật |
| Miễn phí | ~500 email/ngày | 300 email/ngày, không hết hạn |
| Người nhận thấy "Từ" | địa chỉ @gmail.com | địa chỉ tên miền của shop (sau khi xác thực) |
| Cần tên miền | Không | Không bắt buộc để bắt đầu; nên xác thực tên miền để email không vào Spam |

## Cách A — Gmail (5 phút)

1. Đăng nhập tài khoản Google sẽ dùng để gửi (nên tạo riêng, ví dụ `tramhuong.diatrungtin@gmail.com`).
2. Bật **Xác minh 2 bước**: <https://myaccount.google.com/security>.
3. Vào **Mật khẩu ứng dụng** (App passwords): <https://myaccount.google.com/apppasswords> → đặt tên "Website" → **Tạo** → chép mã 16 ký tự (bỏ dấu cách).
4. Điền vào `.env`:

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=tramhuong.diatrungtin@gmail.com
SMTP_PASS=abcdefghijklmnop
MAIL_FROM=Trầm Hương Địa Trung Tín <tramhuong.diatrungtin@gmail.com>
```

`MAIL_FROM` phải dùng đúng địa chỉ Gmail đó.

## Cách B — Brevo (khi chạy thật)

1. Đăng ký tại <https://www.brevo.com> (miễn phí, không cần thẻ).
2. **Senders, Domains & Dedicated IPs → Senders**: thêm địa chỉ gửi (ví dụ `no-reply@<ten-mien>` hoặc email của shop) và xác nhận qua email.
3. (Nên làm khi đã có tên miền) **Domains → Add a domain**: thêm các bản ghi DNS Brevo đưa ra (DKIM, SPF, DMARC) tại nơi quản lý tên miền, rồi bấm xác thực. Bước này giúp email không bị vào Spam.
4. **SMTP & API → SMTP**: bấm **Generate a new SMTP key**, chép key. Trên trang này có sẵn **SMTP server**, **Port** và **Login** — dùng đúng các giá trị đó.
5. Điền vào `.env`:

```env
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=<Login hiển thị trên trang SMTP của Brevo>
SMTP_PASS=<SMTP key vừa tạo — không phải API key>
MAIL_FROM=Trầm Hương Địa Trung Tín <no-reply@ten-mien-cua-shop>
```

`MAIL_FROM` phải là địa chỉ đã thêm ở bước 2 (hoặc thuộc tên miền đã xác thực ở bước 3).

## Kiểm tra

```bash
npm run email:test -- email-cua-ban@gmail.com
```

- `✔ Đăng nhập SMTP thành công` và `✔ Đã gửi` → mở hộp thư (kể cả Spam/Quảng cáo).
- Lỗi sai mật khẩu (535 / EAUTH): Gmail phải dùng Mật khẩu ứng dụng; Brevo phải dùng SMTP key.
- Không kết nối được (timeout): kiểm tra host/cổng. Trên VPS, một số nhà cung cấp chặn cổng gửi mail — thử cổng `2525` với Brevo hoặc yêu cầu nhà cung cấp mở cổng 587.
- Lỗi SSL / "wrong version number": cổng 587 đi với `SMTP_SECURE=false`, cổng 465 đi với `SMTP_SECURE=true`.

Sau khi gửi thử được, khởi động lại server (`npm run dev`) rồi thử "Quên mật khẩu" hoặc đặt một đơn.

## Khi chạy trên VPS

Điền cùng các biến trên vào `deploy/.env`, rồi `docker compose up -d api`. Kiểm tra:

```bash
docker compose run --rm api node dist/scripts/test-email.js email-cua-ban@gmail.com
```

Email gửi lỗi được tự thử lại tối đa 5 lần; admin xem danh sách email lỗi tại `GET /api/admin/emails?status=failed` và gửi lại bằng `POST /api/admin/emails/:id/retry`.

## Bảo mật

- Không commit `.env` / `deploy/.env` (đã có trong `.gitignore`).
- Mật khẩu ứng dụng / SMTP key chỉ dùng cho website; lộ thì thu hồi và tạo mới ngay trong Google / Brevo.

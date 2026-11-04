# Triển khai lên VPS

Mô hình: một VPS chạy Docker với 3 container — `db` (PostgreSQL 16), `api` (backend), `caddy` (HTTPS tự động). Database không mở ra internet. Mọi lệnh `docker compose` chạy trong thư mục `deploy/`.

## 0. Chuẩn bị

| Cần có | Ghi chú |
|---|---|
| VPS Ubuntu 24.04, tối thiểu 2 GB RAM, 20 GB đĩa | Nhà cung cấp tùy chọn |
| Tên miền | Ví dụ `api.<ten-mien>` cho backend |
| Bản ghi DNS `A` của `API_DOMAIN` trỏ về IP VPS | Phải có **trước** lần chạy đầu để Caddy lấy chứng chỉ HTTPS |
| Tài khoản SMTP | Bắt buộc ở production (email xác nhận đơn, đặt lại mật khẩu) |

## 1. Cài Docker và tường lửa (một lần)

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # đăng xuất rồi đăng nhập lại
sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable
```

## 2. Lấy mã nguồn và cấu hình

```bash
sudo mkdir -p /opt/diatrungtin && sudo chown $USER /opt/diatrungtin
git clone <repo-url> /opt/diatrungtin && cd /opt/diatrungtin/deploy
cp .env.example .env
openssl rand -hex 24          # dán vào POSTGRES_PASSWORD
nano .env                     # điền domain, CORS_ORIGINS, SMTP…
```

### Checklist `deploy/.env`

- [ ] `API_DOMAIN`, `API_PUBLIC_URL` — domain backend (có `https://` ở biến URL)
- [ ] `APP_PUBLIC_URL` — domain website bán hàng (dùng trong link email)
- [ ] `CORS_ORIGINS` — domain website + trang quản trị, cách nhau dấu phẩy
- [ ] `POSTGRES_PASSWORD` — chỉ chữ và số, sinh bằng `openssl rand -hex 24`
- [ ] `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`
- [ ] `COOKIE_SECURE=true`
- [ ] File `.env` không bao giờ commit (đã có trong `.gitignore`)

## 3. Chạy lần đầu

```bash
cd /opt/diatrungtin/deploy
docker compose up -d db
docker compose build api
docker compose run --rm api node dist/scripts/migrate.js
docker compose up -d
docker compose run --rm -it api node dist/scripts/admin.js create --email <email-admin> --name "<Tên>"
curl https://<API_DOMAIN>/health/ready      # {"status":"ok","checks":{"database":"ok"}}
```

Sau đó đăng nhập trang quản trị và đặt **phí giao hàng** (`PUT /api/admin/store-settings`), thông tin cửa hàng và các trang chính sách. Không chạy `db:seed` trên production.

## 4. Cập nhật phiên bản mới

```bash
cd /opt/diatrungtin && git pull
cd deploy
./backup.sh                                              # sao lưu trước khi cập nhật
docker compose build api
docker compose run --rm api node dist/scripts/migrate.js # chỉ áp migration mới
docker compose up -d api
docker compose logs -f api                               # Ctrl+C để thoát
```

Migration không sửa file đã áp dụng (có kiểm tra checksum). Muốn đổi cấu trúc DB thì thêm file migration mới.

## 5. Sao lưu tự động

`deploy/backup.sh` tạo hai file mỗi lần chạy trong `/var/backups/diatrungtin` và xóa bản cũ hơn 14 ngày:

- `db-<thời gian>.dump` — toàn bộ database
- `uploads-<thời gian>.tgz` — ảnh sản phẩm

```bash
sudo mkdir -p /var/backups/diatrungtin && sudo chown $USER /var/backups/diatrungtin
crontab -e
# Thêm dòng (2:30 sáng mỗi ngày):
30 2 * * * /opt/diatrungtin/deploy/backup.sh >> /var/log/diatrungtin-backup.log 2>&1
```

**Quan trọng:** bản sao lưu nằm trên cùng VPS sẽ mất nếu VPS hỏng. Chép thêm ra ngoài (Google Drive, S3/R2, máy khác) — ví dụ bằng `rclone copy /var/backups/diatrungtin remote:diatrungtin-backup` chạy sau backup.

Thử khôi phục định kỳ (ví dụ mỗi tháng) trên một VPS thử nghiệm để chắc bản sao lưu dùng được.

## 6. Khôi phục

```bash
cd /opt/diatrungtin/deploy
./restore.sh /var/backups/diatrungtin/db-20261105-023000.dump /var/backups/diatrungtin/uploads-20261105-023000.tgz
```

Script hỏi xác nhận (gõ `RESTORE`), dừng `api`, thay database và ảnh, rồi bật lại `api`.

## 7. Vận hành hằng ngày

| Việc | Lệnh / nơi xem |
|---|---|
| Xem log | `docker compose logs -f api` |
| Tình trạng | `docker compose ps`, `https://<API_DOMAIN>/health/ready` |
| Email gửi lỗi | Trang quản trị → `GET /api/admin/emails?status=failed`, gửi lại bằng `POST /api/admin/emails/:id/retry` |
| Đổi mật khẩu admin | `docker compose run --rm -it api node dist/scripts/admin.js reset-password --email <email>` |
| Khóa admin | `... admin.js disable --email <email>` |
| Dọn dữ liệu cũ | Tự động mỗi 6 giờ (phiên hết hạn, email đã gửi > 90 ngày…) |
| Khởi động lại | `docker compose restart api` |

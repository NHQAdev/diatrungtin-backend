# API

Base URL local: `http://localhost:4000`. Frontend gọi với `credentials: 'include'` (cookie phiên do server đặt, HttpOnly).

- Thành công: `{ "data": … }`, danh sách có thêm `"meta": { page, pageSize, total, totalPages }`.
- Lỗi: `{ "error": { "code", "message", "details?" } }`. `message` là tiếng Việt, hiển thị được ngay.
- Mã lỗi: `VALIDATION_ERROR` 400 (details: `[{ field, message }]`), `BAD_REQUEST` 400, `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409, `OUT_OF_STOCK` 409, `PRICE_CHANGED` 409, `IDEMPOTENCY_KEY_REUSED` 409, `INVALID_STATUS_TRANSITION` 409, `RATE_LIMITED` 429, `STORE_NOT_CONFIGURED` 503, `INTERNAL_ERROR` 500.
- Tiền: số nguyên VNĐ. Phân trang: `?page=1&pageSize=20` (tối đa 100).
- Request POST/PUT/PATCH/DELETE từ trình duyệt phải có `Origin` nằm trong `CORS_ORIGINS`.

## Hệ thống

| Method | Path | Ghi chú |
|---|---|---|
| GET | `/health` | Tiến trình đang chạy |
| GET | `/health/ready` | DB truy cập được (200) hoặc không (503) |
| GET | `/uploads/:file` | Ảnh sản phẩm đã upload |

## Cửa hàng (public)

| Method | Path | Ghi chú |
|---|---|---|
| GET | `/api/store` | Tên, hotline, email, địa chỉ, MXH, phí giao hàng. Trường `null` = chưa có, frontend hiển thị **[Cập nhật]** |
| GET | `/api/pages` | Danh sách trang nội dung đã xuất bản |
| GET | `/api/pages/:slug` | Một trang (chính sách đổi trả, giao hàng…) |

## Catalog (public)

Giá trả về theo **người đang xem**: khách business đã được duyệt thấy giá business; còn lại thấy giá lẻ (`priceTier`).

| Method | Path | Ghi chú |
|---|---|---|
| GET | `/api/categories` | Cây danh mục (cha → con) |
| GET | `/api/collections` | Bộ sưu tập đang hiển thị |
| GET | `/api/tags?type=audience\|need` | Thẻ lọc đối tượng / nhu cầu |
| GET | `/api/products` | Danh sách. Query: `q` (không phân biệt dấu/hoa thường: "vong tay" = "Vòng tay"), `category` (slug, gồm cả danh mục con), `collection`, `audience=a,b`, `need=a,b`, `minPrice`, `maxPrice`, `inStock=true`, `sort=newest\|price_asc\|price_desc\|name_asc`, `page`, `pageSize` |
| GET | `/api/products/:slug` | Chi tiết: breadcrumb, ảnh, thông số, tag, bộ sưu tập, `variants[]` |

Mỗi phần tử `variants[]`: `{ id, sku, name, options, price, retailPrice, inStock, availableQuantity (≤ 99), maxExtraBeads, extraBeadPrice }`. Nút mua chỉ bật khi đã chọn một variant có `inStock`. Nếu `maxExtraBeads > 0`, cho chọn 0…`maxExtraBeads` hạt thêm; giá dòng = `(price + extraBeads × extraBeadPrice) × quantity`.

## Tài khoản khách

Cookie `dtt_session` (30 ngày, SameSite=Lax).

| Method | Path | Body / ghi chú |
|---|---|---|
| POST | `/api/auth/register` | Cá nhân: `{ accountType: "personal", email, password (≥ 8), fullName, phone }`. Doanh nghiệp: thêm `accountType: "business", companyName, taxCode, invoiceAddress` → `businessStatus: "pending"`, chưa có giá business tới khi admin duyệt |
| POST | `/api/auth/login` | `{ email, password }` — giới hạn 10 lần/15 phút/IP |
| POST | `/api/auth/logout` | 204 |
| GET | `/api/auth/me` | `{ customer: { id, email, fullName, phone, accountType, businessStatus, companyName, taxCode, invoiceAddress, priceTier, emailVerified } }` |
| GET | `/api/auth/email-verification` | (đăng nhập) `{ emailVerified, email, expiresAt \| null, resendAvailableAt }`. Không bao giờ trả mã. |
| POST | `/api/auth/email-verification/verify` | `{ code: "6 chữ số" }` → `{ customer }`. Sai mã: 400 `VALIDATION_ERROR` (field `code`, báo số lần còn lại); mã hết hạn hoặc sai 5 lần: 400 `BAD_REQUEST` với `details.reason = "expired"`. Đã xác minh rồi thì trả 200. |
| POST | `/api/auth/email-verification/resend` | Gửi mã mới (mã cũ hết hiệu lực) → `{ expiresAt, resendAvailableAt, email }`. Chờ 60 giây giữa hai lần, tối đa 5 mã/giờ: 429 `RATE_LIMITED` với `details.retryAfterSeconds`. Đã xác minh: 409. |
| PATCH | `/api/auth/email-verification/email` | `{ email }` — sửa email gõ nhầm khi **chưa** xác minh, gửi mã tới email mới → `{ customer, expiresAt, resendAvailableAt }`. Email đã có tài khoản khác hoặc đã xác minh: 409. |
| POST | `/api/auth/forgot-password` | `{ email }` — luôn trả cùng một thông báo; email chứa link `APP_PUBLIC_URL/dat-lai-mat-khau?token=…` (1 giờ, dùng 1 lần) |
| POST | `/api/auth/reset-password` | `{ token, password }` — đăng xuất mọi thiết bị |
| PATCH | `/api/account/profile` | `{ fullName?, phone? }` |
| PUT | `/api/account/business` | `{ companyName, taxCode, invoiceAddress }` — nâng cấp lên doanh nghiệp hoặc đổi thông tin; đổi tên công ty/MST thì quay lại chờ duyệt |
| POST | `/api/account/change-password` | `{ currentPassword, newPassword }` — đăng xuất các thiết bị khác |
| GET | `/api/account/orders` | Đơn của tôi (phân trang) |
| GET | `/api/account/orders/:code` | Chi tiết đơn của tôi |
| POST | `/api/account/orders/:code/cancel` | `{ reason? }` — chỉ khi đơn còn chờ xác nhận |

## Giỏ hàng và đặt hàng

Giỏ hàng lưu ở frontend (localStorage): `[{ variantId, quantity, extraBeads }]`. Server không nhận giá từ frontend.

### POST `/api/checkout/quote`

Body `{ items }` → `{ priceTier, lines[], subtotal, shippingFee, total, problems[] }`. `problems`: `{ variantId, reason: "unavailable" | "insufficient_stock", availableQuantity }` — hiển thị cạnh dòng tương ứng và chặn nút đặt hàng.

### POST `/api/orders`

Header bắt buộc: `Idempotency-Key: <crypto.randomUUID()>` — tạo **một** key cho mỗi lần bấm "Đặt hàng"; nếu mạng lỗi và thử lại thì gửi **lại đúng key đó**.

```json
{
  "items": [{ "variantId": "…", "quantity": 1, "extraBeads": 2 }],
  "contact": { "fullName": "…", "phone": "0912345678", "email": "a@b.vn" },
  "shippingAddress": { "province": "…", "ward": "…", "addressLine": "…" },
  "note": null,
  "requestInvoice": false,
  "expectedTotal": 560000
}
```

- `expectedTotal` = `total` từ lần quote gần nhất mà khách đã xem.
- `201` → `{ code, total, orderStatus, accessToken, replayed: false }`. Lưu `accessToken` để mở trang đơn ngay (gọi `/api/orders/access`).
- `200` với `replayed: true` → yêu cầu lặp, trả lại đơn đã tạo (không có `accessToken`).
- `409 PRICE_CHANGED` → `details` là báo giá mới; hiển thị cho khách xem lại, rồi gửi lại với `expectedTotal` mới **và key mới**.
- `409 OUT_OF_STOCK` → `details` giống `problems` ở trên.
- `409 IDEMPOTENCY_KEY_REUSED` → cùng key nhưng nội dung khác.
- `503 STORE_NOT_CONFIGURED` → admin chưa đặt phí giao hàng.
- `requestInvoice: true` chỉ dùng được với tài khoản doanh nghiệp đã đăng nhập; thông tin hóa đơn lấy từ tài khoản.

### Tra cứu và hủy (khách vãng lai)

| Method | Path | Ghi chú |
|---|---|---|
| POST | `/api/orders/lookup` | `{ code, phone }` → bản rút gọn (không có địa chỉ đầy đủ, email) |
| POST | `/api/orders/access` | `{ code, token }` (token từ email/response tạo đơn) → bản đầy đủ + `canCancel` |
| POST | `/api/orders/cancel` | `{ code, token, reason? }` — chỉ khi đơn còn chờ xác nhận; gọi lại nhiều lần vẫn an toàn |

Link trong email: `APP_PUBLIC_URL/don-hang/<code>?token=…` (thêm `&action=cancel` cho link hủy).

## Quản trị

Tất cả cần cookie admin (`/api/admin/auth/login`). Xem `ARCHITECTURE.md` về xác thực quản trị.

### Xác thực

| Method | Path |
|---|---|
| POST | `/api/admin/auth/login` · `/api/admin/auth/logout` |
| GET | `/api/admin/auth/me` |

### Tổng quan, cấu hình, nội dung

| Method | Path | Ghi chú |
|---|---|---|
| GET | `/api/admin/dashboard` | Đơn chờ xác nhận, chờ giao, COD chưa thu, đơn hôm nay, doanh nghiệp chờ duyệt, SKU sắp hết (≤ 3), email gửi lỗi |
| GET/PUT | `/api/admin/store-settings` | `{ storeName, hotline, email, address, businessInfo, facebookUrl, zaloUrl, shippingFee, freeShippingThreshold }` |
| GET/POST | `/api/admin/pages` | `{ slug, title, content, isPublished }` |
| PATCH/DELETE | `/api/admin/pages/:id` | |

### Catalog

| Method | Path | Ghi chú |
|---|---|---|
| GET/POST | `/api/admin/categories` | `{ name, slug?, parentId?, description?, sortOrder, isVisible }` (slug tự sinh từ tên nếu bỏ trống) |
| PATCH/DELETE | `/api/admin/categories/:id` | Không xóa được khi còn sản phẩm/danh mục con (409) |
| GET/POST | `/api/admin/collections` · PATCH/DELETE `/:id` | `{ name, slug?, description?, imageUrl?, sortOrder, isVisible }` |
| GET/POST | `/api/admin/tags` · PATCH/DELETE `/:id` | `{ type: "audience" \| "need", name, slug?, sortOrder }` |
| GET | `/api/admin/products` | `q` (tên hoặc SKU), `status`, `categoryId`, `lowStock=<n>` |
| GET | `/api/admin/products/:id` | Đầy đủ: variants (gồm tồn kho), ảnh, `tagIds`, `collectionIds` |
| POST | `/api/admin/products` | Sản phẩm + `images[]`, `tagIds[]`, `collectionIds[]`, `variants[]` trong một lần |
| PATCH | `/api/admin/products/:id` | Gửi trường nào sửa trường đó; `images`/`tagIds`/`collectionIds` gửi lên là thay toàn bộ |
| DELETE | `/api/admin/products/:id` | Chỉ khi chưa từng có đơn; ngược lại 409 → dùng `status: "hidden"` |
| POST | `/api/admin/products/:id/variants` | Variant mới |
| PATCH | `/api/admin/variants/:id` | Sửa giá, thuộc tính, trạng thái (không sửa tồn ở đây) |
| DELETE | `/api/admin/variants/:id` | Chỉ khi chưa từng có đơn |
| POST | `/api/admin/variants/:id/stock-adjustments` | `{ change: +5 \| -2, note }` — bắt buộc ghi lý do |
| GET | `/api/admin/variants/:id/stock-movements` | Lịch sử tồn kho |
| POST | `/api/admin/uploads` | `multipart/form-data`, field `file`: JPG/PNG/WEBP ≤ `UPLOAD_MAX_MB` → `{ url }` |

Variant body: `{ sku, name, options: { bead_size_mm: 8 }, retailPrice, businessPrice?, maxExtraBeads, extraBeadPrice?, businessExtraBeadPrice?, status, sortOrder, initialStock }`. SKU tự chuyển chữ hoa, duy nhất toàn hệ thống; `options` duy nhất trong một sản phẩm; `maxExtraBeads > 0` thì bắt buộc `extraBeadPrice`. Sản phẩm chỉ chuyển sang `active` khi có ít nhất một variant đang bán.

### Khách hàng

| Method | Path | Ghi chú |
|---|---|---|
| GET | `/api/admin/customers` | `q`, `accountType`, `businessStatus=pending` (hàng chờ duyệt) |
| GET | `/api/admin/customers/:id` | Kèm 20 đơn gần nhất |
| POST | `/api/admin/customers/:id/business-review` | `{ decision: "approve" }` hoặc `{ decision: "reject", reason }` — gửi email cho khách |
| POST | `/api/admin/customers/:id/status` | `{ status: "active" \| "disabled" }` — khóa thì đăng xuất mọi thiết bị |

### Đơn hàng

| Method | Path | Ghi chú |
|---|---|---|
| GET | `/api/admin/orders` | `q` (mã, SĐT, email, tên), `orderStatus`, `paymentStatus`, `fulfillmentStatus`, `from`, `to` |
| GET | `/api/admin/orders/:id` | Đơn + dòng hàng + lịch sử (`events`) + `availableActions` |
| POST | `/api/admin/orders/:id/actions` | `{ action, carrier?, trackingNumber?, reason?, note? }` |
| PATCH | `/api/admin/orders/:id/details` | Sửa thông tin nhận hàng: `{ customerName?, phone?, email?, shippingProvince?, shippingWard?, shippingAddressLine?, note?, reason }` — `reason` bắt buộc; chỉ khi đơn chưa giao cho vận chuyển; lịch sử lưu giá trị cũ → mới. Không sửa sản phẩm/tiền |

Hành động hợp lệ (frontend chỉ hiện nút có trong `availableActions`):

| action | Điều kiện | Kết quả |
|---|---|---|
| `confirm` | đơn `pending` | đơn `confirmed`, email khách |
| `start_packing` | `confirmed` + chưa giao | giao hàng `packing` |
| `ship` | `confirmed` + `packing`; bắt buộc `carrier`, `trackingNumber` | `shipped`, email khách |
| `deliver` | `shipped` | `delivered` |
| `mark_paid` | `delivered` + `unpaid` | thanh toán `paid` (đã thu COD) |
| `complete` | `delivered` + `paid` | đơn `completed` |
| `cancel` | `pending`/`confirmed` + `unfulfilled`/`packing`; bắt buộc `reason` | `cancelled`, hoàn tồn đúng 1 lần, email khách |
| `mark_returned` | `confirmed` + `shipped`/`delivered`; bắt buộc `reason` | `cancelled` + `returned`, hoàn tồn |
| `mark_refunded` | `cancelled` + `paid` | `refunded` |

### Email

| Method | Path | Ghi chú |
|---|---|---|
| GET | `/api/admin/emails?status=failed\|pending\|sent` | Danh sách email (không trả nội dung vì email đặt lại mật khẩu chứa link bí mật) |
| POST | `/api/admin/emails/:id/retry` | Gửi lại email đang lỗi (sau khi sửa cấu hình SMTP) |

import { formatVnd } from '../../lib/format.js';
import type { EmailMessage } from './outbox.js';

// Plain-text emails. Kept simple on purpose; HTML templates can come later.

const SIGNATURE = '\n\n—\nTrầm Hương Địa Trung Tín';

export function passwordResetEmail(to: string, resetUrl: string): EmailMessage {
  return {
    to,
    subject: 'Đặt lại mật khẩu — Trầm Hương Địa Trung Tín',
    body:
      `Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản ${to}.\n\n` +
      `Mở liên kết sau trong vòng 1 giờ để đặt mật khẩu mới:\n${resetUrl}\n\n` +
      'Nếu bạn không yêu cầu, hãy bỏ qua email này. Mật khẩu hiện tại vẫn giữ nguyên.' +
      SIGNATURE,
  };
}

export function emailVerificationEmail(to: string, fullName: string, code: string, ttlMinutes: number): EmailMessage {
  return {
    to,
    subject: `${code} là mã xác minh email — Trầm Hương Địa Trung Tín`,
    body:
      `Chào ${fullName},\n\n` +
      `Mã xác minh email của bạn là: ${code}\n\n` +
      `Mã có hiệu lực trong ${ttlMinutes} phút. Không chia sẻ mã này với bất kỳ ai, kể cả người tự nhận là nhân viên cửa hàng.\n\n` +
      'Nếu bạn không đăng ký tài khoản, hãy bỏ qua email này.' +
      SIGNATURE,
  };
}

export function businessReviewEmail(to: string, approved: boolean, reason?: string | null): EmailMessage {
  return {
    to,
    subject: approved ? 'Tài khoản doanh nghiệp đã được duyệt' : 'Tài khoản doanh nghiệp chưa được duyệt',
    body: approved
      ? 'Tài khoản doanh nghiệp của bạn đã được duyệt. Từ bây giờ, giá dành cho doanh nghiệp sẽ được áp dụng khi bạn đăng nhập và đặt hàng.' + SIGNATURE
      : `Tài khoản doanh nghiệp của bạn chưa được duyệt.${reason ? `\nLý do: ${reason}` : ''}\n` +
        'Bạn vẫn có thể mua hàng với giá bán lẻ, hoặc cập nhật lại thông tin doanh nghiệp để được xem xét lại.' +
        SIGNATURE,
  };
}

export interface OrderEmailData {
  code: string;
  customerName: string;
  email: string;
  items: { productName: string; variantName: string; extraBeads: number; quantity: number; lineTotal: number }[];
  subtotal: number;
  shippingFee: number;
  total: number;
  shippingAddress: string;
}

export function orderPlacedEmail(order: OrderEmailData, orderUrl: string, cancelUrl: string): EmailMessage {
  const lines = order.items
    .map((item) => {
      const beads = item.extraBeads > 0 ? ` (+${item.extraBeads} hạt)` : '';
      return `- ${item.productName} — ${item.variantName}${beads} × ${item.quantity}: ${formatVnd(item.lineTotal)}`;
    })
    .join('\n');
  return {
    to: order.email,
    subject: `Đã nhận đơn hàng ${order.code}`,
    body:
      `Chào ${order.customerName},\n\n` +
      `Cảm ơn bạn đã đặt hàng. Mã đơn của bạn là ${order.code}. Chúng tôi sẽ liên hệ để xác nhận đơn.\n\n` +
      `${lines}\n\n` +
      `Tạm tính: ${formatVnd(order.subtotal)}\n` +
      `Phí giao hàng: ${formatVnd(order.shippingFee)}\n` +
      `Tổng cộng: ${formatVnd(order.total)}\n` +
      'Thanh toán: khi nhận hàng (COD)\n\n' +
      `Giao đến: ${order.shippingAddress}\n\n` +
      `Theo dõi đơn hàng: ${orderUrl}\n` +
      `Nếu muốn hủy đơn khi đơn chưa được xác nhận, dùng liên kết sau (không chia sẻ cho người khác):\n${cancelUrl}` +
      SIGNATURE,
  };
}

export function orderStatusEmail(to: string, code: string, message: string): EmailMessage {
  return { to, subject: `Cập nhật đơn hàng ${code}`, body: `Đơn hàng ${code}: ${message}` + SIGNATURE };
}

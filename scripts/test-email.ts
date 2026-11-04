// Checks the SMTP settings in .env and sends one test email.
//
//   npm run email:test -- ban@example.com
//
// Prints a clear message for the most common mistakes (wrong password, blocked port, wrong host).

import nodemailer from 'nodemailer';
import { loadEnv } from '../src/config/env.js';

const env = loadEnv();
const to = process.argv[2];

if (!to || !to.includes('@')) {
  console.error('Cách dùng: npm run email:test -- <email-nhận-thử>');
  process.exit(1);
}
if (!env.SMTP_HOST) {
  console.error('SMTP_HOST đang trống trong .env. Điền thông tin SMTP trước (xem docs/EMAIL.md).');
  process.exit(1);
}

const transporter = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_SECURE,
  auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  connectionTimeout: 15_000,
});

console.log(`Kết nối ${env.SMTP_HOST}:${env.SMTP_PORT} (secure=${env.SMTP_SECURE}) với tài khoản ${env.SMTP_USER ?? '(không có)'}…`);

try {
  await transporter.verify();
  console.log('✔ Đăng nhập SMTP thành công.');
  const info = await transporter.sendMail({
    from: env.MAIL_FROM,
    to,
    subject: 'Email thử — Trầm Hương Địa Trung Tín',
    text: `Nếu bạn nhận được email này, cấu hình gửi email đã đúng.\n\nGửi từ: ${env.MAIL_FROM}\nMáy chủ: ${env.SMTP_HOST}:${env.SMTP_PORT}`,
  });
  console.log(`✔ Đã gửi tới ${to} (message id: ${info.messageId}). Kiểm tra cả hộp thư Spam/Quảng cáo.`);
} catch (error) {
  const err = error as { code?: string; responseCode?: number; message: string };
  console.error(`✘ Lỗi: ${err.message}`);
  if (err.code === 'EAUTH' || err.responseCode === 535) {
    console.error('→ Sai tên đăng nhập hoặc mật khẩu SMTP. Gmail: phải dùng Mật khẩu ứng dụng 16 ký tự, không phải mật khẩu Gmail. Brevo: dùng SMTP key, không phải API key.');
  } else if (err.code === 'ETIMEDOUT' || err.code === 'ECONNECTION' || err.code === 'ESOCKET') {
    console.error('→ Không kết nối được tới máy chủ. Kiểm tra SMTP_HOST/SMTP_PORT; nếu chạy trên VPS, nhà cung cấp có thể đang chặn cổng 587/465 (thử 2525 với Brevo, hoặc hỏi nhà cung cấp mở cổng).');
  } else if (err.code === 'EDNS' || err.code === 'ENOTFOUND') {
    console.error('→ Sai SMTP_HOST (không tìm thấy máy chủ).');
  } else if (/wrong version number|ssl/i.test(err.message)) {
    console.error('→ Sai kiểu mã hóa: cổng 587 thì SMTP_SECURE=false; cổng 465 thì SMTP_SECURE=true.');
  }
  process.exitCode = 1;
}

import type { FastifyInstance, FastifyReply } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Env } from '../../config/env.js';
import type { Db } from '../../db/client.js';
import { conflict } from '../../lib/errors.js';
import { emailSchema, phoneSchema } from '../../lib/http.js';
import {
  changePassword,
  loginCustomer,
  logoutCustomer,
  registerCustomer,
  requestPasswordReset,
  resetPassword,
} from './customer-auth.service.js';
import { CUSTOMER_SESSION_COOKIE, customerProfile, findCustomerBySessionToken, requireCustomer } from './customer-session.js';
import { changeUnverifiedEmail, getVerificationStatus, issueVerificationCode, verifyEmailCode } from './email-verification.service.js';

const newPassword = z
  .string()
  .min(8, 'Mật khẩu cần ít nhất 8 ký tự.')
  .max(256)
  .refine((value) => value.trim() === value, 'Mật khẩu không được bắt đầu hoặc kết thúc bằng khoảng trắng.');

// Vietnamese tax code: 10 digits, or 10 digits + "-" + 3 digits for a branch.
const taxCodeSchema = z.string().trim().regex(/^[0-9]{10}(-[0-9]{3})?$/, 'Mã số thuế gồm 10 số (hoặc 10 số-3 số với chi nhánh).');

const businessFields = z.object({
  companyName: z.string().trim().min(1, 'Vui lòng nhập tên công ty.').max(300),
  taxCode: taxCodeSchema,
  invoiceAddress: z.string().trim().min(1, 'Vui lòng nhập địa chỉ xuất hóa đơn.').max(500),
});

const RegisterBody = z.discriminatedUnion('accountType', [
  z.object({
    accountType: z.literal('personal'),
    email: emailSchema,
    password: newPassword,
    fullName: z.string().trim().min(1, 'Vui lòng nhập họ tên.').max(200),
    phone: phoneSchema,
  }),
  businessFields.extend({
    accountType: z.literal('business'),
    email: emailSchema,
    password: newPassword,
    fullName: z.string().trim().min(1, 'Vui lòng nhập họ tên người liên hệ.').max(200),
    phone: phoneSchema,
  }),
]);

const LoginBody = z.object({ email: emailSchema, password: z.string().min(1, 'Vui lòng nhập mật khẩu.').max(256) });

export function customerAuthRoutes(deps: { db: Db; env: Env }) {
  const { db, env } = deps;
  const sessionInfo = (request: { ip: string; headers: Record<string, unknown> }) => ({
    ipAddress: request.ip ?? null,
    userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
    ttlDays: env.CUSTOMER_SESSION_TTL_DAYS,
  });
  const cookieOptions = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: env.COOKIE_SECURE };
  const setSessionCookie = (reply: FastifyReply, token: string, expiresAt: Date) =>
    reply.setCookie(CUSTOMER_SESSION_COOKIE, token, { ...cookieOptions, expires: expiresAt });

  async function profileFromToken(token: string) {
    const customer = await findCustomerBySessionToken(db, token);
    if (!customer) throw new Error('Session just created but not found');
    return customerProfile(customer);
  }

  return async function register(app: FastifyInstance) {
    app.post('/auth/register', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
      const body = RegisterBody.parse(request.body);
      const session = await registerCustomer(db, body, sessionInfo(request));
      setSessionCookie(reply, session.token, session.expiresAt);
      return reply.status(201).send({ data: { customer: await profileFromToken(session.token) } });
    });

    app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
      const body = LoginBody.parse(request.body);
      const session = await loginCustomer(db, body.email, body.password, sessionInfo(request));
      setSessionCookie(reply, session.token, session.expiresAt);
      return { data: { customer: await profileFromToken(session.token) } };
    });

    app.post('/auth/logout', async (request, reply) => {
      const token = request.cookies[CUSTOMER_SESSION_COOKIE];
      if (token) await logoutCustomer(db, token);
      reply.clearCookie(CUSTOMER_SESSION_COOKIE, cookieOptions);
      return reply.status(204).send();
    });

    app.get('/auth/me', { preHandler: requireCustomer(db) }, async (request) => {
      return { data: { customer: customerProfile(request.customer!) } };
    });

    // ---------- Email verification (D10) ----------

    app.get('/auth/email-verification', { preHandler: requireCustomer(db) }, async (request) => {
      return { data: await getVerificationStatus(db, request.customer!) };
    });

    app.post('/auth/email-verification/verify', { preHandler: requireCustomer(db), config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (request) => {
      const { code } = z.object({ code: z.string().trim().regex(/^[0-9]{6}$/, 'Mã xác minh gồm 6 chữ số.') }).parse(request.body);
      await verifyEmailCode(db, request.customer!, code);
      return { data: { customer: await profileFromToken(request.cookies[CUSTOMER_SESSION_COOKIE]!) } };
    });

    app.post('/auth/email-verification/resend', { preHandler: requireCustomer(db), config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request) => {
      const customer = request.customer!;
      if (customer.emailVerified) throw conflict('Email đã được xác minh.');
      const sent = await issueVerificationCode(db, customer, { enforceLimits: true });
      return { data: { ...sent, email: customer.email } };
    });

    app.patch('/auth/email-verification/email', { preHandler: requireCustomer(db), config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request) => {
      const { email } = z.object({ email: emailSchema }).parse(request.body);
      const sent = await changeUnverifiedEmail(db, request.customer!, email);
      return { data: { ...sent, customer: await profileFromToken(request.cookies[CUSTOMER_SESSION_COOKIE]!) } };
    });

    app.post('/auth/forgot-password', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request) => {
      const { email } = z.object({ email: emailSchema }).parse(request.body);
      await requestPasswordReset(db, env, email);
      // Same answer whether or not the email exists.
      return { data: { message: 'Nếu email đã đăng ký, bạn sẽ nhận được hướng dẫn đặt lại mật khẩu.' } };
    });

    app.post('/auth/reset-password', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request) => {
      const body = z.object({ token: z.string().min(20).max(200), password: newPassword }).parse(request.body);
      await resetPassword(db, body.token, body.password);
      return { data: { message: 'Đã đặt lại mật khẩu. Vui lòng đăng nhập lại.' } };
    });

    // ---------- Account (logged-in customer) ----------

    app.patch('/account/profile', { preHandler: requireCustomer(db) }, async (request) => {
      const body = z
        .object({ fullName: z.string().trim().min(1).max(200).optional(), phone: phoneSchema.optional() })
        .parse(request.body);
      await db
        .updateTable('customers')
        .set({
          ...(body.fullName !== undefined && { full_name: body.fullName }),
          ...(body.phone !== undefined && { phone: body.phone }),
          updated_at: sql`now()`,
        })
        .where('id', '=', request.customer!.id)
        .execute();
      return { data: { customer: customerProfile((await findCustomerBySessionToken(db, request.cookies[CUSTOMER_SESSION_COOKIE]!))!) } };
    });

    // Set or change business information. A personal account becomes a business account here.
    // Changing the company or tax code sends the account back to "pending" for a new admin check.
    app.put('/account/business', { preHandler: requireCustomer(db) }, async (request) => {
      const body = businessFields.parse(request.body);
      const current = request.customer!;
      const needsReview =
        current.accountType !== 'business' || current.taxCode !== body.taxCode || current.companyName !== body.companyName;

      await db
        .updateTable('customers')
        .set({
          account_type: 'business',
          company_name: body.companyName,
          tax_code: body.taxCode,
          invoice_address: body.invoiceAddress,
          ...(needsReview && { business_status: 'pending', business_reviewed_at: null, business_reviewed_by: null, business_rejection_reason: null }),
          updated_at: sql`now()`,
        })
        .where('id', '=', current.id)
        .execute();
      return { data: { customer: customerProfile((await findCustomerBySessionToken(db, request.cookies[CUSTOMER_SESSION_COOKIE]!))!) } };
    });

    app.post('/account/change-password', { preHandler: requireCustomer(db) }, async (request) => {
      const body = z.object({ currentPassword: z.string().min(1).max(256), newPassword }).parse(request.body);
      await changePassword(db, request.customer!.id, request.customer!.sessionId, body.currentPassword, body.newPassword);
      return { data: { message: 'Đã đổi mật khẩu. Các thiết bị khác đã bị đăng xuất.' } };
    });
  };
}


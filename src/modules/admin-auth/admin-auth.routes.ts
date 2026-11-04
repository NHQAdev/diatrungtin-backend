import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import type { Env } from '../../config/env.js';
import { loginAdmin, logoutAdmin } from './admin-auth.service.js';
import { ADMIN_SESSION_COOKIE, requireAdmin } from './require-admin.js';

const LoginBody = z.object({
  email: z.string().trim().email('Email không hợp lệ.').max(254),
  password: z.string().min(1, 'Vui lòng nhập mật khẩu.').max(256),
});

export function adminAuthRoutes(deps: { db: Db; env: Env }) {
  const { db, env } = deps;

  const clearSessionCookie = (reply: FastifyReply) =>
    reply.clearCookie(ADMIN_SESSION_COOKIE, { path: '/api/admin', httpOnly: true, sameSite: 'strict', secure: env.COOKIE_SECURE });

  return async function register(app: FastifyInstance) {
    app.post(
      '/login',
      { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
      async (request, reply) => {
        const body = LoginBody.parse(request.body);
        const result = await loginAdmin(db, {
          email: body.email,
          password: body.password,
          ipAddress: request.ip ?? null,
          userAgent: request.headers['user-agent'] ?? null,
          ttlHours: env.ADMIN_SESSION_TTL_HOURS,
        });

        reply.setCookie(ADMIN_SESSION_COOKIE, result.token, {
          path: '/api/admin',
          httpOnly: true,
          sameSite: 'strict',
          secure: env.COOKIE_SECURE,
          expires: result.expiresAt,
        });
        return { data: { admin: result.admin, expiresAt: result.expiresAt.toISOString() } };
      },
    );

    app.post('/logout', async (request, reply) => {
      const token = request.cookies[ADMIN_SESSION_COOKIE];
      if (token) await logoutAdmin(db, token, request.ip ?? null);
      clearSessionCookie(reply);
      return reply.status(204).send();
    });

    app.get('/me', { preHandler: requireAdmin(db) }, async (request) => {
      const { sessionId: _sessionId, ...admin } = request.admin!;
      return { data: { admin } };
    });
  };
}

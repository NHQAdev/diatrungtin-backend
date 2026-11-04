import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../../db/client.js';
import { unauthenticated } from '../../lib/errors.js';
import { type AuthenticatedAdmin, findAdminBySessionToken } from './admin-auth.service.js';

export const ADMIN_SESSION_COOKIE = 'dtt_admin_session';

declare module 'fastify' {
  interface FastifyRequest {
    admin?: AuthenticatedAdmin;
  }
}

/** preHandler for every admin-only route. Authorization is enforced here, never only in the UI. */
export function requireAdmin(db: Db) {
  return async function requireAdminHandler(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const token = request.cookies[ADMIN_SESSION_COOKIE];
    if (!token) throw unauthenticated();

    const admin = await findAdminBySessionToken(db, token);
    if (!admin) throw unauthenticated('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');

    request.admin = admin;
  };
}

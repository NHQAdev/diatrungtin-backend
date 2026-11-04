import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { Env } from './config/env.js';
import type { Db } from './db/client.js';
import { AppError, forbidden } from './lib/errors.js';
import { adminAuthRoutes } from './modules/admin-auth/admin-auth.routes.js';
import { adminCustomerRoutes } from './modules/admin-customers/admin-customers.routes.js';
import { catalogAdminRoutes } from './modules/catalog/catalog.admin.routes.js';
import { catalogPublicRoutes } from './modules/catalog/catalog.public.routes.js';
import { customerAuthRoutes } from './modules/customer-auth/customer-auth.routes.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { adminOrderRoutes } from './modules/orders/orders.admin.routes.js';
import { orderRoutes } from './modules/orders/orders.routes.js';
import { storeAdminRoutes, storePublicRoutes } from './modules/store/store.routes.js';
import { uploadRoutes } from './modules/uploads/uploads.routes.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface AppDeps {
  env: Env;
  db: Db;
}

export async function buildApp({ env, db }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
    logger: {
      level: env.LOG_LEVEL,
      redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'], remove: true },
      ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
    },
  });

  // cross-origin resource policy: product images are loaded by the shop frontend from another origin.
  await app.register(helmet, { crossOriginResourcePolicy: { policy: 'cross-origin' } });
  await app.register(cors, {
    origin: env.CORS_ORIGINS,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Idempotency-Key'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
  await app.register(cookie);
  // global: false → only routes that opt in via `config.rateLimit` are limited.
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: () => new AppError(429, 'RATE_LIMITED', 'Bạn thao tác quá nhiều lần. Vui lòng thử lại sau.'),
  });

  // Cookies are SameSite, but we also refuse any state-changing request sent by a browser from an
  // origin we do not know (protection against cross-site request forgery).
  app.addHook('onRequest', async (request) => {
    if (SAFE_METHODS.has(request.method)) return;
    const origin = request.headers.origin;
    if (origin && !env.CORS_ORIGINS.includes(origin)) throw forbidden('Nguồn yêu cầu không được phép.');
  });

  app.setErrorHandler((error: FastifyError | AppError | ZodError, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details } });
    }
    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message }));
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: details[0]?.message ?? 'Dữ liệu không hợp lệ.', details } });
    }
    const status = (error as FastifyError).statusCode ?? 500;
    if (status === 413) {
      return reply.status(413).send({ error: { code: 'BAD_REQUEST', message: `File hoặc dữ liệu gửi lên quá lớn (tối đa ${env.UPLOAD_MAX_MB} MB).` } });
    }
    if (status < 500) {
      // Framework-level client errors: malformed JSON, unsupported media type…
      return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: 'Yêu cầu không hợp lệ.' } });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Hệ thống đang gặp sự cố. Vui lòng thử lại sau.' } });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Không tìm thấy đường dẫn.' } }),
  );

  // ---------- Routes ----------
  // Each module is its own plugin, so a hook like "require admin" stays inside that module.

  await app.register(healthRoutes({ db }));
  await app.register(uploadRoutes({ db, env })); // POST /api/admin/uploads, GET /uploads/:file

  // Shop (public + logged-in customer)
  await app.register(catalogPublicRoutes({ db }), { prefix: '/api' });
  await app.register(customerAuthRoutes({ db, env }), { prefix: '/api' });
  await app.register(orderRoutes({ db, env }), { prefix: '/api' });
  await app.register(storePublicRoutes({ db }), { prefix: '/api' });

  // Admin
  await app.register(adminAuthRoutes({ db, env }), { prefix: '/api/admin/auth' });
  await app.register(catalogAdminRoutes({ db }), { prefix: '/api/admin' });
  await app.register(adminCustomerRoutes({ db }), { prefix: '/api/admin' });
  await app.register(adminOrderRoutes({ db }), { prefix: '/api/admin' });
  await app.register(storeAdminRoutes({ db }), { prefix: '/api/admin' });

  return app;
}

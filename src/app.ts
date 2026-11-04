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
import { healthRoutes } from './modules/health/health.routes.js';

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

  await app.register(helmet);
  await app.register(cors, { origin: env.CORS_ORIGINS, credentials: true });
  await app.register(cookie);
  // global: false → only routes that opt in via `config.rateLimit` are limited.
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: () => new AppError(429, 'RATE_LIMITED', 'Bạn thao tác quá nhiều lần. Vui lòng thử lại sau.'),
  });

  app.setErrorHandler((error: FastifyError | AppError | ZodError, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details } });
    }
    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message }));
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Dữ liệu không hợp lệ.', details } });
    }
    const status = (error as FastifyError).statusCode ?? 500;
    if (status < 500) {
      // Framework-level client errors: malformed JSON, payload too large, unsupported media type…
      return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: 'Yêu cầu không hợp lệ.' } });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Hệ thống đang gặp sự cố. Vui lòng thử lại sau.' } });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Không tìm thấy đường dẫn.' } }),
  );

  await app.register(healthRoutes({ db }));

  await app.register(
    async (admin) => {
      // Defence in depth on top of SameSite=Strict cookies: a browser sending a state-changing
      // request from an origin we do not know is rejected before any handler runs.
      admin.addHook('onRequest', async (request) => {
        if (SAFE_METHODS.has(request.method)) return;
        const origin = request.headers.origin;
        if (origin && !env.CORS_ORIGINS.includes(origin)) throw forbidden('Nguồn yêu cầu không được phép.');
      });
      await admin.register(adminAuthRoutes({ db, env }), { prefix: '/auth' });
    },
    { prefix: '/api/admin' },
  );

  return app;
}

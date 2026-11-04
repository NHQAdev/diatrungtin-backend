import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import type { Db } from '../../db/client.js';

export function healthRoutes(deps: { db: Db }) {
  return async function register(app: FastifyInstance) {
    // Liveness: the process is up. Does not touch the database.
    app.get('/health', async () => ({ status: 'ok' }));

    // Readiness: the app can serve traffic (database reachable).
    app.get('/health/ready', async (request, reply) => {
      try {
        await sql`SELECT 1`.execute(deps.db);
        return { status: 'ok', checks: { database: 'ok' } };
      } catch (error) {
        request.log.error({ err: error }, 'readiness check failed');
        return reply.status(503).send({ status: 'error', checks: { database: 'unavailable' } });
      }
    });
  };
}

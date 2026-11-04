import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createDb } from './db/client.js';

const env = loadEnv();
const db = createDb(env.DATABASE_URL, env.DATABASE_POOL_MAX);
const app = await buildApp({ env, db });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await db.destroy();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (error) {
  app.log.fatal({ err: error }, 'failed to start');
  await db.destroy();
  process.exit(1);
}

import path from 'node:path';
import { loadEnv } from '../src/config/env.js';
import { runMigrations } from '../src/db/migrator.js';

// Run from the project root (npm scripts do), both from source and from dist/.
const env = loadEnv();
const migrationsDir = path.resolve(process.cwd(), 'db/migrations');

try {
  const result = await runMigrations(env.DATABASE_URL, migrationsDir);
  console.log(`Applied: ${result.applied.length ? result.applied.join(', ') : '(none)'}`);
  console.log(`Already up to date: ${result.skipped.length}`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}

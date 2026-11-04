import path from 'node:path';
import pg from 'pg';
import { runMigrations } from '../src/db/migrator.js';

// Recreates the test database schema from the migrations before the test run.
// Refuses to touch a database whose name does not contain "test".
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set (see .env.example).');
  if (!new URL(url).pathname.includes('test')) throw new Error('TEST_DATABASE_URL must point to a database named *test*.');

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();

  await runMigrations(url, path.resolve(process.cwd(), 'db/migrations'));
}

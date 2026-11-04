import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

// Plain SQL migrations, applied in filename order, each inside its own transaction.
// An advisory lock stops two deploys from migrating at the same time.
// Applied files must never be edited: a checksum mismatch aborts the run.

const MIGRATION_LOCK_ID = 7_310_442_001;
const FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(connectionString: string, migrationsDir: string): Promise<MigrationResult> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const files = (await readdir(migrationsDir)).filter((file) => FILE_PATTERN.test(file)).sort();
    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    const done = new Map(rows.map((row) => [row.version, row.checksum]));
    const result: MigrationResult = { applied: [], skipped: [] };

    for (const file of files) {
      const rawSql = await readFile(path.join(migrationsDir, file), 'utf8');
      // Windows checkouts may turn LF into CRLF. Hash with LF line endings so the same migration
      // has the same checksum on every machine.
      const sql = rawSql.replace(/\r\n/g, '\n');
      const checksum = createHash('sha256').update(sql).digest('hex');
      // Checksum computed the old way (raw bytes), for databases migrated before this fix.
      const legacyChecksum = createHash('sha256').update(rawSql).digest('hex');
      const previous = done.get(file);

      if (previous !== undefined) {
        if (previous !== checksum && previous !== legacyChecksum) {
          throw new Error(`Migration ${file} was modified after being applied. Create a new migration instead.`);
        }
        result.skipped.push(file);
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
      }
      result.applied.push(file);
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    await client.end();
  }
}

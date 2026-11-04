import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';

// Return BIGINT (int8) as string; money columns will use bigint and be parsed explicitly.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => value);

export type Db = Kysely<Database>;

export function createDb(connectionString: string, poolMax = 10): Db {
  const pool = new pg.Pool({ connectionString, max: poolMax });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

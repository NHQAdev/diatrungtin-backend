import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.js';

// BIGINT (int8) columns hold VND amounts and COUNT(*) results. They come back from pg as strings;
// convert them to numbers, and fail loudly if a value is ever too large to be exact in JavaScript.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`BIGINT value out of safe range: ${value}`);
  return parsed;
});

export type Db = Kysely<Database>;
/** Either the root db or a transaction. Service functions that may run inside a transaction take this. */
export type DbOrTrx = Kysely<Database> | Transaction<Database>;

export function createDb(connectionString: string, poolMax = 10): Db {
  const pool = new pg.Pool({ connectionString, max: poolMax });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

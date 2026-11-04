import type { Kysely } from 'kysely';
import type { Database } from '../../db/schema.js';

export interface AuditEntry {
  actor_type: 'admin' | 'system' | 'anonymous';
  actor_id: string | null;
  action: string;
  entity_type?: string | null;
  entity_id?: string | null;
  ip_address?: string | null;
  metadata?: Record<string, unknown>;
}

/** Accepts the root db or a transaction, so the log commits or rolls back with the change it describes. */
export async function writeAuditLog(db: Kysely<Database>, entry: AuditEntry): Promise<void> {
  await db
    .insertInto('audit_logs')
    .values({
      actor_type: entry.actor_type,
      actor_id: entry.actor_id,
      action: entry.action,
      entity_type: entry.entity_type ?? null,
      entity_id: entry.entity_id ?? null,
      ip_address: entry.ip_address ?? null,
      metadata: JSON.stringify(entry.metadata ?? {}),
    })
    .execute();
}

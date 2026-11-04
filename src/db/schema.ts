import type { ColumnType, Generated, Insertable, Selectable } from 'kysely';

// Hand-written to mirror db/migrations/*.sql. Update together with every migration.

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface AdminUsersTable {
  id: Generated<string>;
  email: string;
  display_name: string;
  password_hash: string;
  status: ColumnType<'active' | 'disabled', 'active' | 'disabled' | undefined>;
  last_login_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AdminSessionsTable {
  id: Generated<string>;
  admin_user_id: string;
  token_hash: Buffer;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Timestamp;
  last_seen_at: Timestamp;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  revoked_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export interface AuditLogsTable {
  id: Generated<string>;
  actor_type: 'admin' | 'system' | 'anonymous';
  actor_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  ip_address: string | null;
  metadata: ColumnType<Record<string, unknown>, string | undefined, string>;
  created_at: Timestamp;
}

export interface Database {
  admin_users: AdminUsersTable;
  admin_sessions: AdminSessionsTable;
  audit_logs: AuditLogsTable;
}

export type AdminUser = Selectable<AdminUsersTable>;
export type NewAuditLog = Insertable<AuditLogsTable>;

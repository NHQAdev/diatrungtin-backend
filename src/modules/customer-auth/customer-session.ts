import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import type { Db } from '../../db/client.js';
import type { AccountType, BusinessStatus, Customer, PriceTier } from '../../db/schema.js';
import { unauthenticated } from '../../lib/errors.js';
import { hashToken } from '../../lib/tokens.js';

export const CUSTOMER_SESSION_COOKIE = 'dtt_session';

export interface CurrentCustomer {
  id: string;
  sessionId: string;
  email: string;
  fullName: string;
  phone: string;
  accountType: AccountType;
  businessStatus: BusinessStatus | null;
  companyName: string | null;
  taxCode: string | null;
  invoiceAddress: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    customer?: CurrentCustomer;
  }
}

const LAST_SEEN_REFRESH_MS = 5 * 60 * 1000;

export function toCurrentCustomer(row: Customer, sessionId: string): CurrentCustomer {
  return {
    id: row.id,
    sessionId,
    email: row.email,
    fullName: row.full_name,
    phone: row.phone,
    accountType: row.account_type,
    businessStatus: row.business_status,
    companyName: row.company_name,
    taxCode: row.tax_code,
    invoiceAddress: row.invoice_address,
  };
}

/** The shape returned to the frontend (no session id). */
export function customerProfile(customer: CurrentCustomer) {
  const { sessionId: _sessionId, ...profile } = customer;
  return { ...profile, priceTier: priceTierFor(customer) };
}

export async function findCustomerBySessionToken(db: Db, token: string): Promise<CurrentCustomer | null> {
  const row = await db
    .selectFrom('customer_sessions as s')
    .innerJoin('customers as c', 'c.id', 's.customer_id')
    .selectAll('c')
    .select(['s.id as session_id', 's.last_seen_at as session_last_seen_at'])
    .where('s.token_hash', '=', hashToken(token))
    .where('s.revoked_at', 'is', null)
    .where('s.expires_at', '>', sql<Date>`now()`)
    .where('c.status', '=', 'active')
    .executeTakeFirst();

  if (!row) return null;

  if (Date.now() - new Date(row.session_last_seen_at).getTime() > LAST_SEEN_REFRESH_MS) {
    await db.updateTable('customer_sessions').set({ last_seen_at: sql`now()` }).where('id', '=', row.session_id).execute();
  }
  return toCurrentCustomer(row, row.session_id);
}

/** For public routes: the logged-in customer, or null for guests. Never throws for a bad cookie. */
export async function getOptionalCustomer(db: Db, request: FastifyRequest): Promise<CurrentCustomer | null> {
  if (request.customer) return request.customer;
  const token = request.cookies[CUSTOMER_SESSION_COOKIE];
  if (!token) return null;
  const customer = await findCustomerBySessionToken(db, token);
  if (customer) request.customer = customer;
  return customer;
}

/** preHandler for routes that need a logged-in customer. */
export function requireCustomer(db: Db) {
  return async function requireCustomerHandler(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const customer = await getOptionalCustomer(db, request);
    if (!customer) throw unauthenticated();
  };
}

/** D8/D9: business prices only for business accounts that an admin has approved. */
export function priceTierFor(customer: Pick<CurrentCustomer, 'accountType' | 'businessStatus'> | null): PriceTier {
  return customer?.accountType === 'business' && customer.businessStatus === 'approved' ? 'business' : 'retail';
}

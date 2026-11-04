import type { DbOrTrx } from '../../db/client.js';

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
}

/**
 * Queue an email. Call it with the same transaction as the change it reports (new order, password
 * reset…): if the transaction rolls back, the email is never sent; if it commits, it will be sent
 * by the email worker even if the mail server is down right now.
 */
export async function enqueueEmail(db: DbOrTrx, message: EmailMessage): Promise<void> {
  await db.insertInto('email_outbox').values({ to_email: message.to, subject: message.subject, body_text: message.body }).execute();
}

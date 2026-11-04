import { createHash, randomBytes } from 'node:crypto';

/** 256-bit random token, URL-safe. Sent to the client once; only its hash is stored. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

import { describe, expect, it } from 'vitest';
import { hashPassword, validatePasswordStrength, verifyPassword } from '../src/lib/password.js';
import { generateToken, hashToken } from '../src/lib/tokens.js';

describe('password hashing', () => {
  it('verifies the right password and rejects others', async () => {
    const stored = await hashPassword('Trầm hương 2026!');
    expect(stored.startsWith('scrypt$32768$8$1$')).toBe(true);
    expect(await verifyPassword('Trầm hương 2026!', stored)).toBe(true);
    expect(await verifyPassword('Tram huong 2026!', stored)).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same password here')).not.toBe(await hashPassword('same password here'));
  });

  it('treats Unicode composed and decomposed forms as the same password', async () => {
    const stored = await hashPassword('Trầm hương'.normalize('NFC') + '-1234');
    expect(await verifyPassword('Trầm hương'.normalize('NFD') + '-1234', stored)).toBe(true);
  });

  it('returns false for malformed stored values instead of throwing', async () => {
    for (const bad of ['', 'plain', 'scrypt$x$8$1$a$b', 'bcrypt$1$2$3$4$5']) {
      expect(await verifyPassword('anything', bad)).toBe(false);
    }
  });

  it('enforces a minimum length', () => {
    expect(validatePasswordStrength('short')).not.toBeNull();
    expect(validatePasswordStrength('long enough passphrase')).toBeNull();
    expect(validatePasswordStrength(' padded passphrase ')).not.toBeNull();
  });
});

describe('session tokens', () => {
  it('are random, URL-safe and hash to 32 bytes', () => {
    const a = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(generateToken());
    expect(hashToken(a)).toHaveLength(32);
  });
});

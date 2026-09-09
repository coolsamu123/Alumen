// Password hashing for local accounts. No dependency on db.ts — this module
// stays importable from both users-repo.ts (Node route handlers) and db.ts
// (the one-time admin seed at startup) without creating a require cycle.
//
// scrypt is the Node stdlib choice, deliberately — see PLAN_USER_MANAGEMENT.md
// §8.8: this credential layer has a known expiration date (Okta SSO), so it
// isn't worth adding bcrypt/argon2 as a dependency for it.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, KEYLEN);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

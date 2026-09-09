import { getDb } from './db';
import { hashPassword } from './password';

export type Role = 'admin' | 'basic';

export interface UserRecord {
  id: number;
  email: string;
  name: string;
  auth_provider: 'local' | 'okta';
  password_hash: string | null;
  role: Role;
  is_active: number;
  token_version: number;
  created_at: string;
  last_login_at: string | null;
}

export function findUserByEmail(email: string): UserRecord | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase()) as
    | UserRecord
    | undefined;
}

export function findUserById(id: number): UserRecord | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRecord | undefined;
}

export function listUsers(): UserRecord[] {
  const db = getDb();
  return db.prepare('SELECT * FROM users ORDER BY created_at ASC').all() as UserRecord[];
}

/** Active admins — used to block the last-admin lockout (PLAN §8.5, guard 3). */
export function countActiveAdmins(): number {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(*) as c FROM users WHERE role='admin' AND is_active=1")
    .get() as { c: number };
  return row.c;
}

export function createLocalUser(params: {
  email: string;
  name: string;
  password: string;
  role: Role;
}): UserRecord {
  const db = getDb();
  const email = params.email.trim().toLowerCase();
  db.prepare(
    `INSERT INTO users (email, name, auth_provider, password_hash, role, is_active, token_version, created_at)
     VALUES (?, ?, 'local', ?, ?, 1, 1, datetime('now'))`
  ).run(email, params.name, hashPassword(params.password), params.role);
  return findUserByEmail(email)!;
}

/**
 * Create-or-update-as-admin by email. This is the one operation the
 * break-glass script (`scripts/create-admin.mjs`) needs: it works whether the
 * account exists yet or not, always leaves it active with role='admin', and
 * bumps token_version so any stale session for that email is invalidated.
 */
export function upsertLocalAdmin(params: {
  email: string;
  name: string;
  password: string;
}): UserRecord {
  const email = params.email.trim().toLowerCase();
  const existing = findUserByEmail(email);
  const db = getDb();
  const passwordHash = hashPassword(params.password);

  if (existing) {
    db.prepare(
      `UPDATE users
       SET name = ?, auth_provider = 'local', password_hash = ?, role = 'admin',
           is_active = 1, token_version = token_version + 1
       WHERE id = ?`
    ).run(params.name, passwordHash, existing.id);
    return findUserById(existing.id)!;
  }

  db.prepare(
    `INSERT INTO users (email, name, auth_provider, password_hash, role, is_active, token_version, created_at)
     VALUES (?, ?, 'local', ?, 'admin', 1, 1, datetime('now'))`
  ).run(email, params.name, passwordHash);
  return findUserByEmail(email)!;
}

export function touchLastLogin(id: number): void {
  const db = getDb();
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(id);
}

/** Invalidates every session cookie issued before this call, for this user. */
export function bumpTokenVersion(id: number): void {
  const db = getDb();
  db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(id);
}

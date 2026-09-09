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

export interface ScopeRow {
  scope_type: 'dds' | 'project';
  scope_value: string;
}

export function listUsersWithScopes(): Array<UserRecord & { scopes: ScopeRow[] }> {
  const db = getDb();
  const users = listUsers();
  const scopeRows = db
    .prepare('SELECT user_id, scope_type, scope_value FROM user_scopes')
    .all() as Array<{ user_id: number } & ScopeRow>;

  const byUser = new Map<number, ScopeRow[]>();
  for (const r of scopeRows) {
    const list = byUser.get(r.user_id) ?? [];
    list.push({ scope_type: r.scope_type, scope_value: r.scope_value });
    byUser.set(r.user_id, list);
  }

  return users.map(u => ({ ...u, scopes: byUser.get(u.id) ?? [] }));
}

export function getUserScopes(userId: number): ScopeRow[] {
  const db = getDb();
  return db
    .prepare('SELECT scope_type, scope_value FROM user_scopes WHERE user_id = ?')
    .all(userId) as ScopeRow[];
}

/** Replaces a user's entire scope set atomically — the UI submits the full
 * current selection each time rather than diffing individual grants. */
export function replaceUserScopes(
  userId: number,
  scopes: Array<{ type: 'dds' | 'project'; value: string }>
): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM user_scopes WHERE user_id = ?').run(userId);
    const insert = db.prepare(
      'INSERT INTO user_scopes (user_id, scope_type, scope_value) VALUES (?, ?, ?)'
    );
    for (const s of scopes) insert.run(userId, s.type, s.value);
  });
  tx();
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

// Each of the following bumps token_version — see PLAN_USER_MANAGEMENT.md
// §2.2: a session cookie issued before a deactivation/role change/password
// reset must fail the authoritative recheck in src/lib/auth.ts immediately,
// not just once it naturally expires.

export function setUserActive(id: number, isActive: boolean): void {
  const db = getDb();
  db.prepare(
    'UPDATE users SET is_active = ?, token_version = token_version + 1 WHERE id = ?'
  ).run(isActive ? 1 : 0, id);
}

export function setUserRole(id: number, role: Role): void {
  const db = getDb();
  db.prepare(
    'UPDATE users SET role = ?, token_version = token_version + 1 WHERE id = ?'
  ).run(role, id);
}

export function resetPassword(id: number, password: string): void {
  const db = getDb();
  db.prepare(
    'UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?'
  ).run(hashPassword(password), id);
}

/** Cascades to user_scopes via the users(id) foreign key (PRAGMA foreign_keys = ON). */
export function deleteUser(id: number): void {
  const db = getDb();
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

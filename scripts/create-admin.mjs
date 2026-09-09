#!/usr/bin/env node
// Break-glass admin creation/reset — run via SSH when the web UI can't help
// (first boot without ADMIN_BASIC_AUTH set, locked-out admin, or fixing the
// seeded admin's email before enabling Okta — see PLAN_USER_MANAGEMENT.md
// §2.4 and §8.1). Upserts by email: creates the row if it doesn't exist,
// otherwise resets it to an active local admin with the given name/password.
//
// Usage: node scripts/create-admin.mjs <email> "<name>" <password>

import Database from 'better-sqlite3';
import path from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';

const root = path.resolve(new URL('.', import.meta.url).pathname, '..');
const dbPath = path.join(root, 'data', 'cioo.db');

const [, , emailArg, nameArg, passwordArg] = process.argv;
if (!emailArg || !nameArg || !passwordArg) {
  console.error('Usage: node scripts/create-admin.mjs <email> "<name>" <password>');
  process.exit(1);
}

const email = emailArg.trim().toLowerCase();
if (!email.includes('@')) {
  console.error(`'${email}' doesn't look like an email. Refusing — see PLAN_USER_MANAGEMENT.md §8.1.`);
  process.exit(1);
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

const db = new Database(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL DEFAULT '',
    auth_provider TEXT NOT NULL DEFAULT 'local' CHECK (auth_provider IN ('local','okta')),
    password_hash TEXT,
    role          TEXT NOT NULL CHECK (role IN ('admin','basic')),
    is_active     INTEGER NOT NULL DEFAULT 1,
    token_version INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT
  );
`);

const passwordHash = hashPassword(passwordArg);
const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);

if (existing) {
  db.prepare(
    `UPDATE users
     SET name = ?, auth_provider = 'local', password_hash = ?, role = 'admin',
         is_active = 1, token_version = token_version + 1
     WHERE id = ?`
  ).run(nameArg, passwordHash, existing.id);
  console.log(`Updated existing user '${email}' → active local admin. Old sessions invalidated.`);
} else {
  db.prepare(
    `INSERT INTO users (email, name, auth_provider, password_hash, role, is_active, token_version, created_at)
     VALUES (?, ?, 'local', ?, 'admin', 1, 1, datetime('now'))`
  ).run(email, nameArg, passwordHash);
  console.log(`Created new admin '${email}'.`);
}

db.close();

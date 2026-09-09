// Scope resolution — PLAN_USER_MANAGEMENT.md §2.1, §3, §4.1.
//
// This is a UI-declutter filter, not a security boundary (§2.1: restricting
// visibility is a rare exception, not the threat model). `user_scopes` is an
// EXCEPTION list — a user with no rows in it sees the whole portfolio, which
// is also why 'ALL' is returned early for the common case rather than ever
// materializing "every project id" as a Set.
//
// Session is a required argument (not read from an ambient context) so a
// route that forgets to call this fails to compile instead of silently
// serving an unfiltered response.

import { getDb } from './db';
import type { AuthedUser } from './auth';

export type VisibleProjectIds = Set<string> | 'ALL';

export function getVisibleProjectIds(session: AuthedUser | null): VisibleProjectIds {
  // No session (anonymous public reader) or an admin: unrestricted. Public
  // read views staying open is unrelated to this — see §2.4/Fase 5.
  if (!session || session.role === 'admin') return 'ALL';

  const db = getDb();
  const scopes = db
    .prepare('SELECT scope_type, scope_value FROM user_scopes WHERE user_id = ?')
    .all(session.id) as Array<{ scope_type: 'dds' | 'project'; scope_value: string }>;

  if (scopes.length === 0) return 'ALL';

  const ddsValues = scopes.filter(s => s.scope_type === 'dds').map(s => s.scope_value);
  const projectIds = new Set(
    scopes.filter(s => s.scope_type === 'project').map(s => s.scope_value)
  );

  if (ddsValues.length === 0) return projectIds;

  // DDS grants are dynamic: resolved against the current `projects` table at
  // read time, so a project added to a granted DDS later shows up on its own
  // — no need to ever reassign a user's scope.
  const placeholders = ddsValues.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT DISTINCT project_id FROM projects WHERE dds IN (${placeholders})`)
    .all(...ddsValues) as Array<{ project_id: string }>;

  for (const r of rows) projectIds.add(r.project_id);
  return projectIds;
}

/**
 * An impact endpoint is visible if it's in the visible set, OR it's the
 * virtual GIO_SERVICES aggregator node (not a real project — see
 * ProjectContext.tsx and PLAN_USER_MANAGEMENT.md §2.3).
 */
export function isImpactEndpointVisible(
  projectId: string,
  visible: VisibleProjectIds
): boolean {
  if (visible === 'ALL') return true;
  if (projectId === 'GIO_SERVICES') return true;
  return visible.has(projectId);
}

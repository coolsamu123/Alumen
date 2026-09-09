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
import { fetchProjectSummariesForViews } from './impact-engine';
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
  const projectIds = scopes.filter(s => s.scope_type === 'project').map(s => s.scope_value);
  return resolveScopedProjectIds(ddsValues, projectIds);
}

/**
 * The DDS+project → project-id-set resolution, factored out so the admin
 * "how many projects will this grant show" preview (Fase 3) can compute the
 * exact same result a not-yet-saved scope draft would produce, without
 * duplicating the DDS lookup query.
 */
export function resolveScopedProjectIds(ddsValues: string[], projectIds: string[]): Set<string> {
  const result = new Set(projectIds);
  if (ddsValues.length === 0) return result;

  // DDS grants are dynamic: resolved at read time against each project's
  // CURRENT dds, so a project added to (or moved into) a granted DDS later
  // shows up on its own — no need to ever reassign a user's scope.
  //
  // Deliberately NOT a raw query against the `projects` table: that table
  // has one row per historical review, and a project's dds can change
  // between reviews — a naive `WHERE dds = ?` counts every review that ever
  // had that dds, not the project's current one. fetchProjectSummariesForViews()
  // already resolves "current dds" as the latest review's value (see
  // impact-engine.ts's `latestByReview`) and is the same source /api/projects
  // serves from, so scope resolution stays consistent with what the UI shows.
  const ddsSet = new Set(ddsValues);
  for (const s of fetchProjectSummariesForViews()) {
    if (ddsSet.has(s.dds)) result.add(s.projectId);
  }
  return result;
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

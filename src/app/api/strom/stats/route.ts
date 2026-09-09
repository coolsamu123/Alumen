import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

// Reads mutable state — must not be prerendered at build time. See the note in
// api/drive/projects/route.ts.
export const dynamic = 'force-dynamic';

// Read-only counts for the Strom Architecture header + StatsTab.
// One endpoint, ~1KB response, polled at most every few seconds by the UI.
export async function GET() {
  try {
    const db = getDb();
    const projects = (db.prepare('SELECT COUNT(*) c FROM projects').get() as { c: number }).c;
    const docsSuccess = (db.prepare("SELECT COUNT(*) c FROM documents_cache WHERE fetch_status='success'").get() as { c: number }).c;
    const docsSkipped = (db.prepare("SELECT COUNT(*) c FROM documents_cache WHERE fetch_status LIKE 'skipped_%'").get() as { c: number }).c;
    const docsError = (db.prepare("SELECT COUNT(*) c FROM documents_cache WHERE fetch_status='error'").get() as { c: number }).c;
    const goalsSuccess = (db.prepare("SELECT COUNT(*) c FROM project_goals WHERE status='success'").get() as { c: number }).c;
    const goalsV4 = (db.prepare("SELECT COUNT(*) c FROM project_goals WHERE status='success' AND prompt_version=4").get() as { c: number }).c;
    const impacts = (db.prepare('SELECT COUNT(*) c FROM projects_impact').get() as { c: number }).c;
    const impactsWithCitations = (db.prepare("SELECT COUNT(*) c FROM projects_impact WHERE citations != '[]' AND citations IS NOT NULL").get() as { c: number }).c;
    const impactsWithChain = (db.prepare("SELECT COUNT(*) c FROM projects_impact WHERE evidence_chain != '[]' AND evidence_chain IS NOT NULL").get() as { c: number }).c;
    const dives = (db.prepare('SELECT COUNT(*) c FROM impact_deep_dives').get() as { c: number }).c;

    return NextResponse.json({
      projects,
      documents: { success: docsSuccess, skipped: docsSkipped, error: docsError, total: docsSuccess + docsSkipped + docsError },
      goals: { success: goalsSuccess, v4: goalsV4 },
      impacts: { total: impacts, withCitations: impactsWithCitations, withChain: impactsWithChain },
      deepDives: dives,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

#!/usr/bin/env node
/**
 * Rewrites the GIO_SERVICES / DDS_IMPACTS rows of projects_impact from the
 * current project_goals.impact_claims — the same result impact-engine.ts
 * produces at the end of a run (materializeClaimsAsImpacts +
 * replaceMaterialisedClaimRows), without calling the LLM.
 *
 * Written for PLAN_PROMPTS_CATALOG_REVIEW.md Fase A (§2.1), which fixed two
 * things in stored data:
 *   - direction: roles describe what the TARGET does, so primary_provider now
 *     maps to depends_on and downstream_consumer to provides_to;
 *   - phantom edges: rows whose claim no longer exists are deleted instead of
 *     being left behind by INSERT OR REPLACE.
 * Project-to-project rows are not touched.
 *
 * Usage, from the app root:
 *   node scripts/rematerialize-claims.cjs          # dry run — prints what would change
 *   node scripts/rematerialize-claims.cjs --apply  # backs up the DB, then rewrites
 *
 * Run it only AFTER the code with the new mapping is deployed: the scheduler
 * materialises with whatever code is live, so running this first gets undone.
 *
 * Mirrors impact-engine.ts (ROLE_TO_DIRECTION, citation resolution,
 * evidence_chain format). Change both together.
 */
const path = require('path');
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const DB_PATH = path.join(__dirname, '..', 'data', 'cioo.db');

const ROLE_TO_DIRECTION = {
  primary_provider: 'depends_on',
  downstream_consumer: 'provides_to',
  regional_executor: 'requires_coordination',
  risk_owner: 'requires_coordination',
  blocked_by: 'depends_on',
};

const normalizeName = (s) => s.toLowerCase()
  .replace(/\.(txt|csv|pdf|docx?|xlsx?|md)$/i, '')
  .replace(/[_\s-]+/g, ' ')
  .replace(/[()]/g, '')
  .trim();

const rowKey = (r) => [r.source, r.target, r.impact_type, r.gio, r.dds].join('|');

function currentRows(db, lang) {
  return db.prepare(`
    SELECT source_project_id AS source, target_project_id AS target, impact_type,
           direction, gio_services AS gio, dds_entities AS dds
    FROM projects_impact
    WHERE output_language = ? AND target_project_id IN ('GIO_SERVICES', 'DDS_IMPACTS')
  `).all(lang);
}

function plannedRows(db, lang) {
  const goals = db.prepare(`
    SELECT id, project_id, impact_claims FROM project_goals
    WHERE project_id != '' AND status = 'success' AND output_language = ?
  `).all(lang);

  const fileMap = new Map();
  const ids = goals.map(g => g.project_id);
  if (ids.length > 0) {
    const docs = db.prepare(
      `SELECT project_id, url, file_name FROM documents_cache
       WHERE project_id IN (${ids.map(() => '?').join(',')}) AND fetch_status = 'success'`
    ).all(...ids);
    for (const d of docs) fileMap.set(`${d.project_id}|${normalizeName(d.file_name || '')}`, d.url);
  }

  // Keyed like the UNIQUE constraint, last claim wins — what INSERT OR REPLACE does.
  const byKey = new Map();
  for (const g of goals) {
    let claims;
    try { claims = JSON.parse(g.impact_claims || '[]'); } catch { continue; }
    if (!Array.isArray(claims)) continue;

    for (const c of claims) {
      if (!c || (c.target_kind !== 'gio' && c.target_kind !== 'dds')) continue;
      if (!c.target || !c.impact_type || !c.role) continue;

      const url = c.evidence_file ? fileMap.get(`${g.project_id}|${normalizeName(c.evidence_file)}`) : undefined;
      // storeImpacts links a row to every claim on the same (kind, target).
      const matches = [];
      claims.forEach((o, idx) => {
        if (o && o.target_kind === c.target_kind && o.target === c.target) matches.push(idx);
      });

      const row = {
        source: g.project_id,
        target: c.target_kind === 'gio' ? 'GIO_SERVICES' : 'DDS_IMPACTS',
        impact_type: c.impact_type,
        direction: ROLE_TO_DIRECTION[c.role] || 'requires_coordination',
        severity: (c.severity === 'medium' ? 'low' : c.severity) || 'low',
        explanation: c.evidence_quote || '',
        gio: JSON.stringify(c.target_kind === 'gio' ? [c.target] : []),
        dds: JSON.stringify(c.target_kind === 'dds' ? [c.target] : []),
        citations: JSON.stringify(url && c.evidence_quote ? [{ doc_url: url, snippet: c.evidence_quote }] : []),
        chain: JSON.stringify(matches.length > 0
          ? matches.map(i => ({ goal_id: g.id, claim_idx: i, source: 'claim' }))
          : [{ goal_id: g.id, source: 'free' }]),
      };
      byKey.set(rowKey(row), row);
    }
  }
  return [...byKey.values()];
}

function diff(current, planned) {
  const plannedByKey = new Map(planned.map(r => [rowKey(r), r]));
  const currentByKey = new Map(current.map(r => [rowKey(r), r]));
  let removed = 0, added = 0, directionChanged = 0;
  const removedByProject = new Map();
  for (const [k, r] of currentByKey) {
    const p = plannedByKey.get(k);
    if (!p) {
      removed++;
      removedByProject.set(r.source, (removedByProject.get(r.source) || 0) + 1);
    } else if (p.direction !== r.direction) {
      directionChanged++;
    }
  }
  for (const k of plannedByKey.keys()) if (!currentByKey.has(k)) added++;
  return { removed, added, directionChanged, projectsWithRemovals: removedByProject.size };
}

async function main() {
  const db = new Database(DB_PATH, { fileMustExist: true });
  db.pragma('busy_timeout = 5000');

  const busy = db.prepare(`
    SELECT (SELECT COUNT(*) FROM impact_runs WHERE status = 'running')
         + (SELECT COUNT(*) FROM goals_runs WHERE status = 'running')
         + (SELECT COUNT(*) FROM auto_runs WHERE finished_at IS NULL) AS n
  `).get().n;
  if (busy > 0) {
    console.error('An Impact, Goals or auto-discovery run is in progress. Run this again once it finishes.');
    process.exit(1);
  }

  const langs = db.prepare(`
    SELECT output_language AS lang FROM project_goals WHERE status = 'success'
    UNION
    SELECT output_language FROM projects_impact WHERE target_project_id IN ('GIO_SERVICES', 'DDS_IMPACTS')
  `).all().map(r => r.lang);

  const plans = {};
  for (const lang of langs) {
    const current = currentRows(db, lang);
    const planned = plannedRows(db, lang);
    plans[lang] = planned;
    const d = diff(current, planned);
    console.log(
      `[${lang}] GIO/DDS rows now: ${current.length} → after: ${planned.length} | ` +
      `removed: ${d.removed} (in ${d.projectsWithRemovals} projects) | added: ${d.added} | ` +
      `direction changed: ${d.directionChanged}`
    );
  }

  if (!APPLY) {
    console.log('\nDry run — nothing was written. Re-run with --apply to back up the DB and rewrite.');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${DB_PATH}.bak-rematerialize-${stamp}`;
  await db.backup(backupPath);
  console.log(`\nBackup written: ${backupPath}`);

  const insert = db.prepare(`
    INSERT OR REPLACE INTO projects_impact
      (source_project_id, target_project_id, impact_type, direction, severity, explanation,
       batch_id, gio_services, dds_entities, citations, evidence_chain, output_language)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const batchId = `rematerialize-${stamp}`;
  db.transaction(() => {
    for (const lang of langs) {
      db.prepare(
        "DELETE FROM projects_impact WHERE output_language = ? AND target_project_id IN ('GIO_SERVICES', 'DDS_IMPACTS')"
      ).run(lang);
      for (const r of plans[lang]) {
        insert.run(r.source, r.target, r.impact_type, r.direction, r.severity, r.explanation,
          batchId, r.gio, r.dds, r.citations, r.chain, lang);
      }
    }
  })();

  let mismatches = 0;
  for (const lang of langs) {
    const d = diff(currentRows(db, lang), plans[lang]);
    mismatches += d.removed + d.added + d.directionChanged;
  }
  console.log(mismatches === 0
    ? 'Applied. Stored GIO/DDS rows now match the current claims exactly.'
    : `Applied, but ${mismatches} row(s) still differ from the plan — inspect before trusting the data.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

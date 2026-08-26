const Database = require('better-sqlite3');
const db = new Database('/opt/strom/app/data/cioo.db');

const ROLE_TO_DIRECTION = {
  primary_provider: 'provides_to',
  downstream_consumer: 'depends_on',
  regional_executor: 'requires_coordination',
  risk_owner: 'requires_coordination',
  blocked_by: 'depends_on',
};

const normalizeName = (s) =>
  s.toLowerCase()
    .replace(/\.(txt|csv|pdf|docx?|xlsx?|md)$/i, '')
    .replace(/[_\s-]+/g, ' ')
    .replace(/[()]/g, '')
    .trim();

function runForLang(lang) {
  const goals = db.prepare(`
    SELECT id, project_id, impact_claims
    FROM project_goals
    WHERE status='success' AND output_language=? AND impact_claims IS NOT NULL AND impact_claims != '[]'
  `).all(lang);

  const allProjectIds = [...new Set(goals.map(g => g.project_id))];
  const fileMap = new Map();
  if (allProjectIds.length > 0) {
    const ph = allProjectIds.map(() => '?').join(',');
    const docs = db.prepare(
      `SELECT project_id, url, file_name FROM documents_cache WHERE project_id IN (${ph}) AND fetch_status='success'`
    ).all(...allProjectIds);
    for (const d of docs) {
      fileMap.set(`${d.project_id}|${normalizeName(d.file_name)}`, { url: d.url, file_name: d.file_name });
    }
  }

  const ins = db.prepare(`
    INSERT OR REPLACE INTO projects_impact
    (source_project_id, target_project_id, impact_type, direction, severity, explanation, batch_id, gio_services, dds_entities, citations, evidence_chain, output_language)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const batchId = 'rematerialise-2026-06-18';
  let claimsSeen = 0, claimsKept = 0, claimsDropped = 0;

  const trx = db.transaction(() => {
    for (const g of goals) {
      let claims;
      try { claims = JSON.parse(g.impact_claims); } catch { continue; }
      if (!Array.isArray(claims)) continue;

      // Pre-index claims to compute claim_idx for evidence_chain
      claims.forEach((c, claim_idx) => {
        claimsSeen++;
        if (!c || (c.target_kind !== 'gio' && c.target_kind !== 'dds')) { claimsDropped++; return; }
        if (!c.target || !c.impact_type || !c.role) { claimsDropped++; return; }

        const pseudoTarget = c.target_kind === 'gio' ? 'GIO_SERVICES' : 'DDS_IMPACTS';
        const direction = ROLE_TO_DIRECTION[c.role] || 'requires_coordination';
        const severity = (c.severity === 'medium' ? 'low' : c.severity) || 'low';

        const doc = c.evidence_file ? fileMap.get(`${g.project_id}|${normalizeName(c.evidence_file)}`) : undefined;
        const citations = (doc && c.evidence_quote)
          ? [{ doc_url: doc.url, snippet: c.evidence_quote }]
          : [];

        const evidenceChain = [{ goal_id: g.id, claim_idx, source: 'claim' }];

        ins.run(
          g.project_id,
          pseudoTarget,
          c.impact_type,
          direction,
          severity,
          c.evidence_quote || '',
          batchId,
          JSON.stringify(c.target_kind === 'gio' ? [c.target] : []),
          JSON.stringify(c.target_kind === 'dds' ? [c.target] : []),
          JSON.stringify(citations),
          JSON.stringify(evidenceChain),
          lang
        );
        claimsKept++;
      });
    }
  });
  trx();

  console.log(`[${lang}] materialised ${claimsKept}/${claimsSeen} (dropped ${claimsDropped})`);
}

for (const lang of ['en', 'fr']) runForLang(lang);

console.log('\n=== Post counts ===');
console.log(db.prepare("SELECT output_language, target_project_id, COUNT(*) as n FROM projects_impact GROUP BY output_language, target_project_id ORDER BY output_language, target_project_id").all());

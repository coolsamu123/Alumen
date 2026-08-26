import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getProjectImpacts, aggregateImpacts } from '@/lib/impact-engine';
import { composeNarrative } from '@/lib/impact-narrative';
import { getActiveOutputLanguage } from '@/lib/llm';
import type { ProjectImpact, ImpactCitation } from '@/lib/types';

interface ProjectMeta {
  projectId: string;
  name: string;
  dds: string;
  currentGate: string;
  costKEur: number | null;
  description: string;
}

interface PseudoNodeImpact {
  // Raw aggregated impact this node was extracted from
  impactId: number;
  severity: string;
  direction: string;
  impactTypes: string[];
  explanations: string[];
  // citationsByExplanation[i] backs explanations[i]; empty array when the LLM
  // could not ground that explanation in any document.
  citationsByExplanation: ImpactCitation[][];
  // Parallel: per-explanation impact_type and severity (the values from the
  // original raw row that produced explanations[i]). Lets the UI render
  // per-message badges instead of only the unioned card-level badges.
  impactTypeByExplanation: string[];
  severityByExplanation: string[];
  // Parallel: synthesised "Why this matters" narrative composed from
  // project name + direction + target + impact_type + severity + summary.
  // Renders as the headline of the Reason tab; the original verbatim quote
  // (explanations[i]) becomes the audit-grade "Evidence" companion.
  narrativeByExplanation: string[];
  // The "primary" explanation (longest at highest severity)
  explanation: string;
}

interface PseudoNode {
  // Display name (e.g., 'Cloud Services' or 'Americas')
  name: string;
  // Aggregated severity for the node (max across all impacts touching it)
  severity: string;
  // All impacts that mention this node (one project may have multiple raw rows)
  impacts: PseudoNodeImpact[];
}

interface ProjectEdge {
  otherProjectId: string;
  otherProjectName: string;
  otherProjectDds: string;
  severity: string;
  direction: string;
  impactTypes: string[];
  explanations: string[];
  citationsByExplanation: ImpactCitation[][];
  impactTypeByExplanation: string[];
  severityByExplanation: string[];
  // Same role as PseudoNodeImpact.narrativeByExplanation — see comment there.
  narrativeByExplanation: string[];
  explanation: string;
  count: number;
  bidirectional: boolean;
}

// Two-tier severity rank. `medium` is aliased to `low` so any stray legacy row
// sorts as low rather than landing in the unknown-zero bucket.
const SEVERITY_RANK: Record<string, number> = { high: 2, low: 1, medium: 1 };

function pickMaxSeverity(items: { severity: string }[]): string {
  let best = 'low';
  let rank = 0;
  for (const it of items) {
    const r = SEVERITY_RANK[it.severity] ?? 0;
    if (r > rank) { rank = r; best = it.severity; }
  }
  return best;
}

function pickMaxSeverityFromList(severities: string[]): string {
  let best = 'low';
  let rank = 0;
  for (const s of severities) {
    const r = SEVERITY_RANK[s] ?? 0;
    if (r > rank) { rank = r; best = s; }
  }
  return best;
}

function fanOutPseudo(
  impacts: ProjectImpact[],
  pseudoTarget: 'GIO_SERVICES' | 'DDS_IMPACTS',
  pickList: (imp: ProjectImpact) => string[],
  pickPerExplanation: (imp: ProjectImpact) => string[][] | undefined,
  // Per-source-project summary lookup used to compose the narrative. Keyed
  // by sourceProjectId; missing entries → narrative skips the project-context
  // sentence (the relationship + classifier sentences still render).
  projectInfo: Map<string, { name: string; summary: string }>,
): PseudoNode[] {
  const byName = new Map<string, PseudoNodeImpact[]>();

  for (const imp of impacts) {
    if (imp.sourceProjectId !== pseudoTarget && imp.targetProjectId !== pseudoTarget) continue;
    const names = pickList(imp);
    const explanations = imp.explanations ?? [imp.explanation];
    const cbe = imp.citationsByExplanation
      ?? explanations.map((_, i) => (i === 0 ? (imp.citations ?? []) : []));
    const itbe = imp.impactTypeByExplanation ?? explanations.map(() => imp.impactType);
    const sbe = imp.severityByExplanation ?? explanations.map(() => imp.severity);
    const perExpLists = pickPerExplanation(imp);

    // Source project context — for GIO/DDS fan-out the "source" is whichever
    // side isn't the pseudo target. In practice that's always the centered
    // project, but resolve generically so we cope with legacy rows where
    // direction was inverted.
    const sourceProjectId = imp.sourceProjectId === pseudoTarget ? imp.targetProjectId : imp.sourceProjectId;
    const sourceInfo = projectInfo.get(sourceProjectId);
    const sourceName = sourceInfo?.name || sourceProjectId;
    const sourceSummary = sourceInfo?.summary || '';

    for (const name of names) {
      // Filter explanations to those whose ORIGINATING raw row pointed at
      // this specific service/entity. Without this, the aggregate's UNION
      // of services causes every node to show every message — leaking
      // Cloud Services messages into Security & Compliance card, etc.
      let keepIdx: number[];
      if (Array.isArray(perExpLists) && perExpLists.length === explanations.length) {
        keepIdx = explanations
          .map((_, i) => i)
          .filter(i => (perExpLists[i] || []).includes(name));
        // Defensive fallback: if the parallel array misses (legacy data),
        // keep all explanations so the card isn't empty.
        if (keepIdx.length === 0) keepIdx = explanations.map((_, i) => i);
      } else {
        keepIdx = explanations.map((_, i) => i);
      }

      // Per-node severity/impactTypes must reflect ONLY the rows that originated
      // at this specific service/entity — NOT the aggregated row's primary
      // severity. Without this re-derivation, the aggregator's "primary"
      // (highest-severity row in the unordered project_pair group) leaks into
      // every sibling node fan-out: a project with one high-severity claim on
      // Security & Compliance and one medium-severity claim on User Workplace
      // would draw BOTH edges in red because both share the same aggregated
      // primary. The original raw severities live in severityByExplanation[],
      // already filtered to this node by keepIdx — recompute the max from
      // there, and union the per-node impact_types the same way.
      const kept_sbe = keepIdx.map(i => sbe[i] ?? imp.severity);
      const kept_itbe = keepIdx.map(i => itbe[i] ?? imp.impactType);
      const nodeSeverity = kept_sbe.length > 0 ? pickMaxSeverityFromList(kept_sbe) : imp.severity;
      const nodeImpactTypes = Array.from(new Set(kept_itbe.filter(Boolean)));

      const arr = byName.get(name) ?? [];
      arr.push({
        impactId: imp.id,
        severity: nodeSeverity,
        direction: imp.direction,
        impactTypes: nodeImpactTypes.length > 0 ? nodeImpactTypes : [imp.impactType],
        explanations: keepIdx.map(i => explanations[i]),
        citationsByExplanation: keepIdx.map(i => cbe[i] ?? []),
        impactTypeByExplanation: kept_itbe,
        severityByExplanation: kept_sbe,
        narrativeByExplanation: keepIdx.map(i => composeNarrative({
          sourceProjectName: sourceName,
          sourceSummary,
          targetName: name,
          direction: imp.direction,
          impactType: itbe[i] ?? imp.impactType,
          severity: sbe[i] ?? imp.severity,
        })),
        explanation: imp.explanation,
      });
      byName.set(name, arr);
    }
  }

  return Array.from(byName.entries()).map(([name, impacts]) => ({
    name,
    severity: pickMaxSeverity(impacts),
    impacts,
  })).sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0));
}

// Onda 4 fallback: when impact rows have empty `citations[]` but a populated
// `evidenceChain` (which happens since Goals now extracts atomic claims and
// the Impact LLM is told to leave evidence in the claim itself), synthesize
// citations from the underlying claim/relation. Runs on RAW rows (before
// aggregation) so each row's chain produces its own citation set — the
// downstream `aggregateImpacts` then keeps `citationsByExplanation[i]`
// aligned with `explanations[i]` naturally.
function enrichEmptyCitations(impacts: ProjectImpact[]): void {
  const db = getDb();

  const goalIds = new Set<number>();
  for (const imp of impacts) {
    const hasCitations = (imp.citations?.length ?? 0) > 0;
    if (hasCitations) continue;
    for (const e of imp.evidenceChain ?? []) {
      if (typeof e.goal_id === 'number') goalIds.add(e.goal_id);
    }
  }
  if (goalIds.size === 0) return;

  const ids = Array.from(goalIds);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, project_id, impact_claims, project_relations FROM project_goals WHERE id IN (${placeholders})`
  ).all(...ids) as Array<{ id: number; project_id: string; impact_claims: string; project_relations: string }>;
  const goalById = new Map<number, { project_id: string; claims: Array<{ evidence_file: string; evidence_quote: string }>; relations: Array<{ evidence_quote: string; source_file: string }> }>();
  for (const r of rows) {
    let claims: Array<{ evidence_file: string; evidence_quote: string }> = [];
    let relations: Array<{ evidence_quote: string; source_file: string }> = [];
    try { const v = JSON.parse(r.impact_claims || '[]'); if (Array.isArray(v)) claims = v; } catch { /* ignore */ }
    try { const v = JSON.parse(r.project_relations || '[]'); if (Array.isArray(v)) relations = v; } catch { /* ignore */ }
    goalById.set(r.id, { project_id: r.project_id, claims, relations });
  }

  // Build file_name → (doc_url) map for the project_ids we care about. The
  // Goals LLM emits `evidence_file` as a filename WITHOUT [doc_url=...] prefix.
  // The convention is inconsistent across paths (on-disk uses underscores +
  // .txt; documents_cache uses spaces + no extension), so we index by a
  // normalized key that strips extensions and unifies separators.
  const projectIds = Array.from(new Set(rows.map(r => r.project_id)));
  const normalizeName = (s: string) =>
    s.toLowerCase()
      .replace(/\.(txt|csv|pdf|docx?|xlsx?|md)$/i, '')
      .replace(/[_\s-]+/g, ' ')
      .replace(/[()]/g, '')
      .trim();
  const fileMap = new Map<string, { url: string; file_name: string }>(); // key = `${project_id}|${normalized_name}`
  if (projectIds.length > 0) {
    const ph = projectIds.map(() => '?').join(',');
    const docs = db.prepare(
      `SELECT project_id, url, file_name FROM documents_cache WHERE project_id IN (${ph}) AND fetch_status = 'success'`
    ).all(...projectIds) as Array<{ project_id: string; url: string; file_name: string }>;
    for (const d of docs) {
      fileMap.set(`${d.project_id}|${normalizeName(d.file_name)}`, { url: d.url, file_name: d.file_name });
    }
  }

  for (const imp of impacts) {
    const hasCitations = (imp.citations?.length ?? 0) > 0;
    if (hasCitations) continue;
    const chain = imp.evidenceChain ?? [];
    if (chain.length === 0) continue;
    const synth: ImpactCitation[] = [];
    const seen = new Set<string>();
    for (const e of chain) {
      const g = goalById.get(e.goal_id);
      if (!g) continue;
      let quote = '', fileName = '';
      if (e.source === 'claim' && typeof e.claim_idx === 'number') {
        const c = g.claims[e.claim_idx];
        if (!c) continue;
        quote = c.evidence_quote; fileName = c.evidence_file;
      } else if (e.source === 'relation' && typeof e.relation_idx === 'number') {
        const r = g.relations[e.relation_idx];
        if (!r) continue;
        quote = r.evidence_quote; fileName = r.source_file;
      } else {
        continue; // 'free' source has no quote to surface
      }
      if (!quote) continue;
      const key = `${g.project_id}|${fileName}|${quote.slice(0, 60)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const doc = fileMap.get(`${g.project_id}|${normalizeName(fileName)}`);
      synth.push({
        doc_url: doc?.url || '',
        file_name: doc?.file_name || fileName || '(unknown file)',
        snippet: quote,
      });
    }
    if (synth.length > 0) {
      // Mutate the RAW row in place — aggregateImpacts later reads
      // `citations` from each row and aligns it with explanations[i].
      imp.citations = synth;
    }
  }
}

// Latest summary_one_line per project from project_goals, scoped to the
// active output language so the narrative matches the language of the impact
// rows we're rendering. Used by composeNarrative for the "Why this matters"
// project-context sentence. Falls back gracefully when a project has no
// extracted goal row in the active language — narrative omits that sentence.
function lookupProjectSummaries(
  projectIds: string[],
  lang: string,
): Map<string, { name: string; summary: string }> {
  if (projectIds.length === 0) return new Map();
  const db = getDb();
  const placeholders = projectIds.map(() => '?').join(',');
  // First pass: rows in the active language. Most recent first.
  const rows = db.prepare(`
    SELECT project_id, project_name, summary_one_line, analyzed_at
    FROM project_goals
    WHERE project_id IN (${placeholders})
      AND status = 'success'
      AND output_language = ?
    ORDER BY analyzed_at DESC
  `).all(...projectIds, lang) as Array<{ project_id: string; project_name: string; summary_one_line: string; analyzed_at: string }>;

  const out = new Map<string, { name: string; summary: string }>();
  for (const r of rows) {
    if (out.has(r.project_id)) continue;
    out.set(r.project_id, {
      name: r.project_name || r.project_id,
      summary: r.summary_one_line || '',
    });
  }
  // Fallback: any-language row for projects that don't have an entry in the
  // active language (e.g. analysed only in EN but user switched to FR).
  const missing = projectIds.filter(id => !out.has(id));
  if (missing.length > 0) {
    const ph2 = missing.map(() => '?').join(',');
    const fallback = db.prepare(`
      SELECT project_id, project_name, summary_one_line
      FROM project_goals
      WHERE project_id IN (${ph2}) AND status = 'success'
      ORDER BY analyzed_at DESC
    `).all(...missing) as Array<{ project_id: string; project_name: string; summary_one_line: string }>;
    for (const r of fallback) {
      if (out.has(r.project_id)) continue;
      out.set(r.project_id, {
        name: r.project_name || r.project_id,
        summary: r.summary_one_line || '',
      });
    }
  }
  return out;
}

function lookupProjectMeta(projectIds: string[]): Map<string, ProjectMeta> {
  if (projectIds.length === 0) return new Map();
  const db = getDb();
  const placeholders = projectIds.map(() => '?').join(',');
  // Use latest review per project for the meta
  const rows = db.prepare(`
    SELECT project_id, name, dds, gate, cost_keur, description
    FROM projects
    WHERE project_id IN (${placeholders})
    ORDER BY review_date DESC
  `).all(...projectIds) as Array<{
    project_id: string;
    name: string;
    dds: string;
    gate: string;
    cost_keur: number | null;
    description: string;
  }>;

  const out = new Map<string, ProjectMeta>();
  for (const r of rows) {
    if (out.has(r.project_id)) continue; // first wins (latest review)
    out.set(r.project_id, {
      projectId: r.project_id,
      name: r.name,
      dds: r.dds || '',
      currentGate: r.gate || '',
      costKEur: r.cost_keur,
      description: r.description || '',
    });
  }
  return out;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId');
    if (!projectId) {
      return NextResponse.json({ error: 'Missing required query parameter: projectId' }, { status: 400 });
    }

    // 1) Fetch all raw impacts for this project, then aggregate (merges duplicate
    //    pairs and unions gioServices/ddsEntities/explanations).
    const raw = getProjectImpacts(projectId);
    // Onda 4 fallback: backfill each raw row's empty citations from its own
    // evidenceChain → goal claim/relation. RUNS BEFORE AGGREGATE so the
    // per-row alignment is preserved through aggregateImpacts (each
    // explanations[i] keeps its specific citationsByExplanation[i]).
    enrichEmptyCitations(raw);
    const aggregated = aggregateImpacts(raw);

    // 2) Center project meta
    const centerMetaMap = lookupProjectMeta([projectId]);
    const center = centerMetaMap.get(projectId) ?? {
      projectId,
      name: projectId,
      dds: '',
      currentGate: '',
      costKEur: null,
      description: '',
    };

    // 3) Look up summary_one_line for every source project referenced by any
    //    aggregated row. Used by composeNarrative to add a project-context
    //    sentence ("X is a study to evaluate…") to each "Why this matters".
    const allSourceIds = Array.from(new Set(
      aggregated.flatMap(imp => [imp.sourceProjectId, imp.targetProjectId])
        .filter(id => id !== 'GIO_SERVICES' && id !== 'DDS_IMPACTS')
    ));
    const projectInfo = lookupProjectSummaries(allSourceIds, getActiveOutputLanguage());

    // 4) Fan out GIO services into nodes — pick the union of services AND
    //    the per-explanation services so each node card filters down to only
    //    its own messages instead of receiving the project's whole union.
    const gioNodes = fanOutPseudo(aggregated, 'GIO_SERVICES',
      imp => imp.gioServices ?? [],
      imp => imp.gioServicesByExplanation,
      projectInfo);

    // 5) Fan out DDS entities into nodes
    const ddsNodes = fanOutPseudo(aggregated, 'DDS_IMPACTS',
      imp => imp.ddsEntities ?? [],
      imp => imp.ddsEntitiesByExplanation,
      projectInfo);

    // 6) Project-to-project edges (exclude pseudo-targets)
    const projectEdgeRaw = aggregated.filter(imp =>
      imp.sourceProjectId !== 'GIO_SERVICES' && imp.targetProjectId !== 'GIO_SERVICES' &&
      imp.sourceProjectId !== 'DDS_IMPACTS'  && imp.targetProjectId !== 'DDS_IMPACTS'
    );

    const otherIds = Array.from(new Set(
      projectEdgeRaw.flatMap(imp => [imp.sourceProjectId, imp.targetProjectId])
        .filter(id => id !== projectId)
    ));
    const otherMeta = lookupProjectMeta(otherIds);

    const projectEdges: ProjectEdge[] = projectEdgeRaw.map(imp => {
      const otherId = imp.sourceProjectId === projectId ? imp.targetProjectId : imp.sourceProjectId;
      const meta = otherMeta.get(otherId);
      const explanations = imp.explanations ?? [imp.explanation];
      const cbe = imp.citationsByExplanation
        ?? explanations.map((_, i) => (i === 0 ? (imp.citations ?? []) : []));
      const itbe = imp.impactTypeByExplanation ?? explanations.map(() => imp.impactType);
      const sbe = imp.severityByExplanation ?? explanations.map(() => imp.severity);
      // For project-to-project edges the narrative speaks from the row's
      // *actual* source side (which may be the centered project OR the other
      // project, depending on direction).
      const srcInfo = projectInfo.get(imp.sourceProjectId);
      const tgtInfo = projectInfo.get(imp.targetProjectId);
      const sourceName = srcInfo?.name || imp.sourceProjectId;
      const targetName = tgtInfo?.name || imp.targetProjectId;
      const sourceSummary = srcInfo?.summary || '';
      return {
        otherProjectId: otherId,
        otherProjectName: meta?.name || otherId,
        otherProjectDds: meta?.dds || '',
        severity: imp.severity,
        direction: imp.direction,
        impactTypes: imp.impactTypes ?? [imp.impactType],
        explanations,
        citationsByExplanation: cbe,
        impactTypeByExplanation: itbe,
        severityByExplanation: sbe,
        narrativeByExplanation: explanations.map((_, i) => composeNarrative({
          sourceProjectName: sourceName,
          sourceSummary,
          targetName,
          direction: imp.direction,
          impactType: itbe[i] ?? imp.impactType,
          severity: sbe[i] ?? imp.severity,
        })),
        explanation: imp.explanation,
        count: imp.count ?? 1,
        bidirectional: imp.bidirectional ?? false,
      };
    }).sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0));

    return NextResponse.json({
      project: center,
      gioNodes,
      ddsNodes,
      projectEdges,
      stats: {
        gioCount: gioNodes.length,
        ddsCount: ddsNodes.length,
        projectCount: projectEdges.length,
        totalImpacts: aggregated.length,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

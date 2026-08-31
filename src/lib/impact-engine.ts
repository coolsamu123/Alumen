import { v4 as uuidv4 } from 'uuid';
import { getDb } from './db';
import { extractTags } from './similarity';
import { getProjectDocuments, getFileNamesForUrls } from './drive-engine';
import { getPrompts } from './prompts';
import { generateContent, getActiveOutputLanguage, type OutputLanguage } from './llm';
import { normalizeDdsList } from './dds-catalog';
import { isCanonicalTarget, IMPACT_TYPES, IMPACT_DIRECTIONS } from './target-catalog';
import { normalizeProjectId } from './project-id';
import type { CIOOProject, CIOOService, ProjectImpact, ProjectSummary, ImpactAnalysisStatus } from './types';

// ─── Module-level state for tracking analysis progress ───────────────────────

// Reads succeeded Goals rows for the active output language. Callers MUST
// bind the language as the single positional parameter; we use a `?` here
// (rather than baking the language into the string) so prepared-statement
// caching inside better-sqlite3 still pays off.
export const IMPACT_ANALYSIS_QUERY = `
  SELECT
    g.id as goal_id, g.project_id, g.project_name, g.region, g.gate as goal_gate,
    g.month_folder, g.summary_one_line,
    g.digital_technologies, g.change_management, g.security_impacts,
    g.regional_impacts, g.ia_embedded, g.gio_sl_dds_impacts, g.dds_gio_workload,
    g.business_apps_cis,
    g.dds_entities_touched, g.gio_services_touched,
    g.tech_tags, g.vendors, g.data_classifications, g.mentioned_projects,
    g.project_relations, g.out_of_scope,
    g.impact_claims, g.timeline_struct,
    g.raw_gemini_response, g.source_files, g.analyzed_at,
    g.status as goal_status, g.error_message,
    g.output_language,
    p.name as proj_name, p.dds, p.gate as proj_gate, p.decision, p.cost_keur, p.description, p.remarks,
    p.review_date, p.link_positions, p.link_folder, p.link_cioo,
    p.services
  FROM project_goals g
  LEFT JOIN projects p ON g.project_id = p.project_id
  WHERE g.project_id != '' AND g.status = 'success' AND g.output_language = ?
  ORDER BY g.project_id, p.review_date DESC
`;

let analysisStatus: ImpactAnalysisStatus = {
  isRunning: false,
  totalProjects: 0,
  totalBatches: 0,
  completedBatches: 0,
  totalImpacts: 0,
  currentBatchDDS: '',
  errors: [],
  warnings: [],
};

// ─── Fetch all project summaries from DB ─────────────────────────────────────

export interface ProjectRelation {
  project_id: string;
  kind: string;
  relation: string;
  source_file: string;
  evidence_quote: string;
  confidence: 'stated' | 'inferred';
}

export interface OutOfScope {
  topic: string;
  evidence_quote: string;
  source_file: string;
}

// Onda 3: atomic anchored claims emitted by Goals — the Impact engine treats
// these as the authoritative source for GIO/DDS edges, replacing free-text
// inference from `gio_sl_dds_impacts`.
export interface ImpactClaim {
  target_kind: 'gio' | 'dds';
  target: string;
  role: 'primary_provider' | 'downstream_consumer' | 'regional_executor' | 'risk_owner' | 'blocked_by' | string;
  severity: 'high' | 'medium' | 'low' | string;
  impact_type: string;
  evidence_file: string;
  evidence_quote: string;
  confidence: 'stated' | 'inferred';
}

export interface TimelineDep {
  project_id: string;
  reason: string;
  evidence_file: string;
  evidence_quote: string;
}

export interface TimelineStruct {
  gate1_actual: string | null;
  gate2_target: string | null;
  go_live_target: string | null;
  must_complete_before: TimelineDep[];
  blocked_by: TimelineDep[];
}

export interface GoalEntry {
  goal_id: number;
  gate: string;
  decision: string;
  review_date: string;
  region: string;
  month_folder: string;
  summary_one_line: string;
  digital_technologies: string;
  change_management: string;
  security_impacts: string;
  regional_impacts: string;
  ia_embedded: string;
  gio_sl_dds_impacts: string;
  dds_gio_workload: string;
  business_apps_cis: string;
  dds_entities_touched: string[];
  gio_services_touched: string[];
  tech_tags: string[];
  vendors: string[];
  data_classifications: string[];
  mentioned_projects: string[];
  project_relations: ProjectRelation[];
  out_of_scope: OutOfScope[];
  impact_claims: ImpactClaim[];
  timeline_struct: TimelineStruct | null;
  source_files: string;
  analyzed_at: string;
  goal_status: string;
}

export interface ProjectFullRecord {
  projectId: string;
  name: string;
  dds: string;
  currentGate: string;
  costKEur: number | null;
  description: string;
  remarks: string;
  decision: string;
  reviewDate: string;
  linkPositions: string;
  linkFolder: string;
  linkCIOO: string;
  services: CIOOService[];
  goalEntries: GoalEntry[];
  tags: string[];
}

function fetchAllProjectRecords(lang: OutputLanguage = getActiveOutputLanguage()): ProjectFullRecord[] {
  const db = getDb();
  const rows = db.prepare(IMPACT_ANALYSIS_QUERY).all(lang) as Record<string, unknown>[];

  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const key = row.project_id as string;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(row);
  }

  const records: ProjectFullRecord[] = [];
  for (const [projectId, entries] of Array.from(grouped.entries())) {
    const sortedEntries = [...entries].sort((a, b) => {
      const aDate = (a.analyzed_at as string) || '';
      const bDate = (b.analyzed_at as string) || '';
      return bDate.localeCompare(aDate);
    });

    const byReviewDate = sortedEntries.filter(e => e.review_date && String(e.review_date).trim());
    const latestByReview = byReviewDate.length > 0 ? byReviewDate[0] : sortedEntries[0];
    const latestByAnalyzed = sortedEntries[0];

    const allDescriptions = entries.map(e => e.description as string).filter(Boolean);
    const allRemarks = entries.map(e => e.remarks as string).filter(Boolean);
    let bestDescription = allDescriptions.join(' | ');
    const bestRemarks = allRemarks.join(' | ');

    // Fallback: when the projects row is a placeholder (no description), synthesize one
    // from the goal analysis so Details/Timeline/Matrix/Graph have something to render.
    // Prefer the curated one-liner; fall back to tech/biz text.
    if (!bestDescription) {
      const g = latestByAnalyzed;
      const summary = (g.summary_one_line as string) || '';
      const digital = (g.digital_technologies as string) || '';
      const business = (g.business_apps_cis as string) || '';
      bestDescription = (summary || digital || business).slice(0, 400);
    }

    // Fallback review date: project row has no review_date → use goal analysis date.
    let reviewDateStr = (latestByReview.review_date as string) || '';
    if (!reviewDateStr) {
      const analyzedAt = (latestByAnalyzed.analyzed_at as string) || '';
      reviewDateStr = analyzedAt.slice(0, 10); // YYYY-MM-DD
    }

    const parseArr = (raw: unknown): string[] => {
      if (typeof raw !== 'string' || !raw) return [];
      try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string') : []; }
      catch { return []; }
    };
    // Onda 2: parse JSON-of-objects for the new structured arrays. Returns
    // [] on any decode error so callers never see undefined.
    const parseObjArr = <T>(raw: unknown): T[] => {
      if (typeof raw !== 'string' || !raw) return [];
      try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed as T[] : []; }
      catch { return []; }
    };

    const goalEntries: GoalEntry[] = sortedEntries.map(e => ({
      goal_id: e.goal_id as number,
      gate: (e.goal_gate as string) || '',
      decision: (e.decision as string) || '',
      review_date: (e.review_date as string) || '',
      region: (e.region as string) || '',
      month_folder: (e.month_folder as string) || '',
      summary_one_line: (e.summary_one_line as string) || '',
      digital_technologies: (e.digital_technologies as string) || '',
      change_management: (e.change_management as string) || '',
      security_impacts: (e.security_impacts as string) || '',
      regional_impacts: (e.regional_impacts as string) || '',
      ia_embedded: (e.ia_embedded as string) || '',
      gio_sl_dds_impacts: (e.gio_sl_dds_impacts as string) || '',
      dds_gio_workload: (e.dds_gio_workload as string) || '',
      business_apps_cis: (e.business_apps_cis as string) || '',
      dds_entities_touched: parseArr(e.dds_entities_touched),
      gio_services_touched: parseArr(e.gio_services_touched),
      tech_tags:            parseArr(e.tech_tags),
      vendors:              parseArr(e.vendors),
      data_classifications: parseArr(e.data_classifications),
      mentioned_projects:   parseArr(e.mentioned_projects),
      project_relations:    parseObjArr<ProjectRelation>(e.project_relations),
      out_of_scope:         parseObjArr<OutOfScope>(e.out_of_scope),
      impact_claims:        parseObjArr<ImpactClaim>(e.impact_claims),
      // Normalize timeline so downstream code can do .length without guards.
      // LLM may emit `{}` (no timeline) which serializes to a TimelineStruct
      // where must_complete_before/blocked_by are undefined.
      timeline_struct:      (() => {
        const empty: TimelineStruct = { gate1_actual: null, gate2_target: null, go_live_target: null, must_complete_before: [], blocked_by: [] };
        if (typeof e.timeline_struct !== 'string' || !e.timeline_struct) return empty;
        try {
          const t = JSON.parse(e.timeline_struct);
          if (!t || typeof t !== 'object') return empty;
          const tr = t as Record<string, unknown>;
          return {
            gate1_actual:   (typeof tr.gate1_actual   === 'string' ? tr.gate1_actual   : null),
            gate2_target:   (typeof tr.gate2_target   === 'string' ? tr.gate2_target   : null),
            go_live_target: (typeof tr.go_live_target === 'string' ? tr.go_live_target : null),
            must_complete_before: Array.isArray(tr.must_complete_before) ? tr.must_complete_before as TimelineDep[] : [],
            blocked_by:           Array.isArray(tr.blocked_by)           ? tr.blocked_by           as TimelineDep[] : [],
          } as TimelineStruct;
        } catch { return empty; }
      })(),
      source_files: (e.source_files as string) || '',
      analyzed_at: (e.analyzed_at as string) || '',
      goal_status: (e.goal_status as string) || '',
    }));

    // Prefer the real gate from projects.gate; fall back to goal_gate only if it's a real value.
    const pickGate = (v: unknown): string => {
      const s = String(v ?? '').trim();
      if (!s) return '';
      if (s.toLowerCase() === 'unknown') return '';
      return s;
    };
    const projGate = pickGate(latestByReview.proj_gate);
    const goalGateFallback = pickGate(latestByAnalyzed.goal_gate);
    const resolvedGate = projGate || goalGateFallback;

    // Prefer the clean name from projects table over the messy goal filename
    const projName = ((latestByReview.proj_name as string) || '').trim();
    const goalName = ((latestByAnalyzed.project_name as string) || '').trim();
    // projects.name is clean (from sheet); goal name is often a filename with underscores
    const resolvedName = (projName && projName !== projectId) ? projName : (goalName || projectId);

    records.push({
      projectId,
      name: resolvedName,
      dds: latestByReview.dds as string || '',
      currentGate: resolvedGate,
      costKEur: latestByReview.cost_keur as number | null ?? null,
      description: bestDescription,
      remarks: bestRemarks,
      decision: latestByReview.decision as string || '',
      reviewDate: reviewDateStr,
      linkPositions: (latestByReview.link_positions as string) || '',
      linkFolder: (latestByReview.link_folder as string) || '',
      linkCIOO: (latestByReview.link_cioo as string) || '',
      services: (() => {
        try {
          const raw = latestByReview.services as string | undefined;
          return raw ? JSON.parse(raw) as CIOOService[] : [];
        } catch { return [] as CIOOService[]; }
      })(),
      goalEntries,
      tags: extractTags({
        name: resolvedName,
        description: bestDescription,
        remarks: bestRemarks,
      }),
    });
  }

  return records;
}

// ─── Fetch ProjectSummaries for views (used by /api/projects) ───────────────

export function fetchProjectSummariesForViews(): ProjectSummary[] {
  const records = fetchAllProjectRecords();
  return records.map((r): ProjectSummary => {
    // One synthetic history entry per goal analysis so TimelineView has dots to render.
    const history: CIOOProject[] = r.goalEntries.map((g, idx) => ({
      id: g.goal_id,
      projectId: r.projectId,
      name: r.name,
      dds: r.dds,
      gate: g.gate || r.currentGate,
      costKEur: idx === 0 ? r.costKEur : null,
      description: r.description,
      remarks: r.remarks,
      qa: '',
      reviewDate: (g.review_date || g.analyzed_at.slice(0, 10)) || '',
      decision: g.decision || r.decision,
      decisionMode: '',
      decisionDate: '',
      reviewStatus: '',
      documentsStatus: '',
      restricted: '',
      costBeforeG2: null,
      estGate2Date: '',
      sessionStart: '',
      sessionEnd: '',
      participants: '',
      linkPositions: r.linkPositions,
      linkFolder: r.linkFolder,
      linkCIOO: r.linkCIOO,
      year: null,
      month: null,
      batchId: '',
      services: r.services,
    }));

    return {
    projectId: r.projectId,
    name: r.name,
    dds: r.dds,
    currentGate: r.currentGate,
    latestDecision: r.decision,
    costKEur: r.costKEur,
    description: r.description,
    remarks: r.remarks,
    reviewCount: r.goalEntries.length,
    lastReviewDate: r.reviewDate,
    linkPositions: r.linkPositions,
    linkFolder: r.linkFolder,
    linkCIOO: r.linkCIOO,
    tags: r.tags,
    history,
    services: r.services,

    digitalTechnologies: r.goalEntries[0]?.digital_technologies ?? '',
    changeManagement:    r.goalEntries[0]?.change_management    ?? '',
    securityImpacts:     r.goalEntries[0]?.security_impacts     ?? '',
    regionalImpacts:     r.goalEntries[0]?.regional_impacts     ?? '',
    iaEmbedded:          r.goalEntries[0]?.ia_embedded          ?? '',
    gioSlDdsImpacts:     r.goalEntries[0]?.gio_sl_dds_impacts   ?? '',
    ddsGioWorkload:      r.goalEntries[0]?.dds_gio_workload     ?? '',
    businessAppsCis:     r.goalEntries[0]?.business_apps_cis    ?? '',
    subappAnalyzed: true,
    };
  });
}

// ─── Build full-coverage batches ─────────────────────────────────────────────

interface Batch {
  label: string;
  projects: ProjectFullRecord[];
}

const MAX_BATCHES = 200;

interface CoveragePlan {
  batches: Batch[];
  /** Pairs the safety cap left unanalysed. 0 means the target set was covered. */
  uncoveredPairs: number;
  /** 'full' = every pair was targeted; 'filtered' = only plausibly-related ones. */
  mode: 'full' | 'filtered';
  /** Pairs excluded by the relatedness prefilter (0 when mode is 'full'). */
  filteredOutPairs: number;
}

/**
 * Cheap relatedness test used to thin the pair set when full coverage does not
 * fit the batch cap. Two projects are worth an LLM call if they share a
 * technology, a vendor, a GIO service line, or if one names the other.
 *
 * Chosen by measuring every candidate signal against real data (61 projects,
 * 1830 pairs, 30 pairs with a real project→project impact):
 *
 *   tech OR vendor OR mention          → 28.6% of pairs, 28/30 impacts kept
 *   ...OR GIO service                  → 46.9% of pairs, 29/30 impacts kept
 *   ...OR DDS entity                   → 60.7% of pairs, 29/30 impacts kept
 *
 * DDS is deliberately excluded: it costs a fifth of the pair budget and
 * recovers nothing, because its values are too common to discriminate (Airgas
 * in 19 of 61 projects, Americas in 17).
 *
 * A project with no signals at all is treated as related to everything — it
 * cannot be filtered on evidence we do not have, and silently excluding it
 * would be the same silent-omission bug this whole exercise is about.
 */
interface PairSignals {
  tech: Set<string>;
  vendors: Set<string>;
  gio: Set<string>;
  mentions: Set<string>;
  blank: boolean;
}

function extractPairSignals(records: ProjectFullRecord[]): PairSignals[] {
  return records.map(r => {
    const g = r.goalEntries[0];
    const tech = new Set(g?.tech_tags ?? []);
    const vendors = new Set(g?.vendors ?? []);
    const gio = new Set(g?.gio_services_touched ?? []);
    const mentions = new Set<string>([
      ...(g?.mentioned_projects ?? []),
      ...(g?.project_relations ?? []).map(p => p.project_id).filter(Boolean),
    ]);
    return {
      tech, vendors, gio, mentions,
      blank: tech.size === 0 && vendors.size === 0 && gio.size === 0 && mentions.size === 0,
    };
  });
}

function shareAny(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

function pairsWorthAnalysing(records: ProjectFullRecord[]): Set<string> {
  const sig = extractPairSignals(records);
  const N = records.length;
  const keep = new Set<string>();
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const a = sig[i], b = sig[j];
      const related =
        a.blank || b.blank ||
        shareAny(a.tech, b.tech) ||
        shareAny(a.vendors, b.vendors) ||
        shareAny(a.gio, b.gio) ||
        a.mentions.has(records[j].projectId) ||
        b.mentions.has(records[i].projectId);
      if (related) keep.add(`${i}|${j}`);
    }
  }
  return keep;
}

/**
 * Packs projects into batches until every pair in `targetPairs` has appeared
 * together in at least one batch.
 *
 * `pad` fills a short batch up to batchSize with arbitrary extra projects. That
 * is worth it when covering every pair (a fuller batch covers more pairs), but
 * counterproductive on a thinned pair set, where the padding adds prompt content
 * — and therefore eats into every project's share of the prompt budget — while
 * covering no pair anyone asked for.
 */
function packBatches(
  records: ProjectFullRecord[],
  targetPairs: Set<string>,
  batchSize: number,
  pad: boolean,
): Pick<CoveragePlan, 'batches' | 'uncoveredPairs'> {
  const N = records.length;
  const uncovered = new Set(targetPairs);
  const batches: Batch[] = [];
  let round = 1;

  while (uncovered.size > 0) {
    const inBatch: number[] = [];
    const uncoveredByIdx = new Map<number, number>();
    for (const key of uncovered) {
      const [a, b] = key.split('|').map(Number);
      uncoveredByIdx.set(a, (uncoveredByIdx.get(a) ?? 0) + 1);
      uncoveredByIdx.set(b, (uncoveredByIdx.get(b) ?? 0) + 1);
    }

    const seed = [...uncoveredByIdx.entries()].sort((a, b) => b[1] - a[1])[0][0];
    inBatch.push(seed);

    while (inBatch.length < batchSize) {
      let best = -1;
      let bestGain = -1;
      for (let cand = 0; cand < N; cand++) {
        if (inBatch.includes(cand)) continue;
        let gain = 0;
        for (const member of inBatch) {
          const key = cand < member ? `${cand}|${member}` : `${member}|${cand}`;
          if (uncovered.has(key)) gain++;
        }
        if (gain > bestGain) {
          bestGain = gain;
          best = cand;
        }
      }
      if (best < 0) break;
      inBatch.push(best);
      if (bestGain === 0) break;
    }

    if (pad && inBatch.length < batchSize) {
      for (let cand = 0; cand < N && inBatch.length < batchSize; cand++) {
        if (!inBatch.includes(cand)) inBatch.push(cand);
      }
    }

    for (let a = 0; a < inBatch.length; a++) {
      for (let b = a + 1; b < inBatch.length; b++) {
        const i = Math.min(inBatch[a], inBatch[b]);
        const j = Math.max(inBatch[a], inBatch[b]);
        uncovered.delete(`${i}|${j}`);
      }
    }

    batches.push({
      label: `Round ${round++} (${inBatch.length} projects)`,
      projects: inBatch.map(idx => records[idx]),
    });

    // Safety cap: every batch is one LLM call, against a daily budget of
    // STROM_LLM_DAILY_CAP (default 500). Hitting it means the result is NOT the
    // coverage that was asked for, which the caller must be able to say out loud
    // rather than leaving it to a console line nobody reads.
    if (batches.length >= MAX_BATCHES) {
      console.warn(
        `[Impact] packBatches hit the ${MAX_BATCHES}-batch safety cap ` +
        `with ${uncovered.size} pair(s) still uncovered`
      );
      break;
    }
  }

  return { batches, uncoveredPairs: uncovered.size };
}

/**
 * Plans the batches for a run, degrading automatically.
 *
 * Full pairwise coverage is attempted first and kept whenever it fits, so
 * nothing changes for a portfolio small enough to afford it. Only when the cap
 * would truncate the run — silently dropping pairs that the bookkeeping counted
 * as analysed — do we fall back to covering just the plausibly-related pairs.
 * Losing the pairs that share no technology, vendor, service line or mention is
 * a far better trade than losing an arbitrary tail of whatever the packer
 * happened to reach last.
 */
function buildFullCoverageBatches(
  records: ProjectFullRecord[],
  batchSize = 22
): CoveragePlan {
  const N = records.length;
  if (N === 0) return { batches: [], uncoveredPairs: 0, mode: 'full', filteredOutPairs: 0 };
  if (N <= batchSize) {
    return {
      batches: [{ label: `All projects (${N})`, projects: records }],
      uncoveredPairs: 0,
      mode: 'full',
      filteredOutPairs: 0,
    };
  }

  const allPairs = new Set<string>();
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) allPairs.add(`${i}|${j}`);
  }

  const full = packBatches(records, allPairs, batchSize, true);
  if (full.uncoveredPairs === 0) {
    return { ...full, mode: 'full', filteredOutPairs: 0 };
  }

  const related = pairsWorthAnalysing(records);
  const filteredOutPairs = allPairs.size - related.size;
  console.warn(
    `[Impact] full coverage needs more than ${MAX_BATCHES} batches for ${N} projects ` +
    `(${allPairs.size} pairs) — falling back to related pairs only (${related.size}, ` +
    `${((related.size / allPairs.size) * 100).toFixed(1)}%)`
  );

  const filtered = packBatches(records, related, batchSize, false);
  return { ...filtered, mode: 'filtered', filteredOutPairs };
}

// ─── Build prompt for a batch ────────────────────────────────────────────────

interface BuiltImpactPrompt {
  prompt: string;
  /** Projects whose structured content had to be trimmed to fit the budget. */
  truncated: string[];
}

// Every project handed to this function is GUARANTEED to appear in the output.
// `buildFullCoverageBatches` marks a pair (i,j) as covered the moment it puts
// both projects in a batch, so a project silently dropped here would leave that
// pair permanently unanalysed while the bookkeeping claims the opposite — and
// deterministically so, meaning a re-run never repairs it. We therefore truncate
// content to fit rather than drop projects: a pair analysed with less context
// degrades gracefully, a pair never sent to the LLM is a silent lie.
function buildImpactPrompt(records: ProjectFullRecord[]): BuiltImpactPrompt {
  const MAX_PROMPT_CHARS = 200_000;
  const DOC_SLICE = 4000;
  const DOCS_TOTAL = 8000;

  // Per-project slice of the budget. The structured head (ids, tags, atomic
  // claims, relations, goal analyses) has priority and documents absorb only
  // what is left over, because the head is what cross-project reasoning runs on.
  const perProject = records.length > 0
    ? Math.floor(MAX_PROMPT_CHARS / records.length)
    : MAX_PROMPT_CHARS;

  const entries: string[] = [];
  const truncated: string[] = [];
  let docsSqueezed = 0;

  const emit = (field: string, value: string | number | null | undefined): string => {
    if (value === null || value === undefined || value === '') return '';
    return `\n  ${field}: ${value}`;
  };
  const emitArr = (field: string, value: string[] | null | undefined): string => {
    if (!value || value.length === 0) return '';
    return `\n  ${field}: [${value.join(', ')}]`;
  };

  for (const r of records) {
    const parts: string[] = [];
    parts.push(
      `- ${r.projectId}: "${r.name}" (DDS: ${r.dds || 'N/A'}, Gate: ${r.currentGate || 'N/A'}, Cost: ${r.costKEur ? `${r.costKEur}k€` : 'N/A'})`
    );

    // Surface the canonical arrays at the top of the project block so the LLM
    // can correlate stacks/vendors/data classes across projects without
    // re-parsing every free-form field.
    const latest = r.goalEntries[0];
    if (latest) {
      parts.push(emit('Summary', latest.summary_one_line));
      parts.push(emitArr('Tech tags', latest.tech_tags));
      parts.push(emitArr('Vendors', latest.vendors));
      parts.push(emitArr('Data classifications', latest.data_classifications));
      parts.push(emitArr('DDS entities touched', latest.dds_entities_touched));
      parts.push(emitArr('GIO services touched', latest.gio_services_touched));
      parts.push(emitArr('Mentions other projects', latest.mentioned_projects));

      // Onda 2: pre-extracted cross-project relationships from Goals. These
      // are already grounded in evidence quotes — surface them as authoritative
      // pre-edges so the LLM doesn't have to re-derive project↔project links
      // from prose. Format keeps the kind+quote so the LLM can emit a matching
      // impact row with the same wording.
      if (latest.project_relations.length > 0) {
        const lines = latest.project_relations
          .map(pr => `      • → ${pr.project_id} [${pr.kind}, ${pr.confidence}]: "${pr.evidence_quote}" (in ${pr.source_file})`)
          .join('\n');
        parts.push(`\n  Pre-extracted project relations (from Goals):\n${lines}`);
      }

      // Onda 2: explicit out-of-scope statements. Used as NEGATIVE signal — the
      // LLM is instructed below not to invent impacts that contradict these.
      if (latest.out_of_scope.length > 0) {
        const lines = latest.out_of_scope
          .map(o => `      • "${o.topic}" — "${o.evidence_quote}" (in ${o.source_file})`)
          .join('\n');
        parts.push(`\n  EXCLUSIONS (project explicitly out-of-scope for these topics — do NOT emit impacts that contradict):\n${lines}`);
      }

      // Onda 3: atomic claims, the authoritative source for GIO/DDS edges.
      // Each claim already carries target_kind + target + role + severity +
      // impact_type + evidence. The LLM should treat these as the GROUND
      // TRUTH and emit matching impact rows verbatim (one impact per claim).
      if (latest.impact_claims.length > 0) {
        const lines = latest.impact_claims
          .map(c => `      • ${c.target_kind.toUpperCase()} "${c.target}" role=${c.role} sev=${c.severity} type=${c.impact_type} (${c.confidence}): "${c.evidence_quote}" (in ${c.evidence_file})`)
          .join('\n');
        parts.push(`\n  Atomic impact claims (from Goals — emit one impact row per claim, do not invent extras):\n${lines}`);
      }

      // Onda 3: structured timeline + dependencies. Defensive: even though the
      // parser normalizes to empty arrays, guard against any legacy/malformed
      // value that slipped past.
      const tl = latest.timeline_struct;
      const mcb = Array.isArray(tl?.must_complete_before) ? tl!.must_complete_before : [];
      const blk = Array.isArray(tl?.blocked_by) ? tl!.blocked_by : [];
      if (tl && (tl.gate1_actual || tl.gate2_target || tl.go_live_target || mcb.length || blk.length)) {
        const tlParts: string[] = [];
        if (tl.gate1_actual)   tlParts.push(`gate1=${tl.gate1_actual}`);
        if (tl.gate2_target)   tlParts.push(`gate2=${tl.gate2_target}`);
        if (tl.go_live_target) tlParts.push(`go-live=${tl.go_live_target}`);
        const header = tlParts.length ? `      schedule: ${tlParts.join(', ')}` : '';
        const blocks = blk.map(d => `      • blocked_by → ${d.project_id}: "${d.evidence_quote}" (${d.evidence_file})`).join('\n');
        const before = mcb.map(d => `      • must_complete_before → ${d.project_id}: "${d.evidence_quote}" (${d.evidence_file})`).join('\n');
        const body = [header, blocks, before].filter(Boolean).join('\n');
        if (body) parts.push(`\n  Timeline:\n${body}`);
      }
    }

    parts.push(emit('Decision', r.decision));
    parts.push(emit('Review Date', r.reviewDate));
    parts.push(emit('Description', r.description));
    parts.push(emit('Remarks', r.remarks));
    if (r.linkPositions) parts.push(emit('Link (Positions)', r.linkPositions));
    if (r.linkFolder) parts.push(emit('Link (Folder)', r.linkFolder));
    if (r.linkCIOO) parts.push(emit('Link (CIOO)', r.linkCIOO));

    // `goalEntries` is the goals×projects fan-out, not a list of analyses:
    // `project_goals` holds ONE row per (project, language) — see the
    // idx_goals_project_lang UNIQUE index in db.ts — while `projects` holds one
    // row per committee review, so the LEFT JOIN in IMPACT_ANALYSIS_QUERY repeats
    // the same goal analysis once per review. Every field emitted below comes
    // from the goals side, so without this dedup the identical block is repeated
    // K times: it burns prompt budget and reads to the LLM as K independent
    // analyses corroborating each other.
    //
    // Dedup ONLY here. `goalEntries` deliberately keeps all K entries because
    // fetchProjectSummariesForViews builds `history` (TimelineView dots) and
    // `reviewCount` from them — collapsing it at the source empties both.
    const seenGoalIds = new Set<number>();
    const distinctGoals = r.goalEntries.filter(g => {
      if (seenGoalIds.has(g.goal_id)) return false;
      seenGoalIds.add(g.goal_id);
      return true;
    });

    distinctGoals.forEach((g, idx) => {
      const ordinal = distinctGoals.length > 1 ? ` ${idx + 1}` : '';
      const header = `\n  Goal analysis${ordinal}${g.month_folder ? ` [${g.month_folder}]` : ''}${g.analyzed_at ? ` (${g.analyzed_at})` : ''}:`;
      const body = [
        emit('    Region', g.region),
        emit('    Digital Technologies', g.digital_technologies),
        emit('    Change Management', g.change_management),
        emit('    Security Impacts', g.security_impacts),
        emit('    Regional Impacts', g.regional_impacts),
        emit('    IA Embedded', g.ia_embedded),
        emit('    GIO/SL/DDS Impacts', g.gio_sl_dds_impacts),
        emit('    DDS/GIO Workload', g.dds_gio_workload),
        emit('    Business Apps/CIs', g.business_apps_cis),
        emit('    Source Files', g.source_files),
      ].filter(Boolean).join('');
      if (body) parts.push(header + body);
    });

    // Head assembled. Enforce this project's budget before appending documents,
    // so one verbose project can never crowd a later one out of the prompt.
    let entry = parts.filter(Boolean).join('');
    if (entry.length > perProject) {
      entry = entry.slice(0, perProject);
      truncated.push(r.projectId);
    }

    // Documents absorb whatever this project has left of its budget.
    const docBudget = Math.max(0, Math.min(DOCS_TOTAL, perProject - entry.length));
    try {
      // DOC_SLICE is the per-document cap applied below, so let SQLite do the
      // truncation rather than reading whole documents just to discard them.
      const docs = getProjectDocuments(r.projectId, DOC_SLICE);
      // Label each document chunk with its URL + file name so the LLM can
      // produce verifiable citations. The bracketed "[doc_url=..., file_name=...]"
      // header is the exact key the model echoes back in the citations array.
      const labelled = docs
        .filter(d => d.status === 'success' && d.content)
        .map(d => `[doc_url=${d.url}, file_name=${d.fileName || '(unknown)'}]\n${d.content.slice(0, DOC_SLICE)}`)
        .join('\n---\n')
        .slice(0, docBudget);
      if (labelled) {
        entry += `\n  Documents:\n${labelled}`;
      } else if (docBudget === 0 && docs.some(d => d.status === 'success' && d.content)) {
        docsSqueezed++;
      }
    } catch { /* no docs */ }

    entries.push(entry);
  }

  if (truncated.length > 0 || docsSqueezed > 0) {
    console.warn(
      `[Impact] buildImpactPrompt: all ${records.length} projects kept — ` +
      `${truncated.length} structurally truncated, ${docsSqueezed} left without document context ` +
      `(budget ${perProject} chars/project)`
    );
  }

  const projectList = entries.join('\n\n');
  const { impactPrompt } = getPrompts();
  return { prompt: impactPrompt.replace('{{PROJECTS_LIST}}', projectList), truncated };
}

// ─── Parse Gemini response robustly ──────────────────────────────────────────

interface RawCitation {
  doc_url: string;
  snippet: string;
}

interface RawImpact {
  source: string;
  target: string;
  impact_type: string;
  direction: string;
  severity: string;
  explanation: string;
  gio_services?: string[];
  dds_entities?: string[];
  citations?: RawCitation[];
}

// Hard validation of source/target identifiers. The LLM occasionally hallucinates
// pseudo-targets ("DDS_IMPAcripts", "GIO_SVCS", etc.) that look right at a glance
// but break the universe fan-out (they can't be matched to GIO_SERVICES or
// DDS_IMPACTS, so they become phantom "project" satellites). This normaliser:
//   - returns the canonical string when an obvious typo is detected
//   - returns '' when the value can't be salvaged (caller drops the row)
function normalizeImpactTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed === 'GIO_SERVICES' || trimmed === 'DDS_IMPACTS') return trimmed;

  // Fuzzy match for pseudo-target typos: case-insensitive, strip non-alphanum.
  // Examples that must collapse to DDS_IMPACTS:
  //   "DDS_IMPAcripts" (LLM hallucination observed in the wild)
  //   "dds-impacts", "DDS_IMPACT", "DDS IMPACTS"
  const stripped = trimmed.toUpperCase().replace(/[^A-Z]/g, '');
  if (stripped.startsWith('DDSIMP')) return 'DDS_IMPACTS';
  if (stripped.startsWith('GIOSERV') || stripped.startsWith('GIOSL')) return 'GIO_SERVICES';
  // Shared canonicaliser: also accepts PGM programmes (the old `/^PRJ\d{4,}$/`
  // silently dropped every edge touching one, even though the Drive scanner
  // ingests PGM folders) and folds padding differences.
  return normalizeProjectId(trimmed) ?? '';
}

// Controlled-vocabulary matching for `impact_type` / `direction`. The LLM drifts
// on formatting far more often than on meaning ("Platform Shared",
// "platform-shared"), so fold that away before deciding a value is unusable.
// Returns the canonical member, or null when there is no safe mapping.
const IMPACT_TYPE_SET: ReadonlySet<string> = new Set(IMPACT_TYPES);
const IMPACT_DIRECTION_SET: ReadonlySet<string> = new Set(IMPACT_DIRECTIONS);

function canonicalise(raw: string, allowed: ReadonlySet<string>): string | null {
  const folded = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return allowed.has(folded) ? folded : null;
}

function normalizeImpactSource(raw: string): string {
  return normalizeProjectId(raw) ?? '';
}

function parseImpactResponse(text: string): RawImpact[] {
  try {
    // Remove markdown code fences if present
    let clean = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();

    // Find the JSON array
    const start = clean.indexOf('[');
    const end = clean.lastIndexOf(']');
    if (start >= 0 && end > start) {
      clean = clean.slice(start, end + 1);
    }

    const parsed = JSON.parse(clean);
    if (!Array.isArray(parsed)) {
      console.error('[Impact] Gemini returned non-array:', text.slice(0, 300));
      return [];
    }

    let droppedTarget = 0;
    let droppedPseudo = 0;
    const droppedVocab: string[] = [];
    let coercedDirection = 0;

    const out: RawImpact[] = [];
    for (const raw of parsed as Record<string, unknown>[]) {
      const rawCitations = Array.isArray(raw.citations) ? raw.citations as Record<string, unknown>[] : [];
      const citations: RawCitation[] = rawCitations
        .map(c => ({
          doc_url: String(c.doc_url || c.docUrl || c.url || '').trim(),
          snippet: String(c.snippet || c.quote || c.text || '').trim(),
        }))
        .filter(c => c.doc_url && c.snippet);

      const rawSource = String(raw.source || raw.source_project_id || raw.sourceProjectId || '');
      const rawTarget = String(raw.target || raw.target_project_id || raw.targetProjectId || '');
      const source = normalizeImpactSource(rawSource);
      const target = normalizeImpactTarget(rawTarget);
      if (!source || !target) {
        droppedTarget++;
        continue;
      }
      // GIO / DDS pseudo-target rows are materialised deterministically from
      // project_goals.impact_claims (materializeClaimsAsImpacts), so anything
      // the LLM emits for them is at best a duplicate. It cannot be relied on to
      // lose that race either: the UNIQUE key includes gio_services +
      // dds_entities (db.ts), so an LLM row naming a different entity set does
      // NOT collide with the materialised one and would survive alongside it as
      // a phantom edge. The prompt already forbids these rows (prompts.ts) —
      // this is the enforcement half of that contract, because "the LLM
      // disobeys" is precisely what motivated materialising them in the first
      // place. Note we drop AFTER normalisation on purpose: that is what catches
      // corrupted spellings like "DDS_IMPAcripts" instead of letting them
      // through as phantom project satellites.
      if (target === 'GIO_SERVICES' || target === 'DDS_IMPACTS') {
        droppedPseudo++;
        continue;
      }

      // `impact_type` is part of the UNIQUE key, so an off-vocabulary value does
      // not merely mislabel the row — it opens a separate key slot, so the same
      // semantic edge lands twice. Normalise obvious drift (case, spaces,
      // hyphens) and drop what still doesn't match.
      //
      // Measured against 197 real rows (2026-08-31): the only off-vocabulary
      // value was `requires_coordination` — a *direction* value placed in the
      // type field — on 6 rows, 5 of which already had a correctly-typed sibling
      // row for the same pair. So these are usually, but NOT always, redundant:
      // one row was the pair's only edge. Falling back to a default type instead
      // of dropping would not help, since the fallback opens its own key slot and
      // keeps the duplicate while adding a wrong label. We drop, but log the
      // source→target so a genuinely lost edge is auditable rather than silent.
      const rawType = String(raw.impact_type || raw.impactType || raw.type || 'technology_dependency');
      const impactType = canonicalise(rawType, IMPACT_TYPE_SET);
      if (!impactType) {
        droppedVocab.push(`${source}→${target} (${rawType.trim()})`);
        continue;
      }

      // `direction` is NOT part of the UNIQUE key: a bad value costs a vague
      // "relates to" in the narrative, nothing structural. Dropping a real
      // cross-project finding over its label would lose more than it protects,
      // so this one falls back to the pre-existing default instead.
      const rawDirection = String(raw.direction || raw.relationship || 'requires_coordination');
      const direction = canonicalise(rawDirection, IMPACT_DIRECTION_SET) ?? 'requires_coordination';
      if (direction !== rawDirection.trim()) coercedDirection++;

      out.push({
        source,
        target,
        impact_type: impactType,
        direction,
        // Normalise to the 2-tier scale. Default missing severities to 'low'
        // and fold legacy 'medium' values into 'low' (2026-06-18 collapse).
        severity: ((): string => {
          const s = String(raw.severity || raw.level || 'low').toLowerCase();
          return s === 'medium' ? 'low' : s;
        })(),
        explanation: (raw.explanation || raw.reason || raw.description || '') as string,
        gio_services: Array.isArray(raw.gio_services) ? raw.gio_services as string[] : [],
        dds_entities: normalizeDdsList(raw.dds_entities ?? raw.ddsEntities ?? raw.dds),
        citations,
      });
    }
    if (droppedTarget > 0 || droppedPseudo > 0 || droppedVocab.length > 0 || coercedDirection > 0) {
      console.log(
        `[Impact] parseImpactResponse: kept=${out.length} unparseable-target=${droppedTarget} ` +
        `pseudo-target=${droppedPseudo} (materialised separately) off-vocabulary-type=${droppedVocab.length} ` +
        `direction-coerced=${coercedDirection} — of ${parsed.length} rows`
      );
      if (droppedVocab.length > 0) {
        console.log(`[Impact]   off-vocabulary rows dropped: ${droppedVocab.join('; ')}`);
      }
    }
    return out;
  } catch (err) {
    console.error('[Impact] Failed to parse Gemini response:', (err as Error).message, '— raw:', text.slice(0, 500));
    return [];
  }
}

// ─── Store impacts in DB ─────────────────────────────────────────────────────

function storeImpacts(impacts: RawImpact[], batchId: string, lang: OutputLanguage): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO projects_impact
    (source_project_id, target_project_id, impact_type, direction, severity, explanation, batch_id, gio_services, dds_entities, citations, evidence_chain, output_language)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Onda 4: load each source project's Goals once so we can attach an
  // evidence_chain pointer for every impact row we store. Two-pass design:
  //   1. Fetch all relevant project_goals (source projects in this batch).
  //   2. For each impact row, find which atomic claim (or project_relation)
  //      it corresponds to and persist the trace.
  // Scoped to the SAME language we're storing impacts in — otherwise the
  // goal_id we record would point to a row in the other language's analysis.
  const sourceProjectIds = Array.from(new Set(impacts.map(i => i.source).filter(Boolean)));
  const goalsByProject = new Map<string, { goal_id: number; impact_claims: string; project_relations: string }>();
  if (sourceProjectIds.length > 0) {
    const placeholders = sourceProjectIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id, project_id, impact_claims, project_relations FROM project_goals WHERE project_id IN (${placeholders}) AND status = 'success' AND output_language = ?`
    ).all(...sourceProjectIds, lang) as Array<{ id: number; project_id: string; impact_claims: string; project_relations: string }>;
    for (const r of rows) goalsByProject.set(r.project_id, { goal_id: r.id, impact_claims: r.impact_claims, project_relations: r.project_relations });
  }

  const buildChain = (item: RawImpact): string => {
    const g = goalsByProject.get(item.source);
    if (!g) return '[]';
    // Pseudo-targets → match against impact_claims by (target_kind, target).
    if (item.target === 'GIO_SERVICES' || item.target === 'DDS_IMPACTS') {
      let claims: Array<{ target_kind: string; target: string }> = [];
      try { const v = JSON.parse(g.impact_claims || '[]'); if (Array.isArray(v)) claims = v as typeof claims; } catch { /* ignore */ }
      const expectedKind = item.target === 'GIO_SERVICES' ? 'gio' : 'dds';
      const labels = item.target === 'GIO_SERVICES' ? (item.gio_services || []) : (item.dds_entities || []);
      const matches: number[] = [];
      claims.forEach((c, idx) => {
        if (c.target_kind === expectedKind && labels.includes(c.target)) matches.push(idx);
      });
      if (matches.length === 0) return JSON.stringify([{ goal_id: g.goal_id, source: 'free' as const }]);
      return JSON.stringify(matches.map(idx => ({ goal_id: g.goal_id, claim_idx: idx, source: 'claim' as const })));
    }
    // Project↔project → match against project_relations by target project_id.
    if (item.target && item.target.startsWith('PRJ')) {
      let relations: Array<{ project_id: string }> = [];
      try { const v = JSON.parse(g.project_relations || '[]'); if (Array.isArray(v)) relations = v as typeof relations; } catch { /* ignore */ }
      const matchIdx = relations.findIndex(r => r.project_id === item.target);
      if (matchIdx >= 0) return JSON.stringify([{ goal_id: g.goal_id, relation_idx: matchIdx, source: 'relation' as const }]);
    }
    return JSON.stringify([{ goal_id: g.goal_id, source: 'free' as const }]);
  };

  let inserted = 0;
  const insertMany = db.transaction((items: RawImpact[]) => {
    for (const item of items) {
      // Drop self-loops: an LLM occasionally emits source===target rows from
      // out_of_scope-flavored sentences. They are never meaningful as edges.
      if (item.source && item.target && item.source === item.target) continue;
      // Sort entity arrays before serialisation so the UNIQUE constraint key
      // is stable regardless of the order the LLM (or materialiser) listed
      // them — ["HHC","Americas"] and ["Americas","HHC"] must collide.
      const sortedGio = [...(item.gio_services || [])].sort();
      const sortedDds = [...(item.dds_entities || [])].sort();
      const result = stmt.run(
        item.source,
        item.target,
        item.impact_type,
        item.direction,
        item.severity,
        item.explanation || '',
        batchId,
        JSON.stringify(sortedGio),
        JSON.stringify(sortedDds),
        JSON.stringify(item.citations || []),
        buildChain(item),
        lang,
      );
      if (result.changes > 0) inserted++;
    }
  });

  insertMany(impacts);
  return inserted;
}

// ─── Materialize impact_claims as direct rows (Option 3, 2026-06-18) ─────────
// The Goals extractor (Onda 3) already produces atomic, evidence-anchored
// impact_claims — one per (project, target, role). The Impact LLM was being
// asked to faithfully re-emit one row per claim, which turned out to be
// unreliable: it occasionally merged claims sharing an evidence_quote, lost
// rows, or corrupted the pseudo-target (e.g. "DDS_IMPACTS" → "DDS_IMPAcripts").
// This function bypasses the LLM for claim-derived rows: it walks the
// project_goals.impact_claims arrays and builds RawImpact rows deterministically.
// Cross-project deductions still go through the LLM in processBatch.

interface MaterializedClaim {
  target_kind: 'gio' | 'dds';
  target: string;
  role: string;
  severity: string;
  impact_type: string;
  evidence_file: string;
  evidence_quote: string;
  confidence: 'stated' | 'inferred';
}

// Mirrors prompts.ts:231-236 — the role → direction mapping the LLM was supposed
// to apply. Now applied deterministically so the column never disagrees with
// the row's semantics.
const ROLE_TO_DIRECTION: Record<string, string> = {
  primary_provider: 'provides_to',
  downstream_consumer: 'depends_on',
  regional_executor: 'requires_coordination',
  risk_owner: 'requires_coordination',
  blocked_by: 'depends_on',
};

function materializeClaimsAsImpacts(
  records: ProjectFullRecord[],
): RawImpact[] {
  const db = getDb();

  // documents_cache lookup: same normalisation pattern as the universe route's
  // enrichEmptyCitations fallback — strips extension, unifies separators.
  const normalizeName = (s: string) =>
    s.toLowerCase()
      .replace(/\.(txt|csv|pdf|docx?|xlsx?|md)$/i, '')
      .replace(/[_\s-]+/g, ' ')
      .replace(/[()]/g, '')
      .trim();

  const projectIds = records.map(r => r.projectId);
  const fileMap = new Map<string, { url: string; file_name: string }>();
  if (projectIds.length > 0) {
    const ph = projectIds.map(() => '?').join(',');
    const docs = db.prepare(
      `SELECT project_id, url, file_name FROM documents_cache WHERE project_id IN (${ph}) AND fetch_status = 'success'`
    ).all(...projectIds) as Array<{ project_id: string; url: string; file_name: string }>;
    for (const d of docs) {
      fileMap.set(`${d.project_id}|${normalizeName(d.file_name)}`, { url: d.url, file_name: d.file_name });
    }
  }

  const out: RawImpact[] = [];
  let claimsSeen = 0;
  let claimsKept = 0;
  let claimsDroppedBadTarget = 0;

  for (const rec of records) {
    // The latest analysed Goals row for this project. Multi-gate projects can
    // have several; we trust the latest because that's what the LLM-driven path
    // also sees through buildImpactPrompt.
    const latest = rec.goalEntries[0];
    const claims = latest?.impact_claims as MaterializedClaim[] | undefined;
    if (!Array.isArray(claims)) continue;

    for (const c of claims) {
      claimsSeen++;
      if (!c || (c.target_kind !== 'gio' && c.target_kind !== 'dds')) continue;
      if (!c.target || !c.impact_type || !c.role) continue;

      // Validate target against the canonical catalog. Should always pass
      // because sanitizeImpactClaims (goals-analyzer.ts) already filters on the
      // write path, but belt-and-braces: `project_goals.impact_claims` is JSON
      // that survives across schema changes, and the catalog behind
      // isCanonicalTarget is editable at runtime via /admin/catalog — so a value
      // that was canonical when it was stored may not be canonical now.
      const target = c.target;
      if (!isCanonicalTarget(c.target_kind, target)) { claimsDroppedBadTarget++; continue; }

      const pseudoTarget = c.target_kind === 'gio' ? 'GIO_SERVICES' : 'DDS_IMPACTS';
      const direction = ROLE_TO_DIRECTION[c.role] ?? 'requires_coordination';
      // Normalise severity to the 2-tier scale. sanitizeImpactClaims already
      // does this, but we re-apply here so legacy un-sanitised JSON also lands
      // correctly.
      const severity = (c.severity === 'medium' ? 'low' : c.severity) || 'low';

      // Resolve citation. evidence_file is a filename (no doc_url prefix); we
      // look it up in documents_cache. If we can't resolve, we still emit the
      // row with an empty citations[] — the universe route's enrichEmptyCitations
      // fallback will synthesize one from the evidence_chain we store below.
      const doc = c.evidence_file ? fileMap.get(`${rec.projectId}|${normalizeName(c.evidence_file)}`) : undefined;
      const citations: RawCitation[] = (doc && c.evidence_quote)
        ? [{ doc_url: doc.url, snippet: c.evidence_quote }]
        : [];

      out.push({
        source: rec.projectId,
        target: pseudoTarget,
        impact_type: c.impact_type,
        direction,
        severity,
        explanation: c.evidence_quote || '',
        gio_services: c.target_kind === 'gio' ? [target] : [],
        dds_entities: c.target_kind === 'dds' ? [target] : [],
        citations,
      });
      claimsKept++;
    }
  }

  console.log(`[Impact] materializeClaimsAsImpacts: ${claimsKept}/${claimsSeen} claims materialised (dropped bad target: ${claimsDroppedBadTarget})`);
  return out;
}

// ─── Run journal (impact_runs) ───────────────────────────────────────────────
// `analysisStatus` above lives in module memory and dies with the process, so
// these mirror the run into SQLite. A row left in 'running' is reclaimed as
// 'aborted' on the next boot (see reclaimOrphanedImpactRuns in db.ts) — that is
// what makes an OOM-killed or redeployed run visible after the fact.

function startRunRecord(
  batchId: string,
  lang: OutputLanguage,
  totalProjects: number,
  totalBatches: number,
): number | null {
  try {
    const result = getDb().prepare(`
      INSERT INTO impact_runs (batch_id, output_language, status, total_projects, total_batches)
      VALUES (?, ?, 'running', ?, ?)
    `).run(batchId, lang, totalProjects, totalBatches);
    return Number(result.lastInsertRowid);
  } catch (err) {
    // The journal is observability, never a reason to fail the analysis.
    console.error('[Impact] could not open run journal entry:', err);
    return null;
  }
}

function updateRunProgress(runId: number | null, status: ImpactAnalysisStatus): void {
  if (runId === null) return;
  try {
    getDb().prepare(
      'UPDATE impact_runs SET completed_batches = ?, total_impacts = ? WHERE id = ?'
    ).run(status.completedBatches, status.totalImpacts, runId);
  } catch { /* observability only */ }
}

function finishRunRecord(
  runId: number | null,
  status: 'complete' | 'failed',
  s: ImpactAnalysisStatus,
): void {
  if (runId === null) return;
  try {
    getDb().prepare(`
      UPDATE impact_runs
         SET status = ?, finished_at = datetime('now'),
             completed_batches = ?, total_impacts = ?,
             errors_json = ?, warnings_json = ?
       WHERE id = ?
    `).run(
      status,
      s.completedBatches,
      s.totalImpacts,
      JSON.stringify(s.errors),
      JSON.stringify(s.warnings),
      runId,
    );
  } catch { /* observability only */ }
}

interface ImpactRunRow {
  status: string;
  started_at: string;
  finished_at: string | null;
  completed_batches: number;
  total_batches: number;
  total_impacts: number;
}

function readLastRun(): ImpactAnalysisStatus['lastRun'] {
  try {
    const row = getDb().prepare(
      'SELECT status, started_at, finished_at, completed_batches, total_batches, total_impacts FROM impact_runs ORDER BY id DESC LIMIT 1'
    ).get() as ImpactRunRow | undefined;
    if (!row) return null;
    return {
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      completedBatches: row.completed_batches,
      totalBatches: row.total_batches,
      totalImpacts: row.total_impacts,
    };
  } catch {
    return null;
  }
}

// ─── Process a single batch via Gemini ───────────────────────────────────────

async function processBatch(batch: Batch, batchId: string, lang: OutputLanguage): Promise<number> {
  const { prompt, truncated } = buildImpactPrompt(batch.projects);

  // Surface budget pressure in the run status. Kept out of `errors` so the
  // UI's error count keeps meaning "something failed" — every project here
  // still made it into the prompt, just with less context.
  if (truncated.length > 0) {
    analysisStatus.warnings.push(
      `Batch "${batch.label}": prompt budget trimmed the structured content of ${truncated.length} project(s) — ${truncated.join(', ')}`
    );
  }

  const { text } = await generateContent({
    prompt,
    model: 'fast',
    json: true,
    context: 'impact',
    outputLanguage: lang,
  });

  console.log(`[Impact] Batch "${batch.label}" (${batch.projects.length} projects) — response length: ${text.length}, preview: ${text.slice(0, 200)}`);

  const impacts = parseImpactResponse(text);
  console.log(`[Impact] Batch "${batch.label}" — parsed ${impacts.length} impacts`);

  if (impacts.length === 0) return 0;

  return storeImpacts(impacts, batchId, lang);
}

// ─── Main: Run Full Impact Analysis ──────────────────────────────────────────

export async function runFullImpactAnalysis(): Promise<void> {
  if (analysisStatus.isRunning) {
    throw new Error('Impact analysis is already running');
  }

  // Reset status
  analysisStatus = {
    isRunning: true,
    totalProjects: 0,
    totalBatches: 0,
    completedBatches: 0,
    totalImpacts: 0,
    currentBatchDDS: 'Initializing...',
    errors: [],
    warnings: [],
  };

  let runRowId: number | null = null;

  try {
    // Capture language once per run — see goals-analyzer for the same
    // rationale (mid-run toggles must not split a row across languages).
    const lang = getActiveOutputLanguage();
    const records = fetchAllProjectRecords(lang);
    analysisStatus.totalProjects = records.length;

    const plan = buildFullCoverageBatches(records, 22);
    const allBatches = plan.batches;
    analysisStatus.totalBatches = allBatches.length;

    // Whatever the batcher had to give up on, say it. The difference between
    // "no impact found between A and B" and "A and B were never compared" is
    // invisible in the UI, so it has to be stated here.
    if (plan.mode === 'filtered') {
      analysisStatus.warnings.push(
        `Full pairwise coverage did not fit the ${MAX_BATCHES}-batch budget for ${records.length} projects. ` +
        `Compared only project pairs sharing a technology, vendor, GIO service line or explicit mention — ` +
        `${plan.filteredOutPairs} unrelated pair(s) were skipped. Absence of an impact between two projects ` +
        `does not mean they were analysed.`
      );
    }
    if (plan.uncoveredPairs > 0) {
      analysisStatus.warnings.push(
        `Partial coverage: the ${MAX_BATCHES}-batch cap left ${plan.uncoveredPairs} targeted pair(s) uncompared.`
      );
    }

    const runBatchId = uuidv4();
    runRowId = startRunRecord(runBatchId, lang, records.length, allBatches.length);

    for (let i = 0; i < allBatches.length; i++) {
      const batch = allBatches[i];
      analysisStatus.currentBatchDDS = batch.label;

      try {
        const inserted = await processBatch(batch, runBatchId, lang);
        analysisStatus.totalImpacts += inserted;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        analysisStatus.errors.push(`Batch "${batch.label}": ${msg}`);
      }

      analysisStatus.completedBatches = i + 1;
      // Persist progress per batch: if the process is killed here, the journal
      // still shows how far it got instead of resetting to zero.
      updateRunProgress(runRowId, analysisStatus);

      // Small delay to avoid rate limiting
      if (i < allBatches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    // Materialise atomic impact_claims directly into rows AFTER the LLM batches.
    // Claim-derived rows are deterministic by construction, which fixes the class
    // of bugs where the LLM merged sibling claims (e.g. HHC+Americas+CF collapsed
    // onto one CF row), corrupted pseudo-targets ("DDS_IMPACTS" →
    // "DDS_IMPAcripts"), or dropped a claim entirely.
    //
    // These rows do NOT rely on out-competing LLM output. An earlier version of
    // this comment claimed INSERT OR REPLACE on (source, target, impact_type,
    // lang) let them overwrite any LLM equivalent; that stopped being true when
    // the UNIQUE key was widened to include gio_services + dds_entities
    // (2026-06-18, db.ts) — an LLM row naming a different entity set simply does
    // not collide. The guarantee now comes from the other end: parseImpactResponse
    // drops every pseudo-target row before it can reach the DB, so this is the
    // only writer of GIO_SERVICES / DDS_IMPACTS edges.
    analysisStatus.currentBatchDDS = 'Materialising atomic claims';
    try {
      const materialised = materializeClaimsAsImpacts(records);
      const inserted = storeImpacts(materialised, runBatchId, lang);
      console.log(`[Impact] materialised ${inserted}/${materialised.length} claim rows`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      analysisStatus.errors.push(`Claim materialisation: ${msg}`);
    }

    // Update total impacts from DB (more accurate). Scoped to the active
    // language so the badge reflects what the user is actually viewing.
    const db = getDb();
    const countRow = db.prepare(
      'SELECT COUNT(*) as cnt FROM projects_impact WHERE output_language = ?'
    ).get(lang) as { cnt: number };
    analysisStatus.totalImpacts = countRow.cnt;

    analysisStatus.currentBatchDDS = 'Complete';
    finishRunRecord(runRowId, 'complete', analysisStatus);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    analysisStatus.errors.push(`Fatal: ${msg}`);
    finishRunRecord(runRowId, 'failed', analysisStatus);
  } finally {
    analysisStatus.isRunning = false;
  }
}

// ─── Get current analysis status ─────────────────────────────────────────────

export function getImpactStatus(): ImpactAnalysisStatus {
  // If not running, refresh total impacts from DB. Scoped to the active
  // language so the UI counter matches what's actually rendered.
  if (!analysisStatus.isRunning) {
    try {
      const db = getDb();
      const lang = getActiveOutputLanguage();
      const countRow = db.prepare(
        'SELECT COUNT(*) as cnt FROM projects_impact WHERE output_language = ?'
      ).get(lang) as { cnt: number };
      analysisStatus.totalImpacts = countRow.cnt;
    } catch {
      // ignore
    }
  }
  // Read straight from the journal rather than from memory: after a restart the
  // in-memory status is blank, and the journal is the only thing that still
  // knows the previous run was killed mid-flight.
  return { ...analysisStatus, lastRun: readLastRun() };
}

// ─── Portfolio membership ────────────────────────────────────────────────────

/**
 * Canonical ids of every project in the portfolio.
 *
 * Resolved at READ time rather than stored on the row: `projects` is rebuilt on
 * every sheet upload, so a reference that is dangling today can become valid
 * tomorrow (and vice versa) without the impact rows changing. Comparing
 * canonical forms also means `PRJ001395` in the sheet matches a document's
 * `PRJ0001395` — measured 2026-08-31, 4 of 23 references were exactly that.
 */
function loadPortfolioIds(): Set<string> {
  const ids = new Set<string>();
  try {
    const rows = getDb().prepare('SELECT DISTINCT project_id FROM projects').all() as { project_id: string }[];
    for (const r of rows) {
      const id = normalizeProjectId(r.project_id);
      if (id) ids.add(id);
    }
  } catch { /* an empty set just marks everything unresolved */ }
  return ids;
}

function markResolved(rows: ProjectImpact[], portfolio: Set<string>): ProjectImpact[] {
  for (const r of rows) {
    const isPseudo = r.targetProjectId === 'GIO_SERVICES' || r.targetProjectId === 'DDS_IMPACTS';
    r.targetResolved = isPseudo || portfolio.has(normalizeProjectId(r.targetProjectId) ?? '');
  }
  return rows;
}

// ─── Get impacts for a specific project ──────────────────────────────────────

export function getProjectImpacts(projectId: string): ProjectImpact[] {
  const db = getDb();
  const lang = getActiveOutputLanguage();
  const rows = db.prepare(`
    SELECT * FROM projects_impact
    WHERE (source_project_id = ? OR target_project_id = ?) AND output_language = ?
    ORDER BY
      CASE severity WHEN 'high' THEN 1 WHEN 'low' THEN 2 WHEN 'medium' THEN 2 ELSE 3 END,
      created_at DESC
  `).all(projectId, projectId, lang) as ImpactDbRow[];

  return markResolved(rows.map(mapImpactRow), loadPortfolioIds());
}

// ─── Clear all impacts ───────────────────────────────────────────────────────

export function clearAllImpacts(): number {
  if (analysisStatus.isRunning) {
    throw new Error('Cannot clear impacts while an analysis is running');
  }
  const db = getDb();
  const lang = getActiveOutputLanguage();
  // Scope to the active language so toggling FR↔EN doesn't blow away the
  // other side's analysis. Deep-dive cache is language-agnostic in the
  // schema; cascade-clear all of it because the impact rows it cites are
  // gone for this language regardless.
  const result = db.prepare('DELETE FROM projects_impact WHERE output_language = ?').run(lang);
  const ddResult = db.prepare('DELETE FROM impact_deep_dives').run();
  if (ddResult.changes > 0) {
    console.log(`[impact] cleared ${result.changes} impacts (lang=${lang}) and cascaded ${ddResult.changes} cached deep dives`);
  }
  analysisStatus.totalImpacts = 0;
  return result.changes;
}

// ─── Get all impacts ─────────────────────────────────────────────────────────

export function getAllImpacts(): ProjectImpact[] {
  const db = getDb();
  const lang = getActiveOutputLanguage();
  const rows = db.prepare(`
    SELECT * FROM projects_impact
    WHERE output_language = ?
    ORDER BY
      CASE severity WHEN 'high' THEN 1 WHEN 'low' THEN 2 WHEN 'medium' THEN 2 ELSE 3 END,
      created_at DESC
  `).all(lang) as ImpactDbRow[];

  return markResolved(rows.map(mapImpactRow), loadPortfolioIds());
}

// ─── DB row mapping ──────────────────────────────────────────────────────────

interface ImpactDbRow {
  id: number;
  source_project_id: string;
  target_project_id: string;
  impact_type: string;
  direction: string;
  severity: string;
  explanation: string;
  batch_id: string;
  created_at: string;
  gio_services: string;
  dds_entities: string;
  citations: string;
  evidence_chain?: string;
}

// ─── Aggregation ─────────────────────────────────────────────────────────────
// Raw rows in `projects_impact` are granular: the same pair of projects can
// appear up to N times — once per `impact_type`, plus duplicates for bidirectional
// edges (A→B and B→A). For dashboard views this fragmentation inflates the count
// and clutters the UI. `aggregateImpacts` collapses every raw row sharing the
// same unordered pair into a single representative entry, preserving the full
// detail in the *plural* fields (impactTypes, directions, explanations).

// Two-tier severity since 2026-06-18. 'medium' keeps a rank entry so any
// stray legacy row (or a slow-to-update LLM response) still sorts correctly.
const SEVERITY_RANK: Record<string, number> = { high: 2, low: 1, medium: 1 };

export function aggregateImpacts(rows: ProjectImpact[]): ProjectImpact[] {
  const groups = new Map<string, ProjectImpact[]>();
  for (const r of rows) {
    const a = r.sourceProjectId;
    const b = r.targetProjectId;
    const key = a < b ? `${a}__${b}` : `${b}__${a}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }

  const uniqSorted = (xs: string[]) => Array.from(new Set(xs.filter(Boolean))).sort();

  const out: ProjectImpact[] = [];
  for (const arr of groups.values()) {
    // Primary = highest severity, longest explanation as tiebreaker. Used to
    // pick the orientation (source/target) and the headline explanation.
    const primary = [...arr].sort((x, y) => {
      const dr = (SEVERITY_RANK[y.severity] ?? 0) - (SEVERITY_RANK[x.severity] ?? 0);
      if (dr !== 0) return dr;
      return (y.explanation?.length ?? 0) - (x.explanation?.length ?? 0);
    })[0];

    const distinctSources = new Set(arr.map(r => r.sourceProjectId));

    // Keep explanations, citationsByExplanation, impactTypeByExplanation,
    // severityByExplanation in lock-step: each non-empty explanation gets its
    // metadata at the same index. Primary goes first. This is what lets the
    // UI render per-message badges (impact_type + severity) and per-message
    // citation popovers correctly aligned to their originating raw row.
    const ordered = [primary, ...arr.filter(r => r.id !== primary.id)];
    const explanations: string[] = [];
    const citationsByExplanation: NonNullable<ProjectImpact['citations']>[] = [];
    const impactTypeByExplanation: string[] = [];
    const severityByExplanation: string[] = [];
    const gioServicesByExplanation: string[][] = [];
    const ddsEntitiesByExplanation: string[][] = [];
    for (const r of ordered) {
      if (!r.explanation) continue;
      explanations.push(r.explanation);
      citationsByExplanation.push(r.citations ?? []);
      impactTypeByExplanation.push(r.impactType);
      severityByExplanation.push(r.severity);
      gioServicesByExplanation.push(r.gioServices ?? []);
      ddsEntitiesByExplanation.push(r.ddsEntities ?? []);
    }

    out.push({
      id: primary.id,
      sourceProjectId: primary.sourceProjectId,
      targetProjectId: primary.targetProjectId,
      impactType: primary.impactType,
      direction: primary.direction,
      severity: primary.severity,
      explanation: primary.explanation,
      batchId: primary.batchId,
      createdAt: primary.createdAt,
      gioServices: uniqSorted(arr.flatMap(r => r.gioServices ?? [])),
      ddsEntities: uniqSorted(arr.flatMap(r => r.ddsEntities ?? [])),
      citations: primary.citations ?? [],
      evidenceChain: arr.flatMap(r => r.evidenceChain ?? []),
      // Every row in the group shares the same unordered pair, so resolution is
      // a property of the group, not of the representative row.
      targetResolved: primary.targetResolved,
      impactTypes: uniqSorted(arr.map(r => r.impactType)),
      directions: uniqSorted(arr.map(r => r.direction)),
      explanations,
      citationsByExplanation,
      impactTypeByExplanation,
      severityByExplanation,
      gioServicesByExplanation,
      ddsEntitiesByExplanation,
      count: arr.length,
      bidirectional: distinctSources.size > 1,
    });
  }

  return out.sort((x, y) => {
    const dr = (SEVERITY_RANK[y.severity] ?? 0) - (SEVERITY_RANK[x.severity] ?? 0);
    if (dr !== 0) return dr;
    return (y.count ?? 1) - (x.count ?? 1);
  });
}

function mapImpactRow(row: ImpactDbRow): ProjectImpact {
  let parsedGio: string[] = [];
  try {
    parsedGio = row.gio_services ? JSON.parse(row.gio_services) : [];
  } catch { /* ignore */ }
  let parsedDds: string[] = [];
  try {
    parsedDds = row.dds_entities ? JSON.parse(row.dds_entities) : [];
  } catch { /* ignore */ }
  // Citations are stored without file_name (LLM doesn't get a stable one). We
  // enrich at read time so the popover always shows the human-readable name
  // currently in documents_cache, not a snapshot from generation time.
  let parsedCitations: { doc_url: string; file_name: string; snippet: string }[] = [];
  try {
    if (row.citations) {
      const raw = JSON.parse(row.citations) as { doc_url?: string; snippet?: string; file_name?: string }[];
      if (Array.isArray(raw)) {
        parsedCitations = raw
          .filter(c => c && typeof c.doc_url === 'string' && typeof c.snippet === 'string')
          .map(c => ({ doc_url: c.doc_url!, snippet: c.snippet!, file_name: c.file_name || '' }));
      }
    }
  } catch { /* ignore */ }

  if (parsedCitations.length > 0) {
    const urls = parsedCitations.map(c => c.doc_url);
    const nameByUrl = getFileNamesForUrls(urls);
    parsedCitations = parsedCitations.map(c => ({
      ...c,
      file_name: c.file_name || nameByUrl.get(c.doc_url) || '',
    }));
  }

  // Onda 4: parse evidence_chain so the API layer can synthesize fallback
  // citations from goal claims when the LLM left `citations` empty.
  let parsedChain: { goal_id: number; claim_idx?: number; relation_idx?: number; source: 'claim' | 'relation' | 'free' }[] = [];
  try {
    if (row.evidence_chain) {
      const raw = JSON.parse(row.evidence_chain);
      if (Array.isArray(raw)) parsedChain = raw;
    }
  } catch { /* ignore */ }

  return {
    id: row.id,
    sourceProjectId: row.source_project_id,
    targetProjectId: row.target_project_id,
    impactType: row.impact_type,
    direction: row.direction,
    severity: row.severity,
    explanation: row.explanation,
    batchId: row.batch_id,
    createdAt: row.created_at,
    gioServices: parsedGio,
    ddsEntities: parsedDds,
    citations: parsedCitations,
    evidenceChain: parsedChain,
  };
}

// ─── Query Preview ───────────────────────────────────────────────────────────

export interface ImpactQueryPreview {
  query: string;
  columns: string[];
  rowCount: number;
  rows: Record<string, unknown>[];
  groupedRowCount: number;
  generatedAt: string;
}

export function getImpactQueryPreview(mode: 'raw' | 'grouped' = 'raw'): ImpactQueryPreview {
  const db = getDb();
  const lang = getActiveOutputLanguage();
  const rawRows = db.prepare(IMPACT_ANALYSIS_QUERY).all(lang) as Record<string, unknown>[];

  const grouped = new Set(rawRows.map(r => String(r.project_id)));

  const rows = mode === 'grouped'
    ? fetchAllProjectRecords(lang) as unknown as Record<string, unknown>[]
    : rawRows;

  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

  return {
    query: IMPACT_ANALYSIS_QUERY.trim(),
    columns,
    rowCount: rows.length,
    rows,
    groupedRowCount: grouped.size,
    generatedAt: new Date().toISOString(),
  };
}

import { getDb } from './db';
import { generateContent, getActiveOutputLanguage, type OutputLanguage } from './llm';
import { getProjectDocuments, runDriveDownloadSingle, getDriveStatus } from './drive-engine';
import { GATE_ORDER } from './constants';
import crypto from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PlanningEvent {
  date: string | null;
  label: string;
  evidenceFile: string | null;
}

export interface PlanningGate {
  gate: string;
  date: string | null;
  forum: string | null;
  decision: string;
  note: string | null;
  evidenceFile: string | null;
  // true when date/decision come from the `projects` table (deterministic,
  // one row per real review) rather than being read off a document by the LLM.
  deterministic: boolean;
}

export interface PlanningAction {
  title: string;
  owner: string | null;
  status: 'open' | 'done';
  evidenceFile: string | null;
}

export interface PlanningFinancials {
  capexKEur: number | null;
  opexKEur: number | null;
  totalKEur: number | null;
  currency: string | null;
  fundingEntity: string | null;
  notes: string | null;
}

export interface PlanningResult {
  projectId: string;
  events: PlanningEvent[];
  gates: PlanningGate[];
  actions: PlanningAction[];
  financials: PlanningFinancials;
  // Total from the CDIO sheet row (`projects.cost_keur`) — always present when
  // known, regardless of whether `financials` has an LLM-extracted breakdown.
  // The UI falls back to this when `financials` is empty.
  fallbackCostKEur: number | null;
  // false when the project has no successfully-fetched Drive documents at
  // all — the LLM is never called in that case, only deterministic data
  // (gates from `projects`, fallback cost) is returned.
  hasDocuments: boolean;
  // true when this call attempted a just-in-time Drive sync because no
  // documents were cached yet (see `syncBeforeGenerate`).
  syncAttempted: boolean;
  // Set when a just-in-time sync was attempted and failed. `hasDocuments`
  // still reflects reality afterward (it may be true even if a later part of
  // the sync errored, or false if the sync itself failed outright).
  syncError: string | null;
  llmProvider: string | null;
  llmModel: string | null;
  generatedAt: string | null;
  durationMs: number | null;
  cached: boolean;
}

interface PlanningRow {
  project_id: string;
  response_json: string;
  llm_provider: string;
  llm_model: string;
  generated_at: string;
  source_sig: string;
  duration_ms: number | null;
}

interface ProjectRow {
  id: number;
  project_id: string;
  name: string;
  dds: string;
  gate: string;
  decision: string;
  cost_keur: number | null;
  description: string;
  remarks: string;
  review_date: string;
  link_folder: string;
  link_positions: string;
  link_cioo: string;
}

interface GoalsRow {
  digital_technologies: string;
  summary_one_line: string;
  timeline_struct: string;
  source_files: string;
  analyzed_at: string;
}

// The raw shape the LLM is asked to emit — see buildPrompt's JSON schema.
interface RawLLMGate {
  gate?: unknown;
  date?: unknown;
  forum?: unknown;
  decision?: unknown;
  note?: unknown;
  evidence_file?: unknown;
}
interface RawLLMResponse {
  events?: unknown;
  gates?: unknown;
  actions?: unknown;
  financials?: unknown;
}

// ─── Cache key (source signature) ────────────────────────────────────────────
//
// Same recipe as deep-dive-engine.ts: hash of project_goals.source_files +
// analyzed_at. Regenerates automatically when documents are re-scanned.

function computeSourceSig(goalsRow: GoalsRow | undefined): string {
  if (!goalsRow) return 'no-goals';
  const payload = `${goalsRow.source_files || '[]'}|${goalsRow.analyzed_at || ''}`;
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

// ─── Deterministic gate history (from `projects`, one row per real review) ──

function normalizeGateKey(gate: string): string {
  return gate.trim().toLowerCase();
}

function gateSortIndex(gate: string): number {
  const idx = GATE_ORDER.indexOf(gate.trim());
  return idx === -1 ? GATE_ORDER.length : idx;
}

function getDeterministicGates(projectId: string): PlanningGate[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT gate, review_date, decision
    FROM projects
    WHERE project_id = ? AND COALESCE(TRIM(gate), '') != ''
    ORDER BY review_date DESC, id DESC
  `).all(projectId) as { gate: string; review_date: string; decision: string }[];

  // A project can have several sheet rows for the same gate (re-review at the
  // same gate). Keep the most recent one per gate — that dedupe already
  // happens implicitly since rows are ordered newest-first and we only keep
  // the first occurrence of each gate key.
  const seen = new Set<string>();
  const out: PlanningGate[] = [];
  for (const r of rows) {
    const key = normalizeGateKey(r.gate);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      gate: r.gate.trim(),
      date: r.review_date || null,
      forum: null,
      decision: r.decision || '',
      note: null,
      evidenceFile: null,
      deterministic: true,
    });
  }
  return out;
}

function getFallbackCostKEur(projectId: string): number | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT cost_keur FROM projects
    WHERE project_id = ? AND cost_keur IS NOT NULL
    ORDER BY review_date DESC, id DESC
    LIMIT 1
  `).get(projectId) as { cost_keur: number | null } | undefined;
  return row?.cost_keur ?? null;
}

// Merges the deterministic gate list with the LLM's `gates` array. Dedup key
// is the normalized gate label. Deterministic date/decision always win over
// the LLM's — the LLM only ever *adds* forum/note/evidence for a gate that's
// already known, or contributes a gate the sheet doesn't have (e.g. an
// internal TADA pass that never became a CDIO review row).
function mergeGates(deterministic: PlanningGate[], llmGates: RawLLMGate[]): PlanningGate[] {
  const byKey = new Map<string, PlanningGate>();
  for (const d of deterministic) byKey.set(normalizeGateKey(d.gate), { ...d });

  for (const raw of llmGates) {
    const gate = typeof raw.gate === 'string' ? raw.gate.trim() : '';
    if (!gate) continue;
    const key = normalizeGateKey(gate);
    const forum = typeof raw.forum === 'string' && raw.forum.trim() ? raw.forum.trim() : null;
    const note = typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim() : null;
    const evidenceFile = typeof raw.evidence_file === 'string' && raw.evidence_file.trim() ? raw.evidence_file.trim() : null;
    const decision = typeof raw.decision === 'string' ? raw.decision.trim() : '';
    const date = typeof raw.date === 'string' && raw.date.trim() ? raw.date.trim() : null;

    const existing = byKey.get(key);
    if (existing) {
      existing.forum = existing.forum || forum;
      existing.note = existing.note || note;
      existing.evidenceFile = existing.evidenceFile || evidenceFile;
      if (!existing.decision && decision) existing.decision = decision;
    } else {
      byKey.set(key, {
        gate, date, forum, decision, note, evidenceFile,
        deterministic: false,
      });
    }
  }

  return [...byKey.values()].sort((a, b) => {
    if (a.date && b.date) return a.date.localeCompare(b.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return gateSortIndex(a.gate) - gateSortIndex(b.gate);
  });
}

// ─── Cache lookup / write ────────────────────────────────────────────────────

function readCache(projectId: string, sig: string, lang: OutputLanguage): PlanningRow | undefined {
  const db = getDb();
  return db.prepare(`
    SELECT project_id, response_json, llm_provider, llm_model, generated_at, source_sig, duration_ms
    FROM project_planning
    WHERE project_id = ? AND source_sig = ? AND output_language = ?
  `).get(projectId, sig, lang) as PlanningRow | undefined;
}

function readLatestCache(projectId: string, lang: OutputLanguage): PlanningRow | undefined {
  const db = getDb();
  return db.prepare(`
    SELECT project_id, response_json, llm_provider, llm_model, generated_at, source_sig, duration_ms
    FROM project_planning
    WHERE project_id = ? AND output_language = ?
    ORDER BY generated_at DESC
    LIMIT 1
  `).get(projectId, lang) as PlanningRow | undefined;
}

function writeCache(row: {
  projectId: string;
  responseJson: string;
  llmProvider: string;
  llmModel: string;
  sourceSig: string;
  durationMs: number;
  outputLanguage: OutputLanguage;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO project_planning
      (project_id, response_json, llm_provider, llm_model, source_sig, duration_ms, output_language)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, output_language) DO UPDATE SET
      response_json = excluded.response_json,
      llm_provider  = excluded.llm_provider,
      llm_model     = excluded.llm_model,
      source_sig    = excluded.source_sig,
      duration_ms   = excluded.duration_ms,
      generated_at  = datetime('now')
  `).run(
    row.projectId, row.responseJson, row.llmProvider, row.llmModel,
    row.sourceSig, row.durationMs, row.outputLanguage
  );
}

// ─── Prompt builder ──────────────────────────────────────────────────────────

const DOC_SLICE = 15000;
const DOC_TOTAL = 80000;
const PLANNING_TEMPERATURE = 0.2;

function buildPrompt(args: {
  project: ProjectRow;
  goals: GoalsRow | undefined;
  deterministicGates: PlanningGate[];
  docs: { url: string; content: string; status: string; fileName: string }[];
}): string {
  const { project, goals, deterministicGates, docs } = args;

  const docExcerpts: string[] = [];
  let used = 0;
  for (const d of docs) {
    if (d.status !== 'success' || !d.content) continue;
    const text = d.content.slice(0, DOC_SLICE);
    if (used + text.length > DOC_TOTAL) break;
    const fileName = d.fileName || d.url.split('/').pop() || d.url;
    docExcerpts.push(`\n[file_name=${fileName}]\n${text}`);
    used += text.length;
  }
  const docsBlock = docExcerpts.join('\n') || '(no documents available in cache for this project)';

  const gatesBlock = deterministicGates.length > 0
    ? deterministicGates.map(g => `- Gate ${g.gate}: reviewed ${g.date || 'unknown date'}, decision "${g.decision || 'unspecified'}"`).join('\n')
    : '(no gate review rows on record in the CDIO sheet)';

  // Human-readable, not the raw field=value pairs — an earlier version handed
  // the model "gate1_actual=2023-07-11" and it copied that key verbatim into
  // an event's "label", producing unreadable events like `{"label": "gate1_actual"}`.
  let timelineHint = '(none)';
  if (goals?.timeline_struct) {
    try {
      const t = JSON.parse(goals.timeline_struct) as Record<string, unknown>;
      const parts: string[] = [];
      if (t.gate1_actual) parts.push(`Gate 1 actually happened on ${t.gate1_actual}`);
      if (t.gate2_target) parts.push(`Gate 2 is targeted for ${t.gate2_target}`);
      if (t.go_live_target) parts.push(`Go-live is targeted for ${t.go_live_target}`);
      if (parts.length) timelineHint = parts.join('; ');
    } catch { /* ignore malformed JSON */ }
  }

  return `You are a PMO analyst at Air Liquide CIOO, structuring the governance history and budget of an IT project from its Drive documents (TADA notes, OCDIO Position documents, Q&A, budget sheets).

PROJECT
- ID: ${project.project_id}
- Name: ${project.name}
- Owning DDS: ${project.dds || 'unspecified'}
- Current gate (CDIO sheet): ${project.gate || 'unspecified'} (${project.decision || 'no decision'})
- Cost (CDIO sheet, pre-combined CAPEX+OPEX): ${project.cost_keur !== null ? `${project.cost_keur} k€` : 'unspecified'}
- Description: ${project.description || '(empty)'}
- Remarks: ${project.remarks || '(empty)'}
- Goals-extractor summary: ${goals?.summary_one_line || '(no Goals analysis on record)'}
- Goals-extractor timeline hint (narrow, dates only, from an earlier extraction pass): ${timelineHint}

KNOWN GATE REVIEWS (deterministic, already correct — from the CDIO sheet, one row per real review)
${gatesBlock}
For each gate above that you also find discussed in the documents, you may ADD a "forum" (e.g. "TADA", "OCDIO") and a short "note" (e.g. open conditions, why a first pass was rejected) — but do NOT invent a different date or decision for it; the sheet is authoritative for those two fields. You MAY also report additional gate passes found only in the documents (e.g. an internal TADA session that never became a sheet row) with their own date/decision if the documents state them.

PRIMARY DOCUMENT EXCERPTS (truncated to ~${DOC_TOTAL} chars total)
${docsBlock}

TASK
Extract, strictly from the documents above (never invent, never infer beyond what is written):
1. events — a chronological list of dated events: TADA/OCDIO sessions, deployment milestones, hard deadlines, decommission targets, savings-realization dates.
2. gates — as described above.
3. actions — open conditions / follow-ups from the latest gate decision (e.g. "update DRMT", "execute pentest before Go-Live"), with an owner (team or person) when the documents state one.
4. financials — approved CAPEX/OPEX amounts, currency, funding entity, and one or two lines of notes on cost drivers or projected savings, ONLY when the documents state them.

GROUNDING RULES (mandatory)
- Use null (for a single field) or [] (for a list) when something is not stated in the documents. Never guess, never infer, never extrapolate.
- Every event/gate/action should carry the file_name of the document it was read from in "evidence_file" (or null if it's a sheet-derived gate with no document backing).
- Dates: "YYYY-MM-DD" when a full date is known, "YYYY-MM" or "YYYY-Q1" style strings when only a coarser date is stated, null when there is no date at all — still include the event/action, just with date=null.
- Every "label"/"title"/"note" must be a short human-readable phrase in plain English, never an internal field name or code (e.g. write "Go-live target" or "Purchase order deadline", never "go_live_target" or a variable-like token).

Respond ONLY with a JSON object (no markdown fences, no explanation) with exactly this shape:
{
  "events": [
    { "date": "YYYY-MM-DD or YYYY-MM or null", "label": "short event description", "evidence_file": "filename or null" }
  ],
  "gates": [
    { "gate": "2", "date": "YYYY-MM-DD or null", "forum": "TADA | OCDIO | ... or null", "decision": "approved | rejected | contingent | pending or the sheet's own wording", "note": "one line or null", "evidence_file": "filename or null" }
  ],
  "actions": [
    { "title": "short imperative", "owner": "team or person, or null", "status": "open or done", "evidence_file": "filename or null" }
  ],
  "financials": {
    "capex_keur": 0,
    "opex_keur": 0,
    "total_keur": 0,
    "currency": "EUR or null",
    "funding_entity": "string or null",
    "notes": "one or two lines on cost drivers / savings, or null"
  }
}
Use null for any numeric field in "financials" that is not stated. If nothing at all is stated for financials, respond with "financials": { "capex_keur": null, "opex_keur": null, "total_keur": null, "currency": null, "funding_entity": null, "notes": null }.`;
}

// ─── Response parsing ────────────────────────────────────────────────────────

function parseLLMResponse(text: string): RawLLMResponse | null {
  try {
    let clean = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start >= 0 && end > start) clean = clean.slice(start, end + 1);
    const parsed = JSON.parse(clean);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as RawLLMResponse : null;
  } catch {
    return null;
  }
}

function sanitizeEvents(raw: unknown): PlanningEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanningEvent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const label = typeof r.label === 'string' ? r.label.trim() : '';
    if (!label) continue;
    out.push({
      date: typeof r.date === 'string' && r.date.trim() ? r.date.trim() : null,
      label,
      evidenceFile: typeof r.evidence_file === 'string' && r.evidence_file.trim() ? r.evidence_file.trim() : null,
    });
  }
  return out;
}

function sanitizeActions(raw: unknown): PlanningAction[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanningAction[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const title = typeof r.title === 'string' ? r.title.trim() : '';
    if (!title) continue;
    out.push({
      title,
      owner: typeof r.owner === 'string' && r.owner.trim() ? r.owner.trim() : null,
      status: r.status === 'done' ? 'done' : 'open',
      evidenceFile: typeof r.evidence_file === 'string' && r.evidence_file.trim() ? r.evidence_file.trim() : null,
    });
  }
  return out;
}

function sanitizeFinancials(raw: unknown): PlanningFinancials {
  const empty: PlanningFinancials = { capexKEur: null, opexKEur: null, totalKEur: null, currency: null, fundingEntity: null, notes: null };
  if (!raw || typeof raw !== 'object') return empty;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    capexKEur: num(r.capex_keur),
    opexKEur: num(r.opex_keur),
    totalKEur: num(r.total_keur),
    currency: str(r.currency),
    fundingEntity: str(r.funding_entity),
    notes: str(r.notes),
  };
}

function sanitizeGates(raw: unknown): RawLLMGate[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((g): g is RawLLMGate => !!g && typeof g === 'object');
}

// ─── Main entry: get-or-generate a planning result ───────────────────────────

export async function getOrGeneratePlanning(args: { projectId: string; force?: boolean }): Promise<PlanningResult> {
  const { projectId, force = false } = args;
  const db = getDb();
  const lang = getActiveOutputLanguage();

  const project = db.prepare(`
    SELECT id, project_id, name, dds, gate, decision, cost_keur, description, remarks, review_date,
           link_folder, link_positions, link_cioo
    FROM projects
    WHERE project_id = ?
    ORDER BY review_date DESC, id DESC
    LIMIT 1
  `).get(projectId) as ProjectRow | undefined;

  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }

  const goals = db.prepare(`
    SELECT digital_technologies, summary_one_line, timeline_struct, source_files, analyzed_at
    FROM project_goals
    WHERE project_id = ? AND output_language = ?
    ORDER BY analyzed_at DESC
    LIMIT 1
  `).get(projectId, lang) as GoalsRow | undefined;

  const deterministicGates = getDeterministicGates(projectId);
  const fallbackCostKEur = getFallbackCostKEur(projectId);
  const sig = computeSourceSig(goals);

  if (!force) {
    const cached = readCache(projectId, sig, lang);
    if (cached) {
      const parsed = parseLLMResponse(cached.response_json) || {};
      return {
        projectId,
        events: sanitizeEvents(parsed.events),
        gates: mergeGates(deterministicGates, sanitizeGates(parsed.gates)),
        actions: sanitizeActions(parsed.actions),
        financials: sanitizeFinancials(parsed.financials),
        fallbackCostKEur,
        hasDocuments: true,
        syncAttempted: false,
        syncError: null,
        llmProvider: cached.llm_provider,
        llmModel: cached.llm_model,
        generatedAt: cached.generated_at,
        durationMs: cached.duration_ms,
        cached: true,
      };
    }
  }

  let docs = getProjectDocuments(projectId);
  let hasDocuments = docs.some(d => d.status === 'success' && d.content);

  // Nothing cached yet, but the project has a Drive link — the "Generate
  // plan" button is the only sync affordance in this panel (no separate
  // "Sync" button), so a first-ever click here does the Drive fetch itself
  // before falling back to "no documents". Subsequent projects/reviews reuse
  // whatever documents_cache already has (see getProjectDocuments above).
  let syncAttempted = false;
  let syncError: string | null = null;
  const hasDriveLink = !!(project.link_folder || project.link_positions || project.link_cioo);
  if (!hasDocuments && hasDriveLink) {
    syncAttempted = true;
    if (getDriveStatus().isRunning) {
      syncError = 'A Drive sync is already running elsewhere — try again shortly.';
    } else {
      try {
        await runDriveDownloadSingle(projectId);
      } catch (err) {
        syncError = err instanceof Error ? err.message : 'Drive sync failed';
      }
    }
    docs = getProjectDocuments(projectId);
    hasDocuments = docs.some(d => d.status === 'success' && d.content);
  }

  // Still no documents (no Drive link at all, or the sync above found/fetched
  // nothing) — never call the LLM. Return the deterministic-only shell so the
  // UI can render gates/cost with a "no supporting documents" note instead of
  // an empty "Generate" flow that would produce nothing.
  if (!hasDocuments) {
    return {
      projectId,
      events: [],
      gates: mergeGates(deterministicGates, []),
      actions: [],
      financials: { capexKEur: null, opexKEur: null, totalKEur: null, currency: null, fundingEntity: null, notes: null },
      fallbackCostKEur,
      hasDocuments: false,
      syncAttempted,
      syncError,
      llmProvider: null,
      llmModel: null,
      generatedAt: null,
      durationMs: null,
      cached: false,
    };
  }

  const prompt = buildPrompt({ project, goals, deterministicGates, docs });

  const startedAt = Date.now();
  const { text, provider, modelUsed } = await generateContent({
    prompt,
    model: 'pro',
    json: true,
    context: 'project-planning',
    temperature: PLANNING_TEMPERATURE,
  });
  const durationMs = Date.now() - startedAt;

  const parsed = parseLLMResponse(text) || {};
  const responseJson = JSON.stringify({
    events: parsed.events ?? [],
    gates: parsed.gates ?? [],
    actions: parsed.actions ?? [],
    financials: parsed.financials ?? {},
  });

  writeCache({
    projectId,
    responseJson,
    llmProvider: provider,
    llmModel: modelUsed,
    sourceSig: sig,
    durationMs,
    outputLanguage: lang,
  });

  return {
    projectId,
    events: sanitizeEvents(parsed.events),
    gates: mergeGates(deterministicGates, sanitizeGates(parsed.gates)),
    actions: sanitizeActions(parsed.actions),
    financials: sanitizeFinancials(parsed.financials),
    fallbackCostKEur,
    hasDocuments: true,
    syncAttempted,
    syncError,
    llmProvider: provider,
    llmModel: modelUsed,
    generatedAt: new Date().toISOString(),
    durationMs,
    cached: false,
  };
}

// GET path: cached-only, no LLM call. Returns null when nothing was ever
// generated for this project (the UI then decides whether to offer a
// "Generate" button, based on whether documents exist).
export function getCachedPlanning(projectId: string): PlanningResult | null {
  const db = getDb();
  const lang = getActiveOutputLanguage();

  const project = db.prepare(`SELECT 1 FROM projects WHERE project_id = ? LIMIT 1`).get(projectId);
  if (!project) return null;

  const deterministicGates = getDeterministicGates(projectId);
  const fallbackCostKEur = getFallbackCostKEur(projectId);
  const cached = readLatestCache(projectId, lang);

  if (!cached) {
    // Nothing generated yet — still return deterministic gates/cost so the
    // panel isn't empty while the UI decides whether to show "Generate".
    return {
      projectId,
      events: [],
      gates: mergeGates(deterministicGates, []),
      actions: [],
      financials: { capexKEur: null, opexKEur: null, totalKEur: null, currency: null, fundingEntity: null, notes: null },
      fallbackCostKEur,
      hasDocuments: false,
      syncAttempted: false,
      syncError: null,
      llmProvider: null,
      llmModel: null,
      generatedAt: null,
      durationMs: null,
      cached: false,
    };
  }

  const parsed = parseLLMResponse(cached.response_json) || {};
  return {
    projectId,
    events: sanitizeEvents(parsed.events),
    gates: mergeGates(deterministicGates, sanitizeGates(parsed.gates)),
    actions: sanitizeActions(parsed.actions),
    financials: sanitizeFinancials(parsed.financials),
    fallbackCostKEur,
    syncAttempted: false,
    syncError: null,
    hasDocuments: true,
    llmProvider: cached.llm_provider,
    llmModel: cached.llm_model,
    generatedAt: cached.generated_at,
    durationMs: cached.duration_ms,
    cached: true,
  };
}

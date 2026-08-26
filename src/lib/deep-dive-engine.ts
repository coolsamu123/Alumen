import crypto from 'crypto';
import { getDb } from './db';
import { generateContent, getActiveOutputLanguage, type OutputLanguage } from './llm';
import { getProjectDocuments, getFileNamesForUrls } from './drive-engine';
import { getProjectImpacts, aggregateImpacts } from './impact-engine';
import { getTargetDefinition } from './target-catalog';

// ─── Types ──────────────────────────────────────────────────────────────────

// Onda 4: 'project' kind narrates a project↔project edge. The `target` for
// that kind is the *other* PRJ id (e.g. PRJ0018698). Until Onda 4 this was
// the silent gap — the Impact view had no dive for project↔project rows.
export type DeepDiveKind = 'gio' | 'dds' | 'project';

// One source the LLM grounded a section of the deep dive on. `id` is the
// numeric tag the model uses in `_Sources: [n]_` markers within the markdown
// body. doc_url is the verbatim URL the model echoed back from the prompt;
// file_name is enriched from documents_cache at read time.
export interface DeepDiveSource {
  id: number;
  doc_url: string;
  file_name: string;
  snippet: string;
}

export interface DeepDiveResult {
  projectId: string;
  kind: DeepDiveKind;
  target: string;
  responseMd: string;
  sources: DeepDiveSource[];
  llmProvider: string;
  llmModel: string;
  generatedAt: string;
  durationMs: number | null;
  cached: boolean;
}

interface DeepDiveRow {
  project_id: string;
  kind: string;
  target: string;
  response_md: string;
  llm_provider: string;
  llm_model: string;
  generated_at: string;
  source_sig: string;
  duration_ms: number | null;
  sources_json: string;
}

interface ProjectRow {
  project_id: string;
  name: string;
  dds: string;
  gate: string;
  decision: string;
  cost_keur: number | null;
  description: string;
  remarks: string;
  qa: string;
  review_date: string;
  link_folder: string;
  link_positions: string;
  link_cioo: string;
}

interface GoalsRow {
  summary_one_line: string;
  digital_technologies: string;
  change_management: string;
  security_impacts: string;
  regional_impacts: string;
  ia_embedded: string;
  gio_sl_dds_impacts: string;
  dds_gio_workload: string;
  business_apps_cis: string;
  dds_entities_touched: string;     // JSON
  gio_services_touched: string;     // JSON
  tech_tags: string;                // JSON
  vendors: string;                  // JSON
  data_classifications: string;     // JSON
  mentioned_projects: string;       // JSON
  // Onda 2 + Onda 3 structured signal — Deep Dive consumes these directly
  // so its narrative is bound to the same evidence the Impact engine uses.
  project_relations: string;        // JSON: [{project_id, kind, relation, source_file, evidence_quote, confidence}]
  out_of_scope: string;             // JSON: [{topic, evidence_quote, source_file}]
  impact_claims: string;            // JSON: [{target_kind, target, role, severity, impact_type, evidence_file, evidence_quote, confidence}]
  timeline_struct: string;          // JSON object
  region: string;
  source_files: string;
  analyzed_at: string;
}

// ─── Cache key (source signature) ────────────────────────────────────────────
//
// Hashes the source_files + analyzed_at of the latest Goals analysis. If the
// underlying inputs change (re-extraction with different files, or re-analysis
// with same files but newer LLM run), the cached deep-dive is invalidated
// automatically — no TTL, no manual flush.

function computeSourceSig(goalsRow: GoalsRow | undefined): string {
  if (!goalsRow) return 'no-goals';
  const payload = `${goalsRow.source_files || '[]'}|${goalsRow.analyzed_at || ''}`;
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

// ─── Cache lookup / write ────────────────────────────────────────────────────

function readCache(projectId: string, kind: DeepDiveKind, target: string, sig: string, lang: OutputLanguage): DeepDiveRow | undefined {
  const db = getDb();
  return db.prepare(`
    SELECT project_id, kind, target, response_md, llm_provider, llm_model,
           generated_at, source_sig, duration_ms, sources_json
    FROM impact_deep_dives
    WHERE project_id = ? AND kind = ? AND target = ? AND source_sig = ? AND output_language = ?
  `).get(projectId, kind, target, sig, lang) as DeepDiveRow | undefined;
}

function writeCache(row: {
  projectId: string;
  kind: DeepDiveKind;
  target: string;
  responseMd: string;
  sourcesJson: string;
  llmProvider: string;
  llmModel: string;
  sourceSig: string;
  durationMs: number;
  outputLanguage: OutputLanguage;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO impact_deep_dives
      (project_id, kind, target, response_md, llm_provider, llm_model, source_sig, duration_ms, sources_json, output_language)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, kind, target, output_language) DO UPDATE SET
      response_md  = excluded.response_md,
      llm_provider = excluded.llm_provider,
      llm_model    = excluded.llm_model,
      source_sig   = excluded.source_sig,
      duration_ms  = excluded.duration_ms,
      sources_json = excluded.sources_json,
      generated_at = datetime('now')
  `).run(
    row.projectId, row.kind, row.target, row.responseMd,
    row.llmProvider, row.llmModel, row.sourceSig, row.durationMs, row.sourcesJson,
    row.outputLanguage
  );
}

// ─── Prompt builder ──────────────────────────────────────────────────────────

// Gemini 3.1 Pro has a ~1M context window, so we can afford to feed it real
// document content instead of starving it with first-paragraph excerpts.
// At ~4 chars/token these caps land around ~5k tokens per doc and ~20k tokens
// total across docs — still tiny vs. the model's window, plenty to ground the
// analysis on actual content.
const DOC_SLICE = 15000;    // chars per doc
const DOC_TOTAL = 80000;    // total chars across all docs
const DEEP_DIVE_TEMPERATURE = 0.3;

// ─── Few-shot: one synthetic gold-standard deep dive ────────────────────────
//
// Calibrates tone, depth, and grounding discipline. Synthetic so we don't leak
// any real project content; structure mirrors what we want for any real call.
//
// NOTE: the prompt forbids inline citation tags like [goals.X] or [doc:Y] in
// the visible prose. Grounding still matters — when the model attributes a
// claim, it does so in plain prose ("the Goals field listing …", "the rollout
// deck", "the QA notes"), not bracket syntax.

const FEW_SHOT_EXAMPLE = `<example>
INPUT (abridged):
- Target: GIO Service Line "User Workplace"
- Project: PRJ0099999 "Frontline Tablet Rollout — Industrial Apps"
- Goals.summary_one_line: "Replace 4,200 shopfloor laptops with ruggedised Windows tablets across European sites by Q2 next year."
- Goals.gio_services_touched: User Workplace, Security & Compliance
- Goals.security_impacts: "New tablets need Zscaler client + Intune enrolment; reduces local-admin footprint."
- Goals.dds_gio_workload: "Estimated 2 FTE on User Workplace team for image build + pilot support."
- PRIMARY DOCUMENT EXCERPTS:
  [doc_url=https://drive.google.com/drive/folders/EXAMPLE1, file_name=Rollout_Plan_v4.pptx]
  ...standard endpoint image hardened by GIO User Workplace, Intune-managed, no local admin. The pilot covers 200 devices across two French sites before the wider European cutover...
- Existing one-liner: "Replaces shopfloor laptops with managed Windows tablets, depends on User Workplace image and MDM."

OUTPUT:
## Bottom line
The project consumes the standard User Workplace endpoint image and Intune MDM pipeline for 4,200 new tablets, with a ~2 FTE direct load on the User Workplace team over the rollout window.
_Sources: [1]_

## Why this impact exists
The project does not deploy its own device-management stack — it explicitly adopts the GIO User Workplace standard image and the Intune-based MDM pipeline. That puts User Workplace on the critical path: any image, hardening, or MDM-policy change during the rollout window will block site cutovers.
_Sources: [1]_

## Concrete touchpoints
- Endpoint image: project consumes the hardened Windows image owned by User Workplace.
- MDM enrolment: all 4,200 tablets enrol into the User-Workplace-managed Intune tenant.
- Local admin policy: project inherits the User Workplace "no local admin" baseline.
- Endpoint security agent: Zscaler client is part of the User Workplace endpoint bundle.
_Sources: [1]_

## Estimated workload
2 FTE from the User Workplace team for image build and pilot support during the rollout window. Steady-state load after cutover is not documented.
_Sources: []_

## Risks and dependencies
A delay in the next User Workplace image refresh would block site cutovers, since the project has no fallback image. Capacity contention with other User Workplace consumers during the same window is not documented.
_Sources: [1]_

## Origin of the inference
- The critical-path framing comes from the Goals field listing User Workplace as a touched service, reinforced by the explicit dependency in the rollout plan deck.
- The workload figure is taken verbatim from the Goals DDS/GIO workload field.
_Sources: [1]_

## Sources
1. [Rollout_Plan_v4.pptx](https://drive.google.com/drive/folders/EXAMPLE1) — "Standard endpoint image hardened by GIO User Workplace, Intune-managed, no local admin."
</example>`;

function buildPrompt(args: {
  kind: DeepDiveKind;
  target: string;
  project: ProjectRow;
  goals: GoalsRow | undefined;
  docs: { url: string; content: string; status: string; fileName: string }[];
  existingExplanation: string;
}): string {
  const { kind, target, project, goals, docs, existingExplanation } = args;

  const kindLabel =
    kind === 'gio' ? `GIO Service Line "${target}"` :
    kind === 'dds' ? `DDS entity "${target}"` :
    `companion project ${target}`;
  const kindHelper =
    kind === 'gio' ? 'a global infrastructure service line that the project depends on (e.g. Cloud Services, Security & Compliance, User Workplace, Site Infrastructure, Command Center)' :
    kind === 'dds' ? 'a Digital & Data Solutions organisational entity affected by the project (geographic zone, business division, or functional app group)' :
    'another Air Liquide IT project that shares a platform, vendor, timeline dependency, or replaces/extends this one';

  // #3 — Canonical definition of the specific target, if the catalog has one.
  // For kind='project', the target is another PRJ id — we surface the other
  // project's summary instead of catalog text.
  let targetBlock: string;
  if (kind === 'project') {
    // Pull the companion project's summary on the fly. Best-effort: silent
    // fallback to "no companion summary" if the row isn't there.
    const companion = getDb().prepare(`
      SELECT p.name, p.dds, p.gate, g.summary_one_line
      FROM projects p
      LEFT JOIN project_goals g
        ON g.project_id = p.project_id
        AND g.status = 'success'
        AND g.output_language = ?
      WHERE p.project_id = ? LIMIT 1
    `).get(getActiveOutputLanguage(), target) as { name?: string; dds?: string; gate?: string; summary_one_line?: string } | undefined;
    if (companion) {
      targetBlock = `COMPANION PROJECT "${target}"
- Name: ${companion.name || '(unknown)'}
- Owning DDS: ${companion.dds || 'unspecified'}
- Current gate: ${companion.gate || 'unspecified'}
- Summary: ${companion.summary_one_line || '(no Goals summary on record)'}`;
    } else {
      targetBlock = `(target ${target} not found in projects table — the deep dive should explain the relationship using only this project's documents)`;
    }
  } else {
    const targetDefinition = getTargetDefinition(kind as 'gio' | 'dds', target);
    targetBlock = targetDefinition
      ? `CANONICAL DEFINITION OF "${target}" (use this as the ground truth for what this target covers at Air Liquide):
${targetDefinition}`
      : `(no canonical definition available for "${target}" — fall back to the generic kind: ${kindHelper})`;
  }

  // Compose document excerpts (truncated per #1 to a much bigger window).
  // Each block is preceded by an explicit [doc_url=..., file_name=...] header
  // — the model uses these exact strings in its Sources list so the server can
  // map them back to documents_cache rows without ambiguity.
  const docExcerpts: string[] = [];
  let used = 0;
  for (const d of docs) {
    if (d.status !== 'success' || !d.content) continue;
    const text = d.content.slice(0, DOC_SLICE);
    if (used + text.length > DOC_TOTAL) break;
    const fileName = d.fileName || d.url.split('/').pop() || d.url;
    docExcerpts.push(`\n[doc_url=${d.url}, file_name=${fileName}]\n${text}`);
    used += text.length;
  }
  const docsBlock = docExcerpts.join('\n') || '(no documents available in cache for this project)';

  const parseArr = (raw: string | undefined): string[] => {
    if (!raw) return [];
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; }
    catch { return []; }
  };
  const parseObjArr = <T>(raw: string | undefined): T[] => {
    if (!raw) return [];
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v as T[] : []; }
    catch { return []; }
  };
  const fmtArr = (arr: string[]): string => (arr.length ? arr.join(', ') : 'Not identified');

  // Onda 4: pull structured signals and FILTER impact_claims to those matching
  // the current (kind, target) tuple — those are the load-bearing claims the
  // Deep Dive should narrate around. The rest of the project's claims provide
  // surrounding context only.
  type Claim = { target_kind: string; target: string; role: string; severity: string; impact_type: string; evidence_file: string; evidence_quote: string; confidence: string };
  type Relation = { project_id: string; kind: string; relation: string; source_file: string; evidence_quote: string; confidence: string };
  type Exclusion = { topic: string; evidence_quote: string; source_file: string };

  const allClaims = goals ? parseObjArr<Claim>(goals.impact_claims) : [];
  const projectRelations = goals ? parseObjArr<Relation>(goals.project_relations) : [];
  const outOfScope = goals ? parseObjArr<Exclusion>(goals.out_of_scope) : [];

  // For kind='gio'|'dds' the relevant claims are those whose (target_kind,target)
  // match. For kind='project' the load-bearing signal is the `project_relations`
  // entry pointing at the companion project; atomic claims are surrounding
  // context only.
  let relevantClaims: Claim[];
  let relevantRelations: Relation[];
  let otherClaims: Claim[];
  if (kind === 'project') {
    relevantClaims = [];
    relevantRelations = projectRelations.filter(r => r.project_id === target);
    otherClaims = allClaims;
  } else {
    relevantClaims = allClaims.filter(c => c.target_kind === kind && c.target === target);
    relevantRelations = [];
    otherClaims = allClaims.filter(c => !(c.target_kind === kind && c.target === target));
  }

  const claimsForThisTargetBlock = relevantClaims.length > 0
    ? relevantClaims.map((c, i) =>
        `${i + 1}. role=${c.role} sev=${c.severity} type=${c.impact_type} (${c.confidence}) — "${c.evidence_quote}" (in ${c.evidence_file})`
      ).join('\n')
    : (kind === 'project' ? '(this kind does not use impact_claims — see PROJECT RELATIONS below for the load-bearing signal)' : '(no atomic claim was extracted for this target — narrative must rely on Goals fields + document excerpts)');

  const otherClaimsBlock = otherClaims.length > 0
    ? otherClaims.slice(0, 8).map(c => `- ${c.target_kind.toUpperCase()} "${c.target}" role=${c.role} type=${c.impact_type}`).join('\n')
    : '(none)';

  const relevantRelationsBlock = relevantRelations.length > 0
    ? relevantRelations.map((r, i) =>
        `${i + 1}. kind=${r.kind} (${r.confidence}) — "${r.evidence_quote}" (in ${r.source_file})`
      ).join('\n')
    : '';

  const relationsBlock = projectRelations.length > 0
    ? projectRelations.slice(0, 10).map(r => `- → ${r.project_id} [${r.kind}, ${r.confidence}]: "${r.evidence_quote}"`).join('\n')
    : '(none)';

  const exclusionsBlock = outOfScope.length > 0
    ? outOfScope.map(o => `- "${o.topic}" — "${o.evidence_quote}" (in ${o.source_file})`).join('\n')
    : '(none)';

  const goalsBlock = goals
    ? [
        `- summary_one_line: ${goals.summary_one_line || 'Not identified'}`,
        `- tech_tags: ${fmtArr(parseArr(goals.tech_tags))}`,
        `- vendors: ${fmtArr(parseArr(goals.vendors))}`,
        `- data_classifications: ${fmtArr(parseArr(goals.data_classifications))}`,
        `- dds_entities_touched: ${fmtArr(parseArr(goals.dds_entities_touched))}`,
        `- gio_services_touched: ${fmtArr(parseArr(goals.gio_services_touched))}`,
        `- mentioned_projects: ${fmtArr(parseArr(goals.mentioned_projects))}`,
        `- digital_technologies: ${goals.digital_technologies || 'Not identified'}`,
        `- regional_impacts: ${goals.regional_impacts || 'Not identified'}`,
        `- gio_sl_dds_impacts: ${goals.gio_sl_dds_impacts || 'Not identified'}`,
        `- dds_gio_workload: ${goals.dds_gio_workload || 'Not identified'}`,
        `- business_apps_cis: ${goals.business_apps_cis || 'Not identified'}`,
        `- security_impacts: ${goals.security_impacts || 'Not identified'}`,
        `- change_management: ${goals.change_management || 'Not identified'}`,
        `- ia_embedded: ${goals.ia_embedded || 'Not identified'}`,
        `- region: ${goals.region || 'Not identified'}`,
      ].join('\n')
    : '(no Goals analysis on record)';

  return `You are a senior IT portfolio analyst at Air Liquide CIOO.

Your task: explain in detail WHY the project below has an impact on the ${kindLabel} (${kindHelper}). Produce a defensible, evidence-backed analysis that an executive could review before approving the next gate.

${targetBlock}

PROJECT
- ID: ${project.project_id}
- Name: ${project.name}
- Owning DDS: ${project.dds || 'unspecified'}
- Current gate: ${project.gate || 'unspecified'} (${project.decision || 'no decision'})
- Cost: ${project.cost_keur !== null ? `${project.cost_keur} k€` : 'unspecified'}
- Last review: ${project.review_date || 'unspecified'}
- Description (CIOO sheet): ${project.description || '(empty)'}
- Remarks (CIOO sheet): ${project.remarks || '(empty)'}
- QA notes: ${project.qa || '(empty)'}

GOALS-EXTRACTOR FIELDS (raw text the system ingested from project docs)
${goalsBlock}

ATOMIC IMPACT CLAIMS FOR THIS TARGET (authoritative — Goals already extracted these with evidence; the narrative MUST cover all of them)
${claimsForThisTargetBlock}
${relevantRelationsBlock ? `\nPROJECT-TO-PROJECT RELATIONS POINTING AT ${target} (load-bearing for kind='project' dives)\n${relevantRelationsBlock}` : ''}

OTHER ATOMIC CLAIMS (this project's claims on different targets — use as surrounding context, NOT as narrative content)
${otherClaimsBlock}

PROJECT RELATIONS (other PRJs this project depends on, replaces, etc — relevant background)
${relationsBlock}

EXPLICITLY OUT-OF-SCOPE (HARD NEGATIVE SIGNAL — do not narrate impacts that contradict these)
${exclusionsBlock}

PRIMARY DOCUMENT EXCERPTS (truncated to ~${DOC_TOTAL} chars total)
${docsBlock}

EXISTING ONE-LINER ALREADY ON RECORD (do not just rephrase — expand. If the documents contradict it, say so explicitly and provide the corrected framing.)
${existingExplanation || '(none)'}

GROUNDING RULES (mandatory)
- Every factual claim must be backed by at least one of: a Goals-Extractor field, a primary document excerpt, a CIOO project field, or the existing one-liner.
- If you cannot back a claim with one of those sources, DROP the claim entirely. Do not guess, do not infer, do not extrapolate beyond what the inputs literally support.
- Quote short verbatim phrases from documents inside double quotes when they materially support a claim.

SOURCE-TAGGING REQUIREMENT (mandatory)
- At the END of EVERY ## section's body, append a single line of the form: \`_Sources: [n, n, ...]_\` where each n references an entry from your final "## Sources" list. If the section is not backed by any document (purely synthesizes Goals/CIOO fields), append \`_Sources: []_\` instead. The line MUST appear; an empty list is allowed, a missing line is not.
- Do NOT scatter inline \`[n]\` markers inside sentences. Use only the trailing \`_Sources: [...]_\` line per section.
- The "## Sources" section is the LAST section. It is a numbered markdown list. Each entry has the form: \`n. [file_name](doc_url) — "first sentence of the source paragraph"\`. The doc_url MUST be a verbatim copy of one of the doc_url values that appeared in a [doc_url=..., file_name=...] header inside the PRIMARY DOCUMENT EXCERPTS block above. Do not invent URLs.
- Each snippet is the first sentence of the paragraph that backs the claim (max ~200 chars, no paraphrasing).
- If no document literally backs any claim, emit "## Sources" with an empty body — still required so the parser finds it.

OUTPUT REQUIREMENTS
- Markdown only. No code fences, no JSON.
- 6–8 short sections maximum (the "## Sources" section is mandatory and counts toward this total).
- Use exactly these section headers (## level), in this order:
  ## Bottom line
  ## Why this impact exists
  ## Concrete touchpoints
  ## Estimated workload
  ## Risks and dependencies
  ## Origin of the inference
  ## Sources
- "Bottom line" is exactly one sentence summarising why the impact matters and its scale.
- "Concrete touchpoints" is a bulleted list (5–10 bullets) of specific things this project does that touch ${target}. **PRIORITY ORDER**: there is one bullet per ATOMIC IMPACT CLAIM FOR THIS TARGET listed above (use the evidence_quote verbatim as the bullet content, with a short editorial prefix if needed). Add extra bullets ONLY when the documents reveal touchpoints that the claims missed.
- "Estimated workload" gives FTE or man-days if mentioned, else writes "Not documented".
- "Origin of the inference" is a short bulleted recap, in plain prose, of which Goals fields and document names support the main claims — phrased as a reviewer's audit trail.
- If a claim is unsupported by the inputs, drop the claim. Do not write "not documented" inside Bottom line / Why / Touchpoints — only inside Estimated workload and Risks.
- Do not repeat the project name in every paragraph; refer to it as "the project" after the first mention.

OUT-OF-SCOPE HANDLING (Onda 4)
- If any item in the EXPLICITLY OUT-OF-SCOPE block directly contradicts a touchpoint you are about to write, DO NOT write that touchpoint. Add a single sentence at the end of "Risks and dependencies" of the form: "⚠ The project explicitly excludes <topic> ('<evidence_quote>'), so any apparent impact on that surface is non-load-bearing."
- If a claim's evidence_quote contradicts an exclusion, treat the exclusion as the authority and drop the claim instead.

FEW-SHOT EXAMPLE (calibration only — do not copy the content, mirror the depth, structure, and source-tagging style)
${FEW_SHOT_EXAMPLE}`;
}

// ─── Main entry: get-or-generate a deep dive ─────────────────────────────────

export async function getOrGenerateDeepDive(args: {
  projectId: string;
  kind: DeepDiveKind;
  target: string;
  /**
   * When true, the cache lookup is skipped and the LLM is called even if a
   * cached row exists. The fresh result then overwrites the cached row via
   * the ON CONFLICT … DO UPDATE on writeCache.
   */
  force?: boolean;
}): Promise<DeepDiveResult> {
  const { projectId, kind, target, force = false } = args;
  const db = getDb();
  // Active language captured once for both the goals read and the cache
  // key. Without scoping to language, a deep dive cached in EN would be
  // served when the user has toggled to FR.
  const lang = getActiveOutputLanguage();

  // Load project + goals + docs in parallel-friendly fashion (sync queries).
  const project = db.prepare(`
    SELECT project_id, name, dds, gate, decision, cost_keur, description, remarks, qa,
           review_date, link_folder, link_positions, link_cioo
    FROM projects
    WHERE project_id = ?
    ORDER BY review_date DESC, id DESC
    LIMIT 1
  `).get(projectId) as ProjectRow | undefined;

  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }

  const goals = db.prepare(`
    SELECT summary_one_line,
           digital_technologies, change_management, security_impacts, regional_impacts,
           ia_embedded, gio_sl_dds_impacts, dds_gio_workload, business_apps_cis,
           dds_entities_touched, gio_services_touched,
           tech_tags, vendors, data_classifications, mentioned_projects,
           project_relations, out_of_scope, impact_claims, timeline_struct,
           region, source_files, analyzed_at
    FROM project_goals
    WHERE project_id = ? AND output_language = ?
    ORDER BY analyzed_at DESC
    LIMIT 1
  `).get(projectId, lang) as GoalsRow | undefined;

  // Cache lookup (skipped when force=true, e.g. user clicked Regenerate).
  const sig = computeSourceSig(goals);
  if (!force) {
    const cached = readCache(projectId, kind, target, sig, lang);
    if (cached) {
      return {
        projectId: cached.project_id,
        kind: cached.kind as DeepDiveKind,
        target: cached.target,
        responseMd: stripCitationTags(cached.response_md),
        sources: enrichSources(parseSourcesJson(cached.sources_json)),
        llmProvider: cached.llm_provider,
        llmModel: cached.llm_model,
        generatedAt: cached.generated_at,
        durationMs: cached.duration_ms,
        cached: true,
      };
    }
  }

  // Cache miss — gather context, build prompt, call LLM.
  const docs = getProjectDocuments(projectId);
  const aggregated = aggregateImpacts(getProjectImpacts(projectId));
  const matchingImpact = aggregated.find(imp => {
    if (kind === 'gio') {
      const isGio = imp.targetProjectId === 'GIO_SERVICES' || imp.sourceProjectId === 'GIO_SERVICES';
      return isGio && imp.gioServices?.includes(target);
    }
    if (kind === 'dds') {
      const isDds = imp.targetProjectId === 'DDS_IMPACTS' || imp.sourceProjectId === 'DDS_IMPACTS';
      return isDds && imp.ddsEntities?.includes(target);
    }
    // kind === 'project': match the edge where the OTHER side is `target`.
    return imp.targetProjectId === target || imp.sourceProjectId === target;
  });

  const existingExplanation = matchingImpact
    ? (matchingImpact.explanations?.join(' / ') || matchingImpact.explanation || '')
    : '';

  const prompt = buildPrompt({ kind, target, project, goals, docs, existingExplanation });

  const startedAt = Date.now();
  const { text, provider, modelUsed } = await generateContent({
    prompt,
    model: 'pro',
    context: 'deep-dive',
    temperature: DEEP_DIVE_TEMPERATURE,
  });
  const durationMs = Date.now() - startedAt;

  const stripped = stripCodeFences(text).trim();
  const { body, sources } = extractSources(stripped);
  // Belt-and-suspenders: clean up any legacy [doc:X] / [goals.Y] tags the model
  // might still emit inside the body. The new prompt uses _Sources: [n]_ only.
  const cleaned = stripCitationTags(body);
  const enriched = enrichSources(sources);

  writeCache({
    projectId, kind, target,
    responseMd: cleaned,
    sourcesJson: JSON.stringify(sources),
    llmProvider: provider,
    llmModel: modelUsed,
    sourceSig: sig,
    durationMs,
    outputLanguage: lang,
  });

  return {
    projectId, kind, target,
    responseMd: cleaned,
    sources: enriched,
    llmProvider: provider,
    llmModel: modelUsed,
    generatedAt: new Date().toISOString(),
    durationMs,
    cached: false,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function stripCodeFences(text: string): string {
  return text.replace(/^```(?:markdown|md)?\s*/i, '').replace(/```\s*$/i, '');
}

// Belt-and-suspenders: strips inline citation tags from a deep-dive response.
// The current prompt asks the model NOT to emit these, but:
//   - earlier cached rows were generated with a prompt that DID require them, and
//   - the model occasionally slips one in even with explicit instructions.
// Applied on both fresh generations and cached reads so end users always see
// clean prose without having to regenerate.
function stripCitationTags(text: string): string {
  // Match a single tag of the form [goals.field], [doc:filename...], [project.field],
  // or [impact.one_liner]. Filenames in [doc:...] can contain dots, spaces, dashes,
  // underscores — keep the matcher permissive but anchored on the [ ... ] shape.
  const tagRe = /\[(?:goals\.[a-z_]+|project\.[a-z_]+|impact\.[a-z_]+|doc:[^\]]+)\]/gi;
  let cleaned = text
    // Collapse runs of adjacent tags first ("[a][b][c]") so the surrounding-space
    // cleanup that follows treats them as a single unit.
    .replace(new RegExp(`(?:${tagRe.source}\\s*){1,}`, 'gi'), match => {
      // After collapsing, the match is just the tags + optional whitespace; drop it.
      return match.replace(tagRe, '').trim() === '' ? '' : match;
    })
    // Drop leftover individual tags.
    .replace(tagRe, '');
  // Tidy: kill " ." -> ".", "  " -> " ", " ," -> ",", and stray empty parens "()".
  cleaned = cleaned
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ');
  return cleaned;
}

// ─── Sources extraction / enrichment ────────────────────────────────────────

// Pulls the trailing "## Sources" section out of the markdown body. Returns
// the body with that section removed plus the parsed list. The model is told
// to always emit the section (possibly empty), but we tolerate its absence so
// older cached rows and the occasional malformed response don't error out.
function extractSources(text: string): { body: string; sources: DeepDiveSource[] } {
  const re = /^##\s+Sources\s*$/im;
  const match = text.match(re);
  if (!match || match.index === undefined) {
    return { body: text, sources: [] };
  }
  const body = text.slice(0, match.index).trimEnd();
  const sourcesBlock = text.slice(match.index + match[0].length).trim();

  // Each line in the block looks like:  1. [file_name](https://drive...) — "snippet"
  //                                or:  1. [file_name](https://drive...): snippet
  // We capture the id, doc_url, and snippet. Both ASCII "-" and em-dash "—"
  // separators are accepted; quotes around the snippet are optional.
  const entryRe = /^\s*(\d+)\.\s*\[([^\]]+)\]\(([^)]+)\)\s*[—:\-]\s*"?([^"\n]+)"?\s*$/gm;
  const sources: DeepDiveSource[] = [];
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(sourcesBlock)) !== null) {
    sources.push({
      id: parseInt(m[1], 10),
      file_name: m[2].trim(),
      doc_url: m[3].trim(),
      snippet: m[4].trim().replace(/["”]$/, ''),
    });
  }
  return { body, sources };
}

function parseSourcesJson(json: string | null | undefined): DeepDiveSource[] {
  if (!json) return [];
  try {
    const raw = JSON.parse(json) as Partial<DeepDiveSource>[];
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(s => s && typeof s.doc_url === 'string' && typeof s.snippet === 'string')
      .map((s, i) => ({
        id: typeof s.id === 'number' ? s.id : i + 1,
        doc_url: s.doc_url!,
        snippet: s.snippet!,
        file_name: s.file_name || '',
      }));
  } catch { return []; }
}

// Refresh file_name from documents_cache so renames after generation are
// reflected without regeneration.
function enrichSources(sources: DeepDiveSource[]): DeepDiveSource[] {
  if (sources.length === 0) return sources;
  const nameByUrl = getFileNamesForUrls(sources.map(s => s.doc_url));
  return sources.map(s => ({
    ...s,
    file_name: nameByUrl.get(s.doc_url) || s.file_name,
  }));
}

// ─── Convenience: list cached deep dives for a project (introspection) ───────

export function listDeepDivesForProject(projectId: string): DeepDiveResult[] {
  const db = getDb();
  const lang = getActiveOutputLanguage();
  const rows = db.prepare(`
    SELECT project_id, kind, target, response_md, llm_provider, llm_model,
           generated_at, source_sig, duration_ms, sources_json
    FROM impact_deep_dives
    WHERE project_id = ? AND output_language = ?
    ORDER BY generated_at DESC
  `).all(projectId, lang) as DeepDiveRow[];

  return rows.map(r => ({
    projectId: r.project_id,
    kind: r.kind as DeepDiveKind,
    target: r.target,
    responseMd: stripCitationTags(r.response_md),
    sources: enrichSources(parseSourcesJson(r.sources_json)),
    llmProvider: r.llm_provider,
    llmModel: r.llm_model,
    generatedAt: r.generated_at,
    durationMs: r.duration_ms,
    cached: true,
  }));
}

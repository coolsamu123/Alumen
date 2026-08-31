import { getDb } from './db';
import { scanProjects, fileSignature, type ScannedProject } from './goals-scanner';
import { extractAllTexts } from './goals-extractor';
import { getPrompts } from './prompts';
import { generateContent, getActiveOutputLanguage, type OutputLanguage } from './llm';
import {
  filterToCatalog,
  filterToDdsEntities,
  filterToGioServices,
  extractMentionedProjects,
} from './tech-catalog';
import { normalizeProjectId, sameProject } from './project-id';

// Bump this when the prompt schema changes in a way that requires
// re-analysing existing successful rows. The pipeline skip-logic compares
// against project_goals.prompt_version.
// Bumped to 4 in Onda 3: prompt now also asks for atomic `impact_claims`
// (with target_kind/target/role/severity/impact_type/evidence) and structured
// `timeline_struct`. All rows with version<4 get re-analyzed on next run.
export const GOALS_PROMPT_VERSION = 4;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ProjectGoals {
  id: number;
  project_id: string;
  project_name: string;
  region: string;
  gate: string;
  month_folder: string;
  // Free-form
  summary_one_line: string;
  digital_technologies: string;
  change_management: string;
  security_impacts: string;
  regional_impacts: string;
  ia_embedded: string;
  gio_sl_dds_impacts: string;
  dds_gio_workload: string;
  business_apps_cis: string;
  // Canonical arrays — stored as JSON strings in SQLite, parsed at the API edge
  dds_entities_touched: string;     // JSON array
  gio_services_touched: string;     // JSON array
  tech_tags: string;                // JSON array
  vendors: string;                  // JSON array
  data_classifications: string;     // JSON array
  mentioned_projects: string;       // JSON array (regex-extracted, not from LLM)
  prompt_version: number;
  raw_gemini_response: string;
  source_files: string;
  analyzed_at: string;
  status: string;
  error_message: string;
  output_language: OutputLanguage;
}

export interface GoalsRunStatus {
  isRunning: boolean;
  totalProjects: number;
  processedProjects: number;
  successCount: number;
  errorCount: number;
  /** Projects left untouched because nothing changed since the last run.
   *  Kept apart from successCount so "skipped an error row" never reads as a
   *  success in the UI. */
  skippedCount: number;
  currentProject: string;
  errors: string[];
}

let runStatus: GoalsRunStatus = {
  isRunning: false,
  totalProjects: 0,
  processedProjects: 0,
  successCount: 0,
  errorCount: 0,
  skippedCount: 0,
  currentProject: '',
  errors: [],
};

// ─── DB Schema ──────────────────────────────────────────────────────────────

export function initGoalsSchema() {
  // Schema (including ALTER TABLE migrations and the composite UNIQUE index
  // on (project_id, output_language)) is owned by `getDb()` →
  // `initSchema()` in `src/lib/db.ts`. Calling it here just ensures the
  // database is open; the legacy in-file schema kept drifting from the real
  // one in db.ts, so we removed the duplicate DDL.
  getDb();
}

// ─── Prompts ────────────────────────────────────────────────────────────────

function buildGoalsPrompt(project: ScannedProject, documentText: string): string {
  const { goalsPrompt } = getPrompts();
  
  const projectInfo = `PROJECT: ${project.projectName}
PROJECT ID: ${project.projectId}
REGION/DDS: ${project.region}
GATE: ${project.gate}
MONTHS REVIEWED: ${project.monthFolders.join(', ')}`;

  let prompt = goalsPrompt.replace('{{PROJECT_INFO}}', projectInfo);
  prompt = prompt.replace('{{DOCUMENT_TEXT}}', documentText);
  return prompt;
}

/**
 * Parses the model's JSON envelope.
 *
 * Returns null — NOT an empty object — when the response cannot be read, so the
 * caller can tell "the model returned something unparseable" apart from "the
 * documents genuinely contained nothing". Both used to collapse into a
 * `status='partial'` row with no error message, which made a broken response
 * indistinguishable from a thin project.
 */
function parseGoalsResponse(text: string): Record<string, unknown> | null {
  try {
    let clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start >= 0 && end > start) {
      clean = clean.slice(start, end + 1);
    }
    const parsed = JSON.parse(clean);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

// Onda 2: validate / sanitize the new structured arrays the prompt asks for.
// These run AFTER parseGoalsResponse — they don't reject the whole row, they
// just drop malformed entries silently. Empty/missing inputs return [].

const RELATION_KINDS = new Set([
  'predecessor', 'successor', 'parallel',
  'blocked_by', 'blocking', 'replaces', 'extends',
  'shares_platform', 'shares_vendor',
]);

interface ProjectRelation {
  project_id: string;
  kind: string;
  relation: string;
  source_file: string;
  evidence_quote: string;
  confidence: 'stated' | 'inferred';
}

function sanitizeProjectRelations(raw: unknown, ownProjectId: string): ProjectRelation[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ProjectRelation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    // Canonicalise so padding and PGM/PROG spelling differences don't create a
    // second identity for a project we already know (see project-id.ts).
    const pid = normalizeProjectId(r.project_id);
    if (!pid) continue;
    if (sameProject(pid, ownProjectId)) continue;
    const kind = String(r.kind || '').toLowerCase().trim();
    if (!RELATION_KINDS.has(kind)) continue;
    const evidence = String(r.evidence_quote || '').trim();
    if (evidence.length < 10) continue; // require real evidence
    const dedupeKey = `${pid}|${kind}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      project_id: pid,
      kind,
      relation: String(r.relation || '').slice(0, 100).trim(),
      source_file: String(r.source_file || '').trim(),
      evidence_quote: evidence.slice(0, 250),
      confidence: r.confidence === 'stated' ? 'stated' : 'inferred',
    });
  }
  return out;
}

interface OutOfScope {
  topic: string;
  evidence_quote: string;
  source_file: string;
}

function sanitizeOutOfScope(raw: unknown): OutOfScope[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: OutOfScope[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const topic = String(r.topic || '').trim();
    const evidence = String(r.evidence_quote || '').trim();
    if (topic.length < 3 || evidence.length < 10) continue;
    const key = topic.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      topic: topic.slice(0, 80),
      evidence_quote: evidence.slice(0, 250),
      source_file: String(r.source_file || '').trim(),
    });
  }
  return out;
}

// Onda 3: atomic impact_claims sanitizer. Rejects rows where:
//   - target_kind missing or not 'gio'|'dds'
//   - target not in canonical catalog (catches LLM typos)
//   - role outside the controlled enum
//   - evidence_quote shorter than 10 chars (forces real grounding)
import { isCanonicalTarget, type TargetKind } from './target-catalog';

const CLAIM_ROLES = new Set([
  'primary_provider', 'downstream_consumer', 'regional_executor', 'risk_owner', 'blocked_by',
]);
const CLAIM_IMPACT_TYPES = new Set([
  'infrastructure_shared', 'platform_shared', 'technology_dependency', 'vendor_shared',
  'security_dependency', 'organizational', 'regional_rollout', 'integration_required',
  'timeline_blocking', 'resource_contention',
]);
// Two-tier scale since 2026-06-18. 'medium' is silently rewritten to 'low'
// in the loop below — keeps legacy LLM responses from being dropped if the
// prompt update hasn't fully propagated.
const CLAIM_SEVERITIES = new Set(['high', 'low']);

interface ImpactClaim {
  target_kind: TargetKind;
  target: string;
  role: string;
  severity: string;
  impact_type: string;
  evidence_file: string;
  evidence_quote: string;
  confidence: 'stated' | 'inferred';
}

function sanitizeImpactClaims(raw: unknown): ImpactClaim[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ImpactClaim[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const target_kind = String(r.target_kind || '').toLowerCase();
    if (target_kind !== 'gio' && target_kind !== 'dds') continue;
    const target = String(r.target || '').trim();
    if (!isCanonicalTarget(target_kind, target)) continue;
    const role = String(r.role || '').toLowerCase();
    if (!CLAIM_ROLES.has(role)) continue;
    let severity = String(r.severity || '').toLowerCase();
    // Defensive: fold any leftover medium into low so the claim isn't
    // dropped if a slow-to-update model variant still emits the old enum.
    if (severity === 'medium') severity = 'low';
    if (!CLAIM_SEVERITIES.has(severity)) continue;
    const impact_type = String(r.impact_type || '').toLowerCase();
    if (!CLAIM_IMPACT_TYPES.has(impact_type)) continue;
    const evidence_quote = String(r.evidence_quote || '').trim();
    if (evidence_quote.length < 10) continue;
    // Dedupe by (target_kind, target, role, impact_type) — same target can
    // have multiple claims with different roles/types but not duplicates.
    const key = `${target_kind}|${target}|${role}|${impact_type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      target_kind: target_kind as TargetKind,
      target,
      role,
      severity,
      impact_type,
      evidence_file: String(r.evidence_file || '').trim(),
      evidence_quote: evidence_quote.slice(0, 250),
      confidence: r.confidence === 'stated' ? 'stated' : 'inferred',
    });
  }
  return out;
}

interface TimelineDep {
  project_id: string;
  reason: string;
  evidence_file: string;
  evidence_quote: string;
}
interface TimelineStruct {
  gate1_actual: string | null;
  gate2_target: string | null;
  go_live_target: string | null;
  must_complete_before: TimelineDep[];
  blocked_by: TimelineDep[];
}

function sanitizeTimeline(raw: unknown): TimelineStruct {
  const empty: TimelineStruct = {
    gate1_actual: null, gate2_target: null, go_live_target: null,
    must_complete_before: [], blocked_by: [],
  };
  if (!raw || typeof raw !== 'object') return empty;
  const r = raw as Record<string, unknown>;
  const normDate = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!s || s.toLowerCase() === 'null' || s.toLowerCase() === 'n/a' || s.toLowerCase() === 'tbd') return null;
    return s.slice(0, 20);
  };
  const normDeps = (val: unknown): TimelineDep[] => {
    if (!Array.isArray(val)) return [];
    const seen = new Set<string>();
    const list: TimelineDep[] = [];
    for (const item of val) {
      if (!item || typeof item !== 'object') continue;
      const d = item as Record<string, unknown>;
      const pid = normalizeProjectId(d.project_id);
      if (!pid) continue;
      if (seen.has(pid)) continue;
      seen.add(pid);
      const evidence = String(d.evidence_quote || '').trim();
      if (evidence.length < 10) continue;
      list.push({
        project_id: pid,
        reason: String(d.reason || '').slice(0, 80).trim(),
        evidence_file: String(d.evidence_file || '').trim(),
        evidence_quote: evidence.slice(0, 250),
      });
    }
    return list;
  };
  return {
    gate1_actual: normDate(r.gate1_actual),
    gate2_target: normDate(r.gate2_target),
    go_live_target: normDate(r.go_live_target),
    must_complete_before: normDeps(r.must_complete_before),
    blocked_by: normDeps(r.blocked_by),
  };
}

// ─── Pipeline ───────────────────────────────────────────────────────────────

/**
 * Accounts for a project we skipped because nothing changed, using the status
 * the stored row actually has. The previous code incremented `successCount`
 * unconditionally here, so a run that skipped a batch of `error` rows reported
 * them to the user as successes.
 */
function countSkip(status: string): void {
  if (status === 'success') runStatus.successCount++;
  else if (status === 'error') runStatus.errorCount++;
  else runStatus.skippedCount++;
}

async function analyzeProject(project: ScannedProject): Promise<void> {
  const db = getDb();
  initGoalsSchema();
  // Capture the active language ONCE per project. This guards against a
  // toggle mid-batch turning a half-finished run into a mixed-language row
  // (write would use the new language, but parts of the response were
  // generated under the old directive).
  const lang = getActiveOutputLanguage();

  // We re-run when any of these changed since the stored row was written:
  //   - the prompt version was bumped
  //   - the document set changed (compared via fileSignature, NOT the raw path
  //     list — see goals-scanner for why)
  //   - the active language differs from the row we have
  //
  // Until 2026-08-31 the first condition below was just
  // `status === 'success' && versionOk`, with no file comparison at all, so a
  // project that had once succeeded was skipped forever no matter how many new
  // documents arrived — while the comment claimed the opposite.
  const existing = db.prepare(
    "SELECT status, source_files, source_signature, prompt_version FROM project_goals WHERE project_id = ? AND output_language = ?"
  ).get(project.projectId, lang) as
    { status: string; source_files: string; source_signature: string | null; prompt_version: number | null } | undefined;

  const filesJson = JSON.stringify(project.files);
  const signature = fileSignature(project.files);
  const versionOk = (existing?.prompt_version ?? 0) >= GOALS_PROMPT_VERSION;

  if (existing && versionOk) {
    // Legacy row from before signatures existed. Backfill in place and trust
    // its status: re-analysing every pre-existing project just to learn its
    // fingerprint would cost one LLM call per project for no new information.
    if (!existing.source_signature) {
      db.prepare(
        'UPDATE project_goals SET source_signature = ? WHERE project_id = ? AND output_language = ?'
      ).run(signature, project.projectId, lang);
      countSkip(existing.status);
      return;
    }
    if (existing.source_signature === signature) {
      countSkip(existing.status);
      return;
    }
  }

  runStatus.currentProject = `${project.projectId}: ${project.projectName.slice(0, 40)}`;

  const documentText = await extractAllTexts(project.files);

  if (!documentText.trim()) {
    const upsert = db.prepare(`
      INSERT INTO project_goals (project_id, project_name, region, gate, month_folder, source_files, status, error_message, prompt_version, output_language)
      VALUES (?, ?, ?, ?, ?, ?, 'error', 'No text could be extracted from files', ?, ?)
      ON CONFLICT(project_id, output_language) DO UPDATE SET
        project_name=excluded.project_name, region=excluded.region, gate=excluded.gate,
        month_folder=excluded.month_folder, source_files=excluded.source_files,
        status='error', error_message='No text could be extracted from files',
        analyzed_at=datetime('now'), prompt_version=excluded.prompt_version
    `);
    upsert.run(
      project.projectId, project.projectName, project.region, project.gate,
      project.monthFolders.join(', '), filesJson, GOALS_PROMPT_VERSION, lang,
    );
    runStatus.errorCount++;
    return;
  }

  // Call LLM
  const prompt = buildGoalsPrompt(project, documentText);
  const { text: responseText } = await generateContent({
    prompt,
    model: 'pro',
    context: 'goals',
    outputLanguage: lang,
  });
  const parsedOrNull = parseGoalsResponse(responseText);

  // An unreadable response is an error, not a thin extraction. Record it as
  // such — the raw text is kept so the failure can be inspected afterwards.
  if (parsedOrNull === null) {
    db.prepare(`
      INSERT INTO project_goals (project_id, project_name, region, gate, month_folder, source_files, status, error_message, prompt_version, output_language, raw_gemini_response)
      VALUES (?, ?, ?, ?, ?, ?, 'error', ?, ?, ?, ?)
      ON CONFLICT(project_id, output_language) DO UPDATE SET
        project_name=excluded.project_name, region=excluded.region, gate=excluded.gate,
        month_folder=excluded.month_folder, source_files=excluded.source_files,
        status='error', error_message=excluded.error_message,
        raw_gemini_response=excluded.raw_gemini_response,
        analyzed_at=datetime('now'), prompt_version=excluded.prompt_version
    `).run(
      project.projectId, project.projectName, project.region, project.gate,
      project.monthFolders.join(', '), filesJson,
      'LLM response could not be parsed as JSON', GOALS_PROMPT_VERSION, lang, responseText,
    );
    runStatus.errorCount++;
    return;
  }
  const parsed = parsedOrNull;

  // Sanitise canonical array fields against catalogs — drops anything the LLM
  // invented outside the allowed lists.
  const ddsEntitiesArr = filterToDdsEntities(parsed.dds_entities_touched);
  const gioServicesArr = filterToGioServices(parsed.gio_services_touched);
  const techTagsArr    = filterToCatalog(parsed.tech_tags, 'tech');
  const vendorsArr     = filterToCatalog(parsed.vendors, 'vendor');
  const dataClassArr   = filterToCatalog(parsed.data_classifications, 'data');

  // Deterministic extraction: scrape PRJ-codes from the document text AND from
  // every populated text field. Excludes self-references.
  const mentionedSources = [
    documentText,
    parsed.digital_technologies,
    parsed.change_management,
    parsed.gio_sl_dds_impacts,
    parsed.dds_gio_workload,
    parsed.business_apps_cis,
    parsed.regional_impacts,
    parsed.security_impacts,
  ].filter(Boolean).join('\n');
  const mentionedProjectsArr = extractMentionedProjects(mentionedSources, project.projectId);

  const txt = (k: string): string => (typeof parsed[k] === 'string' ? parsed[k] as string : '');
  const summaryOneLine = txt('summary_one_line').slice(0, 250);

  // Onda 2: structured cross-project signal — validated against enum/length
  // constraints before persisting.
  const projectRelations = sanitizeProjectRelations(parsed.project_relations, project.projectId);
  const outOfScope       = sanitizeOutOfScope(parsed.out_of_scope);
  // Onda 3: atomic anchored claims + structured timeline.
  const impactClaims     = sanitizeImpactClaims(parsed.impact_claims);
  const timelineStruct   = sanitizeTimeline(parsed.timeline_struct);

  const freeFormFields = [
    'digital_technologies', 'change_management', 'security_impacts',
    'regional_impacts', 'ia_embedded', 'gio_sl_dds_impacts',
    'dds_gio_workload', 'business_apps_cis',
  ];
  const hasData =
    !!summaryOneLine ||
    freeFormFields.some(f => parsed[f] && parsed[f] !== 'Not identified in available documentation') ||
    ddsEntitiesArr.length > 0 || gioServicesArr.length > 0 ||
    techTagsArr.length > 0 || vendorsArr.length > 0 || dataClassArr.length > 0;

  const upsert = db.prepare(`
    INSERT INTO project_goals (
      project_id, project_name, region, gate, month_folder,
      summary_one_line,
      digital_technologies, change_management, security_impacts,
      regional_impacts, ia_embedded, gio_sl_dds_impacts,
      dds_gio_workload, business_apps_cis,
      dds_entities_touched, gio_services_touched,
      tech_tags, vendors, data_classifications, mentioned_projects,
      project_relations, out_of_scope,
      impact_claims, timeline_struct,
      prompt_version,
      raw_gemini_response, source_files, source_signature, status,
      output_language,
      error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')
    ON CONFLICT(project_id, output_language) DO UPDATE SET
      project_name=excluded.project_name, region=excluded.region, gate=excluded.gate,
      month_folder=excluded.month_folder,
      summary_one_line=excluded.summary_one_line,
      digital_technologies=excluded.digital_technologies,
      change_management=excluded.change_management,
      security_impacts=excluded.security_impacts,
      regional_impacts=excluded.regional_impacts,
      ia_embedded=excluded.ia_embedded,
      gio_sl_dds_impacts=excluded.gio_sl_dds_impacts,
      dds_gio_workload=excluded.dds_gio_workload,
      business_apps_cis=excluded.business_apps_cis,
      dds_entities_touched=excluded.dds_entities_touched,
      gio_services_touched=excluded.gio_services_touched,
      tech_tags=excluded.tech_tags,
      vendors=excluded.vendors,
      data_classifications=excluded.data_classifications,
      mentioned_projects=excluded.mentioned_projects,
      project_relations=excluded.project_relations,
      out_of_scope=excluded.out_of_scope,
      impact_claims=excluded.impact_claims,
      timeline_struct=excluded.timeline_struct,
      prompt_version=excluded.prompt_version,
      raw_gemini_response=excluded.raw_gemini_response,
      source_files=excluded.source_files,
      source_signature=excluded.source_signature,
      status=excluded.status,
      analyzed_at=datetime('now'),
      error_message=''
  `);

  upsert.run(
    project.projectId, project.projectName, project.region, project.gate,
    project.monthFolders.join(', '),
    summaryOneLine,
    txt('digital_technologies'),
    txt('change_management'),
    txt('security_impacts'),
    txt('regional_impacts'),
    txt('ia_embedded'),
    txt('gio_sl_dds_impacts'),
    txt('dds_gio_workload'),
    txt('business_apps_cis'),
    JSON.stringify(ddsEntitiesArr),
    JSON.stringify(gioServicesArr),
    JSON.stringify(techTagsArr),
    JSON.stringify(vendorsArr),
    JSON.stringify(dataClassArr),
    JSON.stringify(mentionedProjectsArr),
    JSON.stringify(projectRelations),
    JSON.stringify(outOfScope),
    JSON.stringify(impactClaims),
    JSON.stringify(timelineStruct),
    GOALS_PROMPT_VERSION,
    responseText,
    filesJson,
    signature,
    hasData ? 'success' : 'partial',
    lang,
  );

  runStatus.successCount++;
}



export async function runSingleGoalAnalysis(projectId: string): Promise<void> {
  if (runStatus.isRunning) {
    throw new Error('Goals analysis is already running');
  }

  runStatus = {
    isRunning: true,
    totalProjects: 1,
    processedProjects: 0,
    successCount: 0,
    errorCount: 0,
    skippedCount: 0,
    currentProject: 'Scanning project...',
    errors: [],
  };

  try {
    initGoalsSchema();
    const projects = scanProjects();
    const project = projects.find(p => p.projectId === projectId);
    
    if (!project) {
      throw new Error(`No local files found in data/drive for project ${projectId}`);
    }

    // Force re-analysis by resetting both status and prompt_version so the
    // skip-on-current-version guard in analyzeProject doesn't bail out.
    // Scoped to the ACTIVE language only — we don't want to invalidate the
    // other language's cached analysis just because the user asked to redo
    // this one.
    const db = getDb();
    const lang = getActiveOutputLanguage();
    db.prepare(
      "UPDATE project_goals SET status = 'pending', prompt_version = 0 WHERE project_id = ? AND output_language = ?"
    ).run(projectId, lang);

    await analyzeProject(project);
    runStatus.processedProjects++;
    runStatus.currentProject = 'Complete';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    runStatus.errors.push(`Fatal: ${msg}`);
  } finally {
    runStatus.isRunning = false;
  }
}

export async function runGoalsAnalysis(): Promise<void> {
  if (runStatus.isRunning) {
    throw new Error('Goals analysis is already running');
  }

  runStatus = {
    isRunning: true,
    totalProjects: 0,
    processedProjects: 0,
    successCount: 0,
    errorCount: 0,
    skippedCount: 0,
    currentProject: 'Scanning projects...',
    errors: [],
  };

  try {
    initGoalsSchema();
    const projects = scanProjects();
    runStatus.totalProjects = projects.length;

    for (const project of projects) {
      try {
        await analyzeProject(project);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        runStatus.errors.push(`${project.projectId}: ${msg}`);
        runStatus.errorCount++;

        // Save error state to DB
        const db = getDb();
        const lang = getActiveOutputLanguage();
        db.prepare(`
          INSERT INTO project_goals (project_id, project_name, region, gate, month_folder, source_files, status, error_message, output_language)
          VALUES (?, ?, ?, ?, ?, ?, 'error', ?, ?)
          ON CONFLICT(project_id, output_language) DO UPDATE SET
            status='error', error_message=?, analyzed_at=datetime('now')
        `).run(
          project.projectId, project.projectName, project.region, project.gate,
          project.monthFolders.join(', '), JSON.stringify(project.files),
          msg, lang, msg
        );
      }

      runStatus.processedProjects++;

      // Rate limit: 1.5s between Gemini calls
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    runStatus.currentProject = 'Complete';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    runStatus.errors.push(`Fatal: ${msg}`);
  } finally {
    runStatus.isRunning = false;
  }
}

export function getGoalsStatus(): GoalsRunStatus {
  return { ...runStatus };
}

export function getGoalsList(filters?: { region?: string; gate?: string; status?: string; outputLanguage?: OutputLanguage }): ProjectGoals[] {
  initGoalsSchema();
  const db = getDb();
  const lang = filters?.outputLanguage ?? getActiveOutputLanguage();

  // Auto-sync discovered projects into the DB. Placeholders are seeded for
  // the active language only — when the user toggles to the other one and
  // visits Goals again, this same code path will seed placeholders for
  // *that* language too. No cross-language clobbering.
  //
  // This SEEDS new projects; it must not touch an existing row. Until
  // 2026-08-31 the conflict clause overwrote `source_files`, so merely opening
  // the Goals tab overwrote the record of which documents a row was extracted
  // from — erasing the very signal the re-analysis check depends on. Change
  // detection now lives in `source_signature`, which only `analyzeProject`
  // writes, but the principle stands: a read path must not mutate provenance.
  try {
    const scanned = scanProjects();
    const upsertStmt = db.prepare(`
      INSERT INTO project_goals (project_id, project_name, region, gate, source_files, status, analyzed_at, output_language)
      VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?)
      ON CONFLICT(project_id, output_language) DO NOTHING
    `);
    for (const p of scanned) {
      upsertStmt.run(p.projectId, p.projectName, p.region, p.gate, JSON.stringify(p.files), lang);
    }
  } catch (e) {
    console.error('Failed to sync projects into goals list:', e);
  }

  let sql = 'SELECT * FROM project_goals WHERE output_language = ?';
  const params: string[] = [lang];

  if (filters?.region) {
    sql += ' AND region = ?';
    params.push(filters.region);
  }
  if (filters?.gate) {
    sql += ' AND gate = ?';
    params.push(filters.gate);
  }
  if (filters?.status) {
    sql += ' AND status = ?';
    params.push(filters.status);
  }

  sql += ' ORDER BY project_id';
  return db.prepare(sql).all(...params) as ProjectGoals[];
}

export function getGoalsExportCsv(): string {
  const goals = getGoalsList();
  const headers = [
    'Project ID', 'Project Name', 'Region', 'Gate', 'Month',
    'Summary',
    'Digital Technologies', 'Change Management', 'Security Impacts',
    'Regional Impacts', 'AI Embedded', 'GIO SL / DDS Impacts',
    'DDS / GIO Workload', 'Business Apps & CIs',
    'DDS Entities', 'GIO Services', 'Tech Tags', 'Vendors',
    'Data Classifications', 'Mentioned Projects',
    'Prompt Version', 'Status',
  ];

  const escape = (val: string) => `"${(val || '').replace(/"/g, '""')}"`;
  const fmtJson = (val: string) => {
    try { const arr = JSON.parse(val || '[]'); return Array.isArray(arr) ? arr.join('; ') : ''; }
    catch { return ''; }
  };

  const rows = goals.map(g => [
    g.project_id, g.project_name, g.region, g.gate, g.month_folder,
    g.summary_one_line || '',
    g.digital_technologies, g.change_management, g.security_impacts,
    g.regional_impacts, g.ia_embedded, g.gio_sl_dds_impacts,
    g.dds_gio_workload, g.business_apps_cis,
    fmtJson(g.dds_entities_touched),
    fmtJson(g.gio_services_touched),
    fmtJson(g.tech_tags),
    fmtJson(g.vendors),
    fmtJson(g.data_classifications),
    fmtJson(g.mentioned_projects),
    String(g.prompt_version ?? 0),
    g.status,
  ].map(v => escape(String(v))).join(','));

  return [headers.map(escape).join(','), ...rows].join('\n');
}

export function resetGoalsData(): void {
  if (runStatus.isRunning) {
    throw new Error('Cannot reset while analysis is running');
  }

  const db = getDb();
  const lang = getActiveOutputLanguage();
  // Reset acts on the current language only. The other language's analysis
  // (if any) is left untouched — users toggling FR↔EN expect "reset" to
  // mean "clear what I'm currently looking at", not "nuke everything".
  db.prepare(`
    UPDATE project_goals
    SET summary_one_line = '',
        digital_technologies = '',
        change_management = '',
        security_impacts = '',
        regional_impacts = '',
        ia_embedded = '',
        gio_sl_dds_impacts = '',
        dds_gio_workload = '',
        business_apps_cis = '',
        dds_entities_touched = '[]',
        gio_services_touched = '[]',
        tech_tags = '[]',
        vendors = '[]',
        data_classifications = '[]',
        mentioned_projects = '[]',
        -- Onda 2/3 fields. Omitted here until 2026-08-31, which meant a "reset"
        -- left the densest output (claims, relations, exclusions, timeline)
        -- populated from the previous run.
        project_relations = '[]',
        out_of_scope = '[]',
        impact_claims = '[]',
        timeline_struct = '{}',
        prompt_version = 0,
        raw_gemini_response = '',
        analyzed_at = NULL,
        status = 'pending',
        error_message = ''
    WHERE output_language = ?
  `).run(lang);

  runStatus = {
    isRunning: false,
    totalProjects: 0,
    processedProjects: 0,
    successCount: 0,
    errorCount: 0,
    skippedCount: 0,
    currentProject: '',
    errors: [],
  };
}

import * as XLSX from 'xlsx';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from './db';
import { excelDateToISO, parseCost } from './date-utils';
import { normalizeProjectId } from './project-id';
import { normalizeDds } from './dds-catalog';

interface RawRow {
  [key: string]: string | number | null | undefined;
}

export interface ProjectInsert {
  projectId: string;
  name: string;
  dds: string;
  gate: string;
  costKEur: number | null;
  description: string;
  remarks: string;
  qa: string;
  reviewDate: string;
  decision: string;
  decisionMode: string;
  decisionDate: string;
  reviewStatus: string;
  documentsStatus: string;
  restricted: string;
  costBeforeG2: number | null;
  estGate2Date: string;
  sessionStart: string;
  sessionEnd: string;
  participants: string;
  linkPositions: string;
  linkFolder: string;
  linkCIOO: string;
  year: number | null;
  month: number | null;
  batchId: string;
}

// ─── Format detection ───────────────────────────────────────────────────────

export type Format = 'cioo-legacy' | 'cdio';

function detectFormat(worksheet: XLSX.WorkSheet): Format {
  // Read first 2 rows as 2-D array to inspect headers
  const head = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
    header: 1,
    defval: '',
    blankrows: false,
  }).slice(0, 2);

  const flat = head.flat().map(v => String(v ?? '').toLowerCase());

  // CDIO sheet has headers in row 0 with these exact tokens.
  if (flat.some(s => s.includes('cdioo period')) || flat.some(s => s.includes('multi-cluster'))) {
    return 'cdio';
  }
  // Legacy CIOO Forecast has headers on row 2 with "GCIOO" or "DDS".
  return 'cioo-legacy';
}

// ─── Public entry points ────────────────────────────────────────────────────

export interface CdioMergeResult {
  /** Rows written (added + updated). */
  count: number;
  batchId: string;
  errors: string[];
  format: Format;
  added: number;
  updated: number;
  /** Rows that existed as 'drive' or 'manual' and are now governed by the sheet. */
  promoted: number;
  /** 'excel' rows no longer in the sheet, newly marked cdio_missing_since. */
  missing: number;
}

/** Reads the workbook into canonical, deduplicated project rows. Writes nothing. */
export function parseCdioWorkbook(buffer: Buffer): { rows: ProjectInsert[]; format: Format } {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  // Prefer the canonical CDIO sheet if it exists in this workbook. Falls back
  // to the first sheet for older single-sheet exports.
  const cdioName = workbook.SheetNames.find(n => n.trim().toLowerCase() === 'cdio internal committee');
  const sheetName = cdioName ?? workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const format = detectFormat(worksheet);

  const rawRows: ProjectInsert[] = format === 'cdio'
    ? parseCdioSheet(worksheet)
    : parseCiooLegacySheet(worksheet);

  // Canonicalise ids BEFORE deduping, so `PRJ001395` and `PRJ0001395` collapse
  // into one project instead of two. Cells the sheet uses as process
  // placeholders ("N/A", "PRJ code to be created", "Contract Note") or that
  // follow another scheme entirely ("X1_6896", "FR_7346") cannot be
  // canonicalised; they are kept verbatim so nothing silently disappears from
  // the portfolio, but reported so they can be fixed at the source.
  const unnormalisable: string[] = [];
  for (const row of rawRows) {
    const canonical = normalizeProjectId(row.projectId);
    if (canonical) {
      row.projectId = canonical;
    } else if (row.projectId) {
      unnormalisable.push(row.projectId);
    }
  }
  if (unnormalisable.length > 0) {
    console.warn(
      `[excel] ${unnormalisable.length} row(s) have a project id that is not canonical and was left as-is: ` +
      unnormalisable.map(v => JSON.stringify(v)).join(', ')
    );
  }

  // The CDIO sheet lists the same project across multiple review cycles, so the
  // same project_id can appear in several rows. Keep only the one with the most
  // recent review_date (ties → keep the last occurrence in source order, which
  // matches the chronological order of the sheet).
  return { rows: dedupeByProjectId(rawRows), format };
}

/**
 * Merges sheet rows into `projects`. Nothing is deleted.
 *
 * This used to DELETE FROM projects and reinsert, which took with it every row
 * the sheet does not own: Drive-discovered stubs, and now projects added by
 * hand ("avulso"). The sheet is re-read automatically from Drive (cdio-sync.ts),
 * so a wipe on every read is no longer an option.
 *
 *   in sheet, not in DB          → INSERT, source 'excel'
 *   in sheet and in DB           → UPDATE the columns the sheet owns; a 'drive'
 *                                  or 'manual' row is promoted to 'excel'
 *   'excel' in DB, not in sheet  → kept, cdio_missing_since set (its goals and
 *                                  impact edges stay valid)
 *   'drive' / 'manual' not in sheet → untouched
 *
 * Links (folder, positions, CIOO) belong to Drive discovery: an existing value
 * is never overwritten, only filled when empty.
 */
export function mergeCdioRows(rows: ProjectInsert[], format: Format): CdioMergeResult {
  const db = getDb();
  const batchId = uuidv4();
  const errors: string[] = [];
  let added = 0, updated = 0, promoted = 0, missing = 0;

  // A row without any id cannot be matched on the next read, so merging it would
  // insert a fresh copy every hour. The old wipe-and-reinsert hid this.
  const keyed = rows.filter(r => r.projectId);
  const unkeyed = rows.length - keyed.length;
  if (unkeyed > 0) errors.push(`${unkeyed} row(s) without a project number were skipped`);

  // An empty read must never mark the whole portfolio as gone from the sheet:
  // a renamed tab or a changed layout would look exactly like that.
  if (keyed.length === 0) {
    throw new Error('No project rows found in the CDIO sheet — nothing was changed');
  }

  const sourceOf = db.prepare('SELECT source FROM projects WHERE project_id = ? LIMIT 1');
  const update = db.prepare(`
    UPDATE projects SET
      name = @name, dds = @dds, gate = @gate, cost_keur = @costKEur,
      description = @description, remarks = @remarks, qa = @qa,
      review_date = @reviewDate, decision = @decision, decision_mode = @decisionMode,
      decision_date = @decisionDate, review_status = @reviewStatus,
      documents_status = @documentsStatus, restricted = @restricted,
      cost_before_g2 = @costBeforeG2, est_gate2_date = @estGate2Date,
      session_start = @sessionStart, session_end = @sessionEnd, participants = @participants,
      link_positions = CASE WHEN @linkPositions <> '' THEN @linkPositions ELSE link_positions END,
      link_folder    = CASE WHEN COALESCE(link_folder, '')    = '' THEN @linkFolder    ELSE link_folder    END,
      link_cioo      = CASE WHEN COALESCE(link_cioo, '')      = '' THEN @linkCIOO      ELSE link_cioo      END,
      year = @year, month = @month, batch_id = @batchId,
      source = 'excel', cdio_missing_since = NULL, uploaded_at = datetime('now')
    WHERE project_id = @projectId
  `);
  const insert = db.prepare(`
    INSERT INTO projects (
      project_id, name, dds, gate, cost_keur, description, remarks, qa,
      review_date, decision, decision_mode, decision_date, review_status,
      documents_status, restricted, cost_before_g2, est_gate2_date,
      session_start, session_end, participants,
      link_positions, link_folder, link_cioo,
      year, month, batch_id, source
    ) VALUES (
      @projectId, @name, @dds, @gate, @costKEur, @description, @remarks, @qa,
      @reviewDate, @decision, @decisionMode, @decisionDate, @reviewStatus,
      @documentsStatus, @restricted, @costBeforeG2, @estGate2Date,
      @sessionStart, @sessionEnd, @participants,
      @linkPositions, @linkFolder, @linkCIOO,
      @year, @month, @batchId, 'excel'
    )
  `);
  const markMissing = db.prepare(`
    UPDATE projects SET cdio_missing_since = datetime('now')
    WHERE project_id = ? AND source = 'excel' AND cdio_missing_since IS NULL
  `);

  db.transaction(() => {
    for (const entry of keyed) {
      try {
        const prior = sourceOf.get(entry.projectId) as { source: string } | undefined;
        if (prior) {
          update.run({ ...entry, batchId });
          updated++;
          if (prior.source !== 'excel') promoted++;
        } else {
          insert.run({ ...entry, batchId });
          added++;
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${entry.projectId}: ${msg}`);
      }
    }

    const inSheet = new Set(keyed.map(r => r.projectId));
    const governed = db.prepare("SELECT DISTINCT project_id FROM projects WHERE source = 'excel'")
      .all() as { project_id: string }[];
    for (const { project_id } of governed) {
      if (!inSheet.has(project_id)) missing += markMissing.run(project_id).changes > 0 ? 1 : 0;
    }
  })();

  return { count: added + updated, batchId, errors, format, added, updated, promoted, missing };
}

/** Upload path (plan B): same merge as the automatic read from Drive. */
export function parseExcelBuffer(buffer: Buffer): CdioMergeResult {
  const { rows, format } = parseCdioWorkbook(buffer);
  return mergeCdioRows(rows, format);
}

// ─── CDIO (new) format ──────────────────────────────────────────────────────
// Sheet "CDIO internal committee". Headers on row 1 (0-indexed). 28 columns A..AB.
//   A  CDIOO Period (Excel serial)
//   B  Internal review date (DD/MM/YYYY string OR Excel serial)
//   C  [OBSOLETE] Mgt review date (ignored)
//   D  Multi-Cluster                 → dds
//   E  Project # in ServiceNow       → project_id
//   F  Project Name                  → name
//   G  CDIO folder                   → link_folder
//   H  Q&A                           → qa
//   I  NotebookLM                    → remarks (appended)
//   J  Short Desc                    → description
//   K  Gate                          → gate
//   L  Project cost (CAPEX)          → cost_keur (combined)
//   M  Project cost (OPEX)           → cost_keur (combined)
//   N  Impact on IT costs            → remarks (appended)
//   O  Impact on non-IT costs        → remarks (appended)
//   P  Status CDIO internal committee  (read, unused)
//   Q  Status TADA/OTAV                (read, unused)
//   R  Status CDIOO Management Decision (read, unused)
//   S  Action plan / questions         (read, unused)
//   T  Governance reriew [sic]         (read, unused)
//   U  IT Proc Leader                  (read, unused)
//   V  IT Proc Feedback                (read, unused)
//   W  IT Proc Attention points      → remarks (appended)
//   X  CDIOO Decision                → decision
//   Y  Link to CDIOO Positions       → link_positions
//   Z  OCDIO position cistribution date [sic]  (read, unused)
//   AA Gating process status           (read, unused)
//   AB lead time (days)                (read, unused)

function parseCdioSheet(worksheet: XLSX.WorkSheet): ProjectInsert[] {
  const rawData: RawRow[] = XLSX.utils.sheet_to_json(worksheet, {
    header: 'A',
    range: 2, // row 0 = group header (PROJECT INFORMATION, …), row 1 = real headers, data starts at row 2
    defval: '',
    blankrows: false,
  });

  // Column G ("CDIO folder") is intentionally ignored: folder links are the
  // sole responsibility of Drive discovery (drive-engine.discoverAndAddProjectFromDrive).
  // Column Y ("Link to CDIOO Positions") shows the minutes' title; the URL is
  // the cell hyperlink, which sheet_to_json drops, so it is read from the cell.
  const entries: ProjectInsert[] = [];

  for (let i = 0; i < rawData.length; i++) {
    const row = rawData[i];
    const projectId = str(row['E']);
    const name = str(row['F']);
    if (!projectId && !name) continue;

    const reviewDate = parseAnyDate(row['B']);
    const period = parseAnyDate(row['A']);
    const periodSerialAsNumber = typeof row['A'] === 'number' ? (row['A'] as number) : NaN;

    // Year/Month derived from CDIOO Period (or fallback to review_date)
    let year: number | null = null;
    let month: number | null = null;
    const ymSource = reviewDate || period;
    if (ymSource && /^\d{4}-\d{2}-\d{2}/.test(ymSource)) {
      year = parseInt(ymSource.slice(0, 4), 10) || null;
      month = parseInt(ymSource.slice(5, 7), 10) || null;
    } else if (!isNaN(periodSerialAsNumber) && periodSerialAsNumber > 0) {
      const iso = excelDateToISO(periodSerialAsNumber);
      if (iso) {
        year = parseInt(iso.slice(0, 4), 10) || null;
        month = parseInt(iso.slice(5, 7), 10) || null;
      }
    }

    // Cost: combine CAPEX + OPEX when both are parseable numbers; otherwise use whichever exists.
    const capexNum = parseCost(row['L']);
    const opexNum = parseCost(row['M']);
    let costKEur: number | null = null;
    if (capexNum !== null && opexNum !== null) {
      costKEur = capexNum + opexNum;
    } else if (capexNum !== null) {
      costKEur = capexNum;
    } else if (opexNum !== null) {
      costKEur = opexNum;
    }

    // Compose remarks from secondary cost/impact/attention fields, preserving the original
    // strings so the LLM still sees them when they're not parseable as numbers.
    // IT Proc Attention lives in column W (28-column layout), not P.
    const remarksParts: string[] = [];
    const itProc = str(row['W']);
    if (itProc) remarksParts.push(`IT Proc Attention: ${itProc}`);
    const capexRaw = str(row['L']);
    const opexRaw = str(row['M']);
    if (capexRaw && capexNum === null) remarksParts.push(`CAPEX: ${capexRaw}`);
    if (opexRaw) remarksParts.push(`OPEX: ${opexRaw}`);
    const impactIt = str(row['N']);
    if (impactIt) remarksParts.push(`Impact on IT costs: ${impactIt}`);
    const impactNonIt = str(row['O']);
    if (impactNonIt) remarksParts.push(`Impact on non-IT costs: ${impactNonIt}`);
    const notebook = str(row['I']);
    if (notebook && notebook.toLowerCase() !== 'notebooklm') {
      remarksParts.push(`NotebookLM: ${notebook}`);
    }

    entries.push({
      projectId,
      name: name || 'Unnamed Project',
      dds: normalizeOwner(row['D']),
      gate: normalizeGate(row['K']),
      costKEur,
      description: str(row['J']),
      remarks: remarksParts.join('\n'),
      qa: str(row['H']),
      reviewDate,
      decision: str(row['X']),
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
      linkPositions: cellLink(worksheet, 'Y', row),
      linkFolder: '',
      linkCIOO: '',
      year,
      month,
      batchId: '', // assigned at insert time
    });
  }

  return entries;
}

/** The hyperlink of `col` on the sheet row `row` came from (or its text, when that is a URL). */
function cellLink(worksheet: XLSX.WorkSheet, col: string, row: RawRow): string {
  const rowNum = (row as { __rowNum__?: number }).__rowNum__;
  if (typeof rowNum !== 'number') return '';
  const cell = worksheet[`${col}${rowNum + 1}`] as XLSX.CellObject | undefined;
  const target = cell?.l?.Target?.trim() ?? '';
  if (/^https?:\/\//i.test(target)) return target;
  const text = String(cell?.v ?? '').trim();
  return /^https?:\/\/\S+$/i.test(text) ? text : '';
}

// ─── Legacy CIOO Forecast format ────────────────────────────────────────────
// Row 2 headers, 25 columns A..Y. See git history of this file for the original mapping.

function parseCiooLegacySheet(worksheet: XLSX.WorkSheet): ProjectInsert[] {
  const rawData: RawRow[] = XLSX.utils.sheet_to_json(worksheet, {
    header: 'A',
    range: 2,
    defval: '',
    blankrows: false,
  });

  const entries: ProjectInsert[] = [];

  for (const row of rawData) {
    const projectId = str(row['C']);
    const name = str(row['D']);
    if (!projectId && !name) continue;

    const reviewDate = parseAnyDate(row['A']);
    const decisionDate = parseAnyDate(row['P']);
    const estGate2Date = parseAnyDate(row['M']);
    const yearRaw = row['X'];
    const monthRaw = row['Y'];

    entries.push({
      projectId: projectId || `UNKNOWN-${entries.length}`,
      name: name || 'Unnamed Project',
      dds: normalizeOwner(row['B']),
      gate: normalizeGate(row['E']),
      costKEur: parseCost(row['F']),
      description: str(row['K']),
      remarks: str(row['I']),
      qa: str(row['J']),
      reviewDate,
      decision: str(row['S']),
      decisionMode: str(row['O']),
      decisionDate,
      reviewStatus: str(row['N']),
      documentsStatus: str(row['G']),
      restricted: str(row['H']),
      costBeforeG2: parseCost(row['L']),
      estGate2Date,
      sessionStart: str(row['Q']),
      sessionEnd: str(row['R']),
      participants: str(row['T']),
      linkPositions: '',
      linkFolder: '',
      linkCIOO: '',
      year: typeof yearRaw === 'number' ? yearRaw : (parseInt(str(yearRaw)) || null),
      month: typeof monthRaw === 'number' ? monthRaw : (parseInt(str(monthRaw)) || null),
      batchId: '',
    });
  }

  return entries;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// Dedupe by project_id, keeping the row with the latest review_date. Ties (or
// missing dates) → keep the last occurrence in source order. Rows with an empty
// project_id are passed through unchanged (they're already pseudo-unique via
// the legacy parser's "UNKNOWN-<index>" fallback).
function dedupeByProjectId(rows: ProjectInsert[]): ProjectInsert[] {
  const byId = new Map<string, ProjectInsert>();
  const passthrough: ProjectInsert[] = [];
  for (const row of rows) {
    if (!row.projectId) { passthrough.push(row); continue; }
    const existing = byId.get(row.projectId);
    if (!existing) {
      byId.set(row.projectId, row);
      continue;
    }
    // ISO date strings compare lexicographically. Empty string sorts before any
    // populated date, so a populated date always wins over a missing one.
    const a = existing.reviewDate || '';
    const b = row.reviewDate || '';
    if (b >= a) byId.set(row.projectId, row);
  }
  return [...byId.values(), ...passthrough];
}

/**
 * Canonicalise the owning entity coming from the CDIO spreadsheet.
 *
 * The column is typed by hand, so it carries typos ("Indutrial Apps",
 * "Entreprise Apps") and names the FIT programme retired ("E&C", "IDD" → now
 * InnoTech). Left raw, those became distinct owner values: filters listed the
 * same entity three times and colours drifted per spelling.
 *
 * "GIO" is deliberately kept as-is rather than dropped. It owns 28 projects and
 * is a valid owner (PLAN_PROMPTS_CATALOG_REVIEW.md §3.1, item 7) — it is just
 * never an impact TARGET, which is a different list (CANONICAL_DDS_NAMES).
 *
 * Anything unrecognised is preserved verbatim: a spreadsheet may legitimately
 * name an entity the catalog has not learned yet, and silently blanking it
 * would lose data the import is supposed to carry.
 */
function normalizeOwner(raw: string | number | null | undefined): string {
  const value = str(raw);
  if (!value) return '';
  if (value.toUpperCase() === 'GIO') return 'GIO';
  return normalizeDds(value) ?? value;
}

function str(val: string | number | null | undefined): string {
  if (val === null || val === undefined) return '';
  return String(val).trim();
}

function normalizeGate(raw: string | number | null | undefined): string {
  const s = str(raw);
  if (/^\d+\.0$/.test(s)) return s.replace('.0', '');
  return s;
}

// Parse a value that might be:
//  - an Excel date serial (number, e.g. 45658)
//  - a serial with thousands-space ("45 694")
//  - a DD/MM/YYYY string ("13/01/2025")
//  - an ISO string ("2025-01-13")
//  - empty / "N/A" / "n/a"
function parseAnyDate(raw: string | number | null | undefined): string {
  if (raw === null || raw === undefined || raw === '') return '';

  if (typeof raw === 'number') return excelDateToISO(raw);

  const s = String(raw).trim();
  if (!s) return '';
  if (/^n\/?a$/i.test(s)) return '';

  // ISO already
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  // DD/MM/YYYY or D/M/YYYY
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // "45 694" → 45694 serial
  const compact = s.replace(/\s/g, '');
  if (/^\d{4,6}$/.test(compact)) {
    const serial = parseInt(compact, 10);
    return excelDateToISO(serial);
  }

  // Last resort: try Date.parse for strings like "Jan 15 2025"
  const ts = Date.parse(s);
  if (!isNaN(ts)) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  return s; // give back unmodified so the value isn't lost
}

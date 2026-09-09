// Reads the two Apps Script control spreadsheets and mirrors them into
// upstream_status / upstream_events. See PLAN_LIVE_DATAFLOW.md — this is
// Fase 1, and it is read-only: the spreadsheets have exactly one writer (the
// Apps Script), Alumen never touches them.
//
// WHY XLSX EXPORT AND NOT fetchSheetCsv() (PLAN §0.2, §3.4, §10.1):
// sheets-engine.ts's CSV export applies *cell formatting*, and in the cleanup
// sheet the numeric columns "Labels Removed" / "Duplicates Deleted" carry a
// date format — so the value 1 comes back as "12/31/1899" and 0 as
// "12/30/1899". The CSV path returns 200, parses fine and type-checks, which
// is exactly what makes it dangerous. The XLSX export returns raw values
// (verified 2026-09-09: PRJ0018861 → labelsRemoved 1, duplicatesDeleted 0).
// The Sheets API, which would also solve this via UNFORMATTED_VALUE, cannot be
// enabled on the AL GCP project — Drive export is the only raw-value path.

import { google } from 'googleapis';
import * as XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';
import { getDb } from './db';
import { normalizeProjectId } from './project-id';

const SERVICE_ACCOUNT_PATH = path.join(process.cwd(), 'data', 'service-account.json');
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Both spreadsheets keep their data in a tab literally named "SyncStatus"
// (verified 2026-09-09). Selecting by name rather than gid sidesteps the gid
// ambiguity in PLAN §4 entirely — the XLSX export carries every tab anyway.
const TAB_NAME = 'SyncStatus';

export const UPSTREAM_SETTINGS = {
  controlSheetId: 'upstream_control_sheet_id',
  cleanupSheetId: 'upstream_cleanup_sheet_id',
  pollSeconds: 'upstream_poll_seconds',
} as const;

const DEFAULTS = {
  controlSheetId: '1AG9e9ihBBE6rfGGUPEQBwobKSE7ql63MxK8AviGr-JQ',
  cleanupSheetId: '1a0M4Xue8NbrPfPbrJJdpJ1MjHTtx_7QsYTIPTruCo_Q',
  pollSeconds: 15,
};

export type UpstreamStage = 'copy' | 'cleanup';
export type UpstreamStatus = 'QUEUED' | 'IN_PROGRESS' | 'DONE' | 'ERROR' | 'UNKNOWN';

export interface UpstreamRow {
  projectId: string;
  stage: UpstreamStage;
  status: UpstreamStatus;
  detail: Record<string, unknown>;
  sheetAt: string | null;
}

export interface UpstreamSnapshot {
  rows: UpstreamRow[];
  /** UTC ISO — when Alumen last successfully read the sheets. */
  readAt: string | null;
  /** Raw Google error from the last failed attempt, or null. */
  error: string | null;
  stale: boolean;
}

// ─── Sheet reading ──────────────────────────────────────────────────────────

function setting(key: string, fallback: string): string {
  try {
    const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value?.trim() || fallback;
  } catch {
    return fallback;
  }
}

async function exportTabRows(fileId: string): Promise<unknown[][]> {
  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    throw new Error('Service account key not found at data/service-account.json');
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_PATH,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.files.export(
    { fileId, mimeType: XLSX_MIME },
    { responseType: 'arraybuffer' }
  );
  const wb = XLSX.read(Buffer.from(res.data as ArrayBuffer), { type: 'buffer' });
  const sheet = wb.Sheets[TAB_NAME];
  if (!sheet) {
    throw new Error(`Tab "${TAB_NAME}" not found (tabs: ${wb.SheetNames.join(', ')})`);
  }
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null });
}

/**
 * The two sheets disagree about headers: the cleanup sheet has one, the
 * control sheet starts straight at data (PLAN §0.1 — that missing header is
 * also what makes the Apps Script skip its own first row). Detecting instead
 * of hardcoding matters: PLAN §0.1 recommends adding the header to the control
 * sheet by hand, and a hardcoded "row 0 is data" would silently start dropping
 * a project the day that happens.
 */
function isHeaderRow(row: unknown[]): boolean {
  const first = String(row?.[0] ?? '').trim();
  if (!first) return false;
  return !normalizeProjectId(first);
}

function dataRows(rows: unknown[][]): unknown[][] {
  const withContent = rows.filter(r =>
    Array.isArray(r) && r.some(c => c !== null && c !== undefined && String(c).trim() !== '')
  );
  if (withContent.length === 0) return [];
  return isHeaderRow(withContent[0]) ? withContent.slice(1) : withContent;
}

/**
 * Excel serial → the wall-clock string the spreadsheet shows. Deliberately
 * returns no timezone suffix: the serial is Europe/Paris local time (the
 * Apps Script declares that timezone), so stamping a Z would shift it by the
 * Paris offset. Callers treat this as display text; observed_at is the field
 * to compare against.
 */
function serialToSheetLocal(value: unknown): string | null {
  if (typeof value !== 'number' || !isFinite(value) || value <= 0) return null;
  const ms = Math.round((value - 25569) * 86400000); // 25569 = 1899-12-30 → 1970-01-01
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().replace('Z', '').slice(0, 19);
}

function num(value: unknown): number | null {
  return typeof value === 'number' && isFinite(value) ? value : null;
}

/**
 * The two scripts use different vocabularies for the same states — the copy
 * script writes "DONE", the cleanup script writes "✅ Done" (verified
 * 2026-09-09). Anything unrecognised becomes UNKNOWN rather than being
 * coerced, so a new state added upstream shows up as itself in detail.raw
 * instead of silently reading as DONE.
 */
function normalizeStatus(value: unknown): UpstreamStatus {
  const raw = String(value ?? '').replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().toUpperCase();
  if (!raw) return 'UNKNOWN';
  if (raw.includes('ERROR') || raw.includes('FAIL')) return 'ERROR';
  if (raw.includes('DONE') || raw.includes('COMPLETE')) return 'DONE';
  if (raw.includes('PROGRESS') || raw.includes('RUNNING')) return 'IN_PROGRESS';
  if (raw.includes('QUEUE') || raw.includes('PENDING')) return 'QUEUED';
  return 'UNKNOWN';
}

// Control sheet: [Project, Status, Files Copied, Last Updated, (Error)]
function parseControl(rows: unknown[][]): UpstreamRow[] {
  const out: UpstreamRow[] = [];
  for (const r of dataRows(rows)) {
    const projectId = normalizeProjectId(String(r[0] ?? ''));
    if (!projectId) continue;
    const error = String(r[4] ?? '').trim();
    out.push({
      projectId,
      stage: 'copy',
      status: error ? 'ERROR' : normalizeStatus(r[1]),
      detail: { filesCopied: num(r[2]), error: error || null, raw: String(r[1] ?? '') },
      sheetAt: serialToSheetLocal(r[3]),
    });
  }
  return out;
}

// Cleanup sheet: [Project, Status, Files Processed, Labels Removed,
//                 Duplicates Deleted, Last Updated, Error]
function parseCleanup(rows: unknown[][]): UpstreamRow[] {
  const out: UpstreamRow[] = [];
  for (const r of dataRows(rows)) {
    const projectId = normalizeProjectId(String(r[0] ?? ''));
    if (!projectId) continue;
    const error = String(r[6] ?? '').trim();
    out.push({
      projectId,
      stage: 'cleanup',
      status: error ? 'ERROR' : normalizeStatus(r[1]),
      detail: {
        filesProcessed: num(r[2]),
        labelsRemoved: num(r[3]),
        duplicatesDeleted: num(r[4]),
        error: error || null,
        raw: String(r[1] ?? ''),
      },
      sheetAt: serialToSheetLocal(r[5]),
    });
  }
  return out;
}

/** One read of both sheets. Throws — the caching layer decides what to do. */
export async function readUpstreamOnce(): Promise<UpstreamRow[]> {
  const controlId = setting(UPSTREAM_SETTINGS.controlSheetId, DEFAULTS.controlSheetId);
  const cleanupId = setting(UPSTREAM_SETTINGS.cleanupSheetId, DEFAULTS.cleanupSheetId);

  const [control, cleanup] = await Promise.all([
    exportTabRows(controlId),
    exportTabRows(cleanupId),
  ]);
  return [...parseControl(control), ...parseCleanup(cleanup)];
}

// ─── Persistence ────────────────────────────────────────────────────────────

/** Upserts the mirror and appends one upstream_events row per real transition. */
export function persistUpstream(rows: UpstreamRow[], observedAt: string): void {
  const db = getDb();
  const selectPrev = db.prepare(
    'SELECT status FROM upstream_status WHERE project_id = ? AND stage = ?'
  );
  const upsert = db.prepare(`
    INSERT INTO upstream_status (project_id, stage, status, detail_json, sheet_at, observed_at)
    VALUES (@projectId, @stage, @status, @detailJson, @sheetAt, @observedAt)
    ON CONFLICT(project_id, stage) DO UPDATE SET
      status = excluded.status,
      detail_json = excluded.detail_json,
      sheet_at = excluded.sheet_at,
      observed_at = excluded.observed_at
  `);
  const insertEvent = db.prepare(`
    INSERT INTO upstream_events (project_id, stage, from_status, to_status, observed_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const tx = db.transaction((batch: UpstreamRow[]) => {
    for (const row of batch) {
      const prev = selectPrev.get(row.projectId, row.stage) as { status: string } | undefined;
      // Only real transitions become events — every poll rewrites the mirror,
      // but an unchanged status must not fill the timeline with noise.
      if (!prev || prev.status !== row.status) {
        insertEvent.run(row.projectId, row.stage, prev?.status ?? null, row.status, observedAt);
      }
      upsert.run({
        projectId: row.projectId,
        stage: row.stage,
        status: row.status,
        detailJson: JSON.stringify(row.detail),
        sheetAt: row.sheetAt,
        observedAt,
      });
    }
  });
  tx(rows);
}

export function readMirror(): UpstreamRow[] {
  const rows = getDb()
    .prepare('SELECT project_id, stage, status, detail_json, sheet_at FROM upstream_status')
    .all() as Array<{
      project_id: string;
      stage: string;
      status: string;
      detail_json: string;
      sheet_at: string | null;
    }>;
  return rows.map(r => {
    let detail: Record<string, unknown> = {};
    try { detail = JSON.parse(r.detail_json) as Record<string, unknown>; } catch { /* keep {} */ }
    return {
      projectId: r.project_id,
      stage: r.stage as UpstreamStage,
      status: r.status as UpstreamStatus,
      detail,
      sheetAt: r.sheet_at,
    };
  });
}

// ─── Cache with its own cadence ─────────────────────────────────────────────
//
// PLAN §3.3: the SSE ticks every 500ms–2s per open tab. Reading Google on that
// tick would be ~120 calls/minute per tab and would add hundreds of ms to what
// is otherwise a local SQLite query. So the refresh runs on its own timer and
// the ticks only ever read this cache.

let cache: UpstreamSnapshot = { rows: [], readAt: null, error: null, stale: true };
let timer: NodeJS.Timeout | null = null;
let inFlight = false;

async function refresh(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const rows = await readUpstreamOnce();
    const observedAt = new Date().toISOString();
    persistUpstream(rows, observedAt);
    cache = { rows, readAt: observedAt, error: null, stale: false };
  } catch (e) {
    // Keep the last good rows. A Google hiccup must never blank the panel or
    // take down buildDrivePanelState() with it — it surfaces as upstream.error.
    cache = {
      rows: cache.rows.length ? cache.rows : readMirror(),
      readAt: cache.readAt,
      error: e instanceof Error ? e.message : String(e),
      stale: true,
    };
  } finally {
    inFlight = false;
  }
}

/**
 * Cheap, synchronous, safe to call on every SSE tick. Starts the background
 * refresh on first use (lazily, so nothing runs in processes that never open
 * the panel) and returns whatever the cache holds right now.
 */
export function getUpstreamSnapshot(): UpstreamSnapshot {
  if (!timer) {
    const seconds = Math.max(
      5,
      parseInt(setting(UPSTREAM_SETTINGS.pollSeconds, String(DEFAULTS.pollSeconds)), 10) ||
        DEFAULTS.pollSeconds
    );
    // Seed from the DB so the first paint isn't empty while the first fetch runs.
    try { cache = { ...cache, rows: readMirror() }; } catch { /* table may not exist yet */ }
    void refresh();
    timer = setInterval(() => { void refresh(); }, seconds * 1000);
    // Don't hold the process open on this alone.
    if (typeof timer.unref === 'function') timer.unref();
  }
  return cache;
}

/** For the admin "Test upstream" button — bypasses the cache, surfaces raw errors. */
export async function testUpstream(): Promise<{ ok: true; rows: UpstreamRow[] } | { ok: false; error: string }> {
  try {
    return { ok: true, rows: await readUpstreamOnce() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

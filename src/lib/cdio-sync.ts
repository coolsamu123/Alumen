/**
 * Reads the CDIO sheet straight from Drive and merges it into `projects`.
 *
 * Replaces the manual upload as the normal path: the sheet ("Gating Pre-review -
 * CDIO internal committee", Shared Drive "Alumen" › CDIO) is maintained by other
 * people and changes on its own schedule. The upload stays as plan B and goes
 * through the same merge (excel-parser.ts mergeCdioRows).
 *
 * Cheap when nothing changed: a check is one files.get for modifiedTime; the
 * export and the merge only run when the sheet moved (or when forced).
 *
 * XLSX export, never CSV: the CSV export applies cell formatting (see
 * upstream-sync.ts header) and parseCdioWorkbook already reads XLSX.
 *
 * The one failure that looks like something else: the Air Liquide
 * "Classification" Drive label makes a file invisible to the service account
 * (files.get → 404, the folder lists empty). The error says so, because "file
 * not found" for a file everyone can see in the browser sends people looking
 * at sharing settings instead.
 */
import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { getDb } from './db';
import { parseCdioWorkbook, mergeCdioRows, type CdioMergeResult } from './excel-parser';
import { buildPipelineRows, newCdioProjects } from './pipeline-view';
import { readQueue, enqueueMany } from './alumen-queue';
import { splitByBaseFolder } from './base-folder';

const SERVICE_ACCOUNT_PATH = path.join(process.cwd(), 'data', 'service-account.json');
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const CDIO_SETTINGS = {
  fileId: 'cdio_file_id',
  modifiedTime: 'cdio_modified_time',
  readAt: 'cdio_read_at',
  checkedAt: 'cdio_checked_at',
  error: 'cdio_error',
  lastResult: 'cdio_last_result',
  autoLoad: 'cdio_auto_load',
  lastAutoLoad: 'cdio_last_auto_load',
} as const;

// "Gating Pre-review - CDIO internal committee", Shared Drive "Alumen" › CDIO.
const DEFAULT_FILE_ID = '14TV9WDXR5ts1iwKX-emNB-yU2YdrAQNvzb4gyg91lX4';

export interface CdioStatus {
  fileId: string;
  fileName: string | null;
  /** Drive modifiedTime of the version last merged. */
  modifiedTime: string | null;
  /** When that version was merged. */
  readAt: string | null;
  /** When Drive was last asked whether the sheet changed. */
  checkedAt: string | null;
  error: string | null;
  lastResult: Omit<CdioMergeResult, 'errors' | 'batchId'> & { warnings: string[] } | null;
  /** Projects currently governed by the sheet / no longer in it / added by hand. */
  counts: { inSheet: number; missing: number; manual: number };
  running: boolean;
  /** CDIO projects nobody asked for are queued for Apps Script automatically. */
  autoLoad: boolean;
  lastAutoLoad: { at: string; added: number; error: string | null } | null;
}

let running = false;

function getSetting(key: string): string | null {
  try {
    const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
      { value?: string } | undefined;
    const v = row?.value?.trim();
    return v ? v : null;
  } catch {
    return null;
  }
}

function setSetting(key: string, value: string | null): void {
  const db = getDb();
  if (value === null) {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
    return;
  }
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value);
}

export function cdioFileId(): string {
  return getSetting(CDIO_SETTINGS.fileId) ?? DEFAULT_FILE_ID;
}

function driveClient() {
  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    throw new Error('Service account key not found at data/service-account.json');
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_PATH,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  return google.drive({ version: 'v3', auth });
}

function explain(err: unknown, fileId: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/not found|404/i.test(msg)) {
    return `CDIO file not visible to the service account (${fileId}). ` +
      'Most likely the "Classification" label is back on the file — remove it in Drive ' +
      '(File information › Labels). Otherwise check the file id and sharing.';
  }
  return msg;
}

/**
 * Checks the sheet and merges it if it changed since the last merge.
 * `force` merges even when modifiedTime is unchanged ("Ler CDIO agora").
 */
export async function syncCdio(opts: { force?: boolean } = {}): Promise<{
  changed: boolean;
  result: CdioMergeResult | null;
  error: string | null;
}> {
  if (running) return { changed: false, result: null, error: 'A CDIO read is already running' };
  running = true;
  const fileId = cdioFileId();
  try {
    const drive = driveClient();
    const meta = await drive.files.get({
      fileId,
      fields: 'id,name,modifiedTime',
      supportsAllDrives: true,
    });
    setSetting(CDIO_SETTINGS.checkedAt, new Date().toISOString());
    const modifiedTime = meta.data.modifiedTime ?? '';

    if (!opts.force && modifiedTime && modifiedTime === getSetting(CDIO_SETTINGS.modifiedTime)) {
      setSetting(CDIO_SETTINGS.error, null);
      return { changed: false, result: null, error: null };
    }

    // files.export does not take supportsAllDrives and reaches Shared Drives anyway.
    const res = await drive.files.export(
      { fileId, mimeType: XLSX_MIME },
      { responseType: 'arraybuffer' },
    );
    const { rows, format } = parseCdioWorkbook(Buffer.from(res.data as ArrayBuffer));
    const result = mergeCdioRows(rows, format);

    setSetting(CDIO_SETTINGS.modifiedTime, modifiedTime);
    setSetting(CDIO_SETTINGS.readAt, new Date().toISOString());
    setSetting(CDIO_SETTINGS.error, null);
    setSetting(CDIO_SETTINGS.lastResult, JSON.stringify({
      fileName: meta.data.name ?? null,
      count: result.count, format: result.format,
      added: result.added, updated: result.updated,
      promoted: result.promoted, missing: result.missing,
      warnings: result.errors.slice(0, 20),
    }));
    console.log(
      `[cdio] merged ${meta.data.name}: +${result.added} new, ${result.updated} updated, ` +
      `${result.promoted} promoted, ${result.missing} newly missing`,
    );
    return { changed: true, result, error: null };
  } catch (err: unknown) {
    const message = explain(err, fileId);
    setSetting(CDIO_SETTINGS.error, message);
    console.error('[cdio]', message);
    return { changed: false, result: null, error: message };
  } finally {
    running = false;
  }
}

// ─── Automatic loading ──────────────────────────────────────────────────────
// Every project listed in the CDIO sheet goes through the whole chain without
// anyone clicking "Carregar": after each read, the ones never requested are
// queued for Apps Script (copy → cleanup), and the scheduler takes them from
// there (discover → download → goals → impact).
//
// On by default. Off is a pause, e.g. while two installs share the same Apps
// Script queue and only one of them should be feeding it.

export function isAutoLoadOn(): boolean {
  return getSetting(CDIO_SETTINGS.autoLoad) !== 'off';
}

export function setAutoLoad(on: boolean): void {
  setSetting(CDIO_SETTINGS.autoLoad, on ? 'on' : 'off');
}

export async function autoLoadNewCdio(requestedBy = 'alumen (automatic)'): Promise<{ added: string[]; error: string | null }> {
  if (!isAutoLoadOn()) return { added: [], error: null };
  try {
    const queued = new Set((await readQueue()).map(it => it.projectId.trim().toUpperCase()));
    // Already in the base folder → no copy; linked and carried on by the scheduler.
    const { toQueue } = await splitByBaseFolder(newCdioProjects(buildPipelineRows(queued)));
    const r = toQueue.length ? await enqueueMany(toQueue, requestedBy) : { added: [] as string[] };
    setSetting(CDIO_SETTINGS.lastAutoLoad, JSON.stringify({ at: new Date().toISOString(), added: r.added.length, error: null }));
    if (r.added.length) console.log(`[cdio] auto-load: ${r.added.length} project(s) queued for Apps Script`);
    return { added: r.added, error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    setSetting(CDIO_SETTINGS.lastAutoLoad, JSON.stringify({ at: new Date().toISOString(), added: 0, error: message }));
    console.error('[cdio] auto-load failed:', message);
    return { added: [], error: message };
  }
}

export function getCdioStatus(): CdioStatus {
  const db = getDb();
  let last: (CdioStatus['lastResult'] & { fileName?: string | null }) | null = null;
  try {
    const raw = getSetting(CDIO_SETTINGS.lastResult);
    last = raw ? JSON.parse(raw) : null;
  } catch { /* corrupt setting — show as never read */ }

  const count = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  return {
    fileId: cdioFileId(),
    fileName: last?.fileName ?? null,
    modifiedTime: getSetting(CDIO_SETTINGS.modifiedTime),
    readAt: getSetting(CDIO_SETTINGS.readAt),
    checkedAt: getSetting(CDIO_SETTINGS.checkedAt),
    error: getSetting(CDIO_SETTINGS.error),
    lastResult: last,
    counts: {
      inSheet: count("SELECT COUNT(DISTINCT project_id) c FROM projects WHERE source = 'excel' AND cdio_missing_since IS NULL"),
      missing: count("SELECT COUNT(DISTINCT project_id) c FROM projects WHERE source = 'excel' AND cdio_missing_since IS NOT NULL"),
      manual: count("SELECT COUNT(DISTINCT project_id) c FROM projects WHERE source = 'manual'"),
    },
    running,
    autoLoad: isAutoLoadOn(),
    lastAutoLoad: (() => {
      try { const raw = getSetting(CDIO_SETTINGS.lastAutoLoad); return raw ? JSON.parse(raw) : null; } catch { return null; }
    })(),
  };
}

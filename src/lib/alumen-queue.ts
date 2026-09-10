/**
 * Phase 3 — the queue Alumen leaves for Apps Script.
 *
 * The boundary between the two worlds is a FILE on Drive, not a spreadsheet
 * cell (PLAN §0.2): the Sheets API cannot be enabled on AL's GCP project, and
 * writing through the Drive API to a file Alumen creates itself avoids the
 * broad `auth/spreadsheets` scope.
 *
 * The contract is read by `alumenMergeQueue()` on the Apps Script side:
 *
 *   { "version": 1,
 *     "queue": [ { "projectId", "requestedBy", "requestedAt" } ] }
 *
 * It is ALUMEN, not the script, that removes an item — and only after seeing
 * the project appear in the control sheet. That way a missed worker run never
 * loses a request.
 */
import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { getDb } from './db';

const SERVICE_ACCOUNT_PATH = path.join(process.cwd(), 'data', 'service-account.json');

export const QUEUE_SETTINGS = {
  folderId: 'alumen_queue_folder_id',
} as const;

// The "Copy Utility" folder on the Alumen Shared Drive — the same one holding
// the control sheet and the Apps Script project.
const DEFAULT_FOLDER_ID = '1eu-7Gz4WfEdzUzHu5feoR0N023xDI7bP';

const QUEUE_FILE = '_alumen_queue.json';
const HEARTBEAT_FILE = '_alumen_heartbeat.json';

export interface QueueItem {
  projectId: string;
  requestedBy: string;
  requestedAt: string;
}

export interface Heartbeat {
  at: string;
  pending: number;
}

function folderId(): string {
  try {
    const row = getDb()
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(QUEUE_SETTINGS.folderId) as { value?: string } | undefined;
    const v = row?.value?.trim();
    if (v) return v;
  } catch {
    /* app_settings may not exist yet — fall through to the default */
  }
  return DEFAULT_FOLDER_ID;
}

function driveClient(scope: 'read' | 'write') {
  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    throw new Error('Service account key not found at data/service-account.json');
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_PATH,
    scopes: [
      scope === 'write'
        ? 'https://www.googleapis.com/auth/drive'
        : 'https://www.googleapis.com/auth/drive.readonly',
    ],
  });
  return google.drive({ version: 'v3', auth });
}

type Drive = ReturnType<typeof driveClient>;

/** Finds a file by name inside the folder. `supportsAllDrives` is required:
 *  without it a Shared Drive answers "File not found" (PLAN §0.5). */
async function findByName(drive: Drive, name: string): Promise<string | null> {
  const res = await drive.files.list({
    q: `'${folderId()}' in parents and name = '${name}' and trashed = false`,
    fields: 'files(id)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files?.[0]?.id ?? null;
}

async function readJsonFile<T>(drive: Drive, name: string): Promise<T | null> {
  const id = await findByName(drive, name);
  if (!id) return null;
  const res = await drive.files.get(
    { fileId: id, alt: 'media', supportsAllDrives: true },
    { responseType: 'text' }
  );
  const raw = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Reads the queue. A missing or unreadable file counts as an empty queue —
 *  Apps Script treats both the same way. */
export async function readQueue(): Promise<QueueItem[]> {
  const drive = driveClient('read');
  const payload = await readJsonFile<{ version?: number; queue?: unknown }>(drive, QUEUE_FILE);
  if (!payload || payload.version !== 1 || !Array.isArray(payload.queue)) return [];
  return (payload.queue as QueueItem[]).filter(
    it => it && typeof it.projectId === 'string' && it.projectId.trim() !== ''
  );
}

export async function readHeartbeat(): Promise<Heartbeat | null> {
  const drive = driveClient('read');
  const hb = await readJsonFile<Heartbeat>(drive, HEARTBEAT_FILE);
  if (!hb || typeof hb.at !== 'string') return null;
  return { at: hb.at, pending: Number(hb.pending) || 0 };
}

async function writeQueue(items: QueueItem[]): Promise<void> {
  const drive = driveClient('write');
  const body = JSON.stringify({ version: 1, queue: items }, null, 2);
  const id = await findByName(drive, QUEUE_FILE);
  if (id) {
    await drive.files.update({
      fileId: id,
      media: { mimeType: 'application/json', body },
      supportsAllDrives: true,
    });
  } else {
    await drive.files.create({
      requestBody: { name: QUEUE_FILE, parents: [folderId()], mimeType: 'application/json' },
      media: { mimeType: 'application/json', body },
      supportsAllDrives: true,
    });
  }
}

/**
 * Appends a project to the queue.
 *
 * Read-modify-write on a Drive file is NOT atomic: two admins clicking in the
 * same second can lose a request (PLAN §3.5). Acceptable here — the cost of
 * losing one is re-queueing, and the button is rarely used. If it ever becomes
 * a problem, the answer is one file per request instead of one file holding a
 * list.
 */
export async function enqueue(
  projectId: string,
  requestedBy: string
): Promise<{ added: boolean; reason?: string; queue: QueueItem[] }> {
  const id = projectId.trim().toUpperCase();
  if (!id) return { added: false, reason: 'empty ID', queue: await readQueue() };

  const current = await readQueue();
  if (current.some(it => it.projectId.trim().toUpperCase() === id)) {
    return { added: false, reason: 'already queued', queue: current };
  }

  // Already known upstream? Then the sheet has this project and the script
  // would skip it — queueing again would only clutter the file.
  const known = getDb()
    .prepare('SELECT 1 FROM upstream_status WHERE project_id = ? LIMIT 1')
    .get(id);
  if (known) {
    return { added: false, reason: 'already in the control sheet', queue: current };
  }

  const next = [...current, { projectId: id, requestedBy, requestedAt: new Date().toISOString() }];
  await writeQueue(next);
  return { added: true, queue: next };
}

/**
 * Drops from the queue whatever already showed up in the control sheet.
 *
 * This is the counterpart to "Apps Script never deletes the file": a request
 * only leaves once the other side has confirmed it. Called on the same tick
 * that reads upstream.
 */
export async function pruneQueue(): Promise<number> {
  const current = await readQueue();
  if (!current.length) return 0;

  const rows = getDb()
    .prepare('SELECT DISTINCT project_id FROM upstream_status')
    .all() as Array<{ project_id: string }>;
  const known = new Set(rows.map(r => r.project_id.trim().toUpperCase()));

  const keep = current.filter(it => !known.has(it.projectId.trim().toUpperCase()));
  if (keep.length === current.length) return 0;

  await writeQueue(keep);
  return current.length - keep.length;
}

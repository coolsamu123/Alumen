/**
 * Fase 3 — a fila que o Alumen deixa para o Apps Script.
 *
 * A fronteira entre os dois mundos é um ARQUIVO no Drive, não uma célula de
 * planilha (PLAN §0.2): a Sheets API não pode ser habilitada no projeto GCP da
 * AL, e escrever via Drive API num arquivo que o próprio Alumen cria dispensa
 * o escopo amplo `auth/spreadsheets`.
 *
 * O contrato é lido por `alumenMergeQueue()` no Apps Script:
 *
 *   { "version": 1,
 *     "queue": [ { "projectId", "requestedBy", "requestedAt" } ] }
 *
 * Quem tira item da fila é o ALUMEN, não o script — e só depois de ver o
 * projeto aparecer na planilha de controle. Assim uma execução perdida do
 * worker não perde pedido.
 */
import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { getDb } from './db';

const SERVICE_ACCOUNT_PATH = path.join(process.cwd(), 'data', 'service-account.json');

export const QUEUE_SETTINGS = {
  folderId: 'alumen_queue_folder_id',
} as const;

// Pasta "Copy Utility" no Shared Drive Alumen — a mesma que guarda a planilha
// de controle e o projeto Apps Script.
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
    /* app_settings pode não existir ainda — cai no default */
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

/** Acha um arquivo pelo nome dentro da pasta. `supportsAllDrives` é
 *  obrigatório: sem ele o Shared Drive responde "File not found" (PLAN §0.5). */
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

/** Lê a fila. Arquivo ausente ou ilegível conta como fila vazia — o Apps
 *  Script trata os dois casos do mesmo jeito. */
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
 * Acrescenta um projeto à fila.
 *
 * Read-modify-write num arquivo do Drive NÃO é atômico: dois admins clicando no
 * mesmo segundo podem perder um pedido (PLAN §3.5). Aceitável aqui — o custo de
 * perder é reenfileirar, e o botão é de uso raro. Se um dia virar problema, o
 * caminho é um arquivo por pedido em vez de um arquivo com lista.
 */
export async function enqueue(
  projectId: string,
  requestedBy: string
): Promise<{ added: boolean; reason?: string; queue: QueueItem[] }> {
  const id = projectId.trim().toUpperCase();
  if (!id) return { added: false, reason: 'ID vazio', queue: await readQueue() };

  const current = await readQueue();
  if (current.some(it => it.projectId.trim().toUpperCase() === id)) {
    return { added: false, reason: 'já está na fila', queue: current };
  }

  // Já conhecido pelo upstream? Então a planilha já tem esse projeto e o script
  // o ignoraria — enfileirar de novo só sujaria o arquivo.
  const known = getDb()
    .prepare('SELECT 1 FROM upstream_status WHERE project_id = ? LIMIT 1')
    .get(id);
  if (known) {
    return { added: false, reason: 'já está na planilha de controle', queue: current };
  }

  const next = [...current, { projectId: id, requestedBy, requestedAt: new Date().toISOString() }];
  await writeQueue(next);
  return { added: true, queue: next };
}

/**
 * Tira da fila o que já apareceu na planilha de controle.
 *
 * É a contrapartida do "o Apps Script não apaga o arquivo": o pedido só sai
 * depois de confirmado do outro lado. Chamado no mesmo tique em que o
 * upstream é lido.
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

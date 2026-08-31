import { google } from 'googleapis';
import { classifyFile, pickDuplicatesToSkip } from './file-hygiene';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { getDb } from './db';
import pLimit from 'p-limit';

// ─── Constants ──────────────────────────────────────────────────────────────

const SERVICE_ACCOUNT_PATH = path.join(process.cwd(), 'data', 'service-account.json');
export const DRIVE_LOCAL_ROOT = path.join(process.cwd(), 'data', 'drive');

// Supported export MIME types for Google Workspace files
const EXPORT_MIMES: Record<string, { mime: string; ext: string }> = {
  'application/vnd.google-apps.document': { mime: 'text/plain', ext: '.txt' },
  'application/vnd.google-apps.spreadsheet': { mime: 'text/csv', ext: '.csv' },
  'application/vnd.google-apps.presentation': { mime: 'text/plain', ext: '.txt' },
  'application/vnd.google-apps.drawing': { mime: 'image/png', ext: '.png' },
};

// Files we can extract text from
const TEXT_MIMES = new Set([
  'text/plain', 'text/csv', 'text/html', 'text/xml',
  'application/json', 'application/xml',
]);

const BINARY_DOWNLOADABLE = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/msword',
]);

// ─── Module-level state ─────────────────────────────────────────────────────

interface RecentFile {
  projectId: string;
  fileName: string;
  at: string; // ISO timestamp
}

interface DriveDownloadStatus {
  isRunning: boolean;
  phase: 'idle' | 'scanning' | 'downloading';
  totalUrls: number;
  processedUrls: number;
  totalFiles: number;
  downloadedFiles: number;
  skippedFiles: number;
  errors: string[];
  currentProject: string;
  startedAt: string | null;     // ISO when the current run started (null when idle)
  finishedAt: string | null;    // ISO when the last run finished
  recentFiles: RecentFile[];    // ring buffer, newest first, max 10
}

const RECENT_FILES_MAX = 10;

let downloadStatus: DriveDownloadStatus = {
  isRunning: false,
  phase: 'idle',
  totalUrls: 0,
  processedUrls: 0,
  totalFiles: 0,
  downloadedFiles: 0,
  skippedFiles: 0,
  errors: [],
  currentProject: '',
  startedAt: null,
  finishedAt: null,
  recentFiles: [],
};

function pushRecentFile(projectId: string, fileName: string) {
  downloadStatus.recentFiles = [
    { projectId, fileName, at: new Date().toISOString() },
    ...downloadStatus.recentFiles,
  ].slice(0, RECENT_FILES_MAX);
}

// ─── Auth ───────────────────────────────────────────────────────────────────

export function getDriveClient() {
  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    throw new Error('Service account key not found at data/service-account.json');
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_PATH,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });

  return google.drive({ version: 'v3', auth });
}

// ─── Extract file/folder ID from various URL formats ────────────────────────

export function extractDriveId(url: string): string | null {
  if (!url || !url.includes('drive.google.com')) return null;

  // https://drive.google.com/drive/folders/FOLDER_ID
  let match = url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];

  // https://drive.google.com/file/d/FILE_ID/...
  match = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];

  // https://drive.google.com/open?id=ID
  match = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (match) return match[1];

  // https://docs.google.com/.../d/ID/...
  match = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];

  return null;
}


// ─── Download a single file ─────────────────────────────────────────────────

export async function downloadFile(
  drive: ReturnType<typeof google.drive>,
  fileId: string,
  localDir: string
): Promise<{ name: string; localPath: string; textContent: string; webUrl: string } | null> {
  // Get file metadata
  let meta = await drive.files.get({
    fileId,
    fields: 'id,name,mimeType,size,shortcutDetails',
    supportsAllDrives: true,
  });

  let name = meta.data.name || fileId;
  let mimeType = meta.data.mimeType || '';
  let actualId = fileId;

  // Resolve shortcut
  if (mimeType === 'application/vnd.google-apps.shortcut' && meta.data.shortcutDetails) {
    actualId = meta.data.shortcutDetails.targetId!;
    mimeType = meta.data.shortcutDetails.targetMimeType!;
    
    // Fetch actual target meta to get size
    try {
        meta = await drive.files.get({
            fileId: actualId,
            fields: 'id,name,mimeType,size',
            supportsAllDrives: true,
        });
        name = meta.data.name || name;
    } catch {
        // Fallback to shortcut name if target is inaccessible
    }
  }

  const size = parseInt(meta.data.size || '0', 10);
  // Per-file deep link used by the citation popover. Resolved against the post-
  // shortcut `actualId` so shortcuts open the real file, not the shortcut stub.
  const webUrl = `https://drive.google.com/file/d/${actualId}/view`;

  // Skip very large files (>50MB)
  if (size > 50 * 1024 * 1024) {
    return { name, localPath: '', textContent: `[File too large: ${name} (${(size / 1024 / 1024).toFixed(1)}MB)]`, webUrl };
  }

  // Google Workspace files → export as text
  if (EXPORT_MIMES[mimeType]) {
    const exp = EXPORT_MIMES[mimeType];
    const safeName = sanitizeFilename(name) + exp.ext;
    const localPath = path.join(localDir, safeName);

    // Skip if already downloaded locally
    if (fs.existsSync(localPath)) {
      const text = exp.ext !== '.png' ? fs.readFileSync(localPath, 'utf-8') : `[Image: ${name}]`;
      return { name, localPath, textContent: text.slice(0, 30000), webUrl };
    }

    const res = await drive.files.export(
      { fileId: actualId, mimeType: exp.mime },
      { responseType: 'text' }
    );

    const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    fs.writeFileSync(localPath, text, 'utf-8');
    return { name, localPath, textContent: text.slice(0, 30000), webUrl };
  }

  // Text files → download as text
  if (TEXT_MIMES.has(mimeType)) {
    const safeName = sanitizeFilename(name);
    const localPath = path.join(localDir, safeName);

    if (fs.existsSync(localPath)) {
      const text = fs.readFileSync(localPath, 'utf-8');
      return { name, localPath, textContent: text.slice(0, 30000), webUrl };
    }

    const res = await drive.files.get(
      { fileId: actualId, alt: 'media', supportsAllDrives: true },
      { responseType: 'text' }
    );

    const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    fs.writeFileSync(localPath, text, 'utf-8');
    return { name, localPath, textContent: text.slice(0, 30000), webUrl };
  }

  // Binary files (PDF, DOCX, etc.) → download binary
  if (BINARY_DOWNLOADABLE.has(mimeType)) {
    const safeName = sanitizeFilename(name);
    const localPath = path.join(localDir, safeName);

    if (fs.existsSync(localPath)) {
      return { name, localPath, textContent: `[Binary file: ${name} (${mimeType}, ${(size / 1024).toFixed(0)}KB) — saved locally at ${localPath}]`, webUrl };
    }

    const res = await drive.files.get(
      { fileId: actualId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );

    fs.writeFileSync(localPath, Buffer.from(res.data as ArrayBuffer));
    return { name, localPath, textContent: `[Binary file: ${name} (${mimeType}, ${(size / 1024).toFixed(0)}KB) — saved locally at ${localPath}]`, webUrl };
  }

  // Unknown type
  return { name, localPath: '', textContent: `[Unsupported file type: ${name} (${mimeType})]`, webUrl };
}

// ─── List files in a folder ─────────────────────────────────────────────────

export async function listFolderFiles(
  drive: ReturnType<typeof google.drive>,
  folderId: string,
  depth: number = 0,
  maxDepth: number = 5
): Promise<{ id: string; name: string; mimeType: string }[]> {
  const files: { id: string; name: string; mimeType: string }[] = [];
  let pageToken: string | undefined;

  try {
    do {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, size, shortcutDetails)',
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      for (const f of res.data.files || []) {
        let actualId = f.id!;
        let actualMime = f.mimeType!;
        const actualName = f.name!;

        // Resolve shortcuts
        if (f.mimeType === 'application/vnd.google-apps.shortcut' && f.shortcutDetails) {
          actualId = f.shortcutDetails.targetId!;
          actualMime = f.shortcutDetails.targetMimeType!;
        }

        if (actualMime === 'application/vnd.google-apps.folder') {
          // Recurse into subfolders up to maxDepth
          if (depth < maxDepth) {
            const subFiles = await listFolderFiles(drive, actualId, depth + 1, maxDepth);
            files.push(...subFiles);
          }
        } else {
          files.push({ id: actualId, name: actualName, mimeType: actualMime });
        }
      }

      pageToken = res.data.nextPageToken || undefined;
    } while (pageToken);
  } catch (err) {
    console.warn(`Could not list folder ${folderId}`, err);
  }

  return files;
}

// ─── Process a single URL (folder or file) ──────────────────────────────────

async function processUrl(
  drive: ReturnType<typeof google.drive>,
  url: string,
  projectId: string,
  projectName: string
): Promise<{ files: { name: string; localPath: string; textContent: string; webUrl: string }[] }> {
  const driveId = extractDriveId(url);
  if (!driveId) return { files: [] };

  // Create local directory: data/drive/{projectId}/
  const safeProjName = sanitizeFilename(`${projectId}_${projectName}`.slice(0, 60));
  const localDir = path.join(DRIVE_LOCAL_ROOT, safeProjName);
  if (!fs.existsSync(localDir)) {
    fs.mkdirSync(localDir, { recursive: true });
  }

  const results: { name: string; localPath: string; textContent: string; webUrl: string }[] = [];

    try {
    const meta = await drive.files.get({
      fileId: driveId,
      fields: 'id,mimeType,shortcutDetails',
      supportsAllDrives: true,
    });
    
    let actualId = driveId;
    let mimeType = meta.data.mimeType;

    if (mimeType === 'application/vnd.google-apps.shortcut' && meta.data.shortcutDetails) {
      actualId = meta.data.shortcutDetails.targetId!;
      mimeType = meta.data.shortcutDetails.targetMimeType!;
    }

    if (mimeType === 'application/vnd.google-apps.folder') {
      const allFiles = await listFolderFiles(drive, actualId);
      // Pre-download hygiene filter: drop deprecated/cross-PRJ files BEFORE
      // we hit the network. Skipped entries are surfaced to the caller as
      // synthetic `webUrl='skipped:<reason>'` markers so the cache can record
      // why we passed on them.
      const files: typeof allFiles = [];
      for (const f of allFiles) {
        const verdict = classifyFile(projectId, f.name);
        if (verdict.keep) {
          files.push(f);
        } else {
          results.push({
            name: f.name,
            localPath: '',
            textContent: '',
            webUrl: `skipped:${verdict.reason}:${f.id}`,
          });
        }
      }
      downloadStatus.totalFiles += files.length;
      downloadStatus.phase = 'downloading';

      const limit = pLimit(10); // 10 concurrent downloads

      const downloadPromises = files.map(f => limit(async () => {
        try {
          const result = await downloadFile(drive, f.id, localDir);
          if (result) {
             results.push(result);
             if (result.localPath) {
                 downloadStatus.downloadedFiles++;
                 pushRecentFile(projectId, f.name);
             }
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          downloadStatus.errors.push(`${projectId}/${f.name}: ${msg}`);
          downloadStatus.skippedFiles++;
        }
      }));

      await Promise.all(downloadPromises);

    } else {
      try {
        downloadStatus.totalFiles += 1;
        downloadStatus.phase = 'downloading';
        const result = await downloadFile(drive, actualId, localDir);
        if (result) {
            results.push(result);
            if (result.localPath) {
                downloadStatus.downloadedFiles++;
                pushRecentFile(projectId, result.name || actualId);
            }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        downloadStatus.errors.push(`${projectId}/${actualId}: ${msg}`);
        downloadStatus.skippedFiles++;
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    downloadStatus.errors.push(`${projectId}/${url}: ${msg}`);
    downloadStatus.skippedFiles++;
  }

  return { files: results };
}

// ─── Main: Download all project files ───────────────────────────────────────


// ─── Download a single project's files ──────────────────────────────────────

export async function runDriveDownloadSingle(projectId: string): Promise<void> {
  if (downloadStatus.isRunning) {
    throw new Error('Drive download is already running');
  }

  downloadStatus = {
    isRunning: true,
    phase: 'scanning',
    totalUrls: 0,
    processedUrls: 0,
    totalFiles: 0,
    downloadedFiles: 0,
    skippedFiles: 0,
    errors: [],
    currentProject: 'Initializing...',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    recentFiles: [],
  };

  try {
    const drive = getDriveClient();
    const db = getDb();

    // Get specific project
    const row = db.prepare(`
      SELECT project_id, name, link_folder, link_positions, link_cioo
      FROM projects
      WHERE project_id = ?
    `).get(projectId) as { project_id: string; name: string; link_folder: string; link_positions: string; link_cioo: string } | undefined;

    if (!row) {
      throw new Error('Project not found');
    }

    const urls: string[] = [];
    const isLocal: boolean[] = [];
    const rawLinks = [row.link_folder, row.link_positions, row.link_cioo].join(' ').split(/\s+/);
    for (const link of rawLinks) {
      if (!link) continue;
      if (link.startsWith('https://drive.google.com')) {
        urls.push(link);
        isLocal.push(false);
      } else if (link.startsWith('/')) {
        urls.push(link);
        isLocal.push(true);
      }
    }

    if (urls.length === 0) {
      downloadStatus.currentProject = 'Complete (no links)';
      return;
    }

    downloadStatus.totalUrls = urls.length;

    // Prepare DB statements. Each downloaded file becomes its own cache row,
    // keyed by (project_id, file's GDrive URL), so the citation popover can
    // deep-link to the actual file. Hygiene-skipped rows use the synthetic
    // `skipped:<reason>:<id>` URL marker emitted by processUrl().
    const upsertDoc = db.prepare(`
      INSERT OR REPLACE INTO documents_cache (url, project_id, content_text, content_type, fetch_status, file_name)
      VALUES (?, ?, ?, ?, 'success', ?)
    `);
    const upsertDocSkipped = db.prepare(`
      INSERT OR REPLACE INTO documents_cache (url, project_id, fetch_status, file_name)
      VALUES (?, ?, ?, ?)
    `);
    const upsertDocError = db.prepare(`
      INSERT OR REPLACE INTO documents_cache (url, project_id, fetch_status, error_message)
      VALUES (?, ?, 'error', ?)
    `);

    downloadStatus.currentProject = `${row.project_id}: ${row.name.slice(0, 40)}`;

    for (let uIdx = 0; uIdx < urls.length; uIdx++) {
      const url = urls[uIdx];
      const isLoc = isLocal[uIdx];

      try {
        if (!isLoc) {
          const { files } = await processUrl(drive, url, row.project_id, row.name);

          for (const f of files) {
            if (f.webUrl.startsWith('skipped:')) {
              const [, reason] = f.webUrl.split(':');
              upsertDocSkipped.run(f.webUrl, row.project_id, `skipped_${reason}`, f.name || '');
            } else {
              upsertDoc.run(f.webUrl, row.project_id, f.textContent, f.localPath ? 'downloaded' : 'metadata', f.name || '');
            }
          }

          if (files.length === 0) {
            upsertDocError.run(url, row.project_id, 'No files found or not accessible');
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        downloadStatus.errors.push(`${row.project_id}: ${msg}`);
        upsertDocError.run(url, row.project_id, msg);
      }

      downloadStatus.processedUrls++;
    }

    // Onda 1: dedupe pass — after all URLs of the project are ingested, mark
    // rows with duplicate content as 'skipped_duplicate' so the LLM only sees
    // one canonical copy.
    dedupeProjectDocs(row.project_id);

    downloadStatus.currentProject = 'Complete';
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    downloadStatus.errors.push(`Fatal: ${msg}`);
  } finally {
    downloadStatus.isRunning = false;
    downloadStatus.finishedAt = new Date().toISOString();
  }
}

// ─── Discover project from GDrive Link ─────────────────────────────────────

// Accepts: PRJ12345, PRJ-12345, PRJ_12345, PRJ 12345, PRJ12345TR, etc.
// The optional separator between PRJ and the digits handles the common
// Air-Liquide naming where folders are titled like "PRJ-0018641 Foo Bar".
const PRJ_FOLDER_REGEX = /PRJ[\s\-_]*([0-9]+)([A-Z]{0,4})/i;

// Normalize a raw PRJ-ish string from a folder name into the canonical key
// (uppercase, no separators). Returns the original digits as captured, plus a
// numeric-only key (leading zeros stripped) for fallback matching against
// projects whose IDs differ only in zero-padding.
function normalizePrjMatch(raw: string): { canonical: string; digitsKey: string } {
  const m = raw.match(PRJ_FOLDER_REGEX);
  if (!m) return { canonical: '', digitsKey: '' };
  const digits = m[1];
  const suffix = (m[2] || '').toUpperCase();
  return {
    canonical: `PRJ${digits}${suffix}`,
    digitsKey: `${String(parseInt(digits, 10))}${suffix}`, // "0018641" → "18641"
  };
}

export async function discoverAndAddProjectFromDrive(
  url: string,
  opts: { createMissing?: boolean } = {},
): Promise<{
  created:   { projectId: string; name: string }[];
  linked:    { projectId: string; name: string }[];
  unmatched: { folderName: string; extracted: string }[];
  scannedFolders: number;
}> {
  const createMissing = opts.createMissing !== false;
  const drive = getDriveClient();
  const rootId = extractDriveId(url);

  if (!rootId) {
    throw new Error('Invalid Google Drive URL');
  }

  const foundProjects: { id: string; folderName: string; canonical: string; digitsKey: string }[] = [];
  let scannedFolders = 0;

  // Recursive search for all PRJ folders
  async function searchForProjectFolders(folderId: string, depth: number = 0): Promise<void> {
    if (depth > 5) return;

    try {
      // First get this folder's name to see if it's the one
      const folderMeta = await drive.files.get({
        fileId: folderId,
        fields: 'id,name',
        supportsAllDrives: true,
      });

      scannedFolders++;
      const name = folderMeta.data.name || '';
      const { canonical, digitsKey } = normalizePrjMatch(name);

      if (canonical) {
        foundProjects.push({ id: folderId, folderName: name, canonical, digitsKey });
        // If it's a project folder, we don't need to recurse deeper inside it for discovery
        return;
      }

      // If not, list subfolders and recurse
      const res = await drive.files.list({
        q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name)',
        pageSize: 100,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      for (const f of res.data.files || []) {
        if (!f.id) continue;
        await searchForProjectFolders(f.id, depth + 1);
      }
    } catch (err) {
      console.warn('Error searching folder', folderId, err);
    }
  }

  await searchForProjectFolders(rootId);

  const db = getDb();
  const created: { projectId: string; name: string }[] = [];
  const linked:  { projectId: string; name: string }[] = [];
  const unmatched: { folderName: string; extracted: string }[] = [];

  // Build a digit-key index of existing projects so we can match folders whose
  // PRJ id differs only by zero-padding (e.g. folder "PRJ-18641" → DB "PRJ0018641").
  const existingRows = db.prepare(
    "SELECT project_id, name, link_folder FROM projects WHERE project_id LIKE 'PRJ%'"
  ).all() as Array<{ project_id: string; name: string | null; link_folder: string | null }>;
  const byCanonical = new Map<string, { project_id: string; name: string | null; link_folder: string | null }>();
  const byDigits    = new Map<string, { project_id: string; name: string | null; link_folder: string | null }>();
  for (const row of existingRows) {
    byCanonical.set(row.project_id.toUpperCase(), row);
    const dm = row.project_id.match(/^PRJ([0-9]+)([A-Z]*)$/i);
    if (dm) {
      const key = `${String(parseInt(dm[1], 10))}${(dm[2] || '').toUpperCase()}`;
      byDigits.set(key, row);
    }
  }

  for (const proj of foundProjects) {
    const folderLink = `https://drive.google.com/drive/folders/${proj.id}`;

    // Try exact canonical match first; fall back to digit-key match.
    let existing = byCanonical.get(proj.canonical);
    let matchedProjectId = proj.canonical;
    if (!existing) {
      const fallback = byDigits.get(proj.digitsKey);
      if (fallback) {
        existing = fallback;
        matchedProjectId = fallback.project_id;
      }
    }

    if (existing) {
      const newLinkFolder = existing.link_folder
        ? (existing.link_folder.includes(folderLink) ? existing.link_folder : existing.link_folder + ' ' + folderLink)
        : folderLink;
      db.prepare('UPDATE projects SET link_folder = ? WHERE project_id = ?').run(newLinkFolder, matchedProjectId);
      linked.push({ projectId: matchedProjectId, name: existing.name || proj.folderName });
    } else if (createMissing) {
      // No match anywhere → create a new stub. The "Add a Drive source" flow
      // explicitly opts in to this; Sync All passes createMissing=false to
      // avoid populating projects table with junk stubs picked up during a
      // bulk root scan.
      db.prepare('INSERT INTO projects (project_id, name, link_folder) VALUES (?, ?, ?)').run(proj.canonical, proj.folderName, folderLink);
      created.push({ projectId: proj.canonical, name: proj.folderName });
      unmatched.push({ folderName: proj.folderName, extracted: proj.canonical });
    } else {
      unmatched.push({ folderName: proj.folderName, extracted: proj.canonical });
    }
  }

  return { created, linked, unmatched, scannedFolders };
}

export async function runDriveDownload(): Promise<void> {
  if (downloadStatus.isRunning) {
    throw new Error('Drive download is already running');
  }

  downloadStatus = {
    isRunning: true,
    phase: 'scanning',
    totalUrls: 0,
    processedUrls: 0,
    totalFiles: 0,
    downloadedFiles: 0,
    skippedFiles: 0,
    errors: [],
    currentProject: 'Initializing...',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    recentFiles: [],
  };

  try {
    const drive = getDriveClient();
    const db = getDb();

    // Get all unique project URLs
    const rows = db.prepare(`
      SELECT DISTINCT p.project_id, p.name,
        p.link_folder, p.link_positions, p.link_cioo
      FROM projects p
      WHERE p.link_folder LIKE '%drive.google.com%'
         OR p.link_positions LIKE '%drive.google.com%'
         OR p.link_cioo LIKE '%drive.google.com%'
         OR p.link_folder LIKE '/%'
         OR p.link_positions LIKE '/%'
         OR p.link_cioo LIKE '/%'
      GROUP BY p.project_id
    `).all() as { project_id: string; name: string; link_folder: string; link_positions: string; link_cioo: string }[];

    // Collect all unique URLs per project. We do NOT skip URLs based on the
    // documents_cache row — folders can gain new files over time, and a partial
    // download (e.g. PDFs through but Google-Workspace exports failed) used to
    // become permanent. Per-file idempotency is already provided by the
    // fs.existsSync(localPath) guard inside downloadFile().
    const projectUrls: { projectId: string; name: string; urls: string[]; isLocal: boolean[] }[] = [];
    for (const row of rows) {
      const urls: string[] = [];
      const isLocal: boolean[] = [];
      const rawLinks = [row.link_folder, row.link_positions, row.link_cioo].join(' ').split(/\s+/);
      for (const link of rawLinks) {
        if (!link) continue;
        if (link.startsWith('https://drive.google.com')) {
          urls.push(link);
          isLocal.push(false);
        } else if (link.startsWith('/')) {
          urls.push(link);
          isLocal.push(true);
        }
      }
      if (urls.length > 0) {
        projectUrls.push({ projectId: row.project_id, name: row.name, urls, isLocal });
      }
    }

    downloadStatus.totalUrls = projectUrls.reduce((sum, p) => sum + p.urls.length, 0);
    downloadStatus.skippedFiles = 0;

    if (downloadStatus.totalUrls === 0) {
      downloadStatus.currentProject = 'Complete (all files already cached)';
      return;
    }

    // Ensure drive root exists
    if (!fs.existsSync(DRIVE_LOCAL_ROOT)) {
      fs.mkdirSync(DRIVE_LOCAL_ROOT, { recursive: true });
    }

    // Prepare DB statement for caching. Each file is its own row keyed by
    // (project_id, file's GDrive URL). Error/no-files rows keep the folder URL
    // since we never resolve a per-file URL on that path. Hygiene-skipped
    // rows use the `skipped:<reason>:<id>` synthetic URL.
    const upsertDoc = db.prepare(`
      INSERT OR REPLACE INTO documents_cache (url, project_id, content_text, content_type, fetch_status, file_name)
      VALUES (?, ?, ?, ?, 'success', ?)
    `);
    const upsertDocSkipped = db.prepare(`
      INSERT OR REPLACE INTO documents_cache (url, project_id, fetch_status, file_name)
      VALUES (?, ?, ?, ?)
    `);
    const upsertDocError = db.prepare(`
      INSERT OR REPLACE INTO documents_cache (url, project_id, fetch_status, error_message)
      VALUES (?, ?, 'error', ?)
    `);

    for (const proj of projectUrls) {
      downloadStatus.currentProject = `${proj.projectId}: ${proj.name.slice(0, 40)}`;

      for (let uIdx = 0; uIdx < proj.urls.length; uIdx++) {
        const url = proj.urls[uIdx];
        const isLoc = proj.isLocal[uIdx];

        try {
          if (isLoc) {
            // Process local folder
            const localPath = decodeURI(url).replace(/^file:\/\//, '');
            if (fs.existsSync(localPath)) {
              let textContent = '';
              const stat = fs.statSync(localPath);
              if (stat.isDirectory()) {
                const files = fs.readdirSync(localPath);
                for (const f of files) {
                  const fp = path.join(localPath, f);
                  if (fs.statSync(fp).isFile() && f.endsWith('.docx') && !f.startsWith('~')) {
                    try {
                      const text = execSync(`unzip -p "${fp}" word/document.xml | sed -e 's/<[^>]*>/ /g'`, { encoding: 'utf-8' });
                      textContent += `\n\n--- ${f} ---\n${text.replace(/\s+/g, ' ')}`;
                    } catch {
                      console.warn(`Failed to read docx ${fp}`);
                    }
                  }
                }
              }
              // Handled by the generic file incrementer logic inside processUrl for uniformity
              downloadStatus.totalFiles++;
              downloadStatus.downloadedFiles++;
              pushRecentFile(proj.projectId, path.basename(localPath));
              upsertDoc.run(url, proj.projectId, textContent.slice(0, 30000), 'local_folder', path.basename(localPath));
            } else {
              upsertDocError.run(url, proj.projectId, 'Local path does not exist');
            }
          } else {
            const { files } = await processUrl(drive, url, proj.projectId, proj.name);

            for (const f of files) {
              if (f.webUrl.startsWith('skipped:')) {
                const [, reason] = f.webUrl.split(':');
                upsertDocSkipped.run(f.webUrl, proj.projectId, `skipped_${reason}`, f.name || '');
              } else {
                // Cache text content in DB, keyed by the file's own GDrive URL
                upsertDoc.run(f.webUrl, proj.projectId, f.textContent, f.localPath ? 'downloaded' : 'metadata', f.name || '');
              }
            }

            if (files.length === 0) {
              upsertDocError.run(url, proj.projectId, 'No files found or not accessible');
            }
          }
        } catch (err: unknown) {
          // URL-level error: log and continue to next URL
          const msg = err instanceof Error ? err.message : String(err);
          downloadStatus.errors.push(`${proj.projectId}: ${msg}`);
          upsertDocError.run(url, proj.projectId, msg);
        }

        downloadStatus.processedUrls++;

        // Small delay to avoid rate limiting
        if (!isLoc) await new Promise(resolve => setTimeout(resolve, 200));
      }

      // Onda 1: dedupe pass per project (after all its URLs are ingested).
      dedupeProjectDocs(proj.projectId);
    }

    downloadStatus.currentProject = 'Complete';
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    downloadStatus.errors.push(`Fatal: ${msg}`);
  } finally {
    downloadStatus.isRunning = false;
    downloadStatus.finishedAt = new Date().toISOString();
  }
}

// ─── Get download status ────────────────────────────────────────────────────

export function getDriveStatus(): DriveDownloadStatus {
  // If not running, compute real counts from DB
  if (!downloadStatus.isRunning) {
    try {
      const db = getDb();
      const successCount = db.prepare(
        `SELECT COUNT(*) as cnt FROM documents_cache WHERE fetch_status = 'success'`
      ).get() as { cnt: number };
      const errorCount = db.prepare(
        `SELECT COUNT(*) as cnt FROM documents_cache WHERE fetch_status = 'error'`
      ).get() as { cnt: number };
      downloadStatus.downloadedFiles = successCount.cnt;
      downloadStatus.totalFiles = successCount.cnt + errorCount.cnt;
    } catch {
      // ignore
    }
  }
  return { ...downloadStatus };
}

// ─── Get cached text content for a project's URLs ───────────────────────────

// Look up the cached file_name (and existence) for a list of document URLs.
// Used by the impact engine to enrich LLM-supplied citations: the model returns
// doc_url + snippet, and the server resolves the human-readable file name from
// documents_cache so the popover doesn't have to trust the model on naming.
export function getFileNamesForUrls(urls: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (urls.length === 0) return out;
  const db = getDb();
  const placeholders = urls.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT url, file_name FROM documents_cache WHERE url IN (${placeholders})`
  ).all(...urls) as { url: string; file_name: string }[];
  for (const r of rows) {
    if (r.file_name) out.set(r.url, r.file_name);
  }
  return out;
}

/**
 * Documents for a project, newest-name-first.
 *
 * `maxChars` truncates `content` in SQL instead of in JS. Callers that only need
 * a prefix should pass it: the Impact engine caps each document at a few
 * thousand chars and calls this once per project *per batch*, so a project's
 * full document text was being read out of SQLite and discarded roughly
 * N/batchSize times per run. Omit it to get the whole text (deep dive, evidence).
 */
export function getProjectDocuments(
  projectId: string,
  maxChars?: number,
): { url: string; content: string; status: string; fileName: string }[] {
  const db = getDb();
  // Per-file rows: each downloaded file is its own row keyed by project_id +
  // GDrive file URL. Skipped rows (deprecated / cross-PRJ / duplicate) are
  // excluded — the LLM only sees clean canonical content.
  const sql = (contentExpr: string) => `
    SELECT url, ${contentExpr} AS content_text, fetch_status, file_name
    FROM documents_cache
    WHERE project_id = ? AND fetch_status NOT LIKE 'skipped_%'
    ORDER BY file_name
  `;

  const sliced = typeof maxChars === 'number' && maxChars > 0;
  const rows = (sliced
    ? db.prepare(sql('substr(content_text, 1, ?)')).all(maxChars, projectId)
    : db.prepare(sql('content_text')).all(projectId)
  ) as { url: string; content_text: string; fetch_status: string; file_name: string }[];

  return rows.map(r => ({
    url: r.url,
    content: r.content_text || '',
    status: r.fetch_status,
    fileName: r.file_name || '',
  }));
}

// Post-ingestion hygiene: marks redundant rows of the same project as
// 'skipped_duplicate' so the LLM only sees one canonical copy of each unique
// content blob. Idempotent — running it twice on the same DB state is a no-op.
// Called from runDriveDownload* after all files for a project are ingested.
export function dedupeProjectDocs(projectId: string): number {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, url, file_name, content_text
    FROM documents_cache
    WHERE project_id = ? AND fetch_status = 'success'
  `).all(projectId) as { id: number; url: string; file_name: string; content_text: string }[];

  const toSkip = pickDuplicatesToSkip(
    rows.map(r => ({ id: r.id, fileName: r.file_name, contentText: r.content_text })),
  );
  if (toSkip.length === 0) return 0;

  const stmt = db.prepare(`UPDATE documents_cache SET fetch_status = 'skipped_duplicate' WHERE id = ?`);
  const tx = db.transaction((ids: number[]) => { for (const id of ids) stmt.run(id); });
  tx(toSkip as number[]);
  return toSkip.length;
}

// ─── Get local file path for a project ──────────────────────────────────────

export function getProjectLocalPath(projectId: string): string | null {
  if (!fs.existsSync(DRIVE_LOCAL_ROOT)) return null;

  const dirs = fs.readdirSync(DRIVE_LOCAL_ROOT);
  const match = dirs.find(d => d.startsWith(projectId));
  if (!match) return null;

  return path.join(DRIVE_LOCAL_ROOT, match);
}

// ─── Count downloaded files per project ─────────────────────────────────────

const DOWNLOADABLE_EXTS = new Set(['.docx', '.xlsx', '.pdf', '.txt', '.csv']);

function countFilesRecursive(dir: string): number {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countFilesRecursive(full);
    } else if (DOWNLOADABLE_EXTS.has(path.extname(entry.name).toLowerCase())) {
      count++;
    }
  }
  return count;
}

export function getDownloadedFilesByProject(): Map<string, number> {
  const result = new Map<string, number>();
  if (!fs.existsSync(DRIVE_LOCAL_ROOT)) return result;

  for (const entry of fs.readdirSync(DRIVE_LOCAL_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const m = entry.name.match(/^(PRJ[0-9]+)/i);
    if (!m) continue;
    const projectId = m[1].toUpperCase();
    const count = countFilesRecursive(path.join(DRIVE_LOCAL_ROOT, entry.name));
    result.set(projectId, (result.get(projectId) || 0) + count);
  }

  return result;
}

// ─── Reset all downloaded data ────────────────────────────────────────────────

export function resetDriveData(): void {
  if (downloadStatus.isRunning) {
    throw new Error('Cannot reset while download is running');
  }

  // Clear DB cache and drive links from projects
  const db = getDb();
  db.exec('DELETE FROM documents_cache');
  db.exec(`
    UPDATE projects 
    SET link_folder = NULL, 
        link_positions = NULL, 
        link_cioo = NULL
  `);

  // Delete local folder
  if (fs.existsSync(DRIVE_LOCAL_ROOT)) {
    fs.rmSync(DRIVE_LOCAL_ROOT, { recursive: true, force: true });
  }

  // Reset status
  downloadStatus = {
    isRunning: false,
    phase: 'idle',
    totalUrls: 0,
    processedUrls: 0,
    totalFiles: 0,
    downloadedFiles: 0,
    skippedFiles: 0,
    errors: [],
    currentProject: '',
    startedAt: null,
    finishedAt: null,
    recentFiles: [],
  };
}

// ─── Get all downloaded content for Gemini ──────────────────────────────────

export function getAllDocumentTexts(): Map<string, string> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT url, content_text FROM documents_cache
    WHERE fetch_status = 'success' AND content_text != ''
  `).all() as { url: string; content_text: string }[];

  const map = new Map<string, string>();
  for (const r of rows) {
    map.set(r.url, r.content_text);
  }
  return map;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sanitizeFilename(name: string): string {
  // Preserve the extension when truncating, otherwise long filenames lose their
  // type marker (e.g. ".pdf" → ".pd") and downstream extension allowlists drop them.
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, name.length - ext.length) : name;
  const cleanStem = stem
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_');
  const cleanExt = ext.replace(/[<>:"/\\|?*]/g, '_');
  const maxStemLen = Math.max(1, 120 - cleanExt.length);
  return cleanStem.slice(0, maxStemLen) + cleanExt;
}

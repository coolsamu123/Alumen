import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { getDb } from './db';

const DRIVE_LOCAL_ROOT = path.join(process.cwd(), 'data', 'drive');

export interface ScannedProject {
  projectId: string;
  projectName: string;
  region: string;            // CDIO sheet's `dds` column, fallback "Global"
  gate: string;              // CDIO sheet's `gate` column, fallback "Unknown"
  monthFolders: string[];    // Review period(s) — derived from CDIO review_date
  files: string[];
}

interface ProjectMetaRow {
  project_id: string;
  name: string | null;
  dds: string | null;
  gate: string | null;
  review_date: string | null;
}

// Recursively collect all files under a directory
function collectFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath));
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (['.docx', '.xlsx', '.pdf', '.txt', '.csv'].includes(ext)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

// Pull DDS / Gate / Name / review_date from the CDIO `projects` table so the
// Goals prompt sees the right governance context instead of generic
// placeholders. Falls back to '' for any missing field.
function loadProjectMetadata(): Map<string, ProjectMetaRow> {
  const out = new Map<string, ProjectMetaRow>();
  try {
    const db = getDb();
    // Latest row per project_id (matches the dedupe used elsewhere).
    const rows = db.prepare(`
      SELECT project_id, name, dds, gate, review_date
      FROM projects
      WHERE id = (SELECT MAX(p2.id) FROM projects p2 WHERE p2.project_id = projects.project_id)
    `).all() as ProjectMetaRow[];
    for (const r of rows) out.set(r.project_id, r);
  } catch (err) {
    console.warn('[goals-scanner] failed to load projects metadata', err);
  }
  return out;
}

// Build a single-element monthFolders array from an ISO review date, e.g.
//   "2025-03-14" → "2025-03". Empty if no date.
function monthFolderFromReview(reviewDate: string | null): string[] {
  if (!reviewDate) return ['Drive Sync'];
  const m = reviewDate.match(/^(\d{4}-\d{2})/);
  return m ? [m[1]] : ['Drive Sync'];
}

// PRJxxxxx folder name may include a non-digit suffix (e.g. PRJ12345TR).
// Match the same pattern as drive-engine for consistency.
// Matches PRJxxxxxxx and PGMxxxxxxx folder names (PGM = portfolio-level
// programme grouping used by CDIO alongside individual projects).
const PRJ_FOLDER_NAME = /^((?:PRJ|PGM)[\s\-_]*[0-9]+[A-Z]{0,4})[_\- ]?(.*)$/i;

/**
 * Stable fingerprint of a project's document set, used to decide whether its
 * goals need re-extracting.
 *
 * Deliberately NOT the raw `JSON.stringify(files)` that `source_files` stores:
 * that is an ordered list of ABSOLUTE paths straight from `readdirSync`, whose
 * order is not guaranteed and which changes wholesale if `data/drive` ever
 * moves. Comparing it would report "changed" for every project at once — and
 * with 301 projects, a false positive costs 301 LLM calls against a daily cap
 * of 500.
 *
 * So: relative paths, sorted, plus each file's size. Size catches an edited
 * document without churning when the Drive sync re-downloads an identical file
 * (which an mtime would). The known gap is an edit that leaves the byte count
 * untouched; that is the price of not re-analysing the whole portfolio on a
 * re-sync.
 */
export function fileSignature(files: string[]): string {
  const parts = files.map(f => {
    let size = -1;
    try { size = fs.statSync(f).size; } catch { /* unreadable → -1, still stable */ }
    return `${path.relative(DRIVE_LOCAL_ROOT, f).split(path.sep).join('/')}:${size}`;
  });
  parts.sort();
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

export function scanProjects(): ScannedProject[] {
  const projectMap = new Map<string, ScannedProject>();

  if (!fs.existsSync(DRIVE_LOCAL_ROOT)) {
    return [];
  }

  const metaByProjectId = loadProjectMetadata();

  for (const entry of fs.readdirSync(DRIVE_LOCAL_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const folderName = entry.name;
    const m = folderName.match(PRJ_FOLDER_NAME);
    if (!m) continue;

    // Canonicalise the PRJ id by stripping any separator inside the prefix.
    const projectId = m[1].replace(/[\s\-_]/g, '').toUpperCase();
    const folderTail = (m[2] || '').replace(/_/g, ' ').trim();

    const projPath = path.join(DRIVE_LOCAL_ROOT, folderName);
    const files = collectFiles(projPath);
    if (files.length === 0) continue;

    const meta = metaByProjectId.get(projectId);
    const projectName = (meta?.name && meta.name.trim()) || folderTail || projectId;
    const region = (meta?.dds && meta.dds.trim()) || 'Global';
    const gate = (meta?.gate && meta.gate.trim()) || 'Unknown';
    const monthFolders = monthFolderFromReview(meta?.review_date ?? null);

    projectMap.set(projectId, {
      projectId,
      projectName,
      region,
      gate,
      monthFolders,
      files,
    });
  }

  return Array.from(projectMap.values());
}

/**
 * "Is this project already in the base folder?" — asked before queueing a copy.
 *
 * Apps Script copies a project into the base folder ("Alumen › Projects").
 * Asking it again for one that is already there would only duplicate the tree
 * (the dedup in cleanup exists precisely because that happened, PLAN §0.5).
 * Such a project skips copy and cleanup: Alumen links it to the existing folder
 * and the scheduler carries it through download → goals → impact
 * (pendingWork: "linked project never downloaded").
 */
import { getDriveClient, discoverAndAddProjectFromDrive } from './drive-engine';
import { baseFolderId, baseFolderUrl, isAutoCycleRunning } from './auto-pipeline';
import { normalizeProjectId } from './project-id';

/** Canonical project ids of the PRJ folders directly inside the base folder. */
export async function projectIdsInBaseFolder(): Promise<Set<string>> {
  const drive = getDriveClient();
  const ids = new Set<string>();
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: `'${baseFolderId()}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'nextPageToken, files(name)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files ?? []) {
      // Folder names carry the number first ("PRJ0022090", "PRJ0022090 - Name").
      const m = (f.name ?? '').match(/[A-Z]{3}\d+[A-Z]?/i);
      const id = m ? normalizeProjectId(m[0]) : null;
      if (id) ids.add(id.toUpperCase());
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return ids;
}

/**
 * Splits ids into those that need a copy and those already in the base folder,
 * and links the latter so the pipeline picks them up. Linking is skipped while
 * a cycle runs — that cycle's own Discover does the same thing.
 */
export async function splitByBaseFolder(projectIds: string[]): Promise<{
  toQueue: string[];
  alreadyThere: string[];
}> {
  if (!projectIds.length) return { toQueue: [], alreadyThere: [] };
  const present = await projectIdsInBaseFolder();
  const toQueue: string[] = [];
  const alreadyThere: string[] = [];
  for (const id of projectIds) {
    (present.has(id.trim().toUpperCase()) ? alreadyThere : toQueue).push(id);
  }
  if (alreadyThere.length && !isAutoCycleRunning()) {
    await discoverAndAddProjectFromDrive(baseFolderUrl());
  }
  return { toQueue, alreadyThere };
}

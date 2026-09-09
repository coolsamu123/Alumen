import { NextRequest, NextResponse } from 'next/server';
import { fetchSheetCsv } from '@/lib/sheets-engine';
import { parse } from 'csv-parse/sync';
import { getDb } from '@/lib/db';
import { normalizeProjectId } from '@/lib/project-id';

/** Merge all sheet rows into the projects table (non-empty values win). */
function syncSheetToProjects(db: ReturnType<typeof getDb>, records: Record<string, string>[]): number {
  const grouped = new Map<string, Record<string, string>[]>();
  for (const row of records) {
    const rawId = row['Project # in ServiceNow'] || row['Project ID'] || row['project_id'];
    if (!rawId) continue;
    // Canonicalise rather than testing the prefix by hand: this accepts PGM
    // and INI alongside PRJ, and — more importantly — pads the digits the way
    // the Excel importer already does (excel-parser.ts), so a sheet writing
    // "PRJ12345" updates PRJ0012345 instead of inserting a second row for the
    // same project.
    const projectId = normalizeProjectId(rawId);
    if (!projectId) continue;
    if (!grouped.has(projectId)) grouped.set(projectId, []);
    grouped.get(projectId)!.push(row);
  }

  const update = db.prepare(`
    UPDATE projects SET name=?, dds=?, gate=?, description=?, review_date=?, decision=?, batch_id=?
    WHERE project_id=?
  `);
  const insert = db.prepare(`
    INSERT INTO projects (project_id, name, dds, gate, description, review_date, decision, batch_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const exists = db.prepare(`SELECT id FROM projects WHERE project_id=?`);

  let count = 0;
  db.transaction(() => {
    for (const [projectId, rows] of grouped) {
      let name = '', dds = '', gate = '', desc = '', reviewDate = '', decision = '', batchId = '';
      for (const row of rows) {
        const rName = String(row['Project Name'] || row['name'] || '').trim();
        const rDds = String(row['Multi-Cluster'] || row['Region'] || row['dds'] || '').trim();
        const rGate = String(row['Gate'] || row['gate'] || '').trim();
        const rDesc = String(row['Short Desc'] || row['description'] || '').trim();
        const rDate = String(row['Internal review date'] || row['review_date'] || '').trim();
        const rDecision = String(row['CDIOO Decision'] || row['decision'] || '').trim();
        const rBatch = String(row['CDIOO Period'] || row['batch_id'] || '').trim();
        if (rName) name = rName;
        if (rDds) dds = rDds;
        if (rGate) gate = rGate;
        if (rDesc) desc = rDesc;
        if (rDate) reviewDate = rDate;
        if (rDecision) decision = rDecision;
        if (rBatch) batchId = rBatch;
      }
      if (exists.get(projectId)) {
        update.run(name, dds, gate, desc, reviewDate, decision, batchId, projectId);
      } else {
        insert.run(projectId, name, dds, gate, desc, reviewDate, decision, batchId);
      }
      count++;
    }
  })();
  return count;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { url, action } = body;

    if (!url) {
      return NextResponse.json({ success: false, error: 'URL is required' }, { status: 400 });
    }

    // Extract Sheet ID
    const idMatch = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (!idMatch) {
      return NextResponse.json({ success: false, error: 'Invalid Google Sheets URL: missing sheet ID' }, { status: 400 });
    }
    const sheetId = idMatch[1];

    // Extract GID (tab ID)
    const gidMatch = url.match(/[#&?]gid=([0-9]+)/);
    const gid = gidMatch ? gidMatch[1] : '0';

    const csvContent = await fetchSheetCsv(sheetId, gid);
    
    // Parse CSV
    const records = parse(csvContent, {
      from_line: 2,
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
    }) as Record<string, string>[];

    if (action === 'load_table') {
      const db = getDb();

      const headers = records.length > 0 ? Object.keys(records[0]) : [];

      db.transaction(() => {
        db.prepare('DELETE FROM drive_sheet_rows').run();
        db.prepare('DELETE FROM drive_sheet_meta').run();

        db.prepare(`
          INSERT INTO drive_sheet_meta (id, sheet_id, gid, source_url, headers_json, row_count, loaded_at)
          VALUES (1, ?, ?, ?, ?, ?, datetime('now'))
        `).run(sheetId, gid, url, JSON.stringify(headers), records.length);

        const insertRow = db.prepare(
          'INSERT INTO drive_sheet_rows (row_index, data_json) VALUES (?, ?)'
        );
        records.forEach((row, i) => insertRow.run(i, JSON.stringify(row)));
      })();

      // Auto-sync sheet data into projects table so gate/dds/decision are always up to date
      const syncCount = syncSheetToProjects(db, records);

      return NextResponse.json({
        success: true,
        headers,
        rows: records,
        rowCount: records.length,
        syncedProjects: syncCount,
        sourceUrl: url,
        loadedAt: new Date().toISOString(),
      });
    }

    if (action === 'save') {
      const db = getDb();
      const importedCount = syncSheetToProjects(db, records);
      return NextResponse.json({ success: true, importedCount, message: `Successfully imported ${importedCount} projects to the database.` });
    }

    return NextResponse.json({ success: true, data: records });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: errorMsg }, { status: 400 });
  }
}

export async function GET() {
  try {
    const db = getDb();
    const meta = db.prepare('SELECT * FROM drive_sheet_meta WHERE id = 1').get() as
      | { sheet_id: string; gid: string; source_url: string; headers_json: string; row_count: number; loaded_at: string }
      | undefined;

    if (!meta) {
      return NextResponse.json({ success: true, loaded: false });
    }

    const rows = db.prepare('SELECT data_json FROM drive_sheet_rows ORDER BY row_index ASC').all() as { data_json: string }[];

    return NextResponse.json({
      success: true,
      loaded: true,
      sourceUrl: meta.source_url,
      sheetId: meta.sheet_id,
      gid: meta.gid,
      headers: JSON.parse(meta.headers_json) as string[],
      rows: rows.map(r => JSON.parse(r.data_json) as Record<string, string>),
      rowCount: meta.row_count,
      loadedAt: meta.loaded_at,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: errorMsg }, { status: 500 });
  }
}

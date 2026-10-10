/**
 * "Generate report" (Details › project panel): one Google Doc per project in
 * Shared Drive "Alumen" › reports.
 *
 * Built from what Alumen already holds — the CDIO row, the goals extraction,
 * the planning result and the impact graph — so it takes seconds and makes no
 * LLM call. Generating again replaces the same Doc (Drive keeps the earlier
 * versions in its history); the Doc is found by the `alumenProject` app
 * property, so renaming it in Drive does not break the link.
 *
 * The Doc is written by uploading HTML with a Google Docs target mimeType:
 * Drive converts it. That needs only the Drive API (the Docs API is not
 * enabled for the service account, same as Sheets), and keeps inline styles on
 * tables, cells and spans.
 */
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { google } from 'googleapis';
import { getDb } from './db';
import { baseFolderId } from './auto-pipeline';
import type { VisibleProjectIds } from './access';

const SERVICE_ACCOUNT_PATH = path.join(process.cwd(), 'data', 'service-account.json');
const FOLDER_SETTING = 'reports_folder_id';
const FOLDER_NAME = 'reports';
const DOC_MIME = 'application/vnd.google-apps.document';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface ReportResult {
  url: string;
  replaced: boolean;
  generatedAt: string;
  generatedBy: string;
}

/** The project's last generated report, as recorded here (no Drive call). */
export function getProjectReport(projectId: string): Omit<ReportResult, 'replaced'> | null {
  const row = getDb().prepare('SELECT url, generated_at, generated_by FROM project_reports WHERE project_id = ?')
    .get(projectId) as { url: string; generated_at: string; generated_by: string } | undefined;
  return row ? { url: row.url, generatedAt: row.generated_at, generatedBy: row.generated_by ?? '' } : null;
}

// ─── Data ───────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

interface Gate { gate?: string; date?: string | null; decision?: string | null; note?: string | null }
interface Action { title?: string; owner?: string | null; status?: string | null }
interface Financials { capex_keur?: number | null; opex_keur?: number | null; total_keur?: number | null; funding_entity?: string | null; notes?: string | null }
interface Timeline { gate2_target?: string; go_live_target?: string; blocked_by?: string[] }

function json<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

interface ImpactLine {
  label: string;
  sublabel: string;
  types: string[];
  severity: string;
  why: string;
}

const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/**
 * Impacts in both directions, one line per counterpart. The engine stores one
 * row per (counterpart, type, entity), so the same project shows up three or
 * four times with the same sentence; the report merges them. Rows whose
 * counterpart is DDS_IMPACTS / GIO_SERVICES are impacts on an organisation,
 * named by their entity list.
 */
function loadImpacts(projectId: string, visible: VisibleProjectIds) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT source_project_id s, target_project_id t, impact_type, severity, explanation, dds_entities, gio_services
    FROM projects_impact
    WHERE (source_project_id = ? OR target_project_id = ?) AND output_language = 'en'
  `).all(projectId, projectId) as Row[];
  const nameOf = db.prepare('SELECT name FROM projects WHERE project_id = ? LIMIT 1');

  const entities = new Map<string, ImpactLine>();
  const projects = new Map<string, ImpactLine>();
  for (const r of rows) {
    const other = s(r.s) === projectId ? s(r.t) : s(r.s);
    const isEntity = /^(DDS_IMPACTS|GIO_SERVICES)$/.test(other);
    let key: string;
    let label: string;
    let sublabel = '';
    if (isEntity) {
      const dds = json<string[]>(r.dds_entities, []);
      const gio = json<string[]>(r.gio_services, []);
      label = dds.length ? `DDS · ${dds.join(', ')}` : gio.length ? `GIO · ${gio.join(', ')}` : other.startsWith('DDS') ? 'DDS' : 'GIO';
      key = label;
    } else {
      // A basic user sees only their projects; don't name the others.
      if (visible !== 'ALL' && !visible.has(other)) continue;
      label = other;
      sublabel = s((nameOf.get(other) as Row | undefined)?.name);
      key = other;
    }
    const map = isEntity ? entities : projects;
    const type = s(r.impact_type).replace(/_/g, ' ');
    const sev = s(r.severity).toLowerCase();
    const cur = map.get(key);
    if (!cur) {
      map.set(key, { label, sublabel, types: [type], severity: sev, why: s(r.explanation) });
      continue;
    }
    if (!cur.types.includes(type)) cur.types.push(type);
    if ((SEVERITY_RANK[sev] ?? 3) < (SEVERITY_RANK[cur.severity] ?? 3)) {
      cur.severity = sev;
      cur.why = s(r.explanation);
    }
  }
  const order = (a: ImpactLine, b: ImpactLine) =>
    (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) || a.label.localeCompare(b.label);
  return {
    entities: Array.from(entities.values()).sort(order),
    projects: Array.from(projects.values()).sort(order),
  };
}

// ─── HTML ───────────────────────────────────────────────────────────────────

const C = {
  ink: '#202124', muted: '#5f6368', line: '#dadce0', head: '#f1f3f4', tile: '#e8f0fe',
  brand: '#0b5394', high: '#c5221f', medium: '#b06000', low: '#188038',
};
const TD = `border:1px solid ${C.line};padding:5px 8px;vertical-align:top;font-size:10pt`;
const TH = `border:1px solid ${C.line};padding:5px 8px;background:${C.head};font-size:10pt;text-align:left`;

const esc = (v: unknown) => s(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const DASH = `<span style="color:#9aa0a6">—</span>`;
const val = (v: unknown) => (s(v) ? esc(v) : DASH);
const chips = (a: string[]) => (a.length ? a.map(esc).join(' · ') : DASH);
const keur = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? `${v.toLocaleString('en-US')} k€` : '');
const link = (url: string, text: string) => `<a href="${esc(url)}">${esc(text)}</a>`;

function kv(rows: Array<[string, string]>): string {
  return `<table style="border-collapse:collapse;width:100%">${rows.map(([k, v]) =>
    `<tr><td style="${TD};background:${C.head};font-weight:bold;width:32%">${esc(k)}</td><td style="${TD}">${v}</td></tr>`,
  ).join('')}</table>`;
}

function grid(heads: string[], widths: number[], rows: string[][]): string {
  return `<table style="border-collapse:collapse;width:100%"><tr>${heads.map((h, i) =>
    `<th style="${TH};width:${widths[i]}%">${esc(h)}</th>`).join('')}</tr>${rows.map(r =>
    `<tr>${r.map(c => `<td style="${TD}">${c}</td>`).join('')}</tr>`).join('')}</table>`;
}

const h2 = (n: number, t: string) => `<h2 style="color:${C.brand};font-size:14pt;margin-top:18pt">${n}. ${esc(t)}</h2>`;
const h3 = (t: string) => `<p style="font-size:10pt;margin-top:10pt"><b>${esc(t)}</b></p>`;
const para = (t: unknown) => `<p style="font-size:10.5pt">${val(t)}</p>`;
const note = (t: string) => `<p style="font-size:9pt;color:${C.muted}">${t}</p>`;
const bullets = (items: string[]) => (items.length ? `<ul>${items.map(x => `<li style="font-size:10pt">${x}</li>`).join('')}</ul>` : para(''));
const sev = (v: string) => `<span style="color:${C[v as 'high' | 'medium' | 'low'] ?? C.muted};font-weight:bold">${esc(v.toUpperCase())}</span>`;
const tile = (label: string, body: string) =>
  `<td style="border:1px solid ${C.line};padding:8px;background:${C.tile};width:25%"><span style="font-size:8pt;color:${C.muted}">${esc(label)}</span><br><b style="font-size:13pt">${body}</b></td>`;

const MAX_PROJECT_IMPACTS = 15;

export function buildReportHtml(projectId: string, visible: VisibleProjectIds, today: string): { html: string; name: string } {
  const db = getDb();
  const p = db.prepare('SELECT * FROM projects WHERE project_id = ? ORDER BY id DESC LIMIT 1').get(projectId) as Row | undefined;
  if (!p) throw new Error(`Project ${projectId} not found`);
  const g = (db.prepare("SELECT * FROM project_goals WHERE project_id = ? AND status = 'success' ORDER BY analyzed_at DESC LIMIT 1").get(projectId) ?? {}) as Row;
  const planRow = db.prepare("SELECT response_json FROM project_planning WHERE project_id = ? AND output_language = 'en'").get(projectId) as Row | undefined;
  const plan = json<{ gates?: Gate[]; actions?: Action[]; financials?: Financials }>(planRow?.response_json, {});
  const fin = plan.financials ?? {};
  const tl = json<Timeline>(g.timeline_struct, {});
  const docs = (db.prepare(`
    SELECT DISTINCT file_name FROM documents_cache
    WHERE project_id = ? AND fetch_status = 'success' AND file_name <> '' ORDER BY file_name
  `).all(projectId) as Row[]).map(r => s(r.file_name));
  const up = Object.fromEntries((db.prepare('SELECT stage, status FROM upstream_status WHERE project_id = ?').all(projectId) as Row[])
    .map(r => [s(r.stage), s(r.status)]));
  const dives = db.prepare("SELECT kind, target, response_md FROM impact_deep_dives WHERE project_id = ? AND output_language = 'en'").all(projectId) as Row[];
  const impacts = loadImpacts(projectId, visible);

  const name = s(p.name) || projectId;
  const totalK = fin.total_keur ?? (p.cost_keur as number | null);
  const highCount = [...impacts.entities, ...impacts.projects].filter(i => i.severity === 'high').length;
  const otherCount = impacts.entities.length + impacts.projects.length - highCount;

  // Gate 2: the goals pass reads the newest documents, the planning pass may be
  // older. Show the newest as the milestone; flag the disagreement in the table.
  const gates = plan.gates ?? [];
  const planG2 = s(gates.find(x => s(x.gate) === '2')?.date);
  const nextMilestone = s(tl.gate2_target) || planG2;

  const folders = s(p.link_folder).split(/\s+/).filter(Boolean);
  const done = (v: string | undefined) => (v === 'DONE' ? '✔' : v ? v.toLowerCase() : '—');

  const html = `<html><head><meta charset="utf-8"></head><body style="font-family:Arial;color:${C.ink}">
<table style="border-collapse:collapse;width:100%"><tr>
<td style="border:none;padding:0;font-size:9pt;color:${C.muted}">ALUMEN · PROJECT REPORT · INTERNAL</td>
<td style="border:none;padding:0;text-align:right;font-size:11pt;font-weight:bold;color:${C.brand}">AIR LIQUIDE</td>
</tr></table>
<h1 style="font-size:20pt;margin-bottom:2pt">${esc(name)}</h1>
<p style="font-size:11pt;color:${C.muted};margin-top:0">${esc(projectId)}${s(p.dds) ? ` · ${esc(p.dds)}` : ''}${s(p.gate) ? ` · Gate ${esc(p.gate)}` : ''} · Generated ${today}</p>

<table style="border-collapse:collapse;width:100%"><tr>
${tile('CDIO DECISION', val(p.decision))}
${tile('TOTAL COST', val(keur(totalK)))}
${tile('NEXT MILESTONE', nextMilestone ? `Gate 2 · ${esc(nextMilestone)}` : DASH)}
${tile('CROSS-PROJECT IMPACTS', `<span style="color:${C.high}">${highCount} high</span> · ${otherCount} other`)}
</tr></table>

${h2(1, 'Executive summary')}
<p style="font-size:11pt"><b>${val(g.summary_one_line)}</b></p>
${para(p.description)}

${h2(2, 'Project identification')}
${kv([
  ['Project # in ServiceNow', esc(projectId)],
  ['Project name', val(name)],
  ['Perimeter (Multi-Cluster)', val(p.dds)],
  ['Gate', val(p.gate)],
  ['CDIO review date', val(p.review_date)],
  ['CDIO decision', val(p.decision)],
  ['Link to CDIO positions', s(p.link_positions) ? link(s(p.link_positions), 'CDIO position') : DASH],
])}

${h2(3, 'Financials')}
${kv([
  ['Capex', val(keur(fin.capex_keur))],
  ['Opex', val(keur(fin.opex_keur))],
  ['Total (Capex & Opex)', `<b>${val(keur(totalK))}</b>`],
  ['Capex & Opex hosted by', val(fin.funding_entity)],
  ['DDS / GIO workload', val(g.dds_gio_workload)],
  ['Notes', val(fin.notes)],
])}

${h2(4, 'Timeline and governance')}
${gates.length ? grid(['Gate', 'Date', 'Decision', 'Note'], [10, 20, 20, 50], gates.map(x => {
  const conflict = s(x.gate) === '2' && s(tl.gate2_target) && planG2 && s(tl.gate2_target) !== planG2;
  return [esc(x.gate), val(x.date), val(x.decision),
    val(x.note) + (conflict ? `<br><span style="color:${C.medium}">Latest documents say ${esc(tl.gate2_target)}.</span>` : '')];
})) : para('')}
<p style="font-size:10pt;margin-top:8pt"><b>Go-live target:</b> ${val(tl.go_live_target)} &nbsp;·&nbsp; <b>Blocked by:</b> ${chips(tl.blocked_by ?? [])}</p>
${h3('Open actions')}
${bullets((plan.actions ?? []).filter(a => s(a.status).toLowerCase() !== 'done').map(a =>
  `${esc(a.title)} <span style="color:${C.muted}">(${esc(a.status || 'open')}${s(a.owner) ? `, ${esc(a.owner)}` : ''})</span>`))}

${h2(5, 'Scope and solution')}
${kv([
  ['Digital technologies', val(g.digital_technologies)],
  ['Business apps / CIs', val(g.business_apps_cis)],
  ['Vendors', chips(json<string[]>(g.vendors, []))],
  ['Technology tags', chips(json<string[]>(g.tech_tags, []))],
])}
${h3('Out of scope')}
${bullets(json<Array<{ topic?: string }>>(g.out_of_scope, []).map(o => esc(o.topic)).filter(Boolean))}

${h2(6, 'Risk, security and AI')}
${kv([
  ['Security impacts', val(g.security_impacts)],
  ['Data classifications', chips(json<string[]>(g.data_classifications, []))],
  ['AI embedded', s(g.ia_embedded_status) || s(g.ia_embedded) ? `<b>${val(g.ia_embedded_status)}</b> — ${val(g.ia_embedded)}` : DASH],
])}

${h2(7, 'Organisation and change')}
${kv([
  ['DDS entities involved', chips(json<string[]>(g.dds_entities_touched, []))],
  ['GIO services involved', chips(json<string[]>(g.gio_services_touched, []))],
  ['Regional impacts', val(g.regional_impacts)],
  ['GIO / SL / DDS impacts', val(g.gio_sl_dds_impacts)],
  ['Change management', val(g.change_management)],
])}

${h2(8, 'Impacts')}
${note(`Found by Alumen in the project documents. High severity first.`)}
${h3('On DDS entities and GIO services')}
${impacts.entities.length
  ? grid(['Impacted', 'Type', 'Severity', 'Why'], [22, 16, 12, 50], impacts.entities.map(i =>
    [`<b>${esc(i.label)}</b>`, esc(i.types.join(', ')), sev(i.severity), val(i.why)]))
  : para('')}
${h3('On other projects')}
${impacts.projects.length
  ? grid(['Related project', 'Type', 'Severity', 'Why'], [22, 16, 12, 50], impacts.projects.slice(0, MAX_PROJECT_IMPACTS).map(i =>
    [`<b>${esc(i.label)}</b>${i.sublabel ? `<br><span style="color:${C.muted}">${esc(i.sublabel)}</span>` : ''}`,
      esc(i.types.join(', ')), sev(i.severity), val(i.why)]))
  : para('')}
${impacts.projects.length > MAX_PROJECT_IMPACTS ? note(`+ ${impacts.projects.length - MAX_PROJECT_IMPACTS} more in Alumen › Impact.`) : ''}
${dives.length ? h3('Deep dives') + bullets(dives.map(d => {
  const first = s(d.response_md).split('\n').find(l => l.trim() && !l.startsWith('#') && !l.startsWith('_')) ?? '';
  return `<b>${esc(s(d.kind).toUpperCase())} · ${esc(d.target)}:</b> ${esc(first.slice(0, 400))}`;
})) : ''}

${h2(9, 'CDIO comments')}
${s(p.remarks) ? s(p.remarks).split('\n').map(para).join('') : para('')}

${h2(10, 'Sources')}
${kv([
  ['CDIO folder', folders.length ? folders.map((u, i) => link(u, `Folder ${i + 1}`)).join(' · ') : DASH],
  ['Alumen pipeline', `copy ${done(up.copy)} · cleanup ${done(up.cleanup)} · documents ${docs.length} · goals ${s(g.analyzed_at) ? `✔ ${esc(s(g.analyzed_at).slice(0, 10))}` : '—'} · impact ${impacts.entities.length + impacts.projects.length ? '✔' : '—'}`],
])}
${h3(`Documents analysed (${docs.length})`)}
${bullets(docs.map(esc))}

<p style="font-size:8pt;color:${C.muted};margin-top:18pt">Generated by Alumen from the CDIO sheet and the project documents in Drive. Fields marked — were not found in either source. Sections 1 and 3–8 are extracted by AI from the documents; check them against the sources before quoting.</p>
</body></html>`;

  return { html, name: `${projectId} - ${name} - Report` };
}

// ─── Drive ──────────────────────────────────────────────────────────────────

function driveClient() {
  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    throw new Error('Service account key not found at data/service-account.json');
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_PATH,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

type Drive = ReturnType<typeof driveClient>;

function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value?: string } | undefined;
  return row?.value?.trim() || null;
}

function setSetting(key: string, value: string): void {
  getDb().prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value);
}

/** Shared Drive root › "reports" — the Shared Drive is the one holding the base folder. */
async function reportsFolderId(drive: Drive): Promise<string> {
  const cached = getSetting(FOLDER_SETTING);
  if (cached) {
    try {
      const f = await drive.files.get({ fileId: cached, fields: 'id,trashed', supportsAllDrives: true });
      if (!f.data.trashed) return cached;
    } catch { /* deleted or moved out of reach — find or create it again */ }
  }
  const base = await drive.files.get({ fileId: baseFolderId(), fields: 'driveId', supportsAllDrives: true });
  const driveId = base.data.driveId;
  if (!driveId) throw new Error('The base folder is not in a Shared Drive; cannot place the reports folder');

  const found = await drive.files.list({
    q: `'${driveId}' in parents and name = '${FOLDER_NAME}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
    corpora: 'drive', driveId, includeItemsFromAllDrives: true, supportsAllDrives: true, fields: 'files(id)',
  });
  let id = found.data.files?.[0]?.id ?? null;
  if (!id) {
    const created = await drive.files.create({
      requestBody: { name: FOLDER_NAME, mimeType: FOLDER_MIME, parents: [driveId] },
      supportsAllDrives: true, fields: 'id',
    });
    id = created.data.id ?? null;
  }
  if (!id) throw new Error('Could not create the reports folder');
  setSetting(FOLDER_SETTING, id);
  return id;
}

/** Escapes a value for a single-quoted Drive query string. */
const driveQuoted = (v: string) => v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const inFlight = new Set<string>();

export async function generateProjectReport(projectId: string, visible: VisibleProjectIds, generatedBy: string): Promise<ReportResult> {
  if (inFlight.has(projectId)) throw new Error('A report for this project is already being generated');
  inFlight.add(projectId);
  try {
    const generatedAt = new Date().toISOString();
    const { html, name } = buildReportHtml(projectId, visible, generatedAt.slice(0, 10));
    const drive = driveClient();
    const folderId = await reportsFolderId(drive);

    const existing = await drive.files.list({
      q: `'${folderId}' in parents and appProperties has { key='alumenProject' and value='${driveQuoted(projectId)}' } and trashed = false`,
      includeItemsFromAllDrives: true, supportsAllDrives: true, fields: 'files(id)',
    });
    const media = { mimeType: 'text/html', body: Readable.from([html]) };
    const fileId = existing.data.files?.[0]?.id;

    const res = fileId
      ? await drive.files.update({
        fileId, media, supportsAllDrives: true, fields: 'id,webViewLink',
        requestBody: { name },
      })
      : await drive.files.create({
        media, supportsAllDrives: true, fields: 'id,webViewLink',
        requestBody: { name, mimeType: DOC_MIME, parents: [folderId], appProperties: { alumenProject: projectId } },
      });
    const url = res.data.webViewLink;
    if (!url || !res.data.id) throw new Error('Drive did not return a link for the report');
    getDb().prepare(`
      INSERT INTO project_reports (project_id, file_id, url, generated_at, generated_by) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET file_id = excluded.file_id, url = excluded.url,
        generated_at = excluded.generated_at, generated_by = excluded.generated_by
    `).run(projectId, res.data.id, url, generatedAt, generatedBy);
    console.log(`[report] ${fileId ? 'replaced' : 'created'} ${projectId}`);
    return { url, replaced: Boolean(fileId), generatedAt, generatedBy };
  } finally {
    inFlight.delete(projectId);
  }
}

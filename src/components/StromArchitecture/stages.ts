// Single source of truth for the Strom Pipeline Architecture view.
// Each entry is a node on the canvas. The canvas layout, side panel
// content, and example renderer all read from this declarative table.
//
// Adding a new pipeline step = adding an entry here (and a sample in
// samples.ts if you want input/output examples).
//
// Layout: nodes are positioned vertically (top → down) based on `row`.
// Same-row nodes are spread horizontally based on `col`. Edges are
// declared explicitly to keep cross-flow lines (e.g. catalog feeding two
// LLM stages) deterministic.

export type StageType =
  | 'manual'      // Human-initiated upload / click
  | 'drive'       // Google Drive I/O
  | 'hygiene'     // Pure validation / dedupe
  | 'parse'       // File parsing (text extraction)
  | 'llm'         // Gemini call
  | 'sanitize'    // Validator + DB upsert
  | 'aggregate'   // API-time enrichment / aggregation
  | 'store'       // DB table
  | 'external';   // External system (Drive, Gemini, Excel)

export interface StageDef {
  id: string;
  type: StageType;
  // Visual position on the canvas grid
  row: number;
  col: number;           // 0..2 (left | center | right)
  // Display
  icon: string;          // emoji
  name: string;
  subtitle?: string;     // 1-line under name (e.g. "Gemini 2.0 Flash")
  // Source pointers (file:line for "View source" link)
  source?: string;
  // Optional code/prompt key that maps to a prompt editor or query view
  promptKey?: 'goals' | 'impact' | 'deep-dive';
  // Trigger API endpoint (when this stage is user-runnable)
  trigger?: {
    label: string;
    method: 'POST' | 'GET';
    url: string;
    body?: Record<string, unknown>;
    note?: string;
  };
  // Typical latency, qualitative
  latency?: string;
  // Short one-line description (shown on Overview tab)
  blurb: string;
  // Rich narrative for the Overview tab. All sub-fields optional — each
  // populated one renders as a labelled section.
  details?: {
    whatItDoes?: string;            // 1-2 paragraphs in plain language
    whyItExists?: string;           // motivation / problem it solves
    howItWorks?: string[];          // bulleted concrete steps
    failureModes?: string[];        // common gotchas
    relatedStages?: string[];       // id refs into STAGES
  };
  // What feeds this stage (just for the Inputs tab — edges are declared
  // separately to keep visual decisions independent).
  inputs: { name: string; type: string; origin: string; example?: string }[];
  // What this stage produces (Output tab).
  outputSchema: string;        // 1-line type/schema description
  outputExampleKey?: string;   // key into samples.ts (matches an exported sample)
}

export interface EdgeDef {
  id: string;
  source: string;
  target: string;
  label?: string;
  /** Optional: dotted line, used for "control" edges vs data edges. */
  dashed?: boolean;
}

// ─── Stages ─────────────────────────────────────────────────────────────────

export const STAGES: StageDef[] = [
  // Row 0: External sources (top)
  {
    id: 'ext-excel',
    type: 'external',
    row: 0, col: 0,
    icon: '📊',
    name: 'CDIO Gating Excel',
    subtitle: 'Pre-review .xlsx (drag-and-drop)',
    blurb: 'Quarterly portfolio sheet from CDIO governance committee.',
    details: {
      whatItDoes: 'The authoritative source for the project portfolio at Air Liquide. Each quarter the CDIO governance committee publishes an Excel sheet listing every project under review, with metadata (DDS, gate, decision, cost, link to Drive folder) per row. Alumen ingests this file as the master list — everything downstream keys off of `project_id` populated here.',
      whyItExists: 'Without a stable, human-curated portfolio list, Alumen would have to discover projects purely from Drive folder names — which is noisy and inconsistent. The Excel is the system of record for "which projects exist this quarter".',
      howItWorks: [
        'User exports the "CDIO internal committee" sheet as .xlsx',
        'Drag-and-drops into the Drive Sync screen',
        'Server parses with the `xlsx` package, validates required columns',
        'Rows upsert into the `projects` table keyed by `project_id`',
      ],
      failureModes: [
        'Empty Project ID column → row silently skipped',
        'Renamed sheet tab → upload fails (looks for "CDIO internal committee" by name)',
        'Same project across multiple uploads → metadata gets overwritten by latest',
      ],
      relatedStages: ['s0-upload', 'store-projects'],
    },
    inputs: [],
    outputSchema: 'multipart/form-data file (.xlsx)',
    outputExampleKey: 'excel-row',
  },
  {
    id: 'ext-drive-root',
    type: 'external',
    row: 0, col: 1,
    icon: '☁️',
    name: 'Google Drive root',
    subtitle: 'Folder shared with service account',
    blurb: 'Top-level folder containing 244+ PRJ subfolders.',
    details: {
      whatItDoes: 'A single Google Drive folder shared with the Alumen service account, containing one subfolder per project (named `PRJxxxxxxx` or `PGMxxxxxxx`). Alumen never browses arbitrary parts of Drive — it scans only this configured root and its immediate children.',
      whyItExists: 'Concentrating all project material under one parent folder lets the service account have minimum-scope access (just one folder shared, not the whole Drive) AND lets discovery be a single API call instead of a global search.',
      howItWorks: [
        'Service account email is shared as Viewer on the root folder by a human admin',
        'Root URL stored in `app_settings.discovery_root` (key-value table)',
        'Discovery uses `drive.files.list` with `q: "<rootId>" in parents`',
        'Each child folder name is matched against `^(PRJ|PGM)\\d+` to link to a project',
      ],
      failureModes: [
        'Service account loses access (e.g., admin revoked share) → 403 on every list',
        'New project folder created but admin forgot to re-share → invisible to Alumen',
        'Folder named without PRJ/PGM prefix → ignored by the regex',
      ],
      relatedStages: ['s1-discovery', 's2-download'],
    },
    inputs: [
      { name: 'service-account.json', type: 'file', origin: '/opt/strom/data/', example: 'al-bco-e9997-talend-etl@…iam.gserviceaccount.com' },
      { name: 'app_settings.discovery_root', type: 'url', origin: 'SQLite', example: 'https://drive.google.com/drive/folders/1IathIq…' },
    ],
    outputSchema: 'List<{ id, name }> via Drive API',
    outputExampleKey: 'drive-root-listing',
  },
  {
    id: 'ext-target-catalog',
    type: 'external',
    row: 0, col: 2,
    icon: '🗂️',
    name: 'Target Catalog',
    subtitle: 'Canonical GIO + DDS taxonomy',
    source: 'src/lib/target-catalog.ts',
    blurb: '5 GIO Service Lines + ~20 DDS Entities with descriptions, typical roles, typical impact types.',
    details: {
      whatItDoes: 'Defines the controlled vocabulary Alumen uses for GIO Service Lines (5 entries) and DDS Entities (~20). Each entry has a canonical `name`, a `description` paragraph (used by LLM prompts to ground reasoning), and optional bias hints (`typicalRoles`, `typicalImpactTypes`) that nudge the LLM toward expected categorisations.',
      whyItExists: 'Without canonical names the LLM would invent variants ("Cyber Sec", "SecComp", "Security & Compliance Service") that cross-project aggregation cannot match. With the catalog, every prompt is told exactly which strings are valid AND every emitted value is validated against the list before storage.',
      howItWorks: [
        '`isCanonicalTarget(kind, target)` rejects LLM output that names a target outside the list',
        '`getTargetDefinition(kind, target)` returns the description, injected into Deep Dive prompts',
        '`getTargetEntry(kind, target)` returns the full entry including bias hints — not wired into any prompt yet (the Goals prompt only sees target names)',
        'TypeScript-only — no DB, no runtime config. Changes require a code deploy',
      ],
      failureModes: [
        'New GIO/DDS entity exists in real life but not in the catalog → LLM gets confused, picks closest mismatch',
        'A `typicalRole` set too narrowly biases LLM into wrong classifications',
        'Renaming an entity here invalidates all impact rows that reference the old name (no rename migration)',
      ],
      relatedStages: ['s5-goals-llm', 's7-impact-llm', 's8-deepdive'],
    },
    inputs: [],
    outputSchema: '{ name, description, typicalRoles[], typicalImpactTypes[] }',
    outputExampleKey: 'target-catalog-entry',
  },

  // Row 1: Upload + Discovery
  {
    id: 's0-upload',
    type: 'manual',
    row: 1, col: 0,
    icon: '⬆️',
    name: 'Excel Upload',
    subtitle: 'POST /api/projects/upload',
    source: 'src/app/api/projects/upload/route.ts',
    blurb: 'Parses the CDIO Gating .xlsx, upserts project rows.',
    latency: '~2s for 250 rows',
    details: {
      whatItDoes: 'Endpoint that receives a multipart .xlsx upload from the Drive Sync screen, parses every row of the "CDIO internal committee" sheet, and persists each row as a project. Existing projects (matched by `project_id`) get their metadata updated; new ones are created.',
      whyItExists: 'The Excel is the human-curated source of truth — the upload endpoint is the single point of entry that keeps the `projects` table in sync. No other path creates project rows except this one (and the `createMissing` flag in Drive Discovery, which is now disabled by default).',
      howItWorks: [
        'Server reads multipart body via `formidable` / built-in Next parser',
        'Loads the .xlsx into memory with the `xlsx` package',
        'Iterates rows, normalises column names, validates `Project ID` is present',
        'For each row: UPSERT projects with the new metadata + a fresh `batch_id`',
        'Returns a summary `{ created, updated, skipped }`',
      ],
      failureModes: [
        'File > 100MB rejected (nginx `client_max_body_size`)',
        'Missing "Project ID" column → row skipped silently, counted as `skipped`',
        'Date column in unexpected format → review_date stored as empty string',
      ],
      relatedStages: ['ext-excel', 'store-projects'],
    },
    inputs: [
      { name: 'file', type: 'multipart .xlsx', origin: 'Excel Upload card in Drive Sync' },
    ],
    outputSchema: 'INSERT/UPDATE → projects table',
    outputExampleKey: 'projects-row',
  },
  {
    id: 's1-discovery',
    type: 'drive',
    row: 1, col: 1,
    icon: '🔭',
    name: 'Drive Discovery',
    subtitle: 'discoverAndAddProjectFromDrive',
    source: 'src/lib/drive-engine.ts:508',
    blurb: 'Lists every subfolder of root, matches PRJ pattern, attaches link_folder to existing projects.',
    latency: '~30s for 244 folders',
    details: {
      whatItDoes: 'Crawls the Drive root, finds every subfolder whose name starts with a project prefix (PRJ or PGM followed by digits), and updates the matching project row with the folder URL. Crucial because the Excel doesn\'t always carry the link — discovery bridges the project_id from the sheet to the actual Drive folder.',
      whyItExists: 'In practice, the CDIO Excel sometimes ships with empty `Link (Folder)` columns. Without discovery, those projects would be invisible to the downloader. Discovery automates the matching step a human would otherwise do by hand for 200+ projects.',
      howItWorks: [
        'Service account lists level-1 children of the discovery_root',
        'For each child, the regex `^(PRJ|PGM)[\\s\\-_]*(\\d+)` extracts the canonical ID',
        'Matches against `projects.project_id` using digit-key (strips zero-padding) so `PRJ001395` casa with `PRJ0001395`',
        'On match: `UPDATE projects SET link_folder = <url>` (appends if there\'s already a URL)',
        'On miss with `createMissing=true`: creates a stub project row. Sync All passes `createMissing=false`',
      ],
      failureModes: [
        'Folder named with weird casing (`prj-1234`) → still works (regex is `/i`)',
        'Folder with two PRJ ids in name (legacy renaming) → matches first one only',
        '`PRJ00XXXXX` placeholder folders → match the regex but no project to link → unmatched',
      ],
      relatedStages: ['ext-drive-root', 'store-projects', 's2-download'],
    },
    inputs: [
      { name: 'discovery_root URL', type: 'string', origin: 'app_settings' },
      { name: 'createMissing', type: 'boolean', origin: 'caller', example: 'false (Sync All) / true (Add a Drive source)' },
    ],
    outputSchema: 'UPDATE projects.link_folder',
    outputExampleKey: 'discovery-result',
  },

  // Row 2: projects store + download
  {
    id: 'store-projects',
    type: 'store',
    row: 2, col: 0,
    icon: '🗄️',
    name: 'projects',
    subtitle: '252 rows · DDS, gate, links',
    blurb: 'Master list of projects, fed by Excel upload and Drive discovery.',
    details: {
      whatItDoes: 'The canonical project registry. Every downstream stage (Download, Goals, Impact, Deep Dive) keys off `project_id` from this table. Carries portfolio metadata (DDS, gate, decision, cost) plus link columns (link_folder / link_positions / link_cioo) that point to Drive material.',
      whyItExists: 'Single source of truth. Splitting projects across many places (Excel + Drive + LLM output) would create inconsistency — this table forces every consumer to agree on which projects exist and how they\'re identified.',
      howItWorks: [
        'Two writers: Excel upload (full metadata) and Drive Discovery (link_folder only)',
        'PK = auto id; unique constraint on `project_id`',
        'Indexed on `project_id`, `dds`, `gate`, `decision`, `batch_id`',
        'Multiple uploads of same project = latest wins (UPSERT semantics)',
      ],
      relatedStages: ['s0-upload', 's1-discovery', 's2-download'],
    },
    inputs: [],
    outputSchema: '252 rows; PK project_id',
    outputExampleKey: 'projects-row',
  },
  {
    id: 's2-download',
    type: 'drive',
    row: 2, col: 1,
    icon: '⬇️',
    name: 'Drive Download',
    subtitle: 'runDriveDownload[Single]',
    source: 'src/lib/drive-engine.ts:613',
    trigger: {
      label: 'Sync a project',
      method: 'POST',
      url: '/api/drive/run',
      body: { mode: 'project', projectId: 'PRJ0021672' },
      note: 'Replace projectId with your target.',
    },
    blurb: 'Walks each folder via Drive API, downloads .txt/.docx/.pdf/.csv into data/drive/<PRJ>/, exports Google Docs as text.',
    latency: '~3-5 min for 95 projects',
    details: {
      whatItDoes: 'For each project with a `link_folder`, recursively walks the Drive folder, downloads every file ≤50MB into the local filesystem (`data/drive/<projectId>/`), and writes a row per file in `documents_cache`. Google Docs are auto-exported as text/plain; PDFs and DOCX kept as binary plus a metadata placeholder.',
      whyItExists: 'The LLM stages need raw text per project. Downloading creates a local mirror so re-running the pipeline doesn\'t re-fetch from Drive every time, and the data persists across restarts.',
      howItWorks: [
        'Three modes: `full` (all projects), `download-only` (skip Goals/Impact stages), `project` (single project by id)',
        'Recurses through subfolders up to depth 5',
        'Per-file: checks if local copy exists; if so, reads from disk (idempotent on rerun)',
        'Otherwise: `drive.files.export` for Google Docs (→ .txt), `drive.files.get` for binaries',
        'Inserts one `documents_cache` row per file, keyed by (project_id, file URL)',
        'Triggers `dedupeProjectDocs` at end of each project to flag duplicates',
      ],
      failureModes: [
        'File > 50MB → returns placeholder text "[File too large]", no download',
        'PDF without text layer → extracted text comes back near-empty (image-only PDF)',
        'Drive 403 (revoked share) → row goes to `fetch_status=error`',
        'Race against another sync running → the second call gets 409',
      ],
      relatedStages: ['store-projects', 's3-hygiene', 'store-docs'],
    },
    inputs: [
      { name: 'projects.link_folder', type: 'url[]', origin: 'projects table' },
      { name: 'file size cap', type: 'bytes', origin: 'constant', example: '50 MB per file' },
    ],
    outputSchema: 'Files in /opt/strom/app/data/drive/<PRJ>/ + rows in documents_cache',
    outputExampleKey: 'documents-cache-row',
  },

  // Row 3: Hygiene + documents_cache
  {
    id: 's3-hygiene',
    type: 'hygiene',
    row: 3, col: 1,
    icon: '🧹',
    name: 'File Hygiene',
    subtitle: 'classify + dedupe',
    source: 'src/lib/file-hygiene.ts',
    blurb: 'Marks deprecated (OLD_VERSION/DO_NOT_USE), cross-PRJ contaminations, and content-hash duplicates so the LLM never sees them.',
    latency: '<100ms post-download',
    details: {
      whatItDoes: 'Stops three classes of noise from polluting the LLM\'s view of each project: (1) explicitly deprecated files (`OLD_VERSION`, `DO_NOT_USE` in name), (2) cross-project contamination (a file named `PRJ0021670_*.txt` accidentally inside `PRJ0021760`\'s folder), and (3) byte-identical duplicates that exist in multiple subfolders (`CIOO-Archiv/` copies of the same Gate Note).',
      whyItExists: 'Audited the corpus and found ~50% of `documents_cache` rows were noise: deprecated versions, cross-project leakage, and exact duplicates. Sending all of them to the LLM cost tokens, polluted citations, and skewed analysis. This stage runs purely on data already in the DB — no LLM, no network.',
      howItWorks: [
        '`classifyFile(projectId, fileName)` returns `{ keep: true }` or `{ keep: false, reason }` based on regex (deprecated terms) and digit-key match (cross-PRJ)',
        'Called BEFORE download for cheap rejection (no API cost for files we\'ll skip)',
        '`dedupeProjectDocs(projectId)` runs after each project finishes downloading: groups rows by sha256 of `content_text`, keeps the one with shortest file_name, marks others as `skipped_duplicate`',
        'Skipped rows stay in the table for audit, but `getProjectDocuments()` filters them out (`fetch_status NOT LIKE skipped_%`)',
      ],
      failureModes: [
        'New deprecated naming convention not in the regex (e.g. `RETIRED_*`) → file slips through',
        'Cross-PRJ file with no PRJ id in the name (e.g. just `BIS Americas evaluation.txt`) → not detected',
        'Two files with same text but different filename casing → both kept (hash is case-sensitive on content)',
      ],
      relatedStages: ['s2-download', 'store-docs'],
    },
    inputs: [
      { name: 'fileName', type: 'string', origin: 'Drive metadata' },
      { name: 'project_id', type: 'string', origin: 'project that owns the folder' },
      { name: 'content_text (for dedupe)', type: 'string', origin: 'extracted text' },
    ],
    outputSchema: 'UPDATE documents_cache.fetch_status to skipped_deprecated | skipped_cross_prj | skipped_duplicate',
    outputExampleKey: 'hygiene-verdict',
  },
  {
    id: 'store-docs',
    type: 'store',
    row: 4, col: 0,
    icon: '📚',
    name: 'documents_cache',
    subtitle: '442 success · 219 skipped',
    blurb: 'One row per file. PK (project_id, url). fetch_status separates the 4 lifecycle states.',
    details: {
      whatItDoes: 'Persistent cache of every Drive file Alumen has touched. Each row has the file\'s own GDrive URL (deep link to the actual file, not its parent folder), the extracted text content, the human-readable filename, and a lifecycle status. This is what the citation popover deep-links to when you click the source icon.',
      whyItExists: 'Caching avoids re-downloading on every pipeline run. Storing the per-file URL (instead of the folder URL the LLM sees) is what makes the "click source → open file in Drive" UX work — without this, you\'d only get the folder.',
      howItWorks: [
        'PK is the composite `(project_id, url)`',
        '`fetch_status` ∈ {`success`, `error`, `skipped_deprecated`, `skipped_cross_prj`, `skipped_duplicate`}',
        '`content_text` capped at 30K chars per file (anything longer truncated)',
        '`getProjectDocuments(projectId)` returns only rows with non-`skipped_*` status',
        '`getFileNamesForUrls(urls)` resolves URL → file_name for the popover even when the LLM emits citations without file_name',
      ],
      relatedStages: ['s2-download', 's3-hygiene', 's4-extract'],
    },
    inputs: [],
    outputSchema: 'rows with url, project_id, content_text, file_name, fetch_status',
    outputExampleKey: 'documents-cache-row',
  },
  {
    id: 's4-extract',
    type: 'parse',
    row: 4, col: 1,
    icon: '📝',
    name: 'Text Extraction',
    subtitle: 'goals-extractor + drive-engine',
    source: 'src/lib/goals-extractor.ts',
    blurb: '.txt → utf-8 read; .docx → unzip + strip XML; .pdf → pdf-parse; .csv → csv-parse; .xlsx → xlsx package.',
    latency: '~50ms per file',
    details: {
      whatItDoes: 'Converts binary or structured files on disk into plain text that the LLM can consume. Each supported format has its own extractor: .txt → utf-8 read; .docx → unzip + strip XML; .pdf → `pdf-parse`; .csv → `csv-parse`; .xlsx → `xlsx` package read as text. Google Docs are already exported as .txt at download time, so they bypass this stage.',
      whyItExists: 'LLMs only read text. Without extraction, ~70% of files (PDFs, DOCX, XLSX) would be invisible. Each format needs different handling — having one place that knows all of them keeps the rest of the pipeline format-agnostic.',
      howItWorks: [
        'Dispatcher reads file extension + mime to pick the extractor',
        'Each extractor returns plain UTF-8 text, max 30K chars',
        'For DOCX: shells out to `unzip -p ... word/document.xml | sed` to strip XML — battle-tested over mammoth/etc',
        'For PDF: `pdf-parse` library; image-only PDFs come back near-empty',
        'For CSV/XLSX: read row-by-row, join cells with separator',
        'Result is written back into `documents_cache.content_text`',
      ],
      failureModes: [
        'Encrypted PDF → throws, row gets `fetch_status=error`',
        'DOCX with unusual structure (templates, locked sections) → text may be incomplete',
        'CSV with non-UTF-8 encoding → mojibake (no auto-detect)',
        'Image-only PDF (scanned) → empty text, no OCR fallback',
      ],
      relatedStages: ['store-docs', 's5-goals-llm'],
    },
    inputs: [
      { name: 'localPath', type: 'fs path', origin: 'downloadFile' },
      { name: 'mimeType', type: 'string', origin: 'Drive metadata' },
    ],
    outputSchema: 'Concatenated text per project (≤ 30K chars per file)',
    outputExampleKey: 'extracted-text',
  },

  // Row 5: Goals LLM
  {
    id: 's5-goals-llm',
    type: 'llm',
    row: 5, col: 1,
    icon: '🤖',
    name: 'Goals Extraction',
    subtitle: 'Gemini',
    source: 'src/lib/goals-analyzer.ts:158',
    promptKey: 'goals',
    trigger: {
      label: 'Run on single project',
      method: 'POST',
      url: '/api/goals',
      body: { action: 'start_single', projectId: 'PRJ0021672' },
    },
    blurb: 'One LLM call per project. Extracts 19 structured fields including impact_claims, project_relations, out_of_scope, timeline_struct.',
    latency: '~10s per project',
    details: {
      whatItDoes: 'The first LLM stage. Reads every document of a project (post-hygiene), gives Gemini the prompt template + canonical taxonomy, and asks it to return a 19-field JSON describing the project: free-text summaries (technologies, regional impacts, business apps), canonical arrays (tech_tags, vendors, gio/dds touched), AND the atomic structured signals introduced by Onda 2/3 (impact_claims, project_relations, out_of_scope, timeline_struct).',
      whyItExists: 'Raw documents are too unstructured for the Impact stage to reason about cross-project relationships efficiently. Goals does the "per-project digestion" — reducing 30K chars of mixed Gate Notes and Q&As into a compact, structured profile. Impact then operates on profiles, not raw text.',
      howItWorks: [
        'For each project: concat the text of all `success`-status docs (capped at ~30K)',
        'Substitute `{{PROJECT_INFO}}` and `{{DOCUMENT_TEXT}}` in the prompt template (`DEFAULT_GOALS_PROMPT` v4)',
        'Call `generateContent` (Gemini, model set in config.json) with `context=goals`',
        'Parse the JSON response; pass to Sanitize stage',
        'Skip-condition: if `source_files` unchanged AND `prompt_version >= 4` → no LLM call (cached row stays)',
      ],
      failureModes: [
        'Gemini returns malformed JSON → parse fails, row gets `status=error`',
        'Sanitizer drops all claims (e.g., evidence_quote too short) → row stored but with empty arrays',
        'Daily LLM cap reached → fire-and-forget call fails silently; row missed this round',
        'Very thin docs (1 Q&A only) → LLM may under-extract (2-3 claims instead of 6+)',
      ],
      relatedStages: ['store-docs', 'ext-target-catalog', 's6-sanitize', 'store-goals'],
    },
    inputs: [
      { name: 'documents (cleaned)', type: 'string', origin: 'documents_cache, status=success' },
      { name: 'DEFAULT_GOALS_PROMPT v4', type: 'template', origin: 'prompts.ts' },
      { name: 'model', type: 'string', origin: 'config.json', example: 'gemini-2.0-flash' },
    ],
    outputSchema: 'JSON: { summary_one_line, impact_claims[], project_relations[], out_of_scope[], ... }',
    outputExampleKey: 'goals-llm-response',
  },

  // Row 6: Sanitize + project_goals
  {
    id: 's6-sanitize',
    type: 'sanitize',
    row: 6, col: 1,
    icon: '🛡️',
    name: 'Sanitize & Persist',
    subtitle: 'validators + upsert',
    source: 'src/lib/goals-analyzer.ts (sanitizeProjectRelations, sanitizeImpactClaims, sanitizeTimeline)',
    blurb: 'Drops malformed entries (invalid kind, < 10 char evidence, non-canonical target). Upserts into project_goals with prompt_version=4.',
    latency: '<10ms',
    details: {
      whatItDoes: 'Defense layer between the LLM and the DB. Validates every field of Gemini\'s JSON response against schemas: enum constraints (kind ∈ {predecessor, successor, …}), minimum evidence length (≥10 chars), canonical-target check via `target-catalog`, date format normalisation for timeline. Malformed entries are dropped silently — bad fields don\'t corrupt the row, but a fully-malformed response produces an empty row instead of garbage.',
      whyItExists: 'LLMs occasionally invent enums ("predecesor" instead of "predecessor"), emit invented target names ("Cyber Sec" instead of "Security & Compliance"), or write evidence_quote that\'s actually paraphrased. Without sanitization those would propagate to Impact and Deep Dive, breaking aggregation and citation. With it, the system fails closed (drop the claim) rather than fail open (store garbage).',
      howItWorks: [
        '`sanitizeProjectRelations`: enum check on `kind`, evidence ≥10 chars, dedupe by `(project_id|kind)`, reject self-loops',
        '`sanitizeOutOfScope`: topic ≥3 chars, evidence ≥10, dedupe by lowercased topic',
        '`sanitizeImpactClaims`: target_kind in {gio, dds}, target must pass `isCanonicalTarget`, role in 5-value enum, impact_type in 10-value enum, severity in 3-value enum',
        '`sanitizeTimeline`: parse dates loosely (null on "TBD"/"N/A"), normalize deps to {project_id, reason, evidence_file, evidence_quote}',
        'Finally: UPSERT into `project_goals` (one row per project), bump `prompt_version=4`, write JSON-encoded arrays back to disk',
      ],
      failureModes: [
        'LLM uses brand-new role Alumen hasn\'t enumerated yet → silently dropped',
        'Sanitizer too strict → real evidence gets cut (e.g. quote of exactly 8 chars dropped because <10)',
        'Target catalog has a typo → all matching claims dropped',
      ],
      relatedStages: ['s5-goals-llm', 'store-goals', 'ext-target-catalog'],
    },
    inputs: [
      { name: 'parsed JSON', type: 'object', origin: 'Gemini response' },
      { name: 'target-catalog (for validation)', type: 'module', origin: 'isCanonicalTarget()' },
    ],
    outputSchema: 'UPSERT project_goals (1 row per project)',
    outputExampleKey: 'project-goals-row',
  },
  {
    id: 'store-goals',
    type: 'store',
    row: 7, col: 1,
    icon: '🎯',
    name: 'project_goals',
    subtitle: '65 success · prompt_version=4',
    blurb: 'Per-project enrichment. Carries impact_claims (atomic edges to GIO/DDS) and project_relations (project↔project).',
    details: {
      whatItDoes: 'The "per-project knowledge profile" produced by Goals. Each row carries ~25 fields: free-text summaries, canonical arrays (tech_tags, vendors, gio_services_touched), and the load-bearing structured signal (impact_claims for GIO/DDS edges, project_relations for project↔project, out_of_scope as negative signal, timeline_struct for gates and dependencies).',
      whyItExists: 'Decoupling per-project digestion from cross-project analysis. By the time Impact runs, it doesn\'t re-read documents — it operates on this compact, structured row. Faster + more deterministic.',
      howItWorks: [
        'PK is auto id; unique on `project_id`',
        '`status` ∈ {`success`, `error`, `partial`}',
        '`prompt_version` increments on each Goals refactor (now 4) — controls re-analysis logic',
        '`source_files` is JSON-encoded list of files used; change in this triggers re-analysis',
        'Arrays stored as JSON-encoded TEXT (sqlite has no native arrays)',
        'New columns added via additive migration (`ALTER TABLE ADD COLUMN`)',
      ],
      relatedStages: ['s6-sanitize', 's7-impact-llm', 's8-deepdive', 's9-universe'],
    },
    inputs: [],
    outputSchema: 'rows with impact_claims, project_relations, out_of_scope, timeline_struct, …',
    outputExampleKey: 'project-goals-row',
  },

  // Row 8: Impact LLM
  {
    id: 's7-impact-llm',
    type: 'llm',
    row: 8, col: 1,
    icon: '🕸️',
    name: 'Impact Analysis',
    subtitle: 'Gemini (batched 22/round)',
    source: 'src/lib/impact-engine.ts:589 (runFullImpactAnalysis)',
    promptKey: 'impact',
    trigger: {
      label: 'Clear + Start',
      method: 'POST',
      url: '/api/impact',
      body: { action: 'start' },
      note: 'Call action:clear first to reset. ~15min for 67 projects.',
    },
    blurb: 'Consumes Goals impact_claims as ground truth + lets the LLM discover additional project↔project edges. Outputs to projects_impact with evidence_chain trace.',
    latency: '~45s per batch × ~17 batches',
    details: {
      whatItDoes: 'The second LLM stage — produces the actual impact graph. Reads every project\'s `project_goals` row (with its claims, relations, exclusions) and asks Gemini to (1) materialize each `impact_claim` as a `projects_impact` row, (2) discover additional project↔project edges from the prose + mentioned_projects + tech_tags overlap, (3) respect `out_of_scope` as a hard negative signal.',
      whyItExists: 'Goals describes projects in isolation. Impact is where cross-project edges emerge: shared platforms (Okta in two projects → `vendor_shared`), timeline blocks (one project gates another), regional rollouts, etc. Without this stage there\'s no graph to render in Project Universe.',
      howItWorks: [
        '`buildFullCoverageBatches` splits 67 projects into rounds of 22 (every pair within a round can be evaluated)',
        'Per batch: build a prompt containing all 22 project profiles (including their impact_claims, project_relations, out_of_scope, EXCLUSIONS block)',
        'One Gemini call per batch with `context=impact`',
        'Parse JSON array; `storeImpacts` does INSERT OR REPLACE on (source, target, impact_type) PK',
        '`storeImpacts` ALSO attaches `evidence_chain` per row by matching back against `project_goals.impact_claims[claim_idx]`',
        'Self-loops dropped at insert time (defensive)',
      ],
      failureModes: [
        'Gemini hallucinates a project_id that doesn\'t exist → orphan target, filtered at read by `enrichImpactCitations`',
        'Round produces 0 impacts (rare) → no error, just an empty batch',
        'Daily LLM cap → batch errors, next batches resume',
        '`evidence_chain` may end up empty (`source: free`) when the LLM diverges from the claim list — falls back to citations[] at read time',
      ],
      relatedStages: ['store-goals', 's6-sanitize', 'store-impacts', 's9-universe'],
    },
    inputs: [
      { name: 'project_goals rows (status=success)', type: 'array', origin: 'project_goals' },
      { name: 'impact_claims (per project)', type: 'array', origin: 'project_goals.impact_claims' },
      { name: 'DEFAULT_IMPACT_PROMPT', type: 'template', origin: 'prompts.ts' },
      { name: 'batchSize', type: 'int', origin: 'buildFullCoverageBatches', example: '22' },
    ],
    outputSchema: 'JSON array → INSERT OR REPLACE projects_impact (PK source, target, type)',
    outputExampleKey: 'impact-llm-response',
  },
  {
    id: 'store-impacts',
    type: 'store',
    row: 9, col: 1,
    icon: '⚡',
    name: 'projects_impact',
    subtitle: '172 rows · 95.8% verifiable',
    blurb: 'Edges of the impact graph. Each row carries citations (LLM-emitted) + evidence_chain (trace back to source claim).',
    details: {
      whatItDoes: 'The impact graph itself. Each row is a directed edge `(source_project_id) → (target_project_id)` of a specific `impact_type`, carrying severity, direction, the GIO services / DDS entities involved, an evidence_chain pointer back to Goals, and (when the LLM emitted them) citations[] with file URLs and snippets.',
      whyItExists: 'This is the single table Project Universe queries. Aggregating everything here (instead of spreading it across `impact_claims` in Goals + LLM raw output + …) means the API layer can join, filter, and dedupe in milliseconds.',
      howItWorks: [
        'PK on `(source_project_id, target_project_id, impact_type)` — INSERT OR REPLACE on rerun preserves uniqueness',
        '`gio_services` and `dds_entities` are JSON-encoded arrays so a single row can touch multiple services',
        '`citations` is JSON `[{doc_url, snippet, file_name}]` — populated by the LLM when grounded, empty otherwise',
        '`evidence_chain` is JSON `[{goal_id, claim_idx?, relation_idx?, source}]` — added at storeImpacts time for full audit trail',
        'Cleared in cascade with `impact_deep_dives` via `clearAllImpacts()` — keeps the dive cache from going stale',
      ],
      relatedStages: ['s7-impact-llm', 's9-universe', 'store-deepdives'],
    },
    inputs: [],
    outputSchema: 'rows: source_project_id, target_project_id, impact_type, direction, severity, gio_services, dds_entities, citations, evidence_chain',
    outputExampleKey: 'projects-impact-row',
  },

  // Row 10: Deep Dive + API
  {
    id: 's8-deepdive',
    type: 'llm',
    row: 10, col: 0,
    icon: '🔬',
    name: 'Deep Dive',
    subtitle: 'Gemini, on-demand per target',
    source: 'src/lib/deep-dive-engine.ts',
    promptKey: 'deep-dive',
    trigger: {
      label: 'Generate one',
      method: 'POST',
      url: '/api/impact/project/deep-dive',
      body: { projectId: 'PRJ0021672', kind: 'gio', target: 'Security & Compliance' },
      note: 'kind ∈ { gio, dds, project }. Cached per (project, kind, target).',
    },
    blurb: 'Narrative markdown explaining WHY a project impacts a specific GIO/DDS/project. Consumes impact_claims + out_of_scope + documents. Supports kind=project for project↔project edges.',
    latency: '~30s per call',
    details: {
      whatItDoes: 'On-demand LLM call that produces a 6-8 section markdown narrative explaining a specific edge: "Why does project X impact target Y?". Goes beyond the one-line `explanation` in projects_impact — gives Bottom Line, Why It Exists, Concrete Touchpoints (one bullet per `impact_claim`), Estimated Workload, Risks, Origin of Inference, and a Sources list with snippets.',
      whyItExists: 'The Reason tab in Project Universe shows the LLM\'s one-liner per impact, which is usually enough. But sometimes a reviewer needs the full reasoning — citations, conditional language, dependencies, edge cases. Deep Dive provides that on-demand narrative without running it for every (project, target) pair upfront.',
      howItWorks: [
        'Inputs: project meta, all `project_goals` fields, `impact_claims` filtered to this (kind, target), `out_of_scope` (as negative signal), document excerpts',
        'For `kind=project`: also pulls the companion project\'s summary + filtered `project_relations` pointing at the target',
        'Cache key is `source_sig` (hash of source_files + analyzed_at) — invalidated when Goals re-analyzes',
        'Cleared cascade by `clearAllImpacts()` so a fresh Impact run doesn\'t leave dives stale',
        'Output stored as `response_md` (markdown) + `sources_json` (array of {file_name, doc_url, snippet})',
      ],
      failureModes: [
        'No `impact_claims` for this (project, target) → narrative falls back to free-text reasoning over docs (less anchored)',
        'kind=project but target project_id missing from DB → uses generic helper, may produce thin output',
        'Source file referenced in `evidence_quote` no longer in `documents_cache` → file_name still shown but no clickable URL',
      ],
      relatedStages: ['store-goals', 'store-impacts', 'store-deepdives'],
    },
    inputs: [
      { name: 'projectId', type: 'string', origin: 'URL/body' },
      { name: 'kind', type: '"gio" | "dds" | "project"', origin: 'URL/body' },
      { name: 'target', type: 'string', origin: 'URL/body', example: 'Security & Compliance' },
      { name: 'force', type: 'boolean', origin: 'body (optional)', example: 'true to bypass cache' },
    ],
    outputSchema: 'INSERT OR REPLACE impact_deep_dives',
    outputExampleKey: 'deep-dive-row',
  },
  {
    id: 's9-universe',
    type: 'aggregate',
    row: 10, col: 1,
    icon: '🌐',
    name: 'Universe API',
    subtitle: 'GET /api/impact/project/universe',
    source: 'src/app/api/impact/project/universe/route.ts',
    blurb: 'Loads impacts, enriches empty citations from evidence_chain (Onda 4), aggregates pairs, fans out per GIO/DDS service. Returns the data the Project Universe view renders.',
    latency: '~150ms',
    details: {
      whatItDoes: 'The assembly point between persisted data and what the UI renders. For a given projectId, loads all impact rows, enriches them (synthesizes citations from evidence_chain when the LLM left them empty), aggregates same-pair edges, fans the result out into per-service / per-entity / per-project buckets, and returns one tidy JSON for the front-end.',
      whyItExists: 'The frontend would otherwise have to do four queries + complex client-side aggregation. Centralising this in the API keeps the React component thin AND guarantees consistent enrichment logic (e.g. fuzzy file_name resolution) regardless of which UI consumes it.',
      howItWorks: [
        '`getProjectImpacts(projectId)` → raw rows where source=projectId OR target=projectId',
        '`enrichEmptyCitations(raw)` synthesizes ImpactCitation[] from each row\'s evidence_chain → goal.impact_claims[idx] with file_name and doc_url resolved via fuzzy match in documents_cache',
        '`aggregateImpacts(raw)` collapses rows sharing the same `(source, target)` pair, building parallel arrays: explanations, citationsByExplanation, impactTypeByExplanation, severityByExplanation, gioServicesByExplanation, ddsEntitiesByExplanation',
        '`fanOutPseudo` iterates GIO/DDS services and filters each node\'s view to only the explanations whose own raw row pointed at that service (no cross-service leak)',
        'Returns `{ project, gioNodes[], ddsNodes[], projectEdges[], stats }`',
      ],
      failureModes: [
        'evidence_chain points to a deleted goal_id → silently dropped from synthesized citations',
        'file_name normalisation mismatch (extension, separators) → file_name shows but doc_url stays empty',
        'Project with no impacts → returns empty arrays, UI shows empty universe (graceful)',
      ],
      relatedStages: ['store-impacts', 'store-goals', 's10-ui'],
    },
    inputs: [
      { name: 'projectId', type: 'string', origin: 'query param' },
      { name: 'projects_impact rows', type: 'array', origin: 'DB' },
      { name: 'project_goals.impact_claims (for fallback)', type: 'array', origin: 'DB' },
      { name: 'documents_cache (file_name ↔ url)', type: 'map', origin: 'DB' },
    ],
    outputSchema: '{ project, gioNodes[], ddsNodes[], projectEdges[], stats }',
    outputExampleKey: 'universe-api-response',
  },
  {
    id: 'store-deepdives',
    type: 'store',
    row: 11, col: 0,
    icon: '📖',
    name: 'impact_deep_dives',
    subtitle: 'On-demand cache',
    blurb: 'Markdown + sources_json per (project, kind, target). Invalidated via cascade in clearAllImpacts.',
    details: {
      whatItDoes: 'Per-edge narrative cache. One row per unique (project_id, kind, target) tuple, storing the full markdown narrative + the structured sources list (with file_name, doc_url, snippet) that the LLM grounded the analysis on. Read-through cache: the UI calls "get or generate" and the table answers if a fresh-enough version exists.',
      whyItExists: 'Each deep dive costs ~30s of LLM time. Caching prevents regenerating the same analysis every time a reviewer clicks the same node. Cache invalidation is critical: a fresh Impact run can change the underlying edge, so dives must be invalidated together.',
      howItWorks: [
        'UNIQUE constraint on `(project_id, kind, target)` — only one current dive per edge',
        '`source_sig` is a hash of the source files + analyzed_at timestamp; mismatch triggers regeneration',
        '`clearAllImpacts()` cascade-deletes all dives — fresh Impact run = fresh dive on next click',
        '`response_md` is plain markdown, max ~10K chars',
        '`sources_json` is `[{id, doc_url, file_name, snippet}]` referenced from `_Sources: [n]_` markers in the markdown',
      ],
      relatedStages: ['s8-deepdive', 's10-ui'],
    },
    inputs: [],
    outputSchema: 'rows: project_id, kind, target, response_md, sources_json, source_sig',
    outputExampleKey: 'deep-dive-row',
  },
  {
    id: 's10-ui',
    type: 'aggregate',
    row: 11, col: 1,
    icon: '🖥️',
    name: 'Project Universe UI',
    subtitle: 'React Flow canvas + side panel',
    source: 'src/components/ProjectUniverseView.tsx',
    blurb: 'Renders the GIO/DDS satellites and project↔project edges. Each impact card shows per-message badges (severity, impact_type) + clickable source popover with evidence quote + GDrive link.',
    latency: 'instant (client-side)',
    details: {
      whatItDoes: 'Visual + interactive surface for a single project\'s impact map. Renders the centre project + connected GIO services (top arc), DDS entities (lower arc), and other projects (outer ring). Clicking a node shows its impact card with per-message badges and the source popover for each explanation.',
      whyItExists: 'A graph view is the natural representation for impact relationships. Tables don\'t convey reach or directionality the same way. The visual layout (arcs by category, severity colour, edge thickness by count) lets reviewers triage at a glance.',
      howItWorks: [
        'On mount: fetch `/api/impact/project/universe?projectId=<id>`',
        '`ProjectUniverseView` builds the ReactFlow node/edge graph from the response',
        'GIO nodes laid out on upper arc, DDS on lower arc, projects on right outer ring',
        'Clicking a node sets `selectedEdgeId` → right panel renders `selectedDetails` with Reason / Evidence tabs',
        'Each "Reason for the impact" bullet shows: text + severity badge + impact_type badge + source popover (icon with N number)',
        'Source popover opens with `file_name + GDrive deep link + snippet` for each citation',
        'Deep Dive button (in Reason tab) triggers `getOrGenerateDeepDive` for `(projectId, kind, target)`',
      ],
      relatedStages: ['s9-universe', 's8-deepdive', 'store-deepdives'],
    },
    inputs: [
      { name: 'Universe API response', type: 'JSON', origin: '/api/impact/project/universe' },
      { name: 'target-catalog (display labels)', type: 'module', origin: 'target-catalog.ts' },
    ],
    outputSchema: 'React tree',
  },
];

// ─── Edges ──────────────────────────────────────────────────────────────────

export const EDGES: EdgeDef[] = [
  // Excel → Upload → projects
  { id: 'e-excel-upload', source: 'ext-excel', target: 's0-upload', label: '.xlsx' },
  { id: 'e-upload-projects', source: 's0-upload', target: 'store-projects', label: 'UPSERT' },

  // Drive root → Discovery → projects (updates link_folder)
  { id: 'e-driveroot-discovery', source: 'ext-drive-root', target: 's1-discovery', label: 'folder listing' },
  { id: 'e-discovery-projects', source: 's1-discovery', target: 'store-projects', label: 'UPDATE link_folder', dashed: true },

  // projects → Download → documents_cache
  { id: 'e-projects-download', source: 'store-projects', target: 's2-download', label: 'link_folder' },
  { id: 'e-download-hygiene', source: 's2-download', target: 's3-hygiene', label: 'file list' },
  { id: 'e-hygiene-docs', source: 's3-hygiene', target: 'store-docs', label: 'rows + status' },

  // documents_cache → Text Extract → (back into rows)
  { id: 'e-docs-extract', source: 'store-docs', target: 's4-extract', label: 'binary content' },
  { id: 'e-extract-docs', source: 's4-extract', target: 'store-docs', label: 'content_text', dashed: true },

  // documents_cache → Goals LLM → Sanitize → project_goals
  { id: 'e-docs-goals', source: 'store-docs', target: 's5-goals-llm', label: 'cleaned text per project' },
  { id: 'e-catalog-goals', source: 'ext-target-catalog', target: 's5-goals-llm', label: 'canonical names', dashed: true },
  { id: 'e-goals-sanitize', source: 's5-goals-llm', target: 's6-sanitize', label: 'raw JSON' },
  { id: 'e-sanitize-goals', source: 's6-sanitize', target: 'store-goals', label: 'UPSERT' },

  // project_goals → Impact LLM → projects_impact
  { id: 'e-goals-impact', source: 'store-goals', target: 's7-impact-llm', label: 'impact_claims + relations' },
  { id: 'e-catalog-impact', source: 'ext-target-catalog', target: 's7-impact-llm', label: 'canonical names', dashed: true },
  { id: 'e-impact-store', source: 's7-impact-llm', target: 'store-impacts', label: 'INSERT' },

  // projects_impact → Universe API → UI
  { id: 'e-impacts-universe', source: 'store-impacts', target: 's9-universe', label: 'rows' },
  { id: 'e-goals-universe', source: 'store-goals', target: 's9-universe', label: 'evidence_chain fallback', dashed: true },
  { id: 'e-universe-ui', source: 's9-universe', target: 's10-ui', label: 'JSON' },

  // Deep Dive
  { id: 'e-goals-deepdive', source: 'store-goals', target: 's8-deepdive', label: 'claims + relations' },
  { id: 'e-impacts-deepdive', source: 'store-impacts', target: 's8-deepdive', label: 'existing edge (context)' },
  { id: 'e-deepdive-store', source: 's8-deepdive', target: 'store-deepdives', label: 'INSERT markdown' },
  { id: 'e-deepdives-ui', source: 'store-deepdives', target: 's10-ui', label: 'on-demand' },
];

export function getStage(id: string): StageDef | undefined {
  return STAGES.find(s => s.id === id);
}

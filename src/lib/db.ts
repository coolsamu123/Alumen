import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DB_DIR, 'cioo.db');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  // Ensure data directory exists
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  const instance = new Database(DB_PATH);
  instance.pragma('journal_mode = WAL');
  instance.pragma('foreign_keys = ON');

  initSchema(instance);

  // Only publish to the module-level singleton AFTER initSchema completes,
  // so concurrent callers during cold-start don't observe a half-migrated DB.
  db = instance;
  return db;
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id      TEXT NOT NULL,
      name            TEXT NOT NULL,
      dds             TEXT DEFAULT '',
      gate            TEXT DEFAULT '',
      cost_keur       REAL,
      description     TEXT DEFAULT '',
      remarks         TEXT DEFAULT '',
      qa              TEXT DEFAULT '',
      review_date     TEXT DEFAULT '',
      decision        TEXT DEFAULT '',
      decision_mode   TEXT DEFAULT '',
      decision_date   TEXT DEFAULT '',
      review_status   TEXT DEFAULT '',
      documents_status TEXT DEFAULT '',
      restricted      TEXT DEFAULT '',
      cost_before_g2  REAL,
      est_gate2_date  TEXT DEFAULT '',
      session_start   TEXT DEFAULT '',
      session_end     TEXT DEFAULT '',
      participants    TEXT DEFAULT '',
      link_positions  TEXT DEFAULT '',
      link_folder     TEXT DEFAULT '',
      link_cioo       TEXT DEFAULT '',
      year            INTEGER,
      month           INTEGER,
      uploaded_at     TEXT DEFAULT (datetime('now')),
      batch_id        TEXT DEFAULT '',
      services        TEXT DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_projects_project_id ON projects(project_id);
    CREATE INDEX IF NOT EXISTS idx_projects_dds ON projects(dds);
    CREATE INDEX IF NOT EXISTS idx_projects_gate ON projects(gate);
    CREATE INDEX IF NOT EXISTS idx_projects_decision ON projects(decision);
    CREATE INDEX IF NOT EXISTS idx_projects_batch ON projects(batch_id);

    CREATE TABLE IF NOT EXISTS analysis_cache (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      analysis_type   TEXT NOT NULL,
      project_ids     TEXT NOT NULL,
      prompt_hash     TEXT NOT NULL,
      request_prompt  TEXT DEFAULT '',
      response_json   TEXT DEFAULT '',
      similarity_score REAL DEFAULT 0,
      created_at      TEXT DEFAULT (datetime('now')),
      model_used      TEXT DEFAULT 'gemini-2.0-flash'
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_hash ON analysis_cache(prompt_hash);
    CREATE INDEX IF NOT EXISTS idx_analysis_projects ON analysis_cache(project_ids);

    CREATE TABLE IF NOT EXISTS documents_cache (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      url             TEXT NOT NULL,
      project_id      TEXT NOT NULL DEFAULT '',
      content_text    TEXT DEFAULT '',
      content_type    TEXT DEFAULT '',
      fetch_status    TEXT DEFAULT '',
      error_message   TEXT DEFAULT '',
      fetched_at      TEXT DEFAULT (datetime('now')),
      file_name       TEXT DEFAULT '',
      UNIQUE(project_id, url)
    );

    CREATE INDEX IF NOT EXISTS idx_documents_project ON documents_cache(project_id);
    CREATE INDEX IF NOT EXISTS idx_documents_url ON documents_cache(url);

    CREATE TABLE IF NOT EXISTS projects_impact (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_project_id TEXT NOT NULL,
      target_project_id TEXT NOT NULL,
      impact_type TEXT NOT NULL,
      direction TEXT NOT NULL,
      severity TEXT NOT NULL,
      explanation TEXT DEFAULT '',
      batch_id TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      gio_services TEXT DEFAULT '[]',
      dds_entities TEXT DEFAULT '[]',
      citations TEXT DEFAULT '[]',
      output_language TEXT NOT NULL DEFAULT 'en',
      -- Includes gio_services + dds_entities in the dedup key so atomic
      -- claim-materialised rows (Option 3, 2026-06-18) coexist as separate
      -- entries for each entity instead of overwriting each other when several
      -- claims share (impact_type, target_kind) but point at different
      -- entities (e.g. HHC / Americas / CF all integration_required on DDS).
      UNIQUE(source_project_id, target_project_id, impact_type, gio_services, dds_entities, output_language)
    );

    CREATE INDEX IF NOT EXISTS idx_impact_source ON projects_impact(source_project_id);
    CREATE INDEX IF NOT EXISTS idx_impact_target ON projects_impact(target_project_id);
    CREATE INDEX IF NOT EXISTS idx_impact_batch ON projects_impact(batch_id);
    -- idx_impact_lang is created in migrateOutputLanguage() — it can't live
    -- in this inline block because pre-migration DBs don't yet have the
    -- output_language column when this DDL runs.

    CREATE TABLE IF NOT EXISTS drive_sheet_meta (
      id              INTEGER PRIMARY KEY CHECK (id = 1),
      sheet_id        TEXT NOT NULL,
      gid             TEXT NOT NULL,
      source_url      TEXT NOT NULL,
      headers_json    TEXT NOT NULL,
      row_count       INTEGER NOT NULL DEFAULT 0,
      loaded_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS drive_sheet_rows (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      row_index       INTEGER NOT NULL,
      data_json       TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_drive_sheet_rows_idx ON drive_sheet_rows(row_index);

    CREATE TABLE IF NOT EXISTS drive_watch_roots (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      url             TEXT NOT NULL UNIQUE,
      drive_id        TEXT NOT NULL,
      label           TEXT DEFAULT '',
      enabled         INTEGER NOT NULL DEFAULT 1,
      added_at        TEXT NOT NULL DEFAULT (datetime('now')),
      last_run_at     TEXT,
      last_run_status TEXT,
      last_run_error  TEXT DEFAULT '',
      added_count     INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS auto_runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at    TEXT NOT NULL,
      finished_at   TEXT,
      trigger       TEXT NOT NULL,
      new_projects  INTEGER NOT NULL DEFAULT 0,
      goals_added   INTEGER NOT NULL DEFAULT 0,
      impacts_added INTEGER NOT NULL DEFAULT 0,
      errors_json   TEXT NOT NULL DEFAULT '[]',
      status        TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_auto_runs_started ON auto_runs(started_at DESC);

    CREATE TABLE IF NOT EXISTS llm_calls (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      called_at   TEXT NOT NULL DEFAULT (datetime('now')),
      provider    TEXT NOT NULL,
      model       TEXT NOT NULL,
      context     TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'success',
      duration_ms INTEGER,
      error_message TEXT DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_llm_calls_called_at ON llm_calls(called_at DESC);
    CREATE INDEX IF NOT EXISTS idx_llm_calls_context ON llm_calls(context);

    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS impact_deep_dives (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id      TEXT NOT NULL,
      kind            TEXT NOT NULL,
      target          TEXT NOT NULL,
      response_md     TEXT NOT NULL,
      llm_provider    TEXT NOT NULL,
      llm_model       TEXT NOT NULL,
      generated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      source_sig      TEXT NOT NULL,
      duration_ms     INTEGER,
      sources_json    TEXT DEFAULT '[]',
      output_language TEXT NOT NULL DEFAULT 'en',
      UNIQUE(project_id, kind, target, output_language)
    );

    CREATE INDEX IF NOT EXISTS idx_deep_dives_project ON impact_deep_dives(project_id);
    -- idx_deep_dives_lang created in migrateOutputLanguage() (same reason).

    CREATE TABLE IF NOT EXISTS project_goals (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id            TEXT NOT NULL,
      project_name          TEXT NOT NULL,
      region                TEXT DEFAULT '',
      gate                  TEXT DEFAULT '',
      month_folder          TEXT DEFAULT '',
      digital_technologies  TEXT DEFAULT '',
      change_management     TEXT DEFAULT '',
      security_impacts      TEXT DEFAULT '',
      regional_impacts      TEXT DEFAULT '',
      ia_embedded           TEXT DEFAULT '',
      gio_sl_dds_impacts    TEXT DEFAULT '',
      dds_gio_workload      TEXT DEFAULT '',
      business_apps_cis     TEXT DEFAULT '',
      raw_gemini_response   TEXT DEFAULT '',
      source_files          TEXT DEFAULT '[]',
      analyzed_at           TEXT DEFAULT NULL,
      status                TEXT DEFAULT 'pending',
      error_message         TEXT DEFAULT '',
      output_language       TEXT NOT NULL DEFAULT 'en'
    );

    -- idx_goals_project_lang (composite UNIQUE) is created in
    -- migrateOutputLanguage(). Pre-migration DBs don't yet have the
    -- output_language column when this block runs.
    CREATE INDEX IF NOT EXISTS idx_goals_region ON project_goals(region);
    CREATE INDEX IF NOT EXISTS idx_goals_status ON project_goals(status);

    -- Impact run journal. The in-memory analysisStatus in impact-engine.ts dies
    -- with the process, so a run killed mid-flight (OOM, deploy, restart) used
    -- to vanish without a trace: nothing distinguished "never ran" from "died at
    -- batch 7 of 21", and its partial rows sat in projects_impact
    -- indistinguishable from a complete run's.
    -- (No backticks in this block: it lives inside a JS template literal.)
    CREATE TABLE IF NOT EXISTS impact_runs (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id          TEXT NOT NULL,
      output_language   TEXT NOT NULL DEFAULT 'en',
      status            TEXT NOT NULL DEFAULT 'running',  -- running | complete | failed | aborted
      started_at        TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at       TEXT,
      total_projects    INTEGER DEFAULT 0,
      total_batches     INTEGER DEFAULT 0,
      completed_batches INTEGER DEFAULT 0,
      total_impacts     INTEGER DEFAULT 0,
      errors_json       TEXT DEFAULT '[]',
      warnings_json     TEXT DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_impact_runs_started ON impact_runs(started_at);
    CREATE INDEX IF NOT EXISTS idx_impact_runs_status ON impact_runs(status);
  `);

  reclaimOrphanedImpactRuns(db);

  try {
    db.exec('ALTER TABLE projects_impact ADD COLUMN gio_services TEXT DEFAULT "[]"');
  } catch {
    // Ignore if column already exists
  }
  try {
    db.exec('ALTER TABLE projects_impact ADD COLUMN dds_entities TEXT DEFAULT "[]"');
  } catch {
    // Ignore if column already exists
  }
  try {
    db.exec('ALTER TABLE projects_impact ADD COLUMN citations TEXT DEFAULT "[]"');
  } catch {
    // Ignore if column already exists
  }
  // Onda 4: trace from impact_id → which goal/claim/dive generated it.
  // Format: JSON array of { goal_id?, claim_idx?, dive_id?, source: 'claim'|'relation'|'free' }.
  try {
    db.exec('ALTER TABLE projects_impact ADD COLUMN evidence_chain TEXT DEFAULT "[]"');
  } catch {
    // Ignore if column already exists
  }

  // 2026-06-18: relax UNIQUE on projects_impact to include gio_services + dds_entities.
  // Pre-existing DBs were created with UNIQUE(source, target, impact_type, lang),
  // which collapsed sibling claims (HHC / Americas / CF on same impact_type) to a
  // single row. Detect the old constraint by name (the auto-generated
  // sqlite_autoindex_projects_impact_1) and, if found, rebuild the table with the
  // wider key. Idempotent: if the new constraint already includes the extra
  // columns, do nothing.
  try {
    const idx = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='projects_impact' AND sql IS NOT NULL"
    ).all() as Array<{ sql: string }>;
    const uniq = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='projects_impact'"
    ).get() as { sql: string } | undefined;
    const constraintIncludesEntities = (uniq?.sql || '').includes('gio_services, dds_entities')
      || idx.some(r => r.sql?.includes('gio_services') && r.sql?.includes('dds_entities'));
    if (!constraintIncludesEntities) {
      console.log('[db] migrating projects_impact UNIQUE constraint to include gio_services + dds_entities');
      db.exec(`
        BEGIN;
        ALTER TABLE projects_impact RENAME TO projects_impact_old;
        CREATE TABLE projects_impact (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_project_id TEXT NOT NULL,
          target_project_id TEXT NOT NULL,
          impact_type TEXT NOT NULL,
          direction TEXT NOT NULL,
          severity TEXT NOT NULL,
          explanation TEXT DEFAULT '',
          batch_id TEXT DEFAULT '',
          created_at TEXT DEFAULT (datetime('now')),
          gio_services TEXT DEFAULT '[]',
          dds_entities TEXT DEFAULT '[]',
          citations TEXT DEFAULT '[]',
          evidence_chain TEXT DEFAULT '[]',
          output_language TEXT NOT NULL DEFAULT 'en',
          UNIQUE(source_project_id, target_project_id, impact_type, gio_services, dds_entities, output_language)
        );
        INSERT INTO projects_impact
          (id, source_project_id, target_project_id, impact_type, direction, severity, explanation,
           batch_id, created_at, gio_services, dds_entities, citations, evidence_chain, output_language)
        SELECT id, source_project_id, target_project_id, impact_type, direction, severity, explanation,
               batch_id, created_at, gio_services, dds_entities, citations, evidence_chain, output_language
          FROM projects_impact_old;
        DROP TABLE projects_impact_old;
        CREATE INDEX IF NOT EXISTS idx_impact_source ON projects_impact(source_project_id);
        CREATE INDEX IF NOT EXISTS idx_impact_target ON projects_impact(target_project_id);
        CREATE INDEX IF NOT EXISTS idx_impact_batch  ON projects_impact(batch_id);
        CREATE INDEX IF NOT EXISTS idx_impact_lang   ON projects_impact(output_language);
        COMMIT;
      `);
    }
  } catch (err) {
    console.error('[db] projects_impact UNIQUE migration failed:', err);
  }
  try {
    db.exec('ALTER TABLE projects ADD COLUMN services TEXT DEFAULT "[]"');
  } catch {
    // Ignore if column already exists
  }
  try {
    db.exec("ALTER TABLE documents_cache ADD COLUMN file_name TEXT DEFAULT ''");
  } catch {
    // Ignore if column already exists
  }
  // Per-file rows: cache is keyed by (project_id, file's own GDrive URL) so the
  // popover can deep-link to the actual file instead of the parent folder. On
  // databases provisioned before this change, the old UNIQUE(url) index would
  // reject the new (project_id,url) duplicates, so drop it; the CREATE TABLE
  // above already defines the composite uniqueness on fresh DBs.
  try {
    db.exec("ALTER TABLE documents_cache ADD COLUMN project_id TEXT NOT NULL DEFAULT ''");
  } catch {
    // Ignore if column already exists
  }
  try { db.exec('DROP INDEX IF EXISTS idx_documents_url'); } catch { /* ignore */ }
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_proj_url ON documents_cache(project_id, url)');
  } catch { /* ignore */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_documents_project ON documents_cache(project_id)'); } catch { /* ignore */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_documents_url ON documents_cache(url)'); } catch { /* ignore */ }
  try {
    db.exec("ALTER TABLE impact_deep_dives ADD COLUMN sources_json TEXT DEFAULT '[]'");
  } catch {
    // Ignore if column already exists
  }

  // project_goals structured-fields migrations (idempotent — column may already exist)
  const addGoalCol = (col: string, decl: string) => {
    try { db.exec(`ALTER TABLE project_goals ADD COLUMN ${col} ${decl}`); }
    catch { /* column already exists */ }
  };
  addGoalCol('summary_one_line',      "TEXT DEFAULT ''");
  addGoalCol('dds_entities_touched',  "TEXT DEFAULT '[]'");
  addGoalCol('gio_services_touched',  "TEXT DEFAULT '[]'");
  addGoalCol('tech_tags',             "TEXT DEFAULT '[]'");
  addGoalCol('vendors',               "TEXT DEFAULT '[]'");
  addGoalCol('data_classifications',  "TEXT DEFAULT '[]'");
  addGoalCol('mentioned_projects',    "TEXT DEFAULT '[]'");
  addGoalCol('prompt_version',        'INTEGER DEFAULT 0');
  // Onda 2 of the Goals→Impact refactor: structured project-to-project
  // relationships and explicit out-of-scope statements, replacing the
  // free-text-only inference path the Impact engine was forced to use.
  addGoalCol('project_relations',     "TEXT DEFAULT '[]'");
  addGoalCol('out_of_scope',          "TEXT DEFAULT '[]'");
  // Onda 3: atomic, anchored impact_claims (replaces gio_sl_dds_impacts prose
  // as the authoritative source for GIO/DDS edges) + structured timeline.
  addGoalCol('impact_claims',         "TEXT DEFAULT '[]'");
  addGoalCol('timeline_struct',       "TEXT DEFAULT '{}'");
  // Fingerprint of the document set this row was extracted from. Empty on rows
  // written before 2026-08-31; analyzeProject backfills those in place without
  // re-running the LLM, so adding this column never triggers a re-analysis.
  addGoalCol('source_signature',      "TEXT DEFAULT ''");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_goals_tech_tags ON project_goals(tech_tags);
    CREATE INDEX IF NOT EXISTS idx_goals_prompt_version ON project_goals(prompt_version);
  `);

  // Dual EN/FR storage migrations. The column lives on both `project_goals`
  // and `projects_impact`; existing rows are tagged 'en' (the historical
  // reality). Uniqueness becomes (canonical_key, output_language) so the same
  // project can carry one analysis per language without colliding.
  migrateOutputLanguage(db);
}

/**
 * Startup recovery for the impact run journal.
 *
 * A run's live state exists only in module memory, so a row still marked
 * 'running' when a fresh process boots cannot belong to a live run — the run
 * that wrote it is gone. Mark those aborted so the UI can say "your last run
 * died at batch 7 of 21" instead of silently showing nothing.
 *
 * ASSUMES A SINGLE WRITER PROCESS. That holds for this deployment (one Next
 * server behind nginx). If the app is ever scaled to multiple workers sharing
 * this SQLite file, a booting worker would wrongly abort a sibling's live run,
 * and this needs a process/owner token instead.
 */
function reclaimOrphanedImpactRuns(db: Database.Database) {
  try {
    const result = db.prepare(
      "UPDATE impact_runs SET status = 'aborted', finished_at = datetime('now') WHERE status = 'running'"
    ).run();
    if (result.changes > 0) {
      console.warn(`[db] marked ${result.changes} orphaned impact run(s) as aborted`);
    }
  } catch (err) {
    console.error('[db] failed to reclaim orphaned impact runs:', err);
  }
}

function migrateOutputLanguage(db: Database.Database) {
  // ── project_goals: single-column UNIQUE index → composite. ──────────────
  // The constraint here lives on a separate UNIQUE INDEX (not inline in
  // CREATE TABLE), so we can swap it without rebuilding the table.
  try {
    db.exec("ALTER TABLE project_goals ADD COLUMN output_language TEXT NOT NULL DEFAULT 'en'");
  } catch {
    // Column already exists.
  }
  try { db.exec('DROP INDEX IF EXISTS idx_goals_project_id'); } catch { /* ignore */ }
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_goals_project_lang ON project_goals(project_id, output_language)');
  } catch { /* ignore */ }

  // ── projects_impact: inline UNIQUE constraint → table rebuild. ──────────
  // The constraint sits inside CREATE TABLE, backed by an auto-index that
  // SQLite refuses to drop directly. The canonical recipe is: create a new
  // table with the desired shape, copy rows, drop old, rename. Guarded so
  // it only runs once (when the column is still missing).
  const hasLang = (() => {
    try {
      const cols = db.prepare("PRAGMA table_info(projects_impact)").all() as Array<{ name: string }>;
      return cols.some(c => c.name === 'output_language');
    } catch {
      return true; // be defensive — if PRAGMA fails, do not attempt rebuild
    }
  })();

  if (!hasLang) {
    const rebuild = db.transaction(() => {
      db.exec(`
        CREATE TABLE projects_impact_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_project_id TEXT NOT NULL,
          target_project_id TEXT NOT NULL,
          impact_type TEXT NOT NULL,
          direction TEXT NOT NULL,
          severity TEXT NOT NULL,
          explanation TEXT DEFAULT '',
          batch_id TEXT DEFAULT '',
          created_at TEXT DEFAULT (datetime('now')),
          gio_services TEXT DEFAULT '[]',
          dds_entities TEXT DEFAULT '[]',
          citations TEXT DEFAULT '[]',
          evidence_chain TEXT DEFAULT '[]',
          output_language TEXT NOT NULL DEFAULT 'en',
          UNIQUE(source_project_id, target_project_id, impact_type, output_language)
        );

        INSERT INTO projects_impact_new (
          id, source_project_id, target_project_id, impact_type, direction, severity,
          explanation, batch_id, created_at, gio_services, dds_entities, citations, evidence_chain
        )
        SELECT
          id, source_project_id, target_project_id, impact_type, direction, severity,
          COALESCE(explanation, ''),
          COALESCE(batch_id, ''),
          COALESCE(created_at, datetime('now')),
          COALESCE(gio_services, '[]'),
          COALESCE(dds_entities, '[]'),
          COALESCE(citations, '[]'),
          COALESCE(evidence_chain, '[]')
        FROM projects_impact;

        DROP TABLE projects_impact;
        ALTER TABLE projects_impact_new RENAME TO projects_impact;

        CREATE INDEX IF NOT EXISTS idx_impact_source ON projects_impact(source_project_id);
        CREATE INDEX IF NOT EXISTS idx_impact_target ON projects_impact(target_project_id);
        CREATE INDEX IF NOT EXISTS idx_impact_batch ON projects_impact(batch_id);
        CREATE INDEX IF NOT EXISTS idx_impact_lang ON projects_impact(output_language);
      `);
    });
    rebuild();
  }

  // ── impact_deep_dives: inline UNIQUE constraint → table rebuild. ────────
  // Same recipe as projects_impact. Without this, a deep dive cached under
  // EN would be served when the user toggles to FR.
  const hasDiveLang = (() => {
    try {
      const cols = db.prepare("PRAGMA table_info(impact_deep_dives)").all() as Array<{ name: string }>;
      return cols.some(c => c.name === 'output_language');
    } catch {
      return true;
    }
  })();

  if (!hasDiveLang) {
    const rebuild = db.transaction(() => {
      db.exec(`
        CREATE TABLE impact_deep_dives_new (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id      TEXT NOT NULL,
          kind            TEXT NOT NULL,
          target          TEXT NOT NULL,
          response_md     TEXT NOT NULL,
          llm_provider    TEXT NOT NULL,
          llm_model       TEXT NOT NULL,
          generated_at    TEXT NOT NULL DEFAULT (datetime('now')),
          source_sig      TEXT NOT NULL,
          duration_ms     INTEGER,
          sources_json    TEXT DEFAULT '[]',
          output_language TEXT NOT NULL DEFAULT 'en',
          UNIQUE(project_id, kind, target, output_language)
        );

        INSERT INTO impact_deep_dives_new (
          id, project_id, kind, target, response_md, llm_provider, llm_model,
          generated_at, source_sig, duration_ms, sources_json
        )
        SELECT
          id, project_id, kind, target, response_md, llm_provider, llm_model,
          generated_at, source_sig, duration_ms,
          COALESCE(sources_json, '[]')
        FROM impact_deep_dives;

        DROP TABLE impact_deep_dives;
        ALTER TABLE impact_deep_dives_new RENAME TO impact_deep_dives;

        CREATE INDEX IF NOT EXISTS idx_deep_dives_project ON impact_deep_dives(project_id);
        CREATE INDEX IF NOT EXISTS idx_deep_dives_lang ON impact_deep_dives(output_language);
      `);
    });
    rebuild();
  }
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

// Canonical definitions for the GIO Service Lines and DDS entities used by the
// Impact engine and Deep Dive analyses.
//
// The Impact engine treats the *names* below as canonical identifiers. The
// Deep Dive prompt enriches them with the `description` text so the LLM stops
// guessing what e.g. "User Workplace" means inside Air Liquide and grounds its
// analysis on a stable definition.
//
// Storage split (2026-06-18):
//   - This file owns the canonical *names* (single source of truth for the set
//     of allowed targets — type-checked against `prompts.ts`).
//   - `target-catalog.data.json` owns the editable per-entry data (description,
//     typicalRoles, typicalImpactTypes). The /admin/catalog UI writes that JSON;
//     `reloadCatalog()` invalidates the in-memory cache so same-process callers
//     see fresh values without a restart.

import fs from 'node:fs';
import path from 'node:path';

export type TargetKind = 'gio' | 'dds';

// Stable enum of roles a project can play in relation to a target. Mirrors the
// `role` field that Goals will emit per impact_claim (Onda 3 of the refactor).
// `impact-engine.ts` derives the impact `direction` from this:
//   - 'primary_provider'        → 'provides_to'
//   - 'downstream_consumer'     → 'depends_on'
//   - 'regional_executor'       → 'requires_coordination'
//   - 'risk_owner'              → 'requires_coordination'
//   - 'blocked_by'              → 'depends_on'
export const TARGET_ROLES = [
  'primary_provider',
  'downstream_consumer',
  'regional_executor',
  'risk_owner',
  'blocked_by',
] as const;

export type TargetRole = typeof TARGET_ROLES[number];

// Mirrors prompts.ts:261 — the controlled vocabulary for `impact_type`.
// Used by the /admin/catalog UI as chip suggestions.
export const IMPACT_TYPES = [
  'technology_dependency',
  'infrastructure_shared',
  'data_dependency',
  'timeline_blocking',
  'resource_contention',
  'organizational',
  'platform_shared',
  'vendor_shared',
  'integration_required',
  'security_dependency',
  'regional_rollout',
] as const;

// Controlled vocabulary for `projects_impact.direction`. Single source of truth:
// this column has THREE producers that used to disagree, which is how
// `feeds_data` / `competes_with` ended up renderable as "relates to" in the
// narrative while `depends_on` / `supersedes` were being written to the DB
// without appearing in the prompt's own enum.
//
//   1. ROLE_TO_DIRECTION (impact-engine.ts) — materialised claim rows:
//      provides_to, depends_on, requires_coordination
//   2. The project-relations mapping in the impact prompt:
//      depends_on, blocks, supersedes, requires_coordination
//   3. The impact prompt's explicit enum for emitted rows:
//      blocks, enables, shares_resource, feeds_data, competes_with,
//      requires_coordination
//
// Anything stored must be in this union, and impact-narrative.ts must have a
// verb phrase for every entry — otherwise the row renders as a vague
// "relates to" in the "Why this matters" panel.
export const IMPACT_DIRECTIONS = [
  'provides_to',
  'depends_on',
  'requires_coordination',
  'blocks',
  'enables',
  'supersedes',
  'shares_resource',
  'feeds_data',
  'competes_with',
] as const;

export interface TargetDefinition {
  name: string;
  description: string;
  typicalRoles?: ReadonlyArray<TargetRole>;
  typicalImpactTypes?: ReadonlyArray<string>;
}

// ─── Canonical names ────────────────────────────────────────────────────────
// MUST stay in sync with prompts.ts. Renaming here without updating prompts.ts
// and the DB would corrupt impact rows.

export const CANONICAL_GIO_NAMES = [
  'Security & Compliance',
  'Command Center',
  'User Workplace',
  'Site Infrastructure',
  'Cloud Services',
] as const;

export const CANONICAL_DDS_NAMES = [
  // Geographic zones
  'Americas', 'Europe', 'APAC', 'AMEI',
  // Business divisions / SBUs
  'CF', 'GM&T', 'E&C', 'HC D&IT',
  'Alizent', 'GDO', 'SEPPIC', 'Airgas', 'HHC',
  // App / functional groups
  'Industrial Apps', 'Enterprise Apps', 'Data & AI Apps',
  'Digital Factory', 'InnoTech', 'CDIO Office', 'IDD',
] as const;

// ─── JSON data loader ───────────────────────────────────────────────────────

type CatalogEntryData = {
  description?: string;
  typicalRoles?: TargetRole[];
  typicalImpactTypes?: string[];
};

export type CatalogData = {
  gio: Record<string, CatalogEntryData>;
  dds: Record<string, CatalogEntryData>;
};

const DATA_PATH = path.join(process.cwd(), 'src/lib/target-catalog.data.json');

let cache: CatalogData | null = null;

function loadCatalog(): CatalogData {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf-8');
    cache = JSON.parse(raw) as CatalogData;
  } catch {
    // Missing file → empty catalog. Lookups fall back to empty descriptions,
    // matching the pre-JSON behaviour for unfilled entries.
    cache = { gio: {}, dds: {} };
  }
  return cache;
}

/** Invalidate the in-memory cache. Called by the admin API after a write so
 *  same-process callers (Impact / Deep Dive) see fresh values without a restart. */
export function reloadCatalog(): void {
  cache = null;
}

/** Persist a single entry's editable fields. Used by /api/admin/catalog. */
export function writeCatalogEntry(
  kind: TargetKind,
  name: string,
  patch: { description?: string; typicalRoles?: TargetRole[]; typicalImpactTypes?: string[] }
): void {
  if (!isCanonicalTarget(kind, name)) {
    throw new Error(`Unknown ${kind} target: ${name}`);
  }
  const data = loadCatalog();
  const existing = data[kind][name] ?? {};
  const cleaned: CatalogEntryData = {};
  const description = patch.description !== undefined ? patch.description : existing.description;
  if (description !== undefined) cleaned.description = description;
  const roles = patch.typicalRoles !== undefined ? patch.typicalRoles : existing.typicalRoles;
  if (roles && roles.length > 0) cleaned.typicalRoles = roles;
  const impactTypes = patch.typicalImpactTypes !== undefined ? patch.typicalImpactTypes : existing.typicalImpactTypes;
  if (impactTypes && impactTypes.length > 0) cleaned.typicalImpactTypes = impactTypes;
  data[kind][name] = cleaned;
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  cache = data;
}

// ─── Builders ───────────────────────────────────────────────────────────────

function buildEntry(kind: TargetKind, name: string): TargetDefinition {
  const data = loadCatalog();
  const e = data[kind][name] ?? {};
  return {
    name,
    description: e.description ?? '',
    typicalRoles: e.typicalRoles,
    typicalImpactTypes: e.typicalImpactTypes,
  };
}

/** Live view of the full catalog for a given kind. Re-reads from cache, so
 *  reflects edits after `reloadCatalog()`. */
export function getCatalog(kind: TargetKind): ReadonlyArray<TargetDefinition> {
  const names = kind === 'gio' ? CANONICAL_GIO_NAMES : CANONICAL_DDS_NAMES;
  return names.map(n => buildEntry(kind, n));
}

// Snapshots at module-init time. Useful for one-shot iteration in scripts/tests.
// For live runtime reads (Impact, Deep Dive), use `getTargetEntry` / `getCatalog`.
export const GIO_SERVICE_DEFINITIONS: ReadonlyArray<TargetDefinition> = getCatalog('gio');
export const DDS_ENTITY_DEFINITIONS: ReadonlyArray<TargetDefinition> = getCatalog('dds');

// ─── Lookup helpers ─────────────────────────────────────────────────────────

const GIO_NAME_SET = new Set<string>(CANONICAL_GIO_NAMES);
const DDS_NAME_SET = new Set<string>(CANONICAL_DDS_NAMES);

/**
 * Returns the canonical description for a target if one exists in the catalog.
 * Falls back to an empty string when:
 *   - the target name is not in the canonical list (unknown / typo), or
 *   - the description field hasn't been filled in yet.
 *
 * Callers (e.g. the Deep Dive prompt builder) should treat an empty return as
 * "no canonical definition available" and degrade to the generic kind helper.
 */
export function getTargetDefinition(kind: TargetKind, target: string): string {
  if (!isCanonicalTarget(kind, target)) return '';
  return buildEntry(kind, target).description.trim();
}

/**
 * Returns the full canonical entry (description + bias hints) for a target.
 * Used by the Goals prompt builder (Onda 3) to inject per-target context
 * inline when asking the LLM to emit `impact_claims`. Returns null when the
 * target name is not in the canonical list.
 */
export function getTargetEntry(kind: TargetKind, target: string): TargetDefinition | null {
  if (!isCanonicalTarget(kind, target)) return null;
  return buildEntry(kind, target);
}

/**
 * Used by validators in `impact-engine.ts` to reject impact_claims whose
 * `target` is not in the canonical catalog (catches LLM typos and drift).
 */
export function isCanonicalTarget(kind: TargetKind, target: string): boolean {
  return (kind === 'gio' ? GIO_NAME_SET : DDS_NAME_SET).has(target);
}

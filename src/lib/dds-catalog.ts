import { CANONICAL_DDS_NAMES, CANONICAL_GIO_NAMES } from './target-catalog';

// ─── DDS (Division / Entity) Catalog ─────────────────────────────────────────
// The canonical list of DDS entities Air Liquide projects are mapped against.
// Used by the Impact engine to emit `target='DDS_IMPACTS'` rows with a
// `dds_entities` array, mirroring how `target='GIO_SERVICES'` works for
// GIO Service Lines.

// Derived from target-catalog.ts rather than retyped. The two lists used to be
// separate copies of the same names, which is how E&C could be canonical in one
// and not the other (PLAN_PROMPTS_CATALOG_REVIEW.md §2.9 — canonical lists
// copied in six places).
export const DDS_CATALOG = CANONICAL_DDS_NAMES;

export type DdsEntity = typeof DDS_CATALOG[number];

const CATALOG_SET = new Set<string>(DDS_CATALOG);

// Aliases observed in the existing DB → canonical form. Applied at ingestion
// (impact prompt response parsing) and on the project.dds field for display.
export const DDS_ALIASES: Record<string, string> = {
  // ── Typos seen in the CDIO spreadsheet ──────────────────────────────────
  'EU': 'Europe',
  'Indutrial Apps': 'Industrial Apps',
  'Entreprise Apps': 'Enterprise Apps',
  'Digital': 'Digital Factory',
  'Digital & AI': 'Data & AI Apps',
  'CDIOO': 'CDIO Office',
  'ALIZENT': 'Alizent',

  // ── The FIT renaming wave (§3.1, items 4, 8, 9 and 12) ──────────────────
  // BIS became DDS across the group and several entities merged. Documents
  // written before the change still use the old names, so they have to resolve
  // to the entity that absorbed them — otherwise the claim is silently dropped.
  'E&C': 'InnoTech',
  'BIS E&C': 'InnoTech',
  'DDS InnoTech': 'InnoTech',
  'IDD': 'InnoTech',

  'HHC': 'HHC',
  'DDS HHC': 'HHC',
  'BIS Home Healthcare': 'HHC',
  'Home Healthcare': 'HHC',

  // ── Prefixed forms of canonical names ───────────────────────────────────
  // "DDS <entity>" appears in 33 projects and "BIS <entity>" in 6, so the bare
  // prefix has to be stripped rather than treated as an unknown entity.
  'DDS Americas': 'Americas',
  'DDS Europe': 'Europe',
  'DDS APAC': 'APAC',
  'DDS AMEI': 'AMEI',
  'DDS CF': 'CF',
  'DDS Airgas': 'Airgas',
  'DDS SEPPIC': 'SEPPIC',
  'DDS Alizent': 'Alizent',
  'DDS Industrial Apps': 'Industrial Apps',
  'DDS Enterprise Apps': 'Enterprise Apps',
  'BIS Industrial Apps': 'Industrial Apps',
  'BIS Enterprise Apps': 'Enterprise Apps',
};

/**
 * GIO service-line aliases. A SEPARATE map on purpose.
 *
 * "GIO Network & Telecom" resolves to Site Infrastructure, which is a GIO name,
 * not a DDS one. Putting it in DDS_ALIASES made normalizeDds() hand back a GIO
 * service line as though it were a DDS entity — the alias lookup returned early
 * without checking that the result belonged to the catalog it was asked about.
 * The guard below now checks that too, but the two vocabularies stay apart
 * regardless: they are different kinds of target (§3.1, item 9).
 */
export const GIO_ALIASES: Record<string, string> = {
  'GIO Network & Telecom': 'Site Infrastructure',
  'GIO N&T': 'Site Infrastructure',
  'Network & Telecom': 'Site Infrastructure',
  'GOPs': 'Command Center',
};

export function normalizeGio(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if ((CANONICAL_GIO_NAMES as readonly string[]).includes(trimmed)) return trimmed;
  const aliased = GIO_ALIASES[trimmed];
  if (aliased) return aliased;
  const lower = trimmed.toLowerCase();
  for (const c of CANONICAL_GIO_NAMES) {
    if (c.toLowerCase() === lower) return c;
  }
  return null;
}

// Trigrams are deliberately NOT aliases. Three-letter codes collide with other
// meanings in free text — "DIN" is also a German standards body — and the
// catalog review (§3.1, item 12) restricts them to structured fields such as
// spreadsheet columns and IT group names. Kept here so a future importer of
// structured data can opt in explicitly.
export const DDS_TRIGRAMS: Record<string, string> = {
  'DHC': 'HHC',
  'DIN': 'InnoTech',
  'BEC': 'InnoTech',
};

// Normalize an arbitrary DDS string to its canonical form. Returns null if the
// value cannot be reconciled to the catalog (caller decides whether to drop).
export function normalizeDds(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (CATALOG_SET.has(trimmed)) return trimmed;
  const aliased = DDS_ALIASES[trimmed];
  // The alias must land inside THIS catalog. Returning it unchecked is how a
  // GIO service line could be emitted as a DDS entity.
  if (aliased && CATALOG_SET.has(aliased)) return aliased;
  // Last-chance case-insensitive match
  const lower = trimmed.toLowerCase();
  for (const c of DDS_CATALOG) {
    if (c.toLowerCase() === lower) return c;
  }
  return null;
}

// Filter+normalize an array. Drops unknowns. Deduplicates while preserving order.
export function normalizeDdsList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const norm = normalizeDds(item);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

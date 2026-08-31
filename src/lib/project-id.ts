// Canonical form for portfolio identifiers, and the single place that decides
// what counts as one.
//
// Before this module the rule was reimplemented in seven places with divergent
// results, which is how the following got into production:
//
//   - `PRJ0001395` (from a document) and `PRJ001395` (from the CDIO sheet) were
//     treated as different projects. Measured 2026-08-31: 4 of 23 cross-project
//     references were the same project written two ways.
//   - `PRJ00XXXX`, a template placeholder, was extracted as a real project three
//     times, because the mention regex accepted any digit count and read the
//     X's as an alpha suffix.
//   - PGM programmes are matched by the Drive scanner but were dropped by the
//     impact engine, whose id test was `/^PRJ\d{4,}$/`.
//
// Canonical form: PREFIX + 7 digits (zero-padded) + optional alpha suffix,
// e.g. `PRJ0017301`, `PGM0001197`, `PRJ0012345TR`.

/** Zero-padding width. 289 of 301 ids in the CDIO sheet already use 7 digits. */
const ID_DIGITS = 7;

/**
 * Minimum digits for something to be a plausible id. Below this we are almost
 * certainly looking at a placeholder or a stray match — `PRJ00XXXX` has two.
 * Matches the threshold the impact engine already used.
 */
const MIN_DIGITS = 4;

/** `PROG` appears in the sheet as a legacy spelling of `PGM`. */
const PREFIX_ALIASES: Readonly<Record<string, string>> = {
  PRJ: 'PRJ',
  PGM: 'PGM',
  PROG: 'PGM',
};

const ID_PATTERN = /(PRJ|PGM|PROG)[\s\-_]*([0-9]+)([A-Z]{0,4})/i;
const ID_PATTERN_GLOBAL = new RegExp(ID_PATTERN.source, 'gi');

function canonicalise(prefixRaw: string, digitsRaw: string, suffixRaw: string): string | null {
  if (digitsRaw.length < MIN_DIGITS) return null;
  const digits = digitsRaw.replace(/^0+/, '');
  if (!digits) return null; // all-zero ids are placeholders, not projects
  const suffix = suffixRaw.toUpperCase();
  // `PRJ0012345XXXX` and friends: an all-X suffix is documentation boilerplate.
  if (suffix && /^X+$/.test(suffix)) return null;
  const prefix = PREFIX_ALIASES[prefixRaw.toUpperCase()] ?? prefixRaw.toUpperCase();
  return `${prefix}${digits.padStart(ID_DIGITS, '0')}${suffix}`;
}

/**
 * Canonical id for a value that is *supposed* to be one (a field, a folder
 * name, a sheet cell). Tolerates surrounding noise — `"PRJ0011825 -"` and
 * `"PGM0001197 (was PROG0019070)"` both resolve, taking the first id present.
 * Returns null when there is nothing usable, which the caller should treat as
 * "not a project reference" rather than substituting a guess.
 */
export function normalizeProjectId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(ID_PATTERN);
  if (!m) return null;
  return canonicalise(m[1], m[2], m[3] ?? '');
}

/** True when `raw` already is, or can be resolved to, a canonical id. */
export function isProjectId(raw: unknown): boolean {
  return normalizeProjectId(raw) !== null;
}

/**
 * Every distinct id mentioned anywhere in a block of free text, canonicalised.
 * `exclude` (itself canonicalised) is removed, so a document is never recorded
 * as referring to its own project.
 */
export function extractProjectIds(text: string, exclude?: string): string[] {
  if (!text) return [];
  const skip = exclude ? normalizeProjectId(exclude) : null;
  const out = new Set<string>();
  const re = new RegExp(ID_PATTERN_GLOBAL.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const id = canonicalise(m[1], m[2], m[3] ?? '');
    if (id && id !== skip) out.add(id);
  }
  return [...out];
}

/**
 * Whether two ids refer to the same project, comparing canonical forms so
 * padding and prefix-spelling differences do not read as different projects.
 */
export function sameProject(a: unknown, b: unknown): boolean {
  const na = normalizeProjectId(a);
  return na !== null && na === normalizeProjectId(b);
}

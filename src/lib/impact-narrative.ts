// Composes a human-readable "Why this matters" narrative for an impact row.
//
// Background: the LLM prompt (prompts.ts:238) sets each impact's `explanation`
// to the verbatim `evidence_quote` from the Goals extractor. That's great for
// auditability — every claim points at a real sentence in a real document —
// but when the evidence sentence happens to be a Gate Review question or a
// fragmentary statement, the "Reason for the impact" panel reads as cryptic
// noise instead of an explanation.
//
// This module re-synthesises a short narrative from the structured metadata we
// already have on every row: the source project's name + one-line summary, the
// direction, the target name (GIO service / DDS entity / other project), the
// impact type, and the severity. The verbatim quote stays in the UI as the
// "Evidence" companion field — narrative + evidence, side by side.
//
// Pure function with no I/O so it can run anywhere in the read path. The
// universe / project APIs call it once per (impact, explanation) tuple after
// they've fetched the source project's summary_one_line.

export interface NarrativeContext {
  /** Project that owns the action in the relationship. For GIO/DDS fan-outs
   *  this is always the centered project; for project-to-project edges it's
   *  the source side of the row. */
  sourceProjectName: string;
  /** One-line description of the source project (from project_goals.
   *  summary_one_line). Used as a parenthetical so a reader who lands on the
   *  card cold has enough context to act. Optional. */
  sourceSummary?: string;
  /** What the source project is impacting: a GIO service line (e.g. "User
   *  Workplace"), a DDS entity (e.g. "GDO"), or another project's name. */
  targetName: string;
  /** Direction string stored on the impact row (see prompts.ts:215-216 and
   *  231-236 for the vocabulary). Unknown values fall back to "relates to". */
  direction: string;
  /** Per-explanation impact_type (e.g. "integration_required"). Pretty-printed
   *  by replacing underscores with spaces. Optional: callers that only want
   *  the shared half of the narrative (composeNarrativeParts().shared) can
   *  leave it out, since the classifier clause is the only thing it feeds. */
  impactType?: string;
  /** Per-explanation severity: "high" | "medium" | "low" | ''. Optional for
   *  the same reason as impactType. */
  severity?: string;
}

/** composeNarrative() split at its one varying seam.
 *
 *  A GIO/DDS node (or a project edge) usually carries several explanations
 *  that share the same source project, target and direction — they differ
 *  only in impact_type / severity, which the universe panel already renders
 *  as badges. Composing the full sentence for each of them made the panel
 *  repeat an identical paragraph once per evidence quote (see the "Why this
 *  matters" duplication in the Reason tab). Splitting lets a caller render
 *  `shared` once above a group of quotes and drop `classifier` when it is
 *  already shown some other way. */
export interface NarrativeParts {
  /** Relationship sentence + project-context sentence. Identical for every
   *  explanation with the same (sourceProjectName, targetName, direction,
   *  sourceSummary) — that identity is what makes grouping safe. */
  shared: string;
  /** Impact type + severity sentence. The only part that varies per
   *  explanation. Empty when the row lost both bits of metadata. */
  classifier: string;
}

// direction → verb phrase. Built from the prompts.ts → impact-engine mappings:
//   role=primary_provider     → provides_to
//   role=downstream_consumer  → depends_on
//   role=regional_executor    → requires_coordination
//   role=risk_owner           → requires_coordination
//   role=blocked_by           → depends_on
// plus the project-relation directions emitted by the LLM:
//   shares_platform/_vendor/_resource → requires_coordination
//   blocked_by/predecessor            → depends_on
//   blocking/successor                → blocks
//   replaces                          → supersedes
//   extends                           → depends_on
// Must cover every value in IMPACT_DIRECTIONS (target-catalog.ts) — a missing
// entry silently degrades the sentence to "relates to". The extra keys below
// (blocked_by, shares_platform, shares_vendor) are not in that union; they are
// kept as tolerance for legacy rows written before the vocabulary was unified.
const DIRECTION_VERBS: Record<string, string> = {
  provides_to: 'provides services to',
  depends_on: 'depends on',
  requires_coordination: 'requires coordination with',
  blocks: 'blocks',
  enables: 'enables',
  supersedes: 'supersedes',
  shares_resource: 'shares resources with',
  feeds_data: 'feeds data to',
  competes_with: 'competes for resources with',
  // Legacy / defensive.
  blocked_by: 'is blocked by',
  shares_platform: 'shares a platform with',
  shares_vendor: 'shares a vendor with',
};

function capitalize(s: string): string {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function prettyType(t: string): string {
  return t.replace(/_/g, ' ').trim();
}

/** Trims trailing punctuation so we can append our own. */
function stripTrailing(s: string): string {
  return s.replace(/[.\s]+$/g, '');
}

/** Builds the three clauses. Shared by composeNarrative and
 *  composeNarrativeParts so both stay in sync. */
function clauses(ctx: NarrativeContext): { relation: string; classifier: string; context: string } {
  const verb = DIRECTION_VERBS[ctx.direction] ?? 'relates to';
  const source = stripTrailing(ctx.sourceProjectName || 'This project');
  const target = stripTrailing(ctx.targetName || 'an unspecified target');

  // First clause: the relationship in plain English.
  const relation = `${source} ${verb} ${target}.`;

  // Second clause: classifier (impact type + severity). Skipped if both are
  // empty — happens for legacy rows that lost the metadata.
  const typeP = ctx.impactType ? prettyType(ctx.impactType) : '';
  const sevP = ctx.severity ? `${ctx.severity} severity` : '';
  let classifier = '';
  if (typeP && sevP) classifier = `${capitalize(typeP)} (${sevP}).`;
  else if (typeP) classifier = `${capitalize(typeP)}.`;
  else if (sevP) classifier = `${capitalize(sevP)}.`;

  // Third clause: project context as a standalone sentence so it reads cleanly
  // regardless of whether the summary is a noun phrase ("A study to evaluate
  // …") or a verb-led sentence ("Provides workforce identity capabilities
  // …"). We don't try to weave it into the first clause — past attempts at
  // "<source> is <summary>" broke for verb-led summaries.
  let context = '';
  if (ctx.sourceSummary && ctx.sourceSummary.trim()) {
    context = stripTrailing(ctx.sourceSummary.trim()) + '.';
  }

  return { relation, classifier, context };
}

export function composeNarrative(ctx: NarrativeContext): string {
  const { relation, classifier, context } = clauses(ctx);
  return [relation, classifier, context].filter(Boolean).join(' ');
}

/** Same content as composeNarrative, split so the varying classifier clause
 *  can be rendered (or dropped) separately from the part that repeats. */
export function composeNarrativeParts(ctx: NarrativeContext): NarrativeParts {
  const { relation, classifier, context } = clauses(ctx);
  return {
    shared: [relation, context].filter(Boolean).join(' '),
    classifier,
  };
}

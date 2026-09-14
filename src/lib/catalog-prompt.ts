/**
 * Renders the target catalog into prompt text.
 *
 * WHY: the canonical names were typed by hand inside the prompts, and again in
 * target-catalog.ts, and again in dds-catalog.ts — PLAN_PROMPTS_CATALOG_REVIEW.md
 * §2.9 counted six copies. They drifted: `E&C` stayed canonical in the prompt
 * long after the business merged it into InnoTech, so the model kept emitting a
 * target the normaliser then dropped on the floor.
 *
 * With this module the prompt asks for a placeholder and the list is generated
 * from the one catalog that the admin screen also edits. Editing an entity in
 * /admin/catalog now changes what the model is told, which is the whole point of
 * having a catalog (§2.3 — "o catálogo não chega a quem decide").
 */
import { getCatalog, type TargetDefinition, type TargetKind } from './target-catalog';

/** One card. Only the fields that are filled appear — a card padded with empty
 *  headings teaches the model that empty is normal. */
function renderCard(e: TargetDefinition): string {
  const lines: string[] = [`- **${e.name}**`];

  const scope = e.scope?.trim() || e.description?.trim();
  if (scope) lines.push(`  scope: ${scope}`);

  if (e.signals?.length) lines.push(`  signals: ${e.signals.join(', ')}`);

  if (e.aliases?.length) {
    lines.push(`  also written as: ${e.aliases.join(', ')} — map these to "${e.name}"`);
  }

  // The distinguishing rule goes last because it is what the model reads just
  // before deciding, and it is the field that fixes the confusions we measured.
  for (const n of e.notThis ?? []) lines.push(`  NOT this: ${n}`);

  if (e.parent) {
    lines.push(`  part of ${e.parent} — claim "${e.name}", never both`);
  }

  // `notes` is deliberately absent: it is written for humans maintaining the
  // catalog ("parent not confirmed"), and feeding the model our open questions
  // invites it to hedge.
  return lines.join('\n');
}

export function renderCatalogCards(kind: TargetKind): string {
  return getCatalog(kind).map(renderCard).join('\n\n');
}

/** Comma-separated canonical names, for the places that need just the list. */
export function canonicalNameList(kind: TargetKind): string {
  return getCatalog(kind).map(e => `"${e.name}"`).join(', ');
}

/** The full catalog block substituted into {{CATALOG_CARDS}}. */
export function renderCatalogBlock(): string {
  return [
    'GIO SERVICE LINES — the five infrastructure service lines. Use these EXACT names:',
    '',
    renderCatalogCards('gio'),
    '',
    'DDS ENTITIES — Digital Delivery Services organisational entities. Use these EXACT names:',
    '',
    renderCatalogCards('dds'),
  ].join('\n');
}

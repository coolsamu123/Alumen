import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getCatalog, type TargetKind } from '@/lib/target-catalog';
import { DDS_ALIASES, DDS_TRIGRAMS, GIO_ALIASES } from '@/lib/dds-catalog';

/**
 * The entity atlas, generated rather than written.
 *
 * ATLAS_ENTIDADES.md exists as prose and says of itself that org charts go
 * stale. It was right: written before Fase C, it already claims the catalog
 * "still has the old text" and that three acronym fixes are pending — both
 * untrue since the rewrite. A second hand-maintained copy of the catalog would
 * drift the same way within weeks.
 *
 * So everything here derives from the two things that are already kept current:
 * the catalog (scope, signals, notThis, parent, aliases) and the database
 * (how much each entity is actually used). Editing an entity in /admin/catalog
 * updates this page; nothing to remember.
 *
 * Open to any signed-in user: it is reference material, read-only, and the
 * counts are aggregates that anyone who can see the portfolio can already
 * reach. Deliberately NOT under /api/admin, which middleware.ts closes.
 */
export const dynamic = 'force-dynamic';

interface Usage {
  owners: number;   // projects whose owning entity is this one
  claims: number;   // anchored claims pointing at it
  touched: number;  // projects marking it as affected
}

function countUsage(kind: TargetKind, names: readonly string[]): Map<string, Usage> {
  const db = getDb();
  const out = new Map<string, Usage>(
    names.map(n => [n, { owners: 0, claims: 0, touched: 0 }])
  );

  if (kind === 'dds') {
    try {
      const rows = db.prepare(
        `SELECT TRIM(dds) AS name, COUNT(DISTINCT project_id) AS n
         FROM projects WHERE TRIM(COALESCE(dds,'')) <> '' GROUP BY TRIM(dds)`
      ).all() as Array<{ name: string; n: number }>;
      for (const r of rows) {
        const e = out.get(r.name);
        if (e) e.owners = r.n;
      }
    } catch { /* tabela pode não existir */ }
  }

  // Claims e "touched" saem do JSON gravado, não de colunas indexáveis, então
  // a contagem é feita em memória — são ~70 linhas, não vale um índice.
  try {
    const rows = db.prepare(
      `SELECT impact_claims, dds_entities_touched, gio_services_touched
       FROM project_goals WHERE status = 'success'`
    ).all() as Array<{
      impact_claims: string | null;
      dds_entities_touched: string | null;
      gio_services_touched: string | null;
    }>;

    for (const r of rows) {
      let claims: Array<{ target_kind?: string; target?: string }> = [];
      try { claims = JSON.parse(r.impact_claims || '[]'); } catch { /* ignora */ }
      for (const c of claims) {
        if (c?.target_kind !== kind) continue;
        const e = out.get(String(c.target ?? ''));
        if (e) e.claims++;
      }

      const raw = kind === 'dds' ? r.dds_entities_touched : r.gio_services_touched;
      let touched: string[] = [];
      try { touched = JSON.parse(raw || '[]'); } catch { /* ignora */ }
      for (const t of new Set(touched)) {
        const e = out.get(String(t));
        if (e) e.touched++;
      }
    }
  } catch { /* tabela pode não existir */ }

  return out;
}

export async function GET() {
  try {
    const build = (kind: TargetKind) => {
      const entries = getCatalog(kind);
      const usage = countUsage(kind, entries.map(e => e.name));
      return entries.map(e => ({
        ...e,
        usage: usage.get(e.name) ?? { owners: 0, claims: 0, touched: 0 },
      }));
    };

    // Tabela de consulta de nomes antigos, com a distinção que importa: trigrama
    // vale só em campo estruturado, porque sigla de três letras colide com
    // outra coisa — "DIN" também é a norma técnica alemã.
    const oldNames = [
      ...Object.entries(DDS_ALIASES).map(([from, to]) => ({ from, to, scope: 'free text and structured fields' })),
      ...Object.entries(GIO_ALIASES).map(([from, to]) => ({ from, to, scope: 'free text and structured fields' })),
      ...Object.entries(DDS_TRIGRAMS).map(([from, to]) => ({ from, to, scope: 'structured fields only' })),
    ].sort((a, b) => a.from.localeCompare(b.from));

    return NextResponse.json({
      gio: build('gio'),
      dds: build('dds'),
      oldNames,
      generatedAt: new Date().toISOString(),
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

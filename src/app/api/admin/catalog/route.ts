import { NextRequest, NextResponse } from 'next/server';
import {
  CANONICAL_GIO_NAMES,
  CANONICAL_DDS_NAMES,
  IMPACT_TYPES,
  TARGET_ROLES,
  type TargetKind,
  type TargetRole,
  getCatalog,
  reloadCatalog,
  writeCatalogEntry,
  isCanonicalTarget,
} from '@/lib/target-catalog';
import { requireAdmin, isSessionError } from '@/lib/auth';

const ROLE_SET = new Set<string>(TARGET_ROLES);

// Defense-in-depth: src/middleware.ts already gates /api/admin/* on an admin
// session before this route runs. This is the same check at the route level,
// using the authoritative session (rereads is_active/token_version from
// SQLite), so a misconfigured middleware can't expose the API on its own.
async function guard(): Promise<NextResponse | null> {
  const session = await requireAdmin();
  if (isSessionError(session)) {
    return NextResponse.json({ error: session.error }, { status: session.status });
  }
  return null;
}

export async function GET() {
  const blocked = await guard();
  if (blocked) return blocked;

  reloadCatalog();
  return NextResponse.json({
    gio: getCatalog('gio'),
    dds: getCatalog('dds'),
    vocab: {
      roles: TARGET_ROLES,
      impactTypes: IMPACT_TYPES,
    },
    canonical: {
      gio: CANONICAL_GIO_NAMES,
      dds: CANONICAL_DDS_NAMES,
    },
  });
}

export async function PATCH(request: NextRequest) {
  const blocked = await guard();
  if (blocked) return blocked;

  try {
    const body = await request.json() as {
      kind?: string;
      name?: string;
      description?: string;
      typicalRoles?: string[];
      typicalImpactTypes?: string[];
    };

    if (body.kind !== 'gio' && body.kind !== 'dds') {
      return NextResponse.json({ error: 'kind must be "gio" or "dds"' }, { status: 400 });
    }
    const kind = body.kind as TargetKind;
    if (typeof body.name !== 'string' || !isCanonicalTarget(kind, body.name)) {
      return NextResponse.json({ error: `Unknown ${kind} target: ${body.name}` }, { status: 400 });
    }

    const patch: { description?: string; typicalRoles?: TargetRole[]; typicalImpactTypes?: string[] } = {};
    if (typeof body.description === 'string') {
      patch.description = body.description.trim();
    }
    if (Array.isArray(body.typicalRoles)) {
      const invalid = body.typicalRoles.find(r => !ROLE_SET.has(r));
      if (invalid) {
        return NextResponse.json({ error: `Invalid role: ${invalid}` }, { status: 400 });
      }
      // Dedup, preserve order.
      const seen = new Set<string>();
      patch.typicalRoles = body.typicalRoles.filter(r => {
        if (seen.has(r)) return false;
        seen.add(r);
        return true;
      }) as TargetRole[];
    }
    if (Array.isArray(body.typicalImpactTypes)) {
      // impact_type is intentionally not enum-validated server-side: prompts.ts
      // documents 11 canonical values but the schema is a free-form string and
      // the LLM occasionally emits adjacent variants we want to allow as hints.
      const seen = new Set<string>();
      patch.typicalImpactTypes = body.typicalImpactTypes
        .filter(s => typeof s === 'string' && s.trim().length > 0)
        .map(s => s.trim())
        .filter(s => {
          if (seen.has(s)) return false;
          seen.add(s);
          return true;
        });
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
    }

    writeCatalogEntry(kind, body.name, patch);

    const updated = getCatalog(kind).find(e => e.name === body.name);
    return NextResponse.json({ success: true, entry: updated });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

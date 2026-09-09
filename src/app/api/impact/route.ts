import { NextRequest, NextResponse } from 'next/server';
import {
  runFullImpactAnalysis,
  getImpactStatus,
  getAllImpacts,
  aggregateImpacts,
  clearAllImpacts,
} from '@/lib/impact-engine';
import { isAnonymousExternal } from '@/lib/public-host';
import { getSession } from '@/lib/auth';
import { getVisibleProjectIds, isImpactEndpointVisible } from '@/lib/access';

// Destructive / expensive actions (start a Gemini run, wipe stored impacts)
// must not be triggerable from the public hostname unless the caller has
// passed the Basic Auth challenge in src/middleware.ts. Anonymous external
// callers are rejected; authed externals and localhost go through. Read-only
// "status" (GET below) stays open to everyone.
function rejectFromPublic(request: NextRequest): NextResponse | null {
  if (isAnonymousExternal(request.headers)) {
    return NextResponse.json(
      { error: 'This action is not available on the public endpoint.' },
      { status: 403 },
    );
  }
  return null;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const raw = searchParams.get('raw') === '1';

    const rawImpacts = getAllImpacts();
    const aggregated = raw ? rawImpacts : aggregateImpacts(rawImpacts);
    const status = getImpactStatus();

    // An edge only survives if BOTH endpoints are visible. Under this scope
    // model that's not about secrecy (§2.1) — it's that an edge pointing at a
    // project missing from the list is a render bug: a dangling Graph node, a
    // Matrix column with no row (§2.3).
    const session = await getSession();
    const visible = getVisibleProjectIds(session);
    const impacts =
      visible === 'ALL'
        ? aggregated
        : aggregated.filter(
            imp =>
              isImpactEndpointVisible(imp.sourceProjectId, visible) &&
              isImpactEndpointVisible(imp.targetProjectId, visible)
          );

    // Stats reflect the returned set (one entry per pair when aggregated).
    const bySeverity: Record<string, number> = {};
    const byType: Record<string, number> = {};
    const byDirection: Record<string, number> = {};

    for (const imp of impacts) {
      bySeverity[imp.severity] = (bySeverity[imp.severity] || 0) + 1;
      for (const t of imp.impactTypes ?? [imp.impactType]) {
        byType[t] = (byType[t] || 0) + 1;
      }
      for (const d of imp.directions ?? [imp.direction]) {
        byDirection[d] = (byDirection[d] || 0) + 1;
      }
    }

    // Same scope rule applied to the pre-aggregation count — otherwise a
    // scoped user would see e.g. "total: 12" next to "rawTotal: 500", which
    // is exactly the "counter that doesn't match the list" bug §2.1 warns
    // about, just on the raw side instead of the aggregated one.
    const rawTotal =
      visible === 'ALL'
        ? rawImpacts.length
        : rawImpacts.filter(
            imp =>
              isImpactEndpointVisible(imp.sourceProjectId, visible) &&
              isImpactEndpointVisible(imp.targetProjectId, visible)
          ).length;

    return NextResponse.json({
      impacts,
      stats: {
        total: impacts.length,
        rawTotal,
        bySeverity,
        byType,
        byDirection,
      },
      status,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const action = body.action;

    if (action === 'status') {
      const status = getImpactStatus();
      return NextResponse.json({ status });
    }

    if (action === 'clear') {
      const blocked = rejectFromPublic(request);
      if (blocked) return blocked;
      const status = getImpactStatus();
      if (status.isRunning) {
        return NextResponse.json(
          { error: 'Cannot clear impacts while an analysis is running', status },
          { status: 409 }
        );
      }
      const deleted = clearAllImpacts();
      return NextResponse.json({
        message: `Cleared ${deleted} impacts`,
        deleted,
        status: getImpactStatus(),
      });
    }

    if (action === 'start') {
      const blocked = rejectFromPublic(request);
      if (blocked) return blocked;
      const status = getImpactStatus();
      if (status.isRunning) {
        return NextResponse.json(
          { error: 'Analysis is already running', status },
          { status: 409 }
        );
      }

      // Fire and forget — runs in background
      runFullImpactAnalysis().catch((err) => {
        console.error('Impact analysis failed:', err);
      });

      // Return immediately with initial status
      const newStatus = getImpactStatus();
      return NextResponse.json({
        message: 'Impact analysis started',
        status: newStatus,
      });
    }

    return NextResponse.json(
      { error: 'Invalid action. Use "start", "status", or "clear".' },
      { status: 400 }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

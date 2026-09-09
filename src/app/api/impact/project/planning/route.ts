import { NextRequest, NextResponse } from 'next/server';
import { getOrGeneratePlanning, getCachedPlanning } from '@/lib/project-planning-engine';

// POST — get-or-generate the Project Planning panel data (timeline, gates,
// actions, CAPEX/OPEX) for a single project.
// Body: { projectId: string, force?: boolean }

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { projectId?: string; force?: boolean };
    const { projectId, force } = body;

    if (!projectId) {
      return NextResponse.json({ error: 'Missing required field: projectId' }, { status: 400 });
    }

    const result = await getOrGeneratePlanning({ projectId, force: force === true });
    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// GET — cached-only (no LLM call). Always includes deterministic gates/cost
// from the CDIO sheet even when nothing has been generated yet; the UI reads
// `generatedAt`/`hasDocuments` to decide whether to offer a "Generate" CTA.
// Query: ?projectId=PRJ...

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId');
    if (!projectId) {
      return NextResponse.json({ error: 'Missing required query: projectId' }, { status: 400 });
    }
    const result = getCachedPlanning(projectId);
    if (!result) {
      return NextResponse.json({ error: `Project ${projectId} not found` }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

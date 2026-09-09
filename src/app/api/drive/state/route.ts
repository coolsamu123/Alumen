import { NextResponse } from 'next/server';
import { buildDrivePanelState } from '@/lib/drive-panel-state';

// Reads mutable state — must not be prerendered at build time. See the note in
// api/drive/projects/route.ts.
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json(buildDrivePanelState());
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

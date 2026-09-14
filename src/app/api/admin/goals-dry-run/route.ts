import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isSessionError } from '@/lib/auth';
import { dryRunGoals } from '@/lib/goals-analyzer';

// Roda a extração de um projeto sem gravar. Serve à validação da Fase D: medir
// o prompt novo no conjunto de referência antes de subir GOALS_PROMPT_VERSION,
// que reprocessa o portfólio inteiro.
//
// Admin-only e uma chamada de LLM por requisição — por isso não fica sob
// /api/strom, que usuário básico alcança.
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const session = await requireAdmin();
  if (isSessionError(session)) {
    return NextResponse.json({ error: session.error }, { status: session.status });
  }
  const projectId = request.nextUrl.searchParams.get('projectId');
  if (!projectId) {
    return NextResponse.json({ error: 'projectId é obrigatório' }, { status: 400 });
  }
  try {
    return NextResponse.json(await dryRunGoals(projectId));
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

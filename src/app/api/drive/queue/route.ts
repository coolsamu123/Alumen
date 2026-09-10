import { NextResponse } from 'next/server';
import { requireAdmin, isSessionError } from '@/lib/auth';
import { readQueue, readHeartbeat, enqueue, pruneQueue } from '@/lib/alumen-queue';

// Sob /api/drive de propósito: middleware.ts trata esse prefixo como admin-only,
// e enfileirar cópia é ação, não leitura. A tela de Data Flow que o usuário
// básico vê continua em /api/strom/dataflow-state, que é só leitura.
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await requireAdmin();
  if (isSessionError(session)) {
    return NextResponse.json({ error: session.error }, { status: session.status });
  }
  try {
    // Reconcilia antes de responder: o plano define que quem tira item da fila
    // é o Alumen, ao ver o projeto aparecer na planilha de controle — não o
    // Apps Script. Depender do botão manual deixaria a fila mentindo até
    // alguém clicar. pruneQueue() só escreve quando há algo a remover, então o
    // caso normal continua sendo leitura pura.
    await pruneQueue().catch(() => 0);
    const [queue, heartbeat] = await Promise.all([readQueue(), readHeartbeat()]);
    return NextResponse.json({ ok: true, queue, heartbeat });
  } catch (err: unknown) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 200 }
    );
  }
}

export async function POST(request: Request) {
  const session = await requireAdmin();
  if (isSessionError(session)) {
    return NextResponse.json({ error: session.error }, { status: session.status });
  }

  let projectId = '';
  try {
    const body = (await request.json()) as { projectId?: string };
    projectId = String(body.projectId ?? '').trim();
  } catch {
    return NextResponse.json({ ok: false, error: 'JSON inválido' }, { status: 400 });
  }
  if (!projectId) {
    return NextResponse.json({ ok: false, error: 'projectId é obrigatório' }, { status: 400 });
  }

  try {
    const result = await enqueue(projectId, session.email);
    return NextResponse.json({ ok: true, ...result });
  } catch (err: unknown) {
    // O erro cru do Google importa: um 403 aqui nomeia a service account que
    // precisa de acesso de escrita na pasta Copy Utility.
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 200 }
    );
  }
}

/** Limpa da fila o que já chegou na planilha de controle. */
export async function DELETE() {
  const session = await requireAdmin();
  if (isSessionError(session)) {
    return NextResponse.json({ error: session.error }, { status: session.status });
  }
  try {
    const removed = await pruneQueue();
    return NextResponse.json({ ok: true, removed });
  } catch (err: unknown) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 200 }
    );
  }
}

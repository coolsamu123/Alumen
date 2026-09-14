import { NextResponse } from 'next/server';
import { getPromptsState, savePrompts, resetPrompts } from '@/lib/prompts';

export async function GET() {
  try {
    // Returns the two strings as before, plus where they came from. A caller
    // that only reads goalsPrompt/impactPrompt keeps working; the admin screen
    // uses `source` and `supersededFrom` to say when a saved override stopped
    // being used because the prompt in code moved past it.
    const prompts = getPromptsState();
    return NextResponse.json(prompts);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { goalsPrompt?: unknown; impactPrompt?: unknown };
    if (typeof body.goalsPrompt !== 'string' || typeof body.impactPrompt !== 'string') {
      return NextResponse.json(
        { error: 'goalsPrompt and impactPrompt must both be strings' },
        { status: 400 }
      );
    }
    // savePrompts stamps the current GOALS_PROMPT_VERSION, which is what lets a
    // later bump in code supersede this override instead of being shadowed by it.
    savePrompts({ goalsPrompt: body.goalsPrompt, impactPrompt: body.impactPrompt });
    return NextResponse.json({ success: true, ...getPromptsState() });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Discard the override and go back to the prompts in code. */
export async function DELETE() {
  try {
    resetPrompts();
    return NextResponse.json({ success: true, ...getPromptsState() });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

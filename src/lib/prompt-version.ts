/**
 * The Goals prompt version, alone in its own module.
 *
 * It lives here because both `goals-analyzer.ts` (which decides whether a
 * project must be reanalysed) and `prompts.ts` (which decides with WHAT TEXT)
 * need it. Importing it from goals-analyzer created a cycle —
 * goals-analyzer → prompts → goals-analyzer — that TypeScript accepts and the
 * module loader resolves by handing one side a partially-initialised module.
 * A version constant read as `undefined` at init would have made every override
 * look superseded, or none of them, depending on load order.
 *
 * Bumping this reprocesses the whole portfolio. See PLAN_PROMPTS_CATALOG_REVIEW.md
 * §4 Fase D before changing it.
 */
export const GOALS_PROMPT_VERSION = 4;

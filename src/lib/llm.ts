import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import path from 'path';
import { getDb } from './db';

export type LLMProvider = 'gemini';
export type ModelSlot = 'fast' | 'pro';
export type OutputLanguage = 'en' | 'fr';

export class LLMCapExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMCapExceededError';
  }
}

const DEFAULT_DAILY_CAP = 500;
const DEFAULT_MODEL = 'gemini-3-pro';
const DEFAULT_OUTPUT_LANGUAGE: OutputLanguage = 'en';
const CONFIG_PATH = path.join(process.cwd(), 'config.json');

interface AppConfig {
  geminiApiKey?: string;
  model?: string;
  outputLanguage?: OutputLanguage;
}

// Appended to every prompt when outputLanguage='fr'. We intentionally do NOT
// rewrite the long extraction templates in prompts.ts — the schemas + canonical
// names there are contracts between code and LLM. The directive below targets
// only free-form fields the user reads; JSON keys, enums, and catalog names
// must stay in English so downstream parsing/validation keeps working.
const FR_OUTPUT_DIRECTIVE = `

OUTPUT LANGUAGE DIRECTIVE — READ CAREFULLY:
Write every free-form text field value in French (français), including
all natural-language explanations, summaries, narratives, and impact
descriptions. Use standard professional French, no Anglicisms unless
the term is a fixed industry standard (e.g. "ERP", "API", "SSO").

DO NOT translate any of the following — they MUST appear exactly as
specified in the schema above:
- JSON keys (e.g. "summary_one_line", "gio_services_touched")
- Enum values (e.g. "primary_provider", "infrastructure_shared",
  "high"/"low", "stated"/"inferred")
- Canonical GIO service line names ("Security & Compliance",
  "Command Center", "User Workplace", "Site Infrastructure",
  "Cloud Services")
- Canonical DDS entity names ("Americas", "Europe", "APAC", "AMEI",
  "CF", "GM&T", "E&C", "HC D&IT", "Alizent", "GDO", "SEPPIC",
  "Airgas", "HHC", "Industrial Apps", "Enterprise Apps",
  "Data & AI Apps", "Digital Factory", "InnoTech", "CDIO Office",
  "IDD")
- Tech tags, vendor names, data classification codes (lowercase-
  hyphenated values from the catalog)
- PRJ project IDs (e.g. "PRJ0010712")
- evidence_quote contents: copy them VERBATIM from the source
  document. If the source paragraph is in English, the quote stays
  in English; if in French, it stays in French. Never paraphrase
  and never translate quotes.`;

function normalizeLanguage(value: unknown): OutputLanguage {
  return value === 'fr' ? 'fr' : 'en';
}

let cachedConfig: { mtimeMs: number; config: AppConfig } | null = null;

function readConfig(): AppConfig {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    if (cachedConfig && cachedConfig.mtimeMs === stat.mtimeMs) {
      return cachedConfig.config;
    }
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as AppConfig;
    cachedConfig = { mtimeMs: stat.mtimeMs, config: parsed };
    return parsed;
  } catch {
    return {};
  }
}

function getDailyCap(): number {
  const raw = process.env.STROM_LLM_DAILY_CAP;
  if (!raw) return DEFAULT_DAILY_CAP;
  const n = parseInt(raw, 10);
  return isNaN(n) || n < 0 ? DEFAULT_DAILY_CAP : n;
}

function todayCountSinceMidnightLocal(): number {
  const db = getDb();
  // SQLite's date('now') is UTC; the host runs UTC on this VM, so this is fine.
  const row = db.prepare(
    "SELECT COUNT(*) c FROM llm_calls WHERE substr(called_at, 1, 10) = date('now')"
  ).get() as { c: number };
  return row.c;
}

export function getTodayLLMStats(): {
  date: string;
  total: number;
  cap: number;
  remaining: number;
  byContext: Record<string, number>;
  byProvider: Record<string, number>;
  errors: number;
} {
  const db = getDb();
  const cap = getDailyCap();
  const totalRow = db.prepare(
    "SELECT COUNT(*) c FROM llm_calls WHERE substr(called_at, 1, 10) = date('now')"
  ).get() as { c: number };
  const errorsRow = db.prepare(
    "SELECT COUNT(*) c FROM llm_calls WHERE substr(called_at, 1, 10) = date('now') AND status = 'error'"
  ).get() as { c: number };
  const byContextRows = db.prepare(
    "SELECT COALESCE(NULLIF(context, ''), '(unspecified)') AS k, COUNT(*) AS c FROM llm_calls WHERE substr(called_at, 1, 10) = date('now') GROUP BY k"
  ).all() as { k: string; c: number }[];
  const byProviderRows = db.prepare(
    "SELECT provider AS k, COUNT(*) AS c FROM llm_calls WHERE substr(called_at, 1, 10) = date('now') GROUP BY k"
  ).all() as { k: string; c: number }[];
  const dateRow = db.prepare("SELECT date('now') AS d").get() as { d: string };

  return {
    date: dateRow.d,
    total: totalRow.c,
    cap,
    remaining: Math.max(0, cap - totalRow.c),
    byContext: Object.fromEntries(byContextRows.map(r => [r.k, r.c])),
    byProvider: Object.fromEntries(byProviderRows.map(r => [r.k, r.c])),
    errors: errorsRow.c,
  };
}

function recordLLMCall(args: {
  provider: LLMProvider;
  model: string;
  context: string;
  status: 'success' | 'error';
  durationMs: number;
  errorMessage?: string;
}) {
  const db = getDb();
  db.prepare(`
    INSERT INTO llm_calls (provider, model, context, status, duration_ms, error_message)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    args.provider,
    args.model,
    args.context,
    args.status,
    args.durationMs,
    args.errorMessage || '',
  );
}

export function getActiveProvider(): LLMProvider {
  return 'gemini';
}

export function resolveModelName(_slot: ModelSlot, _provider: LLMProvider = 'gemini'): string {
  return readConfig().model || DEFAULT_MODEL;
}

/**
 * Returns the currently configured output language for LLM responses and the
 * UI. Reads `config.json` on every call (cached by mtime inside `readConfig`),
 * so flipping the value in admin takes effect immediately for new requests.
 */
export function getActiveOutputLanguage(): OutputLanguage {
  return normalizeLanguage(readConfig().outputLanguage) || DEFAULT_OUTPUT_LANGUAGE;
}

function getApiKey(): string {
  const fromConfig = readConfig().geminiApiKey;
  const key = (fromConfig && fromConfig.trim()) || process.env.GEMINI_API_KEY;
  if (!key || key === 'your_gemini_api_key_here') {
    throw new Error('geminiApiKey not set in config.json');
  }
  return key;
}

export interface GenerateContentParams {
  prompt: string;
  model?: ModelSlot;
  json?: boolean;
  /**
   * Tag identifying which feature triggered this call (e.g. 'goals', 'impact',
   * 'pairwise', 'cluster', 'document', 'admin-test'). Used for the daily-cap
   * accounting and the stats panel. Defaults to 'unspecified'.
   */
  context?: string;
  /**
   * Sampling temperature. Defaults to the model's default. Pass a low value
   * (e.g. 0.2–0.3) for analytical tasks where determinism matters more than
   * variety (deep-dive, impact, goals).
   */
  temperature?: number;
  /**
   * Language for free-form fields in the response. When 'fr', the FR output
   * directive is appended to the prompt. Defaults to the value in config.json
   * (`outputLanguage`), then 'en'. Canonical names, enums, and JSON keys are
   * NEVER translated — see FR_OUTPUT_DIRECTIVE.
   */
  outputLanguage?: OutputLanguage;
}

export interface GenerateContentResult {
  text: string;
  provider: LLMProvider;
  modelUsed: string;
  outputLanguage: OutputLanguage;
}

export async function generateContent({
  prompt,
  model = 'fast',
  json = false,
  context = 'unspecified',
  temperature,
  outputLanguage,
}: GenerateContentParams): Promise<GenerateContentResult> {
  const provider: LLMProvider = 'gemini';
  const modelName = resolveModelName(model, provider);
  const lang = outputLanguage ?? getActiveOutputLanguage();

  // Daily cap check — runs before the API call so a runaway loop can't blow past the budget.
  const cap = getDailyCap();
  if (cap > 0) {
    const used = todayCountSinceMidnightLocal();
    if (used >= cap) {
      throw new LLMCapExceededError(
        `Daily LLM call cap reached (${used}/${cap}). Set STROM_LLM_DAILY_CAP to raise it.`
      );
    }
  }

  const finalPrompt = lang === 'fr' ? prompt + FR_OUTPUT_DIRECTIVE : prompt;

  const startedAt = Date.now();
  try {
    const text = await callGemini(finalPrompt, modelName, json, temperature);

    recordLLMCall({
      provider, model: modelName, context, status: 'success',
      durationMs: Date.now() - startedAt,
    });

    return { text, provider, modelUsed: modelName, outputLanguage: lang };
  } catch (err: unknown) {
    recordLLMCall({
      provider, model: modelName, context, status: 'error',
      durationMs: Date.now() - startedAt,
      errorMessage: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
    });
    throw err;
  }
}

async function callGemini(prompt: string, modelName: string, json: boolean, temperature?: number): Promise<string> {
  const apiKey = getApiKey();
  const genAI = new GoogleGenerativeAI(apiKey);
  const generationConfig: Record<string, unknown> = {};
  if (json) generationConfig.responseMimeType = 'application/json';
  if (typeof temperature === 'number') generationConfig.temperature = temperature;
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: Object.keys(generationConfig).length ? generationConfig : undefined,
  });
  const result = await model.generateContent(prompt);
  return result.response.text();
}

export async function pingProvider(): Promise<{ provider: LLMProvider; model: string; reply: string }> {
  const provider: LLMProvider = 'gemini';
  const modelName = resolveModelName('fast', provider);
  const expected = `Gemini connection OK. Model: ${modelName}.`;
  const { text } = await generateContent({
    prompt: `Reply with exactly: "${expected}" Nothing else.`,
    model: 'fast',
    context: 'admin-test',
    // Force EN so the equality check below works regardless of admin's choice.
    outputLanguage: 'en',
  });
  return { provider, model: modelName, reply: text.trim() };
}

export function isGeminiConfigured(): boolean {
  try {
    getApiKey();
    return true;
  } catch {
    return false;
  }
}

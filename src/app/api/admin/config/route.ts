import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getDb } from '@/lib/db';

const CONFIG_PATH = path.join(process.cwd(), 'config.json');

const PLACEHOLDER_KEYS = new Set([
  'your_gemini_api_key_here',
]);

type OutputLanguage = 'en' | 'fr';

interface AppConfig {
  geminiApiKey?: string;
  model?: string;
  outputLanguage?: OutputLanguage;
}

function normalizeLanguage(value: unknown): OutputLanguage {
  return value === 'fr' ? 'fr' : 'en';
}

function readConfig(): AppConfig {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as AppConfig;
  } catch {
    return {};
  }
}

function writeConfig(next: AppConfig) {
  const merged = { ...readConfig(), ...next };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
}

function maskKey(key: string | undefined): string {
  if (!key || PLACEHOLDER_KEYS.has(key)) return 'Not configured';
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '****' + key.slice(-4);
}

function isConfigured(key: string | undefined): boolean {
  return !!key && !PLACEHOLDER_KEYS.has(key);
}

export async function GET() {
  const cfg = readConfig();
  const geminiKey = cfg.geminiApiKey;

  const db = getDb();
  const analyses = (db.prepare('SELECT COUNT(*) as count FROM analysis_cache').get() as { count: number }).count;
  const documents = (db.prepare('SELECT COUNT(*) as count FROM documents_cache').get() as { count: number }).count;

  return NextResponse.json({
    provider: 'gemini',
    model: cfg.model || 'gemini-3-pro',
    outputLanguage: normalizeLanguage(cfg.outputLanguage),
    apiKeyMasked: maskKey(geminiKey),
    isConfigured: isConfigured(geminiKey),
    keys: {
      gemini: { masked: maskKey(geminiKey), isConfigured: isConfigured(geminiKey) },
    },
    stats: { analyses, documents },
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { apiKey?: string; model?: string; outputLanguage?: string };

    const patch: AppConfig = {};
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
      patch.geminiApiKey = body.apiKey.trim();
    }
    if (typeof body.model === 'string' && body.model.trim()) {
      patch.model = body.model.trim();
    }
    if (body.outputLanguage !== undefined) {
      patch.outputLanguage = normalizeLanguage(body.outputLanguage);
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
    }

    writeConfig(patch);
    const after = readConfig();

    return NextResponse.json({
      success: true,
      provider: 'gemini',
      apiKeyMasked: maskKey(patch.geminiApiKey ?? after.geminiApiKey),
      outputLanguage: normalizeLanguage(after.outputLanguage),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

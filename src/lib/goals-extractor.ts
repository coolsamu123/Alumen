import fs from 'fs';
import path from 'path';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';

/**
 * Character budget for one project's documents.
 *
 * Was 80 000, a figure inherited from a much smaller context window. Measured
 * across the 61 extracted projects on 2026-08-31:
 *
 *   11 of 61 projects (18%) exceeded it
 *   2 900 588 chars of source text in total
 *   670 458 of those — 23% — were never shown to the model
 *
 * The worst case was PRJ0020336 at 225 843 chars, losing 65% of its material;
 * PRJ0010712, which the impact analysis shows connecting to four other
 * projects, was losing 63%. The median project sits at 33 383 chars and is
 * unaffected either way.
 *
 * 300 000 chars is roughly 75k tokens — comfortable for a model with a
 * million-token window, covers every project in the current portfolio with
 * headroom, and leaves the ranking + truncation below as the safety net for
 * genuinely oversized ones. Tune with STROM_GOALS_MAX_CHARS.
 */
const MAX_TEXT_LENGTH = (() => {
  const raw = parseInt(process.env.STROM_GOALS_MAX_CHARS || '', 10);
  return Number.isFinite(raw) && raw >= 10_000 ? raw : 300_000;
})();

export async function extractText(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath);

  try {
    if (ext === '.docx') {
      return await extractDocx(filePath, fileName);
    } else if (ext === '.xlsx') {
      return extractXlsx(filePath, fileName);
    } else if (ext === '.pdf') {
      return await extractPdf(filePath, fileName);
    } else if (ext === '.txt' || ext === '.csv') {
      return extractTxt(filePath, fileName);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[Error extracting ${fileName}: ${msg}]`;
  }

  return '';
}

async function extractDocx(filePath: string, fileName: string): Promise<string> {
  const buffer = fs.readFileSync(filePath);
  const result = await mammoth.extractRawText({ buffer });
  const text = result.value.trim();
  return text ? `\n--- FILE: ${fileName} ---\n${text}` : '';
}

function extractXlsx(filePath: string, fileName: string): string {
  const workbook = XLSX.readFile(filePath);
  const parts: string[] = [`\n--- FILE: ${fileName} ---`];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    if (csv.trim()) {
      parts.push(`[Sheet: ${sheetName}]`);
      parts.push(csv);
    }
  }

  return parts.length > 1 ? parts.join('\n') : '';
}

function extractTxt(filePath: string, fileName: string): string {
  const text = fs.readFileSync(filePath, 'utf-8').trim();
  return text ? `\n--- FILE: ${fileName} ---\n${text}` : '';
}

async function extractPdf(filePath: string, fileName: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PDFParse } = require('pdf-parse');
  const buffer = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  const text = (result.text || '').trim();
  return text ? `\n--- FILE: ${fileName} ---\n${text}` : '';
}

// Heuristic ranking of project files by likely information density. The Goals
// LLM has a finite char budget (MAX_TEXT_LENGTH), so the most decision-relevant
// documents should be extracted FIRST and any tail beyond the budget is dropped.
// Scoring favours business cases, scoping docs, PIDs, and cost models over
// meeting minutes and notes.
//
// Scoring is purely on the basename; the actual ranking is stable: ties keep
// original order so behaviour is reproducible.
const FILE_RANK_RULES: ReadonlyArray<{ pattern: RegExp; score: number }> = [
  { pattern: /business[\s_-]?case|biz[\s_-]?case|bizcase/i,                score: 100 },
  { pattern: /project[\s_-]?charter|charter/i,                             score:  95 },
  { pattern: /^pid\b|project[\s_-]?initiation|initiation[\s_-]?document/i, score:  92 },
  { pattern: /scope|scoping|scope[\s_-]?statement/i,                        score:  88 },
  { pattern: /q[\s_-]?&?[\s_-]?a|qa[\s_-]?session|gate[\s_-]?review/i,     score:  82 },
  { pattern: /\bcdio\b|cioo|gating|pre[\s_-]?review/i,                      score:  80 },
  { pattern: /architecture|solution[\s_-]?design|sad\b|hld|lld/i,           score:  78 },
  { pattern: /security|drmt|risk[\s_-]?assessment|gdpr|compliance/i,        score:  74 },
  { pattern: /cost|budget|capex|opex|finance/i,                             score:  70 },
  { pattern: /roadmap|timeline|plan(?:ning)?|milestone/i,                   score:  65 },
  { pattern: /change[\s_-]?management|adoption|training/i,                  score:  62 },
  { pattern: /requirement|spec(ification)?|brd|frd/i,                        score:  58 },
  { pattern: /deliverable|status[\s_-]?report|steerco|steering/i,           score:  50 },
];

// Applied as SUBTRACTIONS on top of the best positive match, not as alternative
// rules. They used to live at the end of the list above, which — since scoring
// returned on the first match — meant they only ever applied to files matching
// nothing else: "Architecture_Meeting_Minutes.docx" scored 78 for
// "architecture" and never reached the meeting penalty, the exact opposite of
// what the comment promised.
const FILE_PENALTY_RULES: ReadonlyArray<{ pattern: RegExp; penalty: number }> = [
  { pattern: /meeting|minutes|debrief|recap/i,           penalty: 40 },
  { pattern: /\bnotes?\b/i,                              penalty: 25 },
  { pattern: /draft|wip|todo|backup|copy[\s_-]?of/i,     penalty: 45 },
];

function scoreFile(filePath: string): number {
  const base = path.basename(filePath).toLowerCase();

  let score: number | null = null;
  for (const rule of FILE_RANK_RULES) {
    if (rule.pattern.test(base)) { score = rule.score; break; }
  }
  if (score === null) {
    // Extension-based fallback: .docx > .pdf > .xlsx > .csv > .txt.
    const ext = path.extname(base);
    if (ext === '.docx') score = 40;
    else if (ext === '.pdf')  score = 38;
    else if (ext === '.xlsx') score = 35;
    else if (ext === '.csv')  score = 30;
    else score = 25;
  }

  for (const { pattern, penalty } of FILE_PENALTY_RULES) {
    if (pattern.test(base)) score -= penalty;
  }
  return score;
}

function rankFiles(files: string[]): string[] {
  // decorate-sort-undecorate so ties preserve original order
  return files
    .map((f, i) => ({ f, i, score: scoreFile(f) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(x => x.f);
}

export async function extractAllTexts(files: string[]): Promise<string> {
  const ranked = rankFiles(files);
  const parts: string[] = [];
  let totalLength = 0;

  for (const file of ranked) {
    if (totalLength >= MAX_TEXT_LENGTH) break;

    const text = await extractText(file);
    if (text) {
      const remaining = MAX_TEXT_LENGTH - totalLength;
      const truncated = text.slice(0, remaining);
      parts.push(truncated);
      totalLength += truncated.length;
    }
  }

  return parts.join('\n');
}

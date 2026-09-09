// ─── DDS (Division) Colors ───────────────────────────────────────────────────

export const DDS_COLORS: Record<string, string> = {
  'AMEI': '#f97316',
  'Americas': '#ef4444',
  'APAC': '#06b6d4',
  'CF': '#ff2d7a',
  'CDIO Office': '#1d4ed8',
  'CDIOO': '#1e40af',
  'Digital': '#ec4899',
  'Digital Factory': '#f472b6',
  'E&C': '#10b981',
  'EU': '#a855f7',
  'Europe': '#a855f7',
  'Entreprise Apps': '#a855f7',
  'GDO': '#14b8a6',
  'GIO': '#22c55e',
  'GM&T': '#f59e0b',
  'HC D&IT': '#39ff14',
  'IDD': '#22d3ee',
  'Indutrial Apps': '#fb923c',
  'SEPPIC': '#a3e635',
  'ALIZENT': '#e879f9',
  'Alizent': '#e879f9',
};

export const DEFAULT_COLOR = '#ff6b6b';

// ─── Severity Colors ─────────────────────────────────────────────────────────
// Two-tier severity (2026-06-18): we collapsed the prior 3-tier scale into
// {high, low}. Reds stay for genuine high-severity escalations; everything
// else is a soft sky-blue that reads as informational rather than alarming.
// `medium` is kept as a defensive alias so any stray legacy row still renders
// as low instead of falling through to the gray fallback.

export const SEVERITY_COLORS: Record<string, string> = {
  high: '#ef4444',    // red-500 — escalate
  low: '#7dd3fc',     // sky-300 — informational
  medium: '#7dd3fc',  // alias to low (DB-migrated, but defend against stragglers)
};

export const SEVERITY_FALLBACK = '#6b7280';  // gray for unknown / empty severity

// ─── Gate Order & Colors ─────────────────────────────────────────────────────

export const GATE_ORDER = [
  '0', '1', '1 MVP', 'MVP Interm.', '2', '3', '4',
  'MVP Closure', 'Contract note', 'OverRun', 'Overrun'
];

export const GATE_COLORS: Record<string, string> = {
  '0': '#94a3b8',
  '1': '#6366f1',
  '1 MVP': '#8b5cf6',
  'MVP Interm.': '#a78bfa',
  '2': '#06b6d4',
  '3': '#10b981',
  '4': '#22c55e',
  'MVP Closure': '#f59e0b',
  'Contract note': '#f97316',
  'OverRun': '#ef4444',
  'Overrun': '#ef4444',
};

// ─── Decision Colors ─────────────────────────────────────────────────────────

export const DECISION_COLORS: Record<string, string> = {
  'Passed': '#22c55e',
  'Delegated': '#3b82f6',
  'On Hold': '#f59e0b',
  'Not Passed': '#ef4444',
  '': '#475569',
};

// ─── Review Status Order ─────────────────────────────────────────────────────

export const REVIEW_STATUS_ORDER = [
  '1.To be confirmed',
  '2.Confirmed',
  '3.Minutes in prog.',
  '4.Pending valid.',
  '4a. Pending valid. (1/2)',
  '4b. Pending valid. (2/2)',
  '5.Position valid.',
  '6.Min. published',
  '0.Delegated',
];

// ─── Documents Status ────────────────────────────────────────────────────────

export const DOCUMENTS_STATUS_ORDER = [
  '0-On Hold',
  '1-Expected',
  '2-Received',
  '3-Complete',
  '4-Shared',
];

export function getDDSColor(dds: string): string {
  return DDS_COLORS[dds] || DEFAULT_COLOR;
}

export function getGateColor(gate: string): string {
  return GATE_COLORS[gate] || '#6366f1';
}

export function getDecisionColor(decision: string): string {
  return DECISION_COLORS[decision] || '#475569';
}

// Tooltip on every control that a basic user can see but not use. The
// server-side 403 (middleware.ts role gate) is the real protection — this is
// the cosmetic half that tells the user *why* it's greyed out instead of
// leaving them to guess. See PLAN_USER_MANAGEMENT.md §5.2.
export const ADMIN_ONLY_TITLE = 'Requer perfil administrador';

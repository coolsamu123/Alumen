'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type PlanAllProjectStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';

export interface PerProjectPlanState {
  projectId: string;
  name: string;
  status: PlanAllProjectStatus;
  cached: boolean | null;
  hasDocuments: boolean | null;
  errorMessage: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface PlanAllState {
  status: 'idle' | 'running' | 'stopping' | 'done';
  startedAt: string | null;
  finishedAt: string | null;
  totalProjects: number;
  doneProjects: number;
  stopRequested: boolean;
  capExceeded: boolean;
  perProject: Record<string, PerProjectPlanState>;
}

const POLL_MS = 2000;

// Polls the "Plan all" batch-run endpoint. Fetches one snapshot on mount
// (so a page reload or a second browser tab picks up a run already in
// progress elsewhere), then polls every 2s only while a run is active.
export function usePlanAllState() {
  const [state, setState] = useState<PlanAllState | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch('/api/impact/project/planning/run-all');
      const json = await res.json();
      setState(json as PlanAllState);
    } catch { /* transient — next poll or user action retries */ }
  }, []);

  useEffect(() => { fetchState(); }, [fetchState]);

  useEffect(() => {
    const active = state?.status === 'running' || state?.status === 'stopping';
    if (active && !pollRef.current) {
      pollRef.current = setInterval(fetchState, POLL_MS);
    }
    if (!active && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [state?.status, fetchState]);

  const start = useCallback(async (projectIds: string[]) => {
    const res = await fetch('/api/impact/project/planning/run-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectIds }),
    });
    const json = await res.json();
    if (json.state) setState(json.state as PlanAllState);
    if (!res.ok) throw new Error(json.error || 'Failed to start Plan all');
  }, []);

  const stop = useCallback(async () => {
    const res = await fetch('/api/impact/project/planning/run-all', { method: 'DELETE' });
    const json = await res.json();
    if (json.state) setState(json.state as PlanAllState);
  }, []);

  return { state, start, stop };
}

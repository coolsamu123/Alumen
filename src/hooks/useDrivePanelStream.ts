import { useState, useEffect } from 'react';
import type { DrivePanelState } from '@/lib/drive-panel-state';

// Extracted from DriveView.tsx so DataFlowLive.tsx (PLAN_LIVE_DATAFLOW.md
// Fase 2) shares the exact same SSE connection logic rather than
// reimplementing reconnect/snapshot-fallback behavior a second time. Each
// mounted consumer opens its own EventSource — /api/drive/stream already
// supports multiple concurrent clients, and Drive Sync + Data Flow being open
// in two tabs at once is the uncommon case, not the one to optimize for.
export function useDrivePanelStream() {
  const [state, setState] = useState<DrivePanelState | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (cancelled) return;
      es = new EventSource('/api/drive/stream');
      es.addEventListener('hello', () => setConnected(true));
      es.addEventListener('state', (e) => {
        try {
          setState(JSON.parse((e as MessageEvent).data));
        } catch { /* ignore */ }
      });
      es.onerror = () => {
        setConnected(false);
        es?.close();
        es = null;
        // Browser auto-reconnects EventSource normally, but if it dropped
        // entirely (e.g. after sleep), retry manually.
        if (!cancelled) {
          reconnectTimer = setTimeout(connect, 2500);
        }
      };
    };
    connect();

    // Snapshot fetch in parallel so the user sees data even before the first
    // SSE tick arrives.
    fetch('/api/drive/state')
      .then(r => r.json())
      .then(d => { if (!cancelled && d && !d.error) setState(prev => prev || d); })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, []);

  return { state, connected };
}

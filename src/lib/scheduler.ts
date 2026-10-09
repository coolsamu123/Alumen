/**
 * The auto-discovery scheduler.
 *
 * WHY IT EXISTS: the two halves of the chain had different automation. Copy and
 * Cleanup run on the Apps Script heartbeat every 10 minutes; Discover → Download
 * → Goals → Impact only ran when someone triggered it. In practice a project
 * arrived, was copied and cleaned within the hour, and then sat there —
 * PGM0001209 was copied and cleaned on 13 Sep while the newest goals in the
 * database were from 10 Sep. The Data Flow drew six stages as one continuous
 * pipeline while half of it waited for a click.
 *
 * WHY IT IS CHEAP: every tick asks pendingWork() first, which is a SQLite-only
 * question — no Drive call, no LLM. With nothing new it does nothing at all. And
 * runAutoDiscoveryCycle only spends Impact budget when goalsAdded > 0, so the
 * full portfolio recomparison still cannot fire on its own.
 *
 * Lives in its own module so instrumentation.ts can reach it through a single
 * dynamic import inside a `NEXT_RUNTIME === 'nodejs'` branch: this file pulls in
 * better-sqlite3 and googleapis, and the edge build cannot resolve those.
 */
import { runAutoDiscoveryCycle, isAutoCycleRunning, pendingWork } from './auto-pipeline';
import { syncCdio } from './cdio-sync';

const DEFAULT_INTERVAL_MIN = 15;
// The CDIO sheet changes a few times a month. Each check is one Drive metadata
// call; the export and merge only run when modifiedTime moved (cdio-sync.ts).
const CDIO_INTERVAL_MIN = 60;

let started = false;

export function startScheduler(): void {
  if (started) return;
  started = true;

  if (process.env.NODE_ENV !== 'production') {
    console.log('[scheduler] skipped (not production)');
    return;
  }
  if (process.env.ALUMEN_SCHEDULER === 'off') {
    console.log('[scheduler] disabled by ALUMEN_SCHEDULER=off');
    return;
  }

  const minutes = Number(process.env.ALUMEN_SCHEDULER_MINUTES) || DEFAULT_INTERVAL_MIN;

  const tick = async () => {
    try {
      if (isAutoCycleRunning()) return;

      const { total, reasons } = pendingWork();
      if (total === 0) {
        // A hold is not the same as nothing to do, and the difference matters
        // when someone queues four projects and watches nothing happen for
        // half an hour. Logged at most every 15 minutes, which is the tick.
        if (reasons.length) console.log(`[scheduler] ${reasons[0]}`);
        return;
      }

      console.log(`[scheduler] ${total} pending — ${reasons.join('; ')}`);
      await runAutoDiscoveryCycle('scheduled', 'full');
    } catch (err) {
      // A failed tick must never kill the timer: the next one may well succeed,
      // and a scheduler that dies silently is worse than one that logs and retries.
      console.error('[scheduler] tick failed:', err instanceof Error ? err.message : err);
    }
  };

  // First check a minute after boot, not immediately: let the server finish
  // starting before a cycle can take the CPU.
  setTimeout(tick, 60_000);
  setInterval(tick, minutes * 60_000);

  // Independent of the cycle: the portfolio list must stay current even when
  // there is no pipeline work at all. syncCdio never throws (errors are stored
  // and shown in Drive Sync), so the catch is only a last guard for the timer.
  const cdioTick = () => {
    syncCdio().catch(err =>
      console.error('[scheduler] CDIO check failed:', err instanceof Error ? err.message : err));
  };
  setTimeout(cdioTick, 2 * 60_000);
  setInterval(cdioTick, CDIO_INTERVAL_MIN * 60_000);

  console.log(`[scheduler] armed — every ${minutes} min, only when work is pending; CDIO every ${CDIO_INTERVAL_MIN} min`);
}

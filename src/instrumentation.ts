/**
 * Boots the auto-discovery scheduler (src/lib/scheduler.ts).
 *
 * The positive `=== 'nodejs'` form matters: it is what lets the edge build drop
 * this branch as dead code. The scheduler reaches better-sqlite3 and googleapis,
 * and an edge bundle cannot resolve the Node built-ins underneath them — written
 * as an early `!== 'nodejs'` return, webpack still followed the import and the
 * build failed on `Can't resolve 'http'`.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startScheduler } = await import('./lib/scheduler');
    startScheduler();
  }
}

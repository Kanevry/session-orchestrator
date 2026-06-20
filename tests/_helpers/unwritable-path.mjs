/**
 * tests/_helpers/unwritable-path.mjs
 *
 * Returns a filesystem path that is guaranteed UNWRITABLE and — critically —
 * fails FAST (synchronously, with ENOTDIR) for EVERY uid, including root.
 *
 * ## Why this exists (#685 root cause)
 *
 * A test that needs a "writes will fail here" path must NOT use a procfs path
 * like `/proc/nonexistent-…`. As a NON-root user, `mkdirSync(p, {recursive})`
 * into procfs fails fast with EACCES — so on a developer's macOS/Linux box the
 * test passes. But CI runs as ROOT (the Hetzner Docker autoscaler, node:24,
 * uid 0), and as root that same `mkdirSync('/proc/nonexistent', {recursive})`
 * HANGS the event loop synchronously — the syscall never returns. No
 * `testTimeout` / `teardownTimeout` can interrupt a blocked sync syscall, so the
 * whole vitest worker hangs until the outer CI cap kills it (observed: a single
 * such test stalled an entire shard for >18 min → fail-closed → red pipeline).
 *
 * `/dev/null` is a character device on POSIX, so ANY path *under* it (e.g.
 * `/dev/null/x`) yields an immediate ENOTDIR for root and non-root alike — the
 * fast, uniform failure the "unwritable path" tests actually want.
 *
 * POSIX only — `/dev/null` has no Windows equivalent. Callers must early-return
 * on `process.platform === 'win32'` (the existing tests already do).
 *
 * @param {string} [sub='so-unwritable'] - leaf segment under /dev/null
 * @returns {string} a path whose creation fails fast with ENOTDIR for any uid
 */
export function unwritablePath(sub = 'so-unwritable') {
  return `/dev/null/${sub}`;
}

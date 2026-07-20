/**
 * server/ingest/rate-limit.mjs — fixed-window in-memory rate limiter for the
 * ingest server (Epic #841, S5 / GitLab #846; PRD §3-FA4).
 *
 * Privacy invariant (load-bearing): the IP is used ONLY transiently as a Map key
 * for the current window's decision. It is NEVER persisted and NEVER logged —
 * the window is discarded wholesale on reset, and nothing here writes to disk or
 * stderr.
 *
 * Fixed-window semantics: one counter Map ip→count; the whole Map is REPLACED on
 * each window boundary (a clean reset, no per-key expiry bookkeeping). The reset
 * timer is `.unref()`'d so it never keeps the process alive.
 */

/**
 * Create a rate limiter.
 *
 * @param {{ windowMs: number, limit: number, maxTrackedIps: number }} opts
 * @returns {{
 *   check: (ip: string) => { allowed: boolean, retryAfter: number },
 *   stop: () => void,
 *   size: () => number,
 * }}
 */
export function createRateLimiter({ windowMs, limit, maxTrackedIps }) {
  let counts = new Map();
  let windowStart = Date.now();

  const timer = setInterval(() => {
    counts = new Map();
    windowStart = Date.now();
  }, windowMs);
  timer.unref();

  /** Seconds until the current window resets (never below 1). */
  function retryAfterSeconds() {
    const remaining = Math.max(0, windowMs - (Date.now() - windowStart));
    return Math.max(1, Math.ceil(remaining / 1000));
  }

  /**
   * Record one request from `ip` and decide whether it is allowed.
   * @param {string} ip
   * @returns {{ allowed: boolean, retryAfter: number }}
   */
  function check(ip) {
    const current = counts.get(ip);

    if (current === undefined) {
      // New IP this window. Fail CLOSED once the tracking cap is hit — an
      // untracked IP could otherwise bypass the limit unbounded.
      if (counts.size >= maxTrackedIps) {
        return { allowed: false, retryAfter: retryAfterSeconds() };
      }
      counts.set(ip, 1);
      return { allowed: true, retryAfter: 0 };
    }

    if (current >= limit) {
      return { allowed: false, retryAfter: retryAfterSeconds() };
    }

    counts.set(ip, current + 1);
    return { allowed: true, retryAfter: 0 };
  }

  return {
    check,
    stop: () => clearInterval(timer),
    size: () => counts.size,
  };
}

/**
 * Resolve the client IP for the rate-limit decision.
 *
 * SECURITY — XFF rate-limit bypass (CWE-348, Reliance on Untrusted Inputs): the
 * container sits behind exactly ONE trusted proxy (Caddy). Caddy APPENDS the
 * real connecting peer as the RIGHT-MOST X-Forwarded-For entry, so the
 * right-most hop is the only trustworthy one. Every entry to its LEFT is
 * client-supplied and freely spoofable — a client that varies a fabricated
 * left-most `X-Forwarded-For` on each request could otherwise mint a fresh
 * rate-limit bucket per request and bypass the limit unbounded. We therefore
 * take `.pop()` (right-most), NOT `[0]` (left-most).
 *
 * Without trustProxy the direct socket peer is used. An empty/missing XFF (or
 * !trustProxy) falls through to socket.remoteAddress, then the 'unknown'
 * constant, so the limiter never keys on `undefined`.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {boolean} trustProxy
 * @returns {string}
 */
export function extractIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim() !== '') {
      // Right-most hop = the peer Caddy appended (trusted); left-most is client-spoofable.
      return xff.split(',').pop().trim();
    }
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

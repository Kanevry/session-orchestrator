/**
 * server/mcp/rate-limit.mjs — who a request counts against, and how often
 * (#2260). On a public read-only service a full table must not shut out new
 * clients: once it is full, new addresses share one overflow bucket.
 *
 * Privacy invariant: the address is used only as an in-memory key for the
 * current window. Nothing here logs or writes it.
 */
import { isIP } from 'node:net';

/** Strip the IPv4-mapped prefix a dual-stack socket reports. */
const unmap = (addr) => (typeof addr === 'string' && addr.toLowerCase().startsWith('::ffff:') ? addr.slice(7) : addr);

/** Count IPv6 by /64: one subscriber holds a whole /64 and could rotate through it. */
export function bucketFor(ip) {
  if (isIP(ip) !== 6) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).join(':')}::/64`;
}

/**
 * The address a request counts against. X-Forwarded-For is believed only when
 * the TCP peer is one of the configured proxies, and only when its right-most
 * entry is a real IP; anything else counts against the peer itself.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string[]} trustedProxies addresses of the TLS edge
 * @returns {string}
 */
export function clientKey(req, trustedProxies) {
  const peer = unmap(req.socket?.remoteAddress) || 'unknown';
  if (trustedProxies.includes(peer)) {
    const xff = req.headers['x-forwarded-for'];
    const last = typeof xff === 'string' ? unmap(xff.split(',').pop().trim()) : '';
    if (isIP(last) !== 0) return bucketFor(last);
  }
  return isIP(peer) !== 0 ? bucketFor(peer) : 'unknown';
}

/**
 * Fixed-window limiter. Once `maxTracked` addresses are counted in a window,
 * further new addresses share ONE overflow bucket with `overflowLimit`
 * requests: known clients keep their own count, and a flood of fresh addresses
 * throttles only itself and other newcomers, never the whole service.
 *
 * @param {{ windowMs: number, limit: number, maxTracked: number, overflowLimit: number }} opts
 */
export function createRateLimiter({ windowMs, limit, maxTracked, overflowLimit }) {
  let counts = new Map();
  let overflow = 0;
  let windowStart = Date.now();
  const timer = setInterval(() => {
    counts = new Map();
    overflow = 0;
    windowStart = Date.now();
  }, windowMs);
  timer.unref();
  const retryAfter = () => Math.max(1, Math.ceil((windowMs - (Date.now() - windowStart)) / 1000));

  return {
    /** @returns {{ allowed: boolean, retryAfter: number }} */
    check(key) {
      const current = counts.get(key);
      if (current === undefined && counts.size >= maxTracked) {
        overflow += 1;
        return overflow > overflowLimit ? { allowed: false, retryAfter: retryAfter() } : { allowed: true, retryAfter: 0 };
      }
      if ((current ?? 0) >= limit) return { allowed: false, retryAfter: retryAfter() };
      counts.set(key, (current ?? 0) + 1);
      return { allowed: true, retryAfter: 0 };
    },
    stop: () => clearInterval(timer),
    size: () => counts.size,
  };
}

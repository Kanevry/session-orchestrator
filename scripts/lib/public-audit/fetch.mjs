import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { TextDecoder } from 'node:util';
import http from 'node:http';
import https from 'node:https';

const LIMIT = 2 * 1024 * 1024;
function displayUrl(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    return url.href;
  } catch {
    return '[invalid URL]';
  }
}
const redirects = new Set([301, 302, 303, 307, 308]);
class Unsupported extends Error {}

function publicV4(address) {
  const bytes = address.split('.').map(Number);
  const [a, b, c] = bytes;
  return (
    bytes.length === 4 &&
    bytes.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
    !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    )
  );
}
function publicAddress(address) {
  const family = isIP(address);
  if (family === 4) return publicV4(address);
  if (family !== 6 || address.includes('%')) return false;
  // Only ordinary global unicast. This excludes mapped, local, NAT64 and other translation ranges.
  const first = Number.parseInt(address.split(':')[0], 16);
  // Positive range test: a leading "::" (loopback, mapped, unspecified) parses to NaN and must not pass.
  if (!(first >= 0x2000 && first <= 0x3fff)) return false;
  const second = Number.parseInt(address.split(':')[1] || '0', 16);
  if (first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) return false; // protocol assignments, Teredo, benchmark, documentation
  if (first === 0x2002 || (first === 0x3fff && second <= 0x0fff)) return false; // 6to4, documentation
  return true;
}
function normalizeHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers ?? {}).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value) ? value.join(', ') : String(value),
    ]),
  );
}
function nativeRequest(url, { lookup, headers, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      url,
      { method: 'GET', headers, lookup, agent: false, minVersion: 'TLSv1.3' },
      (res) => {
        const parts = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            const error = new Unsupported('Response exceeds byte limit');
            res.destroy(error);
            req.destroy(error);
          } else parts.push(chunk);
        });
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('Response aborted')));
        res.on('end', () => {
          if (!res.complete) {
            reject(new Error('Incomplete response'));
            return;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) });
        });
      },
    );
    const timer = setTimeout(
      () => req.destroy(new Error('Request deadline exceeded')),
      Math.max(1, timeoutMs),
    );
    req.on('error', reject);
    req.on('close', () => clearTimeout(timer));
    req.end();
  });
}

/** Bounded GET transport. Connection DNS is pinned to an address validated for this hop. */
export function createFetcher({
  allowedHosts,
  maxRequestsPerHost = 5,
  requestImpl = nativeRequest,
  resolver = (host) => dnsLookup(host, { all: true, verbatim: true }),
  clock = () => new Date(),
  timeoutMs = 5000,
  maxBytes = LIMIT,
} = {}) {
  if (
    !Array.isArray(allowedHosts) ||
    !allowedHosts.length ||
    !allowedHosts.every((host) => typeof host === 'string' && host.length > 0)
  )
    throw new Error('allowedHosts is required');
  if (!Number.isInteger(maxRequestsPerHost) || maxRequestsPerHost < 1 || maxRequestsPerHost > 5)
    throw new Error('Request budget must be 1..5');
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 5000 ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > LIMIT
  )
    throw new Error('Invalid transport limits');
  const hosts = new Set(allowedHosts.map((host) => host.toLowerCase().replace(/\.$/, '')));
  const counts = Object.create(null);
  const cache = new Map();
  // Completed results only: reusing in-flight promises would deadlock redirect loops (A -> B -> A).
  const done = new Map();
  const timestamp = () => new Date(clock()).toISOString();
  function validate(value) {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      !hosts.has(url.hostname.toLowerCase().replace(/\.$/, ''))
    )
      throw new Unsupported('URL is outside allowed HTTP hosts');
    url.hash = '';
    return url;
  }
  async function perform(initial, userAgent) {
    const chain = [];
    let current = initial;
    let status;
    const originalTime = timestamp();
    const finish = (state, extra = {}) => ({
      state,
      url: displayUrl(initial),
      finalUrl: displayUrl(current),
      timestamp: originalTime,
      ...(status ? { status } : {}),
      chain,
      ...extra,
    });
    try {
      for (let hop = 0; ; hop++) {
        const url = validate(current);
        current = url.href;
        const host = url.hostname.toLowerCase().replace(/\.$/, '');
        const known = hop > 0 ? done.get(JSON.stringify([current, userAgent])) : undefined;
        if (known) {
          // Compose with the finished chain; the limit applies to the whole composed chain.
          chain.push(...known.chain);
          if (chain.filter((entry) => redirects.has(entry.status)).length > 3) {
            chain.splice(4);
            current = chain[3].url;
            status = chain[3].status;
            return finish('not-measurable', { reason: 'Redirect limit exceeded' });
          }
          return { ...known, url: displayUrl(initial), timestamp: originalTime, chain };
        }
        if ((counts[host] ?? 0) >= maxRequestsPerHost)
          return finish('not-fetched', { reason: 'Per-host request budget exhausted' });
        counts[host] = (counts[host] ?? 0) + 1;
        const started = Date.now();
        let timer;
        let expired = false;
        const response = await Promise.race([
          (async () => {
            const bareHost = host.replace(/^\[|\]$/g, '');
            const answers = isIP(bareHost)
              ? [{ address: bareHost, family: isIP(bareHost) }]
              : await resolver(bareHost);
            if (
              !Array.isArray(answers) ||
              !answers.length ||
              answers.some(
                (answer) =>
                  !publicAddress(answer.address) || Number(answer.family) !== isIP(answer.address),
              )
            )
              throw new Unsupported('DNS contains a nonpublic or invalid address');
            const chosen = answers[0];
            const lookup = (_hostname, options, callback) => {
              if (typeof options === 'function') {
                callback = options;
                options = {};
              }
              if (options?.all)
                callback(null, [{ address: chosen.address, family: Number(chosen.family) }]);
              else callback(null, chosen.address, Number(chosen.family));
            };
            const remaining = timeoutMs - (Date.now() - started);
            if (expired || remaining <= 0) throw new Error('Request deadline exceeded');
            return requestImpl(url, {
              lookup,
              headers: { 'user-agent': userAgent, 'accept-encoding': 'identity' },
              timeoutMs: remaining,
              maxBytes,
            });
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              expired = true;
              reject(new Error('Request deadline exceeded'));
            }, timeoutMs);
          }),
        ]).finally(() => clearTimeout(timer));
        status = response.status;
        if (!Number.isInteger(status) || status < 100 || status > 599)
          throw new Unsupported('Invalid HTTP status');
        const headers = normalizeHeaders(response.headers);
        chain.push({ url: current, timestamp: timestamp(), status });
        if (redirects.has(status)) {
          if (!headers.location)
            return finish('not-measurable', { headers, reason: 'Redirect has no Location' });
          if (hop >= 3) return finish('not-measurable', { reason: 'Redirect limit exceeded' });
          current = new URL(headers.location, url).href;
          continue;
        }
        if (status === 429 || status >= 500)
          return finish('unavailable', { headers, reason: `HTTP ${status}` });
        if (
          headers['content-encoding'] &&
          headers['content-encoding'].trim().toLowerCase() !== 'identity'
        )
          throw new Unsupported('Unsupported content encoding');
        if (typeof response.body !== 'string' && !(response.body instanceof Uint8Array))
          throw new Unsupported('Unsupported body');
        const body = Buffer.from(response.body);
        if (body.length > maxBytes) throw new Unsupported('Response exceeds byte limit');
        const contentType = (headers['content-type'] ?? '').toLowerCase();
        const mime = contentType.split(';')[0].trim();
        const binary =
          /^(?:image\/(?!svg\+xml$)|audio\/|video\/|font\/)/.test(mime) ||
          ['application/octet-stream', 'application/pdf', 'application/zip'].includes(mime);
        if (binary)
          return finish('ok', {
            headers,
            body: '',
            bodyKind: 'binary',
            receivedBytes: body.length,
          });
        const charset = /;\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i.exec(contentType);
        const label = charset ? (charset[1] ?? charset[2] ?? charset[3]).trim() : 'utf-8';
        if (
          !['utf-8', 'utf8', 'us-ascii'].includes(label) ||
          (/charset\s*=/.test(contentType) && !charset)
        )
          throw new Unsupported('Unsupported text charset');
        if (label === 'us-ascii' && body.some((byte) => byte > 127))
          throw new Unsupported('Invalid ASCII response');
        let decoded;
        try {
          decoded = new TextDecoder('utf-8', { fatal: true }).decode(body);
        } catch {
          throw new Unsupported('Invalid UTF-8 text response');
        }
        return finish('ok', { headers, body: decoded, receivedBytes: body.length });
      }
    } catch (error) {
      return finish(error instanceof Unsupported ? 'not-measurable' : 'unavailable', {
        reason:
          error instanceof Unsupported
            ? error.message
            : 'Network request failed or deadline exceeded',
      });
    }
  }
  return {
    counts,
    fetch(value, { userAgent = 'PublicAudit/1.0' } = {}) {
      let url;
      try {
        url = validate(value).href;
      } catch (error) {
        return Promise.resolve({
          state: 'not-measurable',
          url: '[invalid URL]',
          finalUrl: '[invalid URL]',
          timestamp: timestamp(),
          chain: [],
          reason: error instanceof Unsupported ? error.message : 'Invalid HTTP URL',
        });
      }
      if (typeof userAgent !== 'string' || !userAgent || /[\r\n]/.test(userAgent))
        return Promise.resolve({
          state: 'not-measurable',
          url,
          finalUrl: url,
          timestamp: timestamp(),
          chain: [],
          reason: 'Invalid user agent',
        });
      const key = JSON.stringify([url, userAgent]);
      if (!cache.has(key))
        cache.set(
          key,
          perform(url, userAgent).then((result) => {
            if (result.state === 'not-fetched') return result;
            done.set(key, result);
            // Also file the final hop under its own URL, shaped like a direct fetch of it. A chain
            // that stopped on a redirect (limit, missing Location) says nothing about that URL.
            const last = result.chain.at(-1);
            const finalKey = JSON.stringify([result.finalUrl, userAgent]);
            if (
              last &&
              last.url === result.finalUrl &&
              !redirects.has(last.status) &&
              !cache.has(finalKey)
            ) {
              const direct = {
                ...result,
                url: result.finalUrl,
                timestamp: last.timestamp,
                chain: [last],
              };
              done.set(finalKey, direct);
              cache.set(finalKey, Promise.resolve(direct));
            }
            return result;
          }),
        );
      return cache.get(key);
    },
  };
}

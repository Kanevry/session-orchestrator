/**
 * server/ingest/config.mjs — pure environment resolution for the ingest server
 * (Epic #841, S5 / GitLab #846; PRD docs/prd/2026-07-20-anonymous-usage-telemetry.md §3-FA4).
 *
 * resolveConfig(env) is PURE: no I/O, no side effects, no top-level clock read.
 * Every knob is host-tunable via env with a deterministic v1 default. Whitespace
 * is treated as "unset" for both string- and number-valued vars (a whitespace
 * value is truthy and would otherwise short-circuit a naive `||` fallback —
 * see .claude/rules/development.md § Env-var fallback whitespace trap).
 */

/**
 * Whitespace-safe string env read: a value that trims to empty falls back.
 * @param {string|undefined} raw
 * @param {string} fallback
 * @returns {string}
 */
function strFromEnv(raw, fallback) {
  return (raw || '').trim() || fallback;
}

/**
 * Whitespace-safe numeric env read. Empty / unparsable / non-finite / zero /
 * negative → fallback. Every knob resolved here is a strictly-positive quantity
 * (port, byte cap, window ms, rate limit, tracked-IP cap, retention months,
 * interval ms), so a `<= 0` or NaN override is a misconfiguration that must not
 * leak through — clamp it back to the deterministic default rather than pass a
 * negative/NaN into the limiter or the body-cap check.
 * @param {string|undefined} raw
 * @param {number} fallback
 * @returns {number}
 */
function numFromEnv(raw, fallback) {
  const s = (raw || '').trim();
  if (s === '') return fallback;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Resolve the ingest-server configuration from an environment object.
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {{
 *   port: number,
 *   dbPath: string,
 *   bodyCap: number,
 *   rateWindowMs: number,
 *   rateLimit: number,
 *   maxTrackedIps: number,
 *   trustProxy: boolean,
 *   retentionMonths: number,
 *   retentionIntervalMs: number,
 * }}
 */
export function resolveConfig(env = process.env) {
  // trustProxy defaults ON (1): the container runs behind Caddy, so the
  // RIGHT-MOST X-Forwarded-For hop is the trusted peer Caddy appended (the
  // left-most is client-spoofable — see rate-limit.mjs extractIp, CWE-348).
  // Explicit '0' opts out.
  const trustProxyRaw = strFromEnv(env.SO_INGEST_TRUST_PROXY, '1');

  return {
    port: numFromEnv(env.PORT, 8787),
    dbPath: strFromEnv(env.SO_INGEST_DB, './data/records.db'),
    bodyCap: numFromEnv(env.SO_INGEST_BODY_CAP, 32768),
    rateWindowMs: numFromEnv(env.SO_INGEST_RATE_WINDOW_MS, 3600000),
    rateLimit: numFromEnv(env.SO_INGEST_RATE_LIMIT, 60),
    maxTrackedIps: numFromEnv(env.SO_INGEST_MAX_TRACKED_IPS, 50000),
    trustProxy: trustProxyRaw === '1',
    retentionMonths: numFromEnv(env.SO_INGEST_RETENTION_MONTHS, 24),
    retentionIntervalMs: numFromEnv(env.SO_INGEST_RETENTION_INTERVAL_MS, 86400000),
  };
}

/**
 * slopcheck.mjs — Package-legitimacy classifier (PRD 2026-05-22 § 2/§ 4 — Pattern 2, issue #520).
 *
 * Defends against LLM-hallucinated package names ("slopsquatting") by classifying
 * package mentions against their respective registry. Returns one of four labels:
 *
 *   - LEGITIMATE — package exists in the registry (versions[] non-empty).
 *   - ASSUMED    — registry probe could not classify definitively (timeout, malformed
 *                  input, unsupported registry, ENOENT, etc.). Fail-soft default.
 *   - SUS        — package exists but carries a known concern (deprecation,
 *                  audit advisory, typosquat heuristic). RESERVED FOR FUTURE WAVES —
 *                  the MVP NEVER emits SUS. The npm-deprecated-flag and audit-warning
 *                  detection paths are not wired up. Tests must not expect SUS emission
 *                  until that detection logic ships. See PRD § 5
 *                  (docs/prd/2026-05-22-gsd-pattern-adoption-quickwins.md) for intent.
 *   - SLOP       — package does NOT exist in the registry (404 / non-zero exit /
 *                  empty version list). Highest-confidence "hallucinated name" signal.
 *
 * Design principles (matches scripts/lib/session-lock.mjs conventions):
 *  - Never throws. Every error path returns a structured result entry. Top-level
 *    `classifyPackages()` wraps every per-package classifier in try/catch so a
 *    single bad input cannot tear down the whole batch.
 *  - Bounded execution. 5 s per package via execFile timeout option. Timeouts
 *    fall back to ASSUMED + WARN — no hangs, no hard-block.
 *  - Order-preserving. Output[i] corresponds to input[i] for any well-formed input.
 *  - Fail-soft on cache I/O. Cache read/write failures degrade silently (WARN to
 *    stderr); classification still returns to the caller.
 *  - Cache: in-memory map mirrors the on-disk JSON file. 24 h TTL.
 *
 * Registry support matrix (MVP):
 *  - npm   — full classification via `npm view <pkg> versions --json`.
 *  - pip   — skeleton: always returns ASSUMED + evidence 'pip-registry-unsupported-mvp'.
 *  - cargo — skeleton: always returns ASSUMED + evidence 'cargo-registry-unsupported-mvp'.
 *  - other — returns ASSUMED + evidence 'unknown-registry'.
 *
 * No external dependencies — Node 20+ stdlib only.
 *
 * Consumed by:
 *  - skills/plan/SKILL.md Phase 3.5 (Package-Audit) — Agent B (parallel).
 *  - skills/discovery/probes/supply-chain-slopcheck.mjs — Agent C (parallel).
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cache file path, relative to repoRoot (or process.cwd() when no repoRoot given). */
export const CACHE_PATH = '.orchestrator/runtime/slopcheck-cache.json';

/** Per-package registry-probe timeout. */
export const DEFAULT_TIMEOUT_MS = 5_000;

/** Cache entry TTL — 24 hours. */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * Closed enum of classification labels.
 * NOTE: 'SUS' is reserved for future waves — the MVP never emits it.
 * The npm-deprecated-flag and audit-warning detection paths are not implemented.
 * Tests should not expect SUS emission until that detection is wired up.
 */
export const CLASSIFICATIONS = Object.freeze(['LEGITIMATE', 'ASSUMED', 'SUS', 'SLOP']);

// ---------------------------------------------------------------------------
// Internal cache (in-memory mirror of disk file)
// ---------------------------------------------------------------------------

/**
 * In-memory cache, keyed by `<registry>:<name>`. Loaded lazily from disk on
 * first access. clearCache() resets this and removes the persisted file.
 *
 * Entry shape: { classification, fetchedAt, evidence? }
 *   - classification: one of CLASSIFICATIONS
 *   - fetchedAt: epoch ms (Number) at write time
 *   - evidence: optional string for diagnostic context
 *
 * @type {Map<string, { classification: string, fetchedAt: number, evidence?: string }>|null}
 */
let _cache = null;
let _cacheLoadedFromPath = null;

/**
 * Resolve the absolute path to the cache file.
 * @param {string|undefined} repoRoot
 * @returns {string}
 */
function cachePathFor(repoRoot) {
  return path.join(repoRoot ?? process.cwd(), CACHE_PATH);
}

/**
 * Build the cache key.
 * @param {string} name
 * @param {string} registry
 * @returns {string}
 */
function cacheKey(name, registry) {
  return `${registry}:${name}`;
}

/**
 * Lazily load the cache from disk into memory. Safe to call repeatedly —
 * subsequent calls are no-ops once the cache is loaded for the given repoRoot.
 * Cache contents are validated; malformed entries are dropped silently.
 *
 * @param {string|undefined} repoRoot
 */
function ensureCacheLoaded(repoRoot) {
  const file = cachePathFor(repoRoot);
  // If cache is already loaded for this path, reuse it.
  if (_cache !== null && _cacheLoadedFromPath === file) return;

  _cache = new Map();
  _cacheLoadedFromPath = file;

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // ENOENT is the expected first-run case; any other I/O error is also non-fatal.
    if (err.code !== 'ENOENT') {
      console.warn(`slopcheck: cache read failed (${err.code ?? 'unknown'}): ${err.message}`);
    }
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt cache — treat as empty. Next write will overwrite atomically.
    console.warn('slopcheck: cache file is corrupt — starting with empty cache');
    return;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;

  for (const [key, entry] of Object.entries(parsed)) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      typeof entry.classification === 'string' &&
      CLASSIFICATIONS.includes(entry.classification) &&
      typeof entry.fetchedAt === 'number' &&
      Number.isFinite(entry.fetchedAt)
    ) {
      const e = { classification: entry.classification, fetchedAt: entry.fetchedAt };
      if (typeof entry.evidence === 'string') e.evidence = entry.evidence;
      _cache.set(key, e);
    }
  }
}

/**
 * Persist the in-memory cache to disk via atomic tmp+rename. Failures degrade
 * to a WARN; the classification result is still returned to the caller.
 *
 * @param {string|undefined} repoRoot
 */
function persistCache(repoRoot) {
  if (_cache === null) return;
  const file = cachePathFor(repoRoot);
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const obj = Object.fromEntries(_cache.entries());
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn(`slopcheck: cache write failed (${err.code ?? 'unknown'}): ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Registry probes
// ---------------------------------------------------------------------------

/**
 * Wrap execFile() callback-style in a Promise. We do NOT use util.promisify
 * here because tests mock the named `execFile` export from 'node:child_process'
 * — promisify would capture the function at import time, which still works,
 * but a manual wrapper is simpler and matches the test mock contract exactly.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} opts
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function execFileAsync(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        // Attach stdout/stderr so the caller can inspect them without re-running.
        err.stdout = stdout ?? '';
        err.stderr = stderr ?? '';
        reject(err);
        return;
      }
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

/**
 * Classify a single npm package via `npm view <pkg> versions --json`.
 *
 * Classification rules (MVP):
 *  - execFile error with err.killed || err.signal → ASSUMED (timeout/SIGTERM).
 *  - execFile error with err.code === 'ENOENT' (npm not on PATH) → ASSUMED.
 *  - execFile error otherwise (exit code 1, stderr 404) → SLOP.
 *  - stdout parses to non-empty array → LEGITIMATE.
 *  - stdout parses to empty array or non-array → ASSUMED (unusual response shape).
 *
 * The PRD § 5 also documents a `SUS` path for known audit warnings; in the
 * MVP we do not fetch audit data (one more network call per package).
 * Discovery probe can call `npm audit` separately and reclassify.
 *
 * @param {string} pkgName  Validated non-empty string.
 * @param {number} timeoutMs
 * @returns {Promise<{ classification: string, evidence?: string }>}
 */
async function classifyNpmPackage(pkgName, timeoutMs) {
  // SEC: validate package name against npm grammar before execFile.
  // Prevents argv injection where a malicious package.json key like
  // "--registry=http://attacker/" would be parsed by npm as a flag.
  // npm package name grammar (RFC): optional @scope/ + lowercase alnum/dash/dot/underscore.
  const NPM_NAME_RE = /^(?:@[a-z0-9~][a-z0-9-._~]*\/)?[a-z0-9~][a-z0-9-._~]*$/i;
  if (!NPM_NAME_RE.test(pkgName)) {
    return { classification: 'SLOP', evidence: 'invalid-npm-package-name' };
  }

  let stdout;
  try {
    const result = await execFileAsync(
      'npm',
      // `--` separator: even if NPM_NAME_RE somehow lets a flag-shaped name slip
      // through, `--` halts npm's option parsing. Belt + braces.
      ['view', '--', pkgName, 'versions', '--json'],
      { timeout: timeoutMs, env: process.env },
    );
    stdout = result.stdout;
  } catch (err) {
    // Timeout or SIGTERM — fail-soft.
    if (err.killed === true || err.signal === 'SIGTERM' || err.signal === 'SIGKILL') {
      console.warn(`slopcheck: npm view timed out for ${pkgName} after ${timeoutMs}ms — classifying as ASSUMED`);
      return { classification: 'ASSUMED', evidence: 'registry-timeout' };
    }
    // npm CLI missing — environmental, fail-soft.
    if (err.code === 'ENOENT') {
      console.warn(`slopcheck: npm CLI not found on PATH — classifying ${pkgName} as ASSUMED`);
      return { classification: 'ASSUMED', evidence: 'npm-cli-missing' };
    }
    // Numeric exit code (e.g. 1 from npm 404) → registry confirmed absence.
    // This matches the test contract: mockNpmNotFound sets err.code = 1.
    if (typeof err.code === 'number') {
      return { classification: 'SLOP', evidence: 'registry-404-or-non-zero-exit' };
    }
    // Any other unexpected error — fail-soft.
    console.warn(`slopcheck: npm view unexpected error for ${pkgName}: ${err.message}`);
    return { classification: 'ASSUMED', evidence: `registry-error:${err.code ?? 'unknown'}` };
  }

  // Parse versions list. `npm view <pkg> versions --json` returns either
  // a JSON array (multi-version packages) or a JSON string (single-version).
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Unparseable response — treat as ASSUMED rather than guessing.
    console.warn(`slopcheck: unparseable npm response for ${pkgName} — classifying as ASSUMED`);
    return { classification: 'ASSUMED', evidence: 'unparseable-registry-response' };
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      // Package record exists but no versions published — extremely rare; ASSUMED.
      return { classification: 'ASSUMED', evidence: 'no-published-versions' };
    }
    return { classification: 'LEGITIMATE', evidence: `versions-count:${parsed.length}` };
  }
  if (typeof parsed === 'string' && parsed.length > 0) {
    // Single-version package — npm collapses the array to a scalar.
    return { classification: 'LEGITIMATE', evidence: 'single-version' };
  }

  // Anything else (object, null, number) — unexpected shape.
  return { classification: 'ASSUMED', evidence: 'unexpected-response-shape' };
}

/**
 * Classify a single package by registry. Skeleton implementations for pip
 * and cargo per PRD § 4 — full registry probes are out-of-scope for the MVP.
 *
 * @param {string} name
 * @param {string} registry
 * @param {number} timeoutMs
 * @returns {Promise<{ classification: string, evidence?: string }>}
 */
async function classifyByRegistry(name, registry, timeoutMs) {
  if (registry === 'npm') {
    return classifyNpmPackage(name, timeoutMs);
  }
  if (registry === 'pip') {
    return { classification: 'ASSUMED', evidence: 'pip-registry-unsupported-mvp' };
  }
  if (registry === 'cargo') {
    return { classification: 'ASSUMED', evidence: 'cargo-registry-unsupported-mvp' };
  }
  return { classification: 'ASSUMED', evidence: 'unknown-registry' };
}

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate a single input entry. Returns a normalised { name, registry } when
 * usable, or { invalid: true, name, registry } otherwise. We preserve the
 * input fields (even when malformed) so the output entry can echo them back.
 *
 * @param {*} entry
 * @returns {{ name: string|null, registry: string|null, invalid: boolean }}
 */
function normaliseEntry(entry) {
  if (typeof entry !== 'object' || entry === null) {
    return { name: null, registry: null, invalid: true };
  }
  const name = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : null;
  const registry = typeof entry.registry === 'string' && entry.registry.length > 0
    ? entry.registry
    : null;
  return { name, registry, invalid: name === null || registry === null };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a list of packages against their respective registries.
 *
 * Each input entry is `{ name: string, registry: 'npm'|'pip'|'cargo'|... }`.
 * Each output entry is `{ name, registry, classification, evidence? }` —
 * positionally aligned with the input. Always returns an Array; never throws.
 *
 * Side-effects:
 *  - Reads/writes `.orchestrator/runtime/slopcheck-cache.json` (24 h TTL).
 *  - Spawns `npm view ...` per uncached npm package (5 s timeout each).
 *  - Writes WARN to stderr on timeouts, cache failures, malformed responses.
 *
 * Callers must NOT rely on classifyPackages running probes in parallel
 * (today it is sequential — keeps the cache-write semantics simple).
 *
 * @param {Array<{ name: string, registry: string }>} pkgs
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] — defaults to process.cwd().
 * @param {number} [opts.timeoutMs=5000] — per-package registry timeout.
 * @returns {Promise<Array<{ name: any, registry: any, classification: string, evidence?: string }>>}
 */
export async function classifyPackages(pkgs, opts = {}) {
  // Top-level never-throw guard: if input is not iterable, return [].
  if (!Array.isArray(pkgs)) return [];
  if (pkgs.length === 0) return [];

  const { repoRoot, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

  try {
    ensureCacheLoaded(repoRoot);
  } catch (err) {
    // ensureCacheLoaded already catches its own I/O errors, but belt+suspenders:
    console.warn(`slopcheck: cache load failed unexpectedly: ${err.message}`);
  }

  const results = [];
  let cacheDirty = false;

  for (const rawEntry of pkgs) {
    const normalised = normaliseEntry(rawEntry);

    // Surface the original fields on the output so callers can correlate.
    const echoName = (rawEntry && typeof rawEntry === 'object') ? rawEntry.name ?? null : null;
    const echoRegistry = (rawEntry && typeof rawEntry === 'object') ? rawEntry.registry ?? null : null;

    if (normalised.invalid) {
      // Malformed input — ASSUMED with diagnostic evidence. Never SLOP, because
      // we cannot prove non-existence without a name to probe.
      results.push({
        name: echoName,
        registry: echoRegistry,
        classification: 'ASSUMED',
        evidence: 'invalid-input-entry',
      });
      continue;
    }

    const key = cacheKey(normalised.name, normalised.registry);
    const cached = _cache?.get(key) ?? null;
    if (cached !== null && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
      // Cache hit — return the cached classification without invoking the registry.
      const entry = {
        name: normalised.name,
        registry: normalised.registry,
        classification: cached.classification,
      };
      if (typeof cached.evidence === 'string') entry.evidence = cached.evidence;
      results.push(entry);
      continue;
    }

    // Cache miss (or expired). Probe the registry; never let an unexpected
    // error escape this loop.
    let probe;
    try {
      probe = await classifyByRegistry(normalised.name, normalised.registry, timeoutMs);
    } catch (err) {
      console.warn(`slopcheck: classifier threw unexpectedly for ${normalised.name}@${normalised.registry}: ${err.message}`);
      probe = { classification: 'ASSUMED', evidence: 'classifier-exception' };
    }

    // Defensive: ensure the classifier returned a valid enum value.
    const classification = CLASSIFICATIONS.includes(probe.classification)
      ? probe.classification
      : 'ASSUMED';
    const evidence = typeof probe.evidence === 'string' ? probe.evidence : undefined;

    const outEntry = { name: normalised.name, registry: normalised.registry, classification };
    if (evidence !== undefined) outEntry.evidence = evidence;
    results.push(outEntry);

    // Update cache (in-memory now, flushed to disk once after the loop).
    if (_cache !== null) {
      const cacheEntry = { classification, fetchedAt: Date.now() };
      if (evidence !== undefined) cacheEntry.evidence = evidence;
      _cache.set(key, cacheEntry);
      cacheDirty = true;
    }
  }

  // Flush cache once per call to avoid N fsync syscalls in a large batch.
  if (cacheDirty) {
    persistCache(repoRoot);
  }

  return results;
}

/**
 * Look up a cached classification entry without contacting the registry.
 * Returns null when the entry is absent, expired, or the cache was never loaded.
 *
 * Note: this helper triggers a one-shot cache load from disk so it can be
 * called BEFORE any classifyPackages() invocation in the same process.
 *
 * @param {string} name
 * @param {string} registry
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] — defaults to process.cwd().
 * @returns {{ classification: string, fetchedAt: number, evidence?: string }|null}
 */
export function getCachedClassification(name, registry, opts = {}) {
  if (typeof name !== 'string' || name.length === 0) return null;
  if (typeof registry !== 'string' || registry.length === 0) return null;
  ensureCacheLoaded(opts.repoRoot);
  const entry = _cache?.get(cacheKey(name, registry)) ?? null;
  if (entry === null) return null;
  if ((Date.now() - entry.fetchedAt) >= CACHE_TTL_MS) return null;
  // Return a shallow copy so callers cannot mutate the in-memory cache.
  const copy = { classification: entry.classification, fetchedAt: entry.fetchedAt };
  if (typeof entry.evidence === 'string') copy.evidence = entry.evidence;
  return copy;
}

/**
 * Wipe the in-memory cache AND remove the persisted cache file. Fail-soft:
 * unlink errors are swallowed (the in-memory clear still succeeds).
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] — defaults to process.cwd().
 */
export function clearCache(opts = {}) {
  _cache = new Map();
  // Reset the loaded-path marker so the next ensureCacheLoaded() will rerun
  // the disk load (now finding either no file or a freshly-written one).
  _cacheLoadedFromPath = null;

  const file = cachePathFor(opts.repoRoot);
  try {
    fs.unlinkSync(file);
  } catch (err) {
    // ENOENT is the expected case after first-run clearCache; any other
    // failure is non-fatal — we already cleared the in-memory cache.
    if (err.code !== 'ENOENT') {
      console.warn(`slopcheck: cache file unlink failed (${err.code ?? 'unknown'}): ${err.message}`);
    }
  }
}

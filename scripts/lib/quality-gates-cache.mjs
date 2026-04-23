/**
 * quality-gates-cache.mjs — Baseline quality-gate result cache (#258).
 *
 * Purpose:
 *   Wave-executor Incremental quality checks run once per session but were
 *   previously re-executed after every implementation wave, even when the
 *   session's dependency tree and session-start ref hadn't changed. This
 *   module persists the session-start Baseline result and lets wave-executor
 *   skip Incremental when the cache is still valid and the working-tree
 *   diff remains narrow.
 *
 * INVARIANT: Full Gate at session-end is NEVER skipped regardless of cache
 * state. This module only short-circuits Incremental in wave-executor.
 *
 * Storage:
 *   .orchestrator/metrics/baseline-results.jsonl  (append-only JSONL, one
 *   record per session baseline run — consistent with sessions.jsonl,
 *   events.jsonl, learnings.jsonl, audit.jsonl precedent).
 *
 * Record schema (version 1):
 *   {
 *     version: 1,
 *     session_id: string,
 *     session_start_ref: string,        // git sha captured at session-start
 *     captured_at: string,              // ISO 8601 UTC
 *     dependency_hash: string,          // sha256 of package.json + lockfile
 *     results: {
 *       typecheck: { status: 'pass'|'fail', error_count?: number },
 *       test:      { status: 'pass'|'fail' },
 *       lint:      { status: 'pass'|'fail' }
 *     }
 *   }
 *
 * Validity rules (see isCacheValid):
 *   - session_start_ref matches current session
 *   - dependency_hash matches current package.json + lockfile
 *   - captured_at within TTL (default 7 days)
 *   - all results.* statuses === 'pass'
 *
 * Skip rule (see shouldSkipIncremental):
 *   cache valid AND changed-file-count < 50
 *
 * Fail-safe: every public function returns a structured result; none throw.
 * On error, shouldSkipIncremental returns skip=false (Incremental runs),
 * loadLatestBaselineResult returns null.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const CACHE_RELATIVE_PATH = '.orchestrator/metrics/baseline-results.jsonl';
const DEFAULT_TTL_DAYS = 7;
const DEFAULT_SCOPE_THRESHOLD = 50;
const RECORD_VERSION = 1;

/**
 * Compute a sha256 hash over package.json plus the active lockfile.
 * Missing lockfile → hash only package.json.
 * Missing package.json → returns the sha256 of the empty string (stable null).
 *
 * @param {string} repoRoot Absolute path to repo root.
 * @returns {string} Hex sha256 digest.
 */
export function computeDependencyHash(repoRoot) {
  const hash = crypto.createHash('sha256');
  const pkgPath = path.join(repoRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    hash.update(fs.readFileSync(pkgPath));
  }
  // Prefer pnpm-lock.yaml (project standard), then package-lock.json, then yarn.lock.
  const lockCandidates = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'];
  for (const candidate of lockCandidates) {
    const candidatePath = path.join(repoRoot, candidate);
    if (fs.existsSync(candidatePath)) {
      hash.update(fs.readFileSync(candidatePath));
      break;
    }
  }
  return hash.digest('hex');
}

/**
 * Append one baseline-result record to the JSONL cache.
 * Creates the metrics directory if missing. Atomic append via appendFileSync.
 *
 * @param {object} params
 * @param {string} params.repoRoot
 * @param {string} params.sessionId
 * @param {string} params.sessionStartRef
 * @param {object} params.results { typecheck, test, lint } — see module header.
 */
export function saveBaselineResult({ repoRoot, sessionId, sessionStartRef, results }) {
  const cachePath = path.join(repoRoot, CACHE_RELATIVE_PATH);
  const cacheDir = path.dirname(cachePath);
  fs.mkdirSync(cacheDir, { recursive: true });
  const record = {
    version: RECORD_VERSION,
    session_id: sessionId,
    session_start_ref: sessionStartRef,
    captured_at: new Date().toISOString(),
    dependency_hash: computeDependencyHash(repoRoot),
    results,
  };
  fs.appendFileSync(cachePath, JSON.stringify(record) + '\n');
}

/**
 * Return the most recent record from the JSONL cache, or null if the file
 * is missing, empty, or the last line is unparseable.
 *
 * Never throws.
 *
 * @param {object} params
 * @param {string} params.repoRoot
 * @returns {object|null}
 */
export function loadLatestBaselineResult({ repoRoot }) {
  try {
    const cachePath = path.join(repoRoot, CACHE_RELATIVE_PATH);
    if (!fs.existsSync(cachePath)) return null;
    const raw = fs.readFileSync(cachePath, 'utf8');
    if (!raw.trim()) return null;
    const lines = raw.split('\n').filter((line) => line.trim().length > 0);
    if (lines.length === 0) return null;
    const last = lines[lines.length - 1];
    return JSON.parse(last);
  } catch {
    return null;
  }
}

/**
 * Validate a cache record against current session context.
 *
 * @param {object} params
 * @param {string} params.repoRoot
 * @param {object|null} params.latestRecord
 * @param {string} params.currentSessionStartRef
 * @param {number} [params.ttlDays=7]
 * @returns {{ valid: boolean, reason: string }}
 */
export function isCacheValid({ repoRoot, latestRecord, currentSessionStartRef, ttlDays = DEFAULT_TTL_DAYS }) {
  if (!latestRecord) {
    return { valid: false, reason: 'no-record' };
  }
  if (latestRecord.session_start_ref !== currentSessionStartRef) {
    return { valid: false, reason: 'session-ref-mismatch' };
  }
  const currentDepHash = computeDependencyHash(repoRoot);
  if (latestRecord.dependency_hash !== currentDepHash) {
    return { valid: false, reason: 'dependency-changed' };
  }
  const capturedAt = Date.parse(latestRecord.captured_at);
  if (Number.isNaN(capturedAt)) {
    return { valid: false, reason: 'ttl-expired' };
  }
  const ageMs = Date.now() - capturedAt;
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  if (ageMs > ttlMs) {
    return { valid: false, reason: 'ttl-expired' };
  }
  const r = latestRecord.results || {};
  const statuses = [r.typecheck?.status, r.test?.status, r.lint?.status];
  if (!statuses.every((s) => s === 'pass')) {
    return { valid: false, reason: 'baseline-had-failures' };
  }
  return { valid: true, reason: 'cache-hit' };
}

/**
 * High-level convenience used by wave-executor.
 *
 * Returns { skip, reason, changedFileCount }. Never throws — on any error
 * (git failure, unreadable cache, etc.) returns skip=false so Incremental
 * runs. Fail safe = run Incremental.
 *
 * @param {object} params
 * @param {string} params.repoRoot
 * @param {string} params.sessionStartRef
 * @param {number} [params.scopeThreshold=50]
 * @returns {{ skip: boolean, reason: string, changedFileCount: number }}
 */
export function shouldSkipIncremental({ repoRoot, sessionStartRef, scopeThreshold = DEFAULT_SCOPE_THRESHOLD }) {
  try {
    const latestRecord = loadLatestBaselineResult({ repoRoot });
    const validity = isCacheValid({ repoRoot, latestRecord, currentSessionStartRef: sessionStartRef });
    if (!validity.valid) {
      return { skip: false, reason: validity.reason, changedFileCount: -1 };
    }
    const diff = spawnSync('git', ['diff', '--name-only', `${sessionStartRef}..HEAD`], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (diff.status !== 0) {
      return { skip: false, reason: 'git-diff-failed', changedFileCount: -1 };
    }
    const changedFileCount = diff.stdout.split('\n').filter((line) => line.trim().length > 0).length;
    if (changedFileCount >= scopeThreshold) {
      return { skip: false, reason: 'scope-too-large', changedFileCount };
    }
    return { skip: true, reason: 'cache-hit', changedFileCount };
  } catch (err) {
    return { skip: false, reason: `error:${err?.message ?? 'unknown'}`, changedFileCount: -1 };
  }
}

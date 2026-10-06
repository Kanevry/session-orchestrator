import { existsSync, readFileSync } from 'node:fs';
import { classifyManifestSession, readProcessLocalSessionIds } from './session-identity/own-session.mjs';
import { findOwnScopeFile } from './scope-gate.mjs';

/**
 * Resolve the active wave number from the wave-scope sidecar (#966 step 1).
 *
 * Mirrors `resolveWave()` in `hooks/pre-bash-memory-propose-audit.mjs` — the
 * same `.{pi,cursor,codex,claude}/wave-scope.json` precedence via
 * {@link findOwnScopeFile}, skipping a PEER session's manifest in the same
 * working copy (#1504: a peer-only result is no wave of ours, never the peer's
 * number) — with ONE deliberate difference: the hook returns `0` for "no
 * wave-scope file", this returns `null`.
 *
 * Absent is not zero. A human running `npm run quality-gate` from a `git push`
 * has no wave at all, and that is the common case; publishing `wave_number: 0`
 * would invent a wave 0 that every consumer then has to special-case. The
 * caller spreads the result so the KEY is omitted, exactly as `counts` is.
 *
 * A non-positive, unsafe or non-integer `wave` field is treated the same way — waves
 * are 1-indexed, so `0` on disk carries no more information than an absent file.
 *
 * Never throws.
 *
 * @param {string} projectDir — directory whose wave-scope sidecar to read.
 * @returns {number|null} positive safe integer wave number, or `null` when there is no wave.
 */
export function resolveWaveNumber(projectDir) {
  try {
    const ownIds = new Set(readProcessLocalSessionIds({ env: process.env, hookInput: null }));
    const { path: waveFile } = findOwnScopeFile(projectDir, ownIds, classifyManifestSession);
    if (!waveFile || !existsSync(waveFile)) return null;
    const wave = JSON.parse(readFileSync(waveFile, 'utf8'))?.wave;
    if (!Number.isSafeInteger(wave) || wave <= 0) return null;
    return wave;
  } catch {
    return null;
  }
}


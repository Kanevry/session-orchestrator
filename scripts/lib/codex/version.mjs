/**
 * version.mjs — the Codex CLI version floor and its check (GitLab #1919).
 *
 * Shared by the installer (`scripts/codex-install.mjs`, hard refusal below the
 * floor) and the readiness CLI (`scripts/runtime-readiness.mjs --codex`,
 * advisory warning). Node built-ins plus `spawnNativeSync` only.
 *
 * ## What is measured and what is not
 *
 * MEASURED (macOS, 2026-11-02): codex-cli 0.160.1 accepts the plugin manifest
 * with a `SessionEnd` hook and fires it. NOT MEASURED: the exact first version
 * between 0.145 and 0.160 that does so; the floor is set to 0.160.0, the
 * lowest release of the measured minor line. Revisit when an older Codex can
 * be tested against the same manifest.
 *
 * ## Fail-open ceiling
 *
 * `checkCodexVersion()` spawns `codex --version`. A spawn that fails, times
 * out or prints no version is `unmeasurable` — reported, never a warning and
 * never a failure ("could not run" is not "ok"). A rollout's
 * `session_meta.payload.cli_version` would avoid the spawn, but whether a
 * rollout exists at SessionStart is unmeasured, so this check is not wired
 * into the SessionStart probe (hook timeout 5 s). Revisit when that is measured.
 */
import { spawnNativeSync } from '../native-command.mjs';

/** Lowest supported Codex CLI version as `[major, minor, patch]`. */
export const MIN_CODEX_VERSION = Object.freeze([0, 160, 0]);

/**
 * Ceiling for `codex --version`. Unmeasured (the command returns in well under
 * a second on the measured host); mirrors the named-ceiling pattern of
 * `LIST_TIMEOUT_MS` in `scripts/runtime-readiness.mjs`. Revisit if a slow host
 * reports `unmeasurable (timeout)`.
 */
export const CODEX_VERSION_TIMEOUT_MS = 5000;

/**
 * Extract `[major, minor, patch]` from `codex --version` output
 * (e.g. `codex-cli 0.160.1`).
 * @param {string} text
 * @returns {number[]|null} null when no version is present
 */
export function parseCodexVersion(text) {
  const match = String(text ?? '').match(/\b(\d+)\.(\d+)\.(\d+)(?:[-+][^\s]+)?\b/);
  return match ? match.slice(1, 4).map(Number) : null;
}

/**
 * Compare two numeric version arrays.
 * @param {number[]} left
 * @param {number[]} right
 * @returns {-1|0|1}
 */
export function compareVersions(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

const MINIMUM = MIN_CODEX_VERSION.join('.');

/**
 * Run `codex --version` once and judge it against `MIN_CODEX_VERSION`.
 * @param {{ spawn?: typeof spawnNativeSync }} [deps]
 * @returns {{ status: 'ok'|'warn'|'unmeasurable', version: string|null, minimum: string, detail: string }}
 */
export function checkCodexVersion({ spawn = spawnNativeSync } = {}) {
  const unmeasurable = (reason) => ({
    status: 'unmeasurable', version: null, minimum: MINIMUM, detail: `Codex-Version nicht messbar (${reason})`,
  });
  let r;
  try {
    r = spawn('codex', ['--version'], { encoding: 'utf8', timeout: CODEX_VERSION_TIMEOUT_MS });
  } catch (error) {
    return unmeasurable(error?.code ?? error?.message ?? 'spawn failed');
  }
  if (r?.error) {
    return unmeasurable(r.error.code === 'ETIMEDOUT' ? 'timeout' : (r.error.code ?? r.error.message));
  }
  if (r?.status !== 0) return unmeasurable(`exit ${r?.status ?? 'null'}`);
  const parsed = parseCodexVersion(r.stdout);
  if (!parsed) return unmeasurable('unparseable output');
  const version = parsed.join('.');
  if (compareVersions(parsed, MIN_CODEX_VERSION) < 0) {
    return {
      status: 'warn', version, minimum: MINIMUM,
      detail: `codex-cli ${version} is below ${MINIMUM}; SessionEnd is not accepted and the plugin manifest may be rejected — upgrade Codex`,
    };
  }
  return { status: 'ok', version, minimum: MINIMUM, detail: `codex-cli ${version} meets ${MINIMUM}` };
}

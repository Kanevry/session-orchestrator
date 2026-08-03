/**
 * scripts/lib/blocked-commands-policy.mjs — policy-floor merge for the
 * destructive-command guard (#972).
 *
 * Before #972 the guard's policy loader was first-hit-wins over
 * [cwd, projectDir, pluginRoot]/.orchestrator/policy/blocked-commands.json.
 * Consequence: an empty (or hostile) consumer policy in cwd SILENTLY disarmed
 * the plugin's own policy — `{"version":1,"rules":[]}` switched the guard off.
 *
 * This module replaces first-hit-wins with a FLOOR/OVERLAY merge:
 *   - FLOOR   = the plugin-root policy (the plugin's own blocklist).
 *   - OVERLAY = the first existing policy from [cwd, projectDir] (a consumer
 *               repo's local policy).
 *   - The overlay can only ADD rules or ESCALATE severity — never remove a
 *     floor rule, never downgrade a floor `block`, never swap a floor rule's
 *     pattern/path-allowlist for its own (field-merge would be the backdoor).
 *
 * Invariant: merged.rules ⊇ floor.rules for EVERY overlay input (including
 * `{}`, `{"rules":[]}`, malformed JSON, and a missing file) — every overlay
 * failure mode fails TO THE FLOOR, not open.
 *
 * All exported functions are TOTAL: they never throw. The consuming hook keeps
 * its documented `main().catch → exit 0` fail-open for internal errors, so any
 * throw here would silently disarm the guard — totality is load-bearing.
 */

import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';

const POLICY_REL = path.join('.orchestrator', 'policy', 'blocked-commands.json');

/** Severity ordering for the escalate-only merge: warn < block. */
const SEVERITY_RANK = { warn: 0, block: 1 };

/** Module-level default per-path cache (each hook invocation is an isolated
 * Node subprocess, so this is fresh per process — issue #250 contract). */
const _defaultCache = new Map();

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the floor and overlay policy paths from the three injected roots.
 *
 * Roles are purely PATH-based (no schema marker): the plugin root supplies the
 * floor; the first existing policy among [cwd, projectDir] is the overlay.
 * When both roles resolve to the SAME file (the common case inside the plugin
 * repo itself, where cwd == pluginRoot), callers must treat it as ONE policy
 * (identity merge) — `loadEffectivePolicy` does exactly that.
 *
 * @param {{cwd?: string, projectDir?: string, pluginRoot?: string}} [roots]
 * @returns {{floorPath: string|null, overlayPath: string|null}} existing paths only
 */
export function resolvePolicyPaths({ cwd, projectDir, pluginRoot } = {}) {
  const candidate = (root) => {
    if (typeof root !== 'string' || root.length === 0) return null;
    try {
      const p = path.join(root, POLICY_REL);
      return existsSync(p) ? p : null;
    } catch {
      return null;
    }
  };

  const floorPath = candidate(pluginRoot);

  let overlayPath = null;
  for (const root of [cwd, projectDir]) {
    const p = candidate(root);
    if (p) { overlayPath = p; break; }
  }

  return { floorPath, overlayPath };
}

// ---------------------------------------------------------------------------
// Rule sanitation (per-file)
// ---------------------------------------------------------------------------

/**
 * Sanitize one file's rules array: drop broken individual rules (missing
 * string id/pattern/severity) and duplicate ids (first occurrence wins), each
 * with a warning — never kill the whole list for one bad entry.
 *
 * Valid rules pass through UNCHANGED (extra fields like `path-allowlist` and
 * `allow-override-flag` are preserved verbatim).
 *
 * @param {unknown} rules
 * @param {string} label - 'floor' | 'overlay' | 'policy' (for warning text)
 * @param {string[]} warnings - appended to in place
 * @returns {object[]}
 */
function sanitizeRules(rules, label, warnings) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(rules)) return out;

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const broken =
      rule === null ||
      typeof rule !== 'object' ||
      typeof rule.id !== 'string' || rule.id.length === 0 ||
      typeof rule.pattern !== 'string' || rule.pattern.length === 0 ||
      typeof rule.severity !== 'string';
    if (broken) {
      const ident = rule && typeof rule === 'object' && typeof rule.id === 'string'
        ? `'${rule.id}'`
        : `at index ${i}`;
      warnings.push(`${label} rule ${ident} skipped (missing/invalid id, pattern, or severity)`);
      continue;
    }
    if (seen.has(rule.id)) {
      warnings.push(`${label} rule '${rule.id}' duplicated within one file — first occurrence wins`);
      continue;
    }
    seen.add(rule.id);
    out.push(rule);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Merge a floor policy with an overlay policy — union by rule id, floor rules
 * first, escalate-only semantics:
 *
 *   (a) overlay-only id                  → appended (additive).
 *   (b) id collision, floor `block`      → the WHOLE floor rule wins (no field
 *       merge — an overlay path-allowlist/pattern would be the backdoor);
 *       overlay definition dropped + warning.
 *   (c) id collision, floor `warn`       → max(floor, overlay) severity with
 *       warn < block, on the FLOOR rule's fields; unknown/missing overlay
 *       severity → floor wins + warning.
 *   (d) duplicate ids WITHIN one file    → first occurrence wins + warning.
 *   (e) broken individual rule           → skipped with warning, list survives.
 *
 * Total function: any non-policy input is treated as an empty rules list.
 *
 * @param {{rules?: unknown}|null|undefined} floor
 * @param {{rules?: unknown}|null|undefined} overlay
 * @returns {{rules: object[], warnings: string[]}}
 */
export function mergePolicies(floor, overlay) {
  const warnings = [];
  const floorRules = sanitizeRules(floor?.rules, 'floor', warnings);
  const overlayRules = sanitizeRules(overlay?.rules, 'overlay', warnings);

  const merged = [...floorRules];
  const indexById = new Map(merged.map((r, i) => [r.id, i]));

  for (const rule of overlayRules) {
    const idx = indexById.get(rule.id);
    if (idx === undefined) {
      // (a) additive overlay-only rule
      indexById.set(rule.id, merged.length);
      merged.push(rule);
      continue;
    }

    const floorRule = merged[idx];
    if (floorRule.severity === 'block') {
      // (b) floor block is immutable — whole floor rule wins
      warnings.push(
        `overlay rule '${rule.id}' shadowed by floor block rule — overlay definition ignored`
      );
      continue;
    }

    if (floorRule.severity === 'warn') {
      // (c) escalate-only on the floor rule's fields.
      // Object.hasOwn, not `in`: `in` walks the prototype chain, so an
      // inherited key like severity:'toString' passed as "known" and silently
      // swallowed the unknown-severity warning (W4 F4).
      if (!Object.hasOwn(SEVERITY_RANK, rule.severity)) {
        warnings.push(
          `overlay rule '${rule.id}' has unknown severity '${rule.severity}' — floor severity kept`
        );
        continue;
      }
      if (SEVERITY_RANK[rule.severity] > SEVERITY_RANK[floorRule.severity]) {
        merged[idx] = { ...floorRule, severity: rule.severity };
      }
      continue;
    }

    // Floor rule carries an unknown severity string — conservative: keep it.
    warnings.push(
      `overlay rule '${rule.id}' collides with floor rule of unknown severity ` +
      `'${floorRule.severity}' — floor rule kept`
    );
  }

  return { rules: merged, warnings };
}

// ---------------------------------------------------------------------------
// Load (with per-path mtime cache)
// ---------------------------------------------------------------------------

/**
 * Read + parse one policy file with a per-path mtime cache.
 *
 * @param {string|null} policyPath
 * @param {Map<string, {mtimeMs: number, policy: object}>} cache
 * @returns {Promise<{status: 'valid', policy: object}
 *   | {status: 'invalid', reason: string}
 *   | {status: 'missing'}>}
 */
async function readPolicyFile(policyPath, cache) {
  if (!policyPath) return { status: 'missing' };

  let mtimeMs;
  try {
    mtimeMs = (await fsp.stat(policyPath)).mtimeMs;
    const cached = cache.get(policyPath);
    if (cached && cached.mtimeMs === mtimeMs) {
      return { status: 'valid', policy: cached.policy };
    }
  } catch {
    // stat failure → fall through to an uncached read attempt (fail-safe;
    // mirrors the pre-#972 loadPolicyCached contract).
    mtimeMs = null;
  }

  let policy;
  try {
    policy = JSON.parse(await fsp.readFile(policyPath, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return { status: 'missing' };
    return { status: 'invalid', reason: 'malformed (invalid JSON)' };
  }
  if (!policy || typeof policy !== 'object' || !Array.isArray(policy.rules)) {
    return { status: 'invalid', reason: 'missing .rules array' };
  }
  if (mtimeMs !== null) cache.set(policyPath, { mtimeMs, policy });
  return { status: 'valid', policy };
}

/**
 * Load the EFFECTIVE policy: floor + overlay, merged escalate-only.
 *
 * Failure modes (all fail-to-floor, never fail-open where a floor exists):
 *   - overlay malformed / missing .rules / EMPTY rules → floor alone + warning
 *     (`rules: []` is explicitly a warning, not a legitimate empty policy —
 *     an empty overlay must not disarm the floor).
 *   - floor unavailable (plugin root unresolvable or file missing) → overlay
 *     alone + warning.
 *   - floor malformed + valid overlay → overlay alone + loud warning.
 *   - both unavailable → `{ rules: null, warnings: [...] }` — the hook keeps
 *     its documented fail-open + stderr warning for this case.
 *   - floorPath === overlayPath (degenerate, e.g. cwd == pluginRoot) → the one
 *     file IS the policy (identity merge; no shadow warnings against itself).
 *
 * Total function: never throws.
 *
 * @param {{cwd?: string, projectDir?: string, pluginRoot?: string,
 *          cache?: Map<string, {mtimeMs: number, policy: object}>}} [opts]
 * @returns {Promise<{rules: object[]|null, warnings: string[]}>}
 */
export async function loadEffectivePolicy({ cwd, projectDir, pluginRoot, cache = _defaultCache } = {}) {
  const warnings = [];
  try {
    const { floorPath, overlayPath } = resolvePolicyPaths({ cwd, projectDir, pluginRoot });

    // Degenerate case: both roles are the same file → ONE policy.
    if (floorPath !== null && floorPath === overlayPath) {
      const res = await readPolicyFile(floorPath, cache);
      if (res.status === 'valid') {
        return { rules: sanitizeRules(res.policy.rules, 'policy', warnings), warnings };
      }
      warnings.push(
        res.status === 'invalid' && res.reason === 'missing .rules array'
          ? 'policy file missing .rules array — skipping guard'
          : 'policy file is malformed (invalid JSON) — skipping guard'
      );
      return { rules: null, warnings };
    }

    const floorRes = await readPolicyFile(floorPath, cache);
    const overlayRes = await readPolicyFile(overlayPath, cache);

    const floorValid = floorRes.status === 'valid';
    const overlayValid = overlayRes.status === 'valid';
    const overlayEmpty = overlayValid && overlayRes.policy.rules.length === 0;

    if (floorValid && overlayValid && !overlayEmpty) {
      const merge = mergePolicies(floorRes.policy, overlayRes.policy);
      return { rules: merge.rules, warnings: [...warnings, ...merge.warnings] };
    }

    if (floorValid) {
      // fail-to-floor: overlay missing is the normal no-overlay case (silent);
      // overlay invalid or empty is a warning — it can never disarm the floor.
      if (overlayRes.status === 'invalid') {
        warnings.push(`overlay policy ignored (${overlayRes.reason}) — floor policy enforced alone`);
      } else if (overlayEmpty) {
        warnings.push(
          'overlay policy ignored (empty rules array — an empty overlay cannot disarm the floor) ' +
          '— floor policy enforced alone'
        );
      }
      return { rules: sanitizeRules(floorRes.policy.rules, 'floor', warnings), warnings };
    }

    if (overlayValid) {
      warnings.push(
        floorRes.status === 'invalid'
          ? `floor policy is ${floorRes.reason} — enforcing overlay policy alone`
          : 'floor policy unavailable (plugin root unresolvable or file missing) — enforcing overlay policy alone'
      );
      if (overlayEmpty) {
        warnings.push('overlay policy has an empty rules array — guard has no rules to enforce');
      }
      return { rules: sanitizeRules(overlayRes.policy.rules, 'overlay', warnings), warnings };
    }

    // Neither side usable.
    if (floorRes.status === 'missing' && overlayRes.status === 'missing') {
      warnings.push(
        'policy file not found (.orchestrator/policy/blocked-commands.json) — skipping guard'
      );
    } else {
      const describe = (res) =>
        res.status === 'missing' ? 'missing' : res.reason;
      warnings.push(
        `no usable policy (floor: ${describe(floorRes)}; overlay: ${describe(overlayRes)}) — skipping guard`
      );
    }
    return { rules: null, warnings };
  } catch (err) {
    // Totality backstop — never throw into the hook's fail-open catch.
    warnings.push(`policy load failed unexpectedly (${err?.message || err}) — skipping guard`);
    return { rules: null, warnings };
  }
}

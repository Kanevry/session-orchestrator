/**
 * owner-config-banner.mjs — #820
 *
 * Session-start Phase 4 readiness probe for the Owner Persona Layer's
 * owner.yaml. Complements the per-section tolerance behaviour added to
 * `loadOwnerConfig` (scripts/lib/owner-yaml.mjs, #820) by surfacing what
 * would otherwise be a silent-failure class: a malformed OPTIONAL section
 * silently replaced by defaults, or the whole file silently discarded
 * because a REQUIRED section is invalid.
 *
 * Three findings, combined into a single null-or-warn result:
 *
 *  1. `droppedSections` present — an OPTIONAL object section (`paths`,
 *     `dispatcher`) was malformed and replaced by its default value.
 *  2. Whole-file discard — a REQUIRED section (`owner`, `tone`,
 *     `efficiency`, `hardware-sharing`) was invalid, so `loadOwnerConfig`
 *     fell back to `source: 'defaults'` with `errors` populated (legacy
 *     behaviour, unchanged since #161).
 *  3. `sectionWarnings` present (and nothing dropped) — an OPTIONAL list
 *     section (`vaults`, `baselines`) has invalid entries that lenient
 *     consumers will drop at point-of-use.
 *  4. Loose file mode (#1636 point 8) — owner.yaml or its directory carries
 *     group/world bits (an older writer under umask 022 left 644/755, salt
 *     included). The writer tightens only what it rewrites, so a host that
 *     never rewrote the file keeps it readable. POSIX only; silent when tight.
 *
 * Plain-JS — no Zod dependency. Never throws. Returns null (silent no-op)
 * when the load was clean (`source: 'file'`, nothing dropped/warned) or the
 * file is simply absent (`source: 'defaults'`, no errors).
 *
 * Mirrors the contract used by other Phase 4 banners
 * (`scripts/lib/loop-readiness-banner.mjs`, `scripts/lib/vault-staleness-banner.mjs`,
 * `scripts/lib/ci-status-banner.mjs`): a single `checkXxx()` entry point that
 * returns `null` or `{ severity, message, ... }`.
 *
 * Cross-references:
 *  - `scripts/lib/owner-yaml.mjs` — loadOwnerConfig, validateOwnerSections.
 *  - `.claude/rules/owner-persona.md` — owner.yaml schema + privacy contract.
 *  - `skills/session-start/SKILL.md` Phase 4 — banner render site (wired separately).
 *  - Issue #820.
 */

import { statSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  loadOwnerConfig,
  resolveOwnerYamlPath,
  getDefaults,
  OPTIONAL_OBJECT_SECTIONS,
} from './owner-yaml.mjs';
import { shellQuote } from './sh-quote.mjs';

/**
 * Format a `{ section, errors }` entry into a short `"name" (first error)` tag.
 * @param {{ section: string, errors?: string[] }} entry
 * @returns {string}
 */
function formatSectionTag(entry) {
  const firstError = Array.isArray(entry?.errors) && entry.errors.length > 0 ? entry.errors[0] : 'invalid';
  return `"${entry?.section}" (${firstError})`;
}

/**
 * Measure owner.yaml and its directory for group/world permission bits.
 * The file fails on any group/world bit (`& 0o077`). The directory fails only
 * on group/world read or write (`& 0o066`): execute-only (e.g. 711) lets
 * others traverse to a known name but not list the directory, and the 600
 * file behind it is what guards the content.
 * Returns one banner line naming the measured modes and the exact fix, or
 * null when both are tight, the file is absent, the platform is win32 (POSIX
 * modes are meaningless there) or any stat fails. Never throws.
 *
 * @param {string} filePath - absolute owner.yaml path
 * @param {string} platform - `process.platform` value
 * @returns {string|null}
 */
function looseModeLine(filePath, platform) {
  if (platform === 'win32') return null;
  try {
    const dir = dirname(filePath);
    const fileMode = statSync(filePath).mode & 0o777;
    const dirMode = statSync(dir).mode & 0o777;
    if ((fileMode & 0o077) === 0 && (dirMode & 0o066) === 0) return null;
    const oct = (m) => m.toString(8).padStart(3, '0');
    return (
      `⚠ owner-config: ${filePath} is ${oct(fileMode)} in a ${oct(dirMode)} directory — open to other users. ` +
      `Fix: chmod 700 ${shellQuote(dir)}; chmod 600 ${shellQuote(filePath)}`
    );
  } catch {
    return null;
  }
}

/**
 * Check owner.yaml load health and produce a session-start banner.
 *
 * @param {{ loader?: (opts?: object) => {
 *   config?: object,
 *   source: 'file'|'defaults'|'partial',
 *   errors: string[],
 *   droppedSections?: Array<{ section: string, errors: string[] }>,
 *   sectionWarnings?: Array<{ section: string, errors: string[] }>,
 * } }} [opts]
 *   - `loader`: defaults to `loadOwnerConfig`; injectable for tests (fake loader).
 *   - `ownerYamlPath`: file whose mode is checked; defaults to `resolveOwnerYamlPath()`.
 *   - `platform`: defaults to `process.platform`; injectable for tests.
 * @returns {null | {
 *   severity: 'warn',
 *   message: string,
 *   droppedSections?: Array<{ section: string, errors: string[] }>,
 *   sectionWarnings?: Array<{ section: string, errors: string[] }>,
 *   discarded?: boolean,
 *   looseMode?: boolean,
 * }}
 */
export function checkOwnerConfig({ loader = loadOwnerConfig, ownerYamlPath, platform = process.platform } = {}) {
  let modeLine;
  try {
    modeLine = looseModeLine(ownerYamlPath ?? resolveOwnerYamlPath(), platform);
  } catch {
    modeLine = null;
  }
  const result = checkLoadHealth(loader);
  if (!modeLine) return result;
  if (!result) return { severity: 'warn', message: modeLine, looseMode: true };
  return { ...result, message: `${result.message}\n${modeLine}`, looseMode: true };
}

/**
 * Load-health findings 1–3 (see module header). Never throws.
 * @param {Function} loader
 * @returns {null | { severity: 'warn', message: string }}
 */
function checkLoadHealth(loader) {
  try {
    const result = loader();
    if (!result || typeof result !== 'object') return null;

    const errors = Array.isArray(result.errors) ? result.errors : [];
    const droppedSections = Array.isArray(result.droppedSections) ? result.droppedSections : [];
    const sectionWarnings = Array.isArray(result.sectionWarnings) ? result.sectionWarnings : [];

    // Clean load (source 'file', nothing dropped/warned) — silent no-op.
    if (result.source === 'file' && droppedSections.length === 0 && sectionWarnings.length === 0) {
      return null;
    }

    // File simply absent (or unreadable with no schema errors) — silent no-op.
    if (result.source === 'defaults' && errors.length === 0) {
      return null;
    }

    // Whole-file discard: a REQUIRED section was invalid (legacy behaviour).
    //
    // #1244 MERGE RULE (owner-yaml.mjs loadOwnerConfig): a VALID optional
    // object section (`paths`, `dispatcher`) survives the discard — merged
    // onto its default in `result.config`. loadOwnerConfig's return carries no
    // dedicated "survived" field, so it is derived here: a section differs
    // from `getDefaults()` only when real, validly-parsed values were merged
    // in. Without this, the banner claimed "the entire file was discarded"
    // while a host-local `paths.confidential-names-file` the operator DID
    // configure correctly was still live — the exact silent-fix-that-lies gap
    // Q3 measured with a tmp owner.yaml (invalid `owner.name`, valid
    // `paths.confidential-names-file`).
    if (result.source === 'defaults' && errors.length > 0) {
      const firstError = errors[0];
      const path = resolveOwnerYamlPath();
      const survivedSections = [];
      if (result.config && typeof result.config === 'object') {
        const defaults = getDefaults();
        for (const name of OPTIONAL_OBJECT_SECTIONS) {
          if (JSON.stringify(result.config[name]) !== JSON.stringify(defaults[name])) {
            survivedSections.push(name);
          }
        }
      }

      const message =
        survivedSections.length > 0
          ? `⚠ owner-config: ${path} has required section(s) invalid (${firstError}) — ` +
            `${survivedSections.map((s) => `"${s}"`).join('/')} kept, everything else defaulted. ` +
            'Fix the file (see .claude/rules/owner-persona.md) to restore your settings.'
          : `⚠ owner-config: ${path} is invalid (${firstError}) — the entire file was ` +
            'discarded and defaults are in effect. Fix the file (see .claude/rules/owner-persona.md) ' +
            'to restore your settings.';

      return {
        severity: 'warn',
        message,
        discarded: true,
        ...(droppedSections.length > 0 ? { droppedSections } : {}),
      };
    }

    // Per-section tolerance findings (#820): dropped OPTIONAL object
    // section(s) and/or invalid OPTIONAL list section(s).
    const parts = [];
    if (droppedSections.length > 0) {
      parts.push(`section(s) replaced by defaults: ${droppedSections.map(formatSectionTag).join(', ')}`);
    }
    if (sectionWarnings.length > 0) {
      parts.push(
        `section(s) with invalid entries (lenient consumers will drop bad entries): ` +
          sectionWarnings.map(formatSectionTag).join(', '),
      );
    }

    if (parts.length === 0) return null;

    return {
      severity: 'warn',
      message: `⚠ owner-config: ${resolveOwnerYamlPath()} — ${parts.join('; ')} — fix the file to restore full config.`,
      ...(droppedSections.length > 0 ? { droppedSections } : {}),
      ...(sectionWarnings.length > 0 ? { sectionWarnings } : {}),
    };
  } catch {
    // Defensive catch-all — banner must never throw.
    return null;
  }
}

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

import { loadOwnerConfig, OWNER_YAML_PATH } from './owner-yaml.mjs';

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
 * Check owner.yaml load health and produce a session-start banner.
 *
 * @param {{ loader?: (opts?: object) => {
 *   source: 'file'|'defaults'|'partial',
 *   errors: string[],
 *   droppedSections?: Array<{ section: string, errors: string[] }>,
 *   sectionWarnings?: Array<{ section: string, errors: string[] }>,
 * } }} [opts]
 *   - `loader`: defaults to `loadOwnerConfig`; injectable for tests (fake loader).
 * @returns {null | {
 *   severity: 'warn',
 *   message: string,
 *   droppedSections?: Array<{ section: string, errors: string[] }>,
 *   sectionWarnings?: Array<{ section: string, errors: string[] }>,
 *   discarded?: boolean,
 * }}
 */
export function checkOwnerConfig({ loader = loadOwnerConfig } = {}) {
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
    if (result.source === 'defaults' && errors.length > 0) {
      const firstError = errors[0];
      return {
        severity: 'warn',
        message:
          `⚠ owner-config: ${OWNER_YAML_PATH} is invalid (${firstError}) — the entire file was ` +
          'discarded and defaults are in effect. Fix the file (see .claude/rules/owner-persona.md) ' +
          'to restore your settings.',
        discarded: true,
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
      message: `⚠ owner-config: ${OWNER_YAML_PATH} — ${parts.join('; ')} — fix the file to restore full config.`,
      ...(droppedSections.length > 0 ? { droppedSections } : {}),
      ...(sectionWarnings.length > 0 ? { sectionWarnings } : {}),
    };
  } catch {
    // Defensive catch-all — banner must never throw.
    return null;
  }
}

/**
 * learnings/sizing-subject.mjs — the one derivation of an `effective-sizing`
 * learning's `subject`, keyed on `(session_type, session_profile)`.
 *
 * GitLab #1247. `ultradeep` is a PROFILE layered on top of an unchanged
 * `session_type: deep` (STATE.md frontmatter key `session-profile`; see
 * `scripts/lib/state-md.mjs` `SESSION_PROFILE_FIELD`, PRD
 * `docs/prd/2026-09-06-ultradeep-session-profile.md`) — 7 waves vs. deep's
 * 4-5. Before this module, the `effective-sizing` analyzer
 * (`skills/evolve/references/evolve-analyze-mode.md`) keyed its subject on
 * `session_type` alone (e.g. `deep-session-sizing`), so a 7-wave ultradeep
 * session and a 5-wave deep session landed on the SAME row — the over-delivery
 * median for one profile silently absorbed the other's.
 *
 * Pure, stdlib-only, no imports, no clock, no fs.
 *
 * ## Subject literal (chosen form, justified)
 *
 * `${session_type}-session-sizing` when `session_profile` is absent/null —
 * BYTE-IDENTICAL to the pre-#1247 literal (`deep-session-sizing`,
 * `feature-session-sizing`, per the existing `skills/evolve/SKILL.md` example
 * row), so learnings keyed before this change still match on re-run.
 * `${session_type}-${session_profile}-session-sizing` when a profile is
 * present — e.g. `deep-ultradeep-session-sizing`. The profile slots BETWEEN
 * type and the `-session-sizing` suffix (rather than, say, prefixing or
 * appending after the suffix) so every subject stays readable as
 * `<type>[-<profile>]-session-sizing` and a reader can strip the trailing
 * `-session-sizing` to recover `type[-profile]` unambiguously — the same
 * shape `session-profile` frontmatter documents ("a wave-shape variant on
 * top of an unchanged session_type").
 *
 * @param {{session_type?: unknown, session_profile?: unknown}} params
 * @returns {string} The canonical `effective-sizing` subject.
 */
export function sizingSubject({ session_type, session_profile } = {}) {
  const type = typeof session_type === 'string' && session_type.trim().length > 0
    ? session_type.trim()
    : 'unknown';
  const profile =
    typeof session_profile === 'string' && session_profile.trim().length > 0
      ? session_profile.trim()
      : null;
  return profile === null ? `${type}-session-sizing` : `${type}-${profile}-session-sizing`;
}

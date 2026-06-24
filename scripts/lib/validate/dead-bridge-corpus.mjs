// dead-bridge-corpus.mjs — Regression corpus + declared real bridges for the
// dead-bridge validator. Issue #671.
//
// PROVENANCE: This module is the equivalence anchor that proves the unified
// dead-bridge validator subsumes three previously-separate guards:
//   - #614 dangling-subagent-type   (subagent_type references a non-existent agent)
//   - #445 dangling-rule-reference  (a "See Also" footer cites a missing sibling rule)
//   - #618 dangling-bootstrap-bridge(a bootstrap shell guard checks a renamed/absent file)
// plus a NEW class introduced by the unified validator:
//   - bridge-balance               (a declared producer/consumer pair where one side
//                                     has zero live matches — set-but-never-read or
//                                     read-but-never-set)
//
// PURE DATA MODULE — no IO, no console, no process.exit. Import-safe.
// The detectors (dead-bridge-detectors.mjs) and the CLI (check-dead-bridge.mjs)
// consume these exports; this module never reaches the filesystem itself.

/**
 * @typedef {Object} CorpusCase
 * @property {string} id          Stable identifier for the regression case.
 * @property {'dangling-subagent-type'|'dangling-rule-reference'|'dangling-bootstrap-bridge'|'bridge-balance'} rule
 * @property {string} description Human-readable summary of what the case proves.
 * @property {string} positive    Minimal source text that MUST produce a Finding for `rule`.
 * @property {string} negative    Minimal source text that MUST NOT produce any Finding.
 */

/**
 * Regression corpus. Each row is an equivalence anchor: the detector for `rule`
 * MUST flag `positive` and MUST clear `negative`. The Quality wave's corpus test
 * consumes these strings directly — keep them minimal and self-contained.
 * @type {CorpusCase[]}
 */
export const CORPUS = [
  {
    id: '614-dead-subagent-type',
    rule: 'dangling-subagent-type',
    description:
      '#614 — a subagent_type reference must resolve to an agent that exists under agents/. ' +
      'The positive names a ghost agent; the negative names code-implementer (which exists).',
    positive: 'subagent_type: "session-orchestrator:ghost-agent-xyz"',
    negative: 'subagent_type: "session-orchestrator:code-implementer"',
  },
  {
    id: '445-dangling-rule-ref',
    rule: 'dangling-rule-reference',
    description:
      '#445 — a "## See Also" footer entry ending in .md must resolve to a sibling rule file ' +
      'under .claude/rules/. The positive cites a non-existent sibling; the negative cites ' +
      'security.md (which exists in .claude/rules/).',
    positive: '## See Also\nfoo · ghost-rule-xyz.md · bar',
    negative: '## See Also\nfoo · security.md · bar',
  },
  {
    id: '618-renamed-dep-guard',
    rule: 'dangling-bootstrap-bridge',
    description:
      '#618 — a bootstrap shell guard that tests for a plugin-relative file must point at a ' +
      'file that actually exists. The positive checks fetch-baseline.sh (only the .mjs exists ' +
      'after the rename); the negative checks fetch-baseline.mjs (present).',
    positive: '[ -f "$PLUGIN_ROOT/scripts/lib/fetch-baseline.sh" ]',
    negative: '[ -f "$PLUGIN_ROOT/scripts/lib/fetch-baseline.mjs" ]',
  },
  {
    id: 'bridge-balance-set-never-read',
    rule: 'bridge-balance',
    description:
      'NEW class — a declared producer/consumer bridge where the consumer side has zero live ' +
      'matches (set-but-never-read). The positive declares an event that is emitted but never ' +
      'consumed; the negative declares an event that is both emitted and consumed.',
    positive:
      'producer emits "orphan_event_set_never_read"; consumer reads <nothing> → 0 consumer matches',
    negative:
      'producer emits "paired_event"; consumer reads "paired_event" → both sides >= 1 match',
  },
  {
    id: 'bridge-balance-read-never-set',
    rule: 'bridge-balance',
    description:
      'NEW class — a declared producer/consumer bridge where the producer side has zero live ' +
      'matches (read-but-never-set). The positive declares a config key that is read but never ' +
      'documented/written; the negative declares a key that is both written and read.',
    positive:
      'consumer reads "phantom_key_read_never_set"; producer writes <nothing> → 0 producer matches',
    negative:
      'consumer reads "paired_key"; producer writes "paired_key" → both sides >= 1 match',
  },
];

/**
 * @typedef {Object} BridgeEndpoint
 * @property {string} pattern   Literal/regex token grepped for at this endpoint.
 * @property {string[]} scope   Repo-relative paths (files or dirs) the grep is scoped to.
 * @property {string[]} [exts]  Optional file-extension allow-list within `scope`.
 */

/**
 * @typedef {Object} Bridge
 * @property {string} id           Stable identifier for the declared bridge.
 * @property {string} description  What the producer/consumer pair represents.
 * @property {BridgeEndpoint} producer  The "set"/"emit"/"document" side.
 * @property {BridgeEndpoint} consumer  The "read"/"parse"/"consume" side.
 */

/**
 * Declared REAL bridges, checked against the LIVE repo by detectBridgeBalance.
 * EVERY entry here MUST currently be BALANCED (both endpoints have >= 1 match) so
 * `node scripts/lib/validate/check-dead-bridge.mjs` stays GREEN. Only declare
 * pairs that have been grep-proven balanced.
 *
 * Grep-proven 2026-06-24 (#671 Wave 2; re-verified Wave 3 against the fixed,
 * file-or-dir-aware detector):
 *   producer: rg -c "test-command" docs/session-config-template.md  => 5
 *   consumer: rg -c "test-command" scripts/lib/config.mjs           => 2
 *
 * NOTE: `scope` entries below are concrete FILE paths (not directories) and
 * `exts` are declared without a leading dot (`'md'`/`'mjs'`). The detector's
 * countMatches() handles both file/dir scope entries and normalizes exts, so
 * this declaration is LIVE — detectBridgeBalance counts 5/2, not 0/0.
 *
 * @type {Bridge[]}
 */
export const BRIDGES = [
  {
    id: 'session-config-test-command',
    description:
      'The `test-command` Session Config key is DOCUMENTED in the config template (producer) ' +
      'and PARSED by the config reader (consumer, via _coerceString(kv, "test-command", ...)). ' +
      'Both endpoints must keep at least one live match — a rename on either side leaves the ' +
      'other dangling.',
    producer: {
      pattern: 'test-command',
      scope: ['docs/session-config-template.md'],
      exts: ['md'],
    },
    consumer: {
      pattern: 'test-command',
      scope: ['scripts/lib/config.mjs'],
      exts: ['mjs'],
    },
  },
];

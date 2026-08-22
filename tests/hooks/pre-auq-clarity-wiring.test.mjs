/**
 * tests/hooks/pre-auq-clarity-wiring.test.mjs
 *
 * WIRING test for hooks/pre-auq-clarity.mjs (#1107).
 *
 * This repo has a documented systemic failure mode: instruments get built,
 * tested and documented — and never switched on ("Gebaut-aber-nicht-
 * eingeschaltet", 7 recorded cases). A registration that merely *exists* in
 * hooks.json proves nothing: the entry can sit under the wrong event, carry a
 * misspelled matcher, or point at a file that is not there, and every one of
 * those failures is SILENT at runtime.
 *
 * So this file deliberately does NOT assert that a string appears somewhere in
 * the manifest (that would pin prose — .claude/rules/test-value.md TV-002c).
 * It parses the manifest and asserts the properties that decide whether the
 * registration has any effect at all: right event, right matcher, real file,
 * neighbour-identical invocation form, registered exactly once — plus the
 * mechanical witness for why the three counterpart harnesses deliberately do
 * NOT carry it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { mapPiToolName } from '../../scripts/lib/pi-hook-bridge.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const HOOKS_DIR = path.join(REPO_ROOT, 'hooks');

const HANDLER = 'pre-auq-clarity.mjs';
const TOOL = 'AskUserQuestion';

/** Exact invocation form every Claude-side hook in this manifest uses. */
const EXPECTED_COMMAND =
  'sh "$CLAUDE_PLUGIN_ROOT/hooks/run-node.sh" "$CLAUDE_PLUGIN_ROOT/hooks/pre-auq-clarity.mjs"';

function readManifest(file) {
  return JSON.parse(readFileSync(path.join(HOOKS_DIR, file), 'utf8'));
}

/**
 * Flatten a Claude/Codex/Pi-shaped manifest into one record per registered
 * hook command, keeping the event + matcher each one is reached through.
 *
 * @param {Record<string, unknown>} manifest
 * @returns {Array<{event: string, matcher: string, hook: Record<string, unknown>}>}
 */
function flattenRegistrations(manifest) {
  const out = [];
  for (const [event, blocks] of Object.entries(manifest.hooks ?? {})) {
    for (const block of Array.isArray(blocks) ? blocks : [blocks]) {
      for (const hook of Array.isArray(block?.hooks) ? block.hooks : []) {
        out.push({ event, matcher: block.matcher ?? '', hook });
      }
    }
  }
  return out;
}

/** Claude Code matcher semantics: `*`/empty = every tool, else `|` alternation. */
function matcherFires(matcher, toolName) {
  if (!matcher || matcher === '*') return true;
  return matcher.split('|').map((p) => p.trim()).includes(toolName);
}

const claude = readManifest('hooks.json');
const registrations = flattenRegistrations(claude).filter((r) =>
  String(r.hook.command ?? '').includes(HANDLER),
);

describe('pre-auq-clarity.mjs registration in hooks/hooks.json', () => {
  // Catches: the hook was never wired at all — the #1107 instrument ships
  // built-but-not-switched-on, and nothing at runtime reports its absence.
  // Also catches DOUBLE registration, which would run the guard twice per
  // question (duplicate telemetry, duplicate decision envelope on one call).
  it('is registered exactly once across the whole manifest', () => {
    expect(registrations).toHaveLength(1);
  });

  // Catches: the entry sits under PostToolUse (or SessionStart, or any other
  // event). A clarity guard that runs AFTER the tool call has already been
  // made cannot withhold a malformed question from the operator — it observes
  // a decision it was built to gate.
  it('is registered on PreToolUse and on no other event', () => {
    expect(registrations.map((r) => r.event)).toEqual(['PreToolUse']);
  });

  // Catches: a misspelled matcher ("AskUserQuestions", "askUserQuestion",
  // "AskUserQuestion "). This is the most expensive defect this file can
  // carry, because it is completely silent: the manifest looks wired, the
  // hook never fires, and no error is ever emitted.
  it('carries the exact AskUserQuestion matcher', () => {
    expect(registrations[0].matcher).toBe(TOOL);
  });

  // Catches the same typo class from the other side, and additionally an
  // OVER-BROAD matcher ("*", "" or "AskUserQuestion|Bash"): the string
  // equality above would reject those, but this asserts the property that
  // actually matters at runtime — it fires on AskUserQuestion and on nothing
  // else. A `*` matcher would run the AUQ guard on every Bash and Edit call.
  it('fires on AskUserQuestion and not on any other tool', () => {
    const { matcher } = registrations[0];
    expect(matcherFires(matcher, TOOL)).toBe(true);
    for (const other of ['Bash', 'Agent', 'Edit', 'Write', 'Skill', 'Read']) {
      expect(matcherFires(matcher, other)).toBe(false);
    }
  });

  // Catches: the command points at a file that does not exist — a rename, a
  // typo in the filename, or a registration that landed before the handler
  // did. Checked against the FILESYSTEM, not against the manifest string, so
  // a self-consistent-but-wrong path still fails.
  it('points at a handler file that exists on disk', () => {
    const match = String(registrations[0].hook.command).match(/hooks\/([\w.-]+\.mjs)/);
    expect(match?.[1]).toBe(HANDLER);
    expect(existsSync(path.join(HOOKS_DIR, match[1]))).toBe(true);
  });

  // Catches: an invocation form that diverges from its neighbours — a bare
  // `node hooks/x.mjs` (breaks on any install whose cwd is not the plugin
  // root), a missing run-node.sh shim (loses the Node-resolution logic every
  // other hook relies on), or a missing timeout (an unbounded hook can hang
  // the tool call).
  it('uses the same invocation form as every other Claude-side hook', () => {
    expect(registrations[0].hook).toEqual({
      type: 'command',
      command: EXPECTED_COMMAND,
      timeout: 5,
    });
  });

  // The invariant above stated once, as a property of the whole PreToolUse
  // surface: catches a future edit that "fixes" the new entry by loosening
  // the shared form instead of matching it.
  it('shares the run-node.sh + $CLAUDE_PLUGIN_ROOT form with all PreToolUse siblings', () => {
    const preToolUse = flattenRegistrations(claude).filter((r) => r.event === 'PreToolUse');
    expect(preToolUse.length).toBeGreaterThan(1);
    for (const { hook } of preToolUse) {
      expect(hook.type).toBe('command');
      expect(hook.timeout).toBe(5);
      expect(hook.command).toContain('$CLAUDE_PLUGIN_ROOT/hooks/run-node.sh');
      expect(hook.command).toMatch(/"\$CLAUDE_PLUGIN_ROOT\/hooks\/[\w.-]+\.mjs"$/);
    }
  });
});

describe('pre-auq-clarity.mjs is deliberately NOT wired on the counterpart harnesses', () => {
  // Catches: a well-meaning "parity" edit that adds an AskUserQuestion
  // matcher to a harness whose tool namespace has no such tool. That entry
  // can never fire, so it is not enforcement — it is maintenance load that
  // ADVERTISES a protection the operator does not have (the #919-P2 class
  // this repo already registers as gaps rather than faking).
  //   Codex: docs/codex-setup.md — "Interactive choices | AskUserQuestion
  //          tool | Numbered Markdown lists"; hooks-codex.json PreToolUse is
  //          [] by design (no payload adapter).
  //   Cursor: docs/cursor-setup.md — same row; hooks-cursor.json is
  //          _enforcement: "reference-only" and declares only two
  //          Cursor-native events.
  //   Pi:    scripts/lib/pi-hook-bridge.mjs TOOL_NAME_MAP — no entry.
  it.each(['hooks-codex.json', 'hooks-cursor.json', 'hooks-pi.json'])(
    '%s carries no pre-auq-clarity registration',
    (file) => {
      expect(readFileSync(path.join(HOOKS_DIR, file), 'utf8')).not.toContain(HANDLER);
    },
  );

  // The mechanical witness for the Pi half of that decision, so the rationale
  // is not prose-only: Pi's bridge maps every tool it knows onto a canonical
  // Claude name, and an unknown tool falls through unchanged. AskUserQuestion
  // falls through; Bash does not. This goes RED the day Pi gains the tool —
  // which is exactly the day the "not wired" decision must be revisited.
  it('has no Pi-native tool that maps onto AskUserQuestion', () => {
    expect(mapPiToolName('bash')).toBe('Bash');
    expect(mapPiToolName('askuserquestion')).toBe('askuserquestion');
  });
});

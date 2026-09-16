/**
 * tests/commands/headless-bare-command-availability.test.mjs
 *
 * #1370 — how a bare slash command of this plugin resolves, and where its body
 * is allowed to live.
 *
 * MEASURED 2026-09-16 on claude 2.1.273, throwaway plugin under `claude -p`.
 * Three states, three outcomes — the middle one is why this file changed shape:
 *
 *   commands/<n>.md alone .................. `Unknown command: /<n>`
 *   commands/<n>.md + user-invocable skill . body RUNS, but the entry lists
 *                                            TWICE in the interactive `/` picker
 *   commands/<n>.md + `user-invocable:false` recognised, runs 0 turns
 *   skill with `user-invocable: true` alone   resolves, lists once
 *
 * So the twin is not redundancy, it is a defect, and the SKILL is the surface
 * that resolves. 24 of the 26 command files were folded into their same-named
 * `skills/<name>/SKILL.md`; `commands/` keeps only the names a skill cannot
 * carry. The marker for "operator-facing slash command" is an EXPLICIT
 * `user-invocable: true` in skill frontmatter (such skills may also carry
 * `argument-hint` / `disable-model-invocation`; neither flag is involved in
 * resolution — `/bootstrap` and `/brainstorm` carry the latter and resolve).
 *
 * MECHANISM 1 (unchanged) — reserved terminal-only built-in names.
 *   `claude -p "/session"` answers `"/session isn't available in this
 *   environment."` even with an EMPTY `CLAUDE_CONFIG_DIR` and NO plugin loaded.
 *   The name is reserved by the harness; no frontmatter or manifest field
 *   overrides it, and a skill mirror does not help. Only the namespaced form
 *   `/session-orchestrator:session` resolves. Since the fold, a reserved name
 *   can now collide from EITHER side — so the collision assertion below runs
 *   against the union (commands ∪ user-invocable skills), not commands alone.
 *
 * NOT A PROSE PIN (`.claude/rules/test-value.md` TV-002c): no assertion reads
 * the WORDING of any markdown file. Everything compares directory listings and
 * PARSED frontmatter against named constants.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { commandFileNames, userInvocableSkills } from '@lib/user-invocable-skills.mjs';

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '../..');
const SKILLS_DIR = path.join(PLUGIN_ROOT, 'skills');

/**
 * The ONLY names allowed to remain a `commands/*.md` file, each with the reason
 * it cannot be a user-invocable skill instead. Adding an entry here is a
 * documented decision, not a fix.
 *
 * `plan` is deliberately ABSENT since the fold: it is still a reserved built-in
 * name (mechanism 1), but its body moved to `skills/plan/SKILL.md`, so the
 * reserved-name collision is now asserted through the skill side below.
 */
const HEADLESS_EXCEPTIONS = {
  // Mechanism 1: reserved terminal-only built-in name. A skills/session/ mirror
  // would not help — the harness refuses the bare name before any plugin lookup,
  // and the twin would additionally double the picker entry. Documented
  // workaround: /session-orchestrator:session (README, docs/install.md).
  session: 'reserved terminal-only built-in name; use /session-orchestrator:session',
  // In-session hook bypass: /templates-ack writes a marker for the running
  // session's pre-bash-templates-first hook. A one-shot `claude -p` process has
  // no subsequent Bash call to unblock, so headless availability is meaningless.
  'templates-ack': 'in-session hook bypass — no meaning in a one-shot print-mode run',
};

/**
 * Terminal-only built-in command names reserved by Claude Code in
 * non-interactive sessions. Every terminal-only built-in's name except `help`
 * and `feedback` stays reserved in print mode.
 *
 * Source: https://code.claude.com/docs/en/slash-commands — retrieved 2026-09-16
 * against claude 2.1.273. The subset that actually collides with this repo is
 * {session, plan}; the rest are carried so that a future `commands/cost.md` — or
 * a future `skills/resume/` marked user-invocable — fails HERE rather than in a
 * customer's headless run.
 */
const RESERVED_TERMINAL_ONLY_BUILTINS = [
  'session', 'plan', 'cost', 'goal', 'reset', 'login', 'logout', 'clear',
  'compact', 'help', 'feedback', 'model', 'config', 'status', 'resume', 'init',
];

/** Collisions this repo has consciously accepted (documented workaround exists). */
const ACCEPTED_BUILTIN_COLLISIONS = ['session', 'plan'];

/**
 * Floor for the explicitly-user-invocable skill census. Replaces the old
 * "≥10 commands" blind-enumerator guard: after the fold the commands/ listing is
 * two entries long, so it can no longer detect an enumerator that silently
 * matches nothing. Floor/ceiling per `.claude/rules/testing.md` § Dynamic
 * Artifact Counts — 26 at the time of writing, floor set below it so adding or
 * retiring one command does not cost a test edit.
 */
const USER_INVOCABLE_FLOOR = 20;

const commandNames = commandFileNames(PLUGIN_ROOT);
const userInvocable = userInvocableSkills(PLUGIN_ROOT);

describe('headless bare-command availability (#1370)', () => {
  it('the user-invocable skill census is non-trivial (guards a blind enumerator)', () => {
    expect(userInvocable.length).toBeGreaterThanOrEqual(USER_INVOCABLE_FLOOR);
  });

  it('commands/ carries ONLY the documented headless exceptions', () => {
    const undocumented = commandNames.filter((n) => !Object.hasOwn(HEADLESS_EXCEPTIONS, n));
    expect(
      undocumented,
      'A slash command belongs in skills/<name>/SKILL.md with an explicit ' +
        '`user-invocable: true`. A commands/*.md file resolves only when a same-named ' +
        'skill exists — and then the picker lists the entry twice. Fold it, or add the ' +
        'name to HEADLESS_EXCEPTIONS with the reason it cannot be a skill.',
    ).toEqual([]);
  });

  it('no name exists as BOTH a commands/*.md and a skills/<name>/SKILL.md (picker-duplicate bug)', () => {
    const twinned = commandNames.filter((n) => existsSync(path.join(SKILLS_DIR, n, 'SKILL.md')));
    expect(
      twinned,
      'Measured on claude 2.1.273: a command + same-named skill runs the SKILL body ' +
        'and lists the entry TWICE in the interactive `/` picker. Delete the command file.',
    ).toEqual([]);
  });

  it('every documented headless exception is still a real command (no stale exemptions)', () => {
    const stale = Object.keys(HEADLESS_EXCEPTIONS).filter((n) => !commandNames.includes(n));
    expect(stale).toEqual([]);
  });

  it('no slash-command name collides with a reserved terminal-only built-in except the documented two', () => {
    // The union is the product's "slash commands" set since the fold — a
    // reserved name can now arrive from the skill side (`plan` does).
    const slashCommands = [...new Set([...commandNames, ...userInvocable])];
    const collisions = slashCommands.filter((n) => RESERVED_TERMINAL_ONLY_BUILTINS.includes(n));
    expect(collisions.sort()).toEqual([...ACCEPTED_BUILTIN_COLLISIONS].sort());
  });
});

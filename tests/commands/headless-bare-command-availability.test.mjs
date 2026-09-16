/**
 * tests/commands/headless-bare-command-availability.test.mjs
 *
 * #1370 — the plugin's bare slash commands under `claude -p` (print mode).
 *
 * TWO INDEPENDENT MECHANISMS were measured on claude 2.1.273 (2026-09-16), and
 * this file pins one regression guard per mechanism.
 *
 * MECHANISM 1 — reserved terminal-only built-in names.
 *   `claude -p "/session"` answers `"/session isn't available in this
 *   environment."` even with an EMPTY `CLAUDE_CONFIG_DIR` and NO plugin loaded.
 *   The name is reserved by the harness; no frontmatter or manifest field
 *   overrides it. Only the namespaced form `/session-orchestrator:session`
 *   resolves. Guarded by the second `it()` below.
 *
 * MECHANISM 2 — the bare alias comes from the SKILL registry, not commands/.
 *   In print mode a plugin's bare `/name` alias is registered only when a
 *   same-named `skills/<name>/SKILL.md` exists. A `commands/<name>.md` on its
 *   own answers `Unknown command: /<name>. Did you mean /cost?`. Proven on a
 *   minimal throwaway plugin: `/foocmd` (command only) unknown,
 *   `/minip:foocmd` ok, `/barskill` (skill only) ok — blind prediction 3/3.
 *   `disable-model-invocation` is NOT involved (`/bootstrap` and `/brainstorm`
 *   carry it and resolve fine). Guarded by the first `it()` below.
 *
 * NOT A PROSE PIN (`.claude/rules/test-value.md` TV-002c): neither assertion
 * reads the WORDING of any markdown file. Both compare directory listings
 * against named constants.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '../..');
const COMMANDS_DIR = path.join(PLUGIN_ROOT, 'commands');
const SKILLS_DIR = path.join(PLUGIN_ROOT, 'skills');

/**
 * Commands that intentionally ship WITHOUT a same-named skill, with the reason
 * each one is exempt. Adding an entry here is a documented decision, not a fix.
 */
const HEADLESS_EXCEPTIONS = {
  // Mechanism 1: reserved terminal-only built-in name. A skills/session/ mirror
  // would not help — the harness refuses the bare name before any plugin lookup.
  // Documented workaround: /session-orchestrator:session (commands/session.md
  // § Headless, README, docs/install.md).
  session: 'reserved terminal-only built-in name; use /session-orchestrator:session',
  // Mechanism 1, same as `session`.
  plan: 'reserved terminal-only built-in name; use /session-orchestrator:plan',
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
 * against claude 2.1.273. The subset that actually collides with this repo's
 * command names is {session, plan}; the rest are carried so that a future
 * `commands/cost.md` or `commands/resume.md` fails HERE rather than in a
 * customer's headless run.
 */
const RESERVED_TERMINAL_ONLY_BUILTINS = [
  'session', 'plan', 'cost', 'goal', 'reset', 'login', 'logout', 'clear',
  'compact', 'help', 'feedback', 'model', 'config', 'status', 'resume', 'init',
];

/** Collisions this repo has consciously accepted (documented workaround exists). */
const ACCEPTED_BUILTIN_COLLISIONS = ['session', 'plan'];

const commandNames = readdirSync(COMMANDS_DIR)
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.replace(/\.md$/, ''))
  .sort();

describe('headless bare-command availability (#1370)', () => {
  it('the command catalog is non-empty (guards a blind enumerator)', () => {
    expect(commandNames.length).toBeGreaterThanOrEqual(10);
  });

  it('every commands/*.md has a same-named skills/<name>/SKILL.md, or is on the documented headless-exception list', () => {
    const missing = commandNames.filter(
      (name) =>
        !existsSync(path.join(SKILLS_DIR, name, 'SKILL.md')) &&
        !Object.hasOwn(HEADLESS_EXCEPTIONS, name),
    );
    expect(
      missing,
      `These commands have no bare /name alias under \`claude -p\` (#1370 mechanism 2). ` +
        `Add skills/<name>/SKILL.md, or add the name to HEADLESS_EXCEPTIONS with its reason.`,
    ).toEqual([]);
  });

  it('every documented headless exception is still a real command (no stale exemptions)', () => {
    const stale = Object.keys(HEADLESS_EXCEPTIONS).filter((n) => !commandNames.includes(n));
    expect(stale).toEqual([]);
  });

  it('no command name collides with a reserved terminal-only built-in except the documented two', () => {
    const collisions = commandNames.filter((n) => RESERVED_TERMINAL_ONLY_BUILTINS.includes(n));
    expect(collisions.sort()).toEqual([...ACCEPTED_BUILTIN_COLLISIONS].sort());
  });
});

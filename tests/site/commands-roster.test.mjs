/**
 * tests/site/commands-roster.test.mjs
 *
 * Bug this catches: a command is added to the plugin (a skill with
 * `user-invocable: true`, or a new `commands/*.md`) and the /commands reference
 * page silently lacks it, or a removed command stays on the page as a card.
 * Nothing else connects site/commands/index.html to the plugin surface.
 *
 * The page side is the `data-command="<name>"` attribute, one per card. No
 * prose is asserted.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { slashCommandNames } from '../../scripts/lib/user-invocable-skills.mjs';

// Never process.cwd(): the pre-push gate runs the suite from $TMPDIR.
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PAGE = join(REPO_ROOT, 'site/commands/index.html');

// The same roster the "commands" metric counts (scripts/site-numbers.mjs), so
// the page and the counted number cannot disagree about what a command is.
const pluginCommands = () => new Set(slashCommandNames(REPO_ROOT));

const pageCommands = () =>
  [...readFileSync(PAGE, 'utf8').matchAll(/\sdata-command="([^"]+)"/g)].map((m) => m[1]);

describe('site /commands: roster matches the plugin', () => {
  it('finds a non-trivial plugin roster (guards the scan itself)', () => {
    expect(pluginCommands().size).toBeGreaterThanOrEqual(10);
  });

  it('carries each command at most once', () => {
    const seen = pageCommands();
    const dupes = seen.filter((n, i) => seen.indexOf(n) !== i);
    expect(dupes, 'data-command values repeated on the page').toEqual([]);
  });

  // The eyebrow states the count in prose ("30 commands"); it must follow the
  // cards, or a new command leaves a stale number at the top of the page.
  it('states the card count in its eyebrow', () => {
    const eyebrow = readFileSync(PAGE, 'utf8').match(/<p class="eyebrow">(\d+) commands/)?.[1];
    expect(Number(eyebrow), 'eyebrow command count').toBe(pageCommands().length);
  });

  it('carries exactly the plugin commands', () => {
    const plugin = pluginCommands();
    const page = new Set(pageCommands());
    expect([...plugin].filter((n) => !page.has(n)).sort(), 'commands missing on /commands').toEqual([]);
    expect([...page].filter((n) => !plugin.has(n)).sort(), 'cards for commands the plugin lacks').toEqual([]);
  });
});

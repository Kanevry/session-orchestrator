/**
 * config-syntax-parity.test.mjs — the four Session Config syntax forms must
 * normalize to ONE config object (#1097 AC-a).
 *
 * The 8 fleet repos write `## Session Config` in four spellings — bullet-bold
 * (`- **key:** value`), bullet-plain (`- key: value`), column-zero
 * (`key: value`) and yaml-fence (the whole block inside ```yaml). Three of them
 * carry hand-written defensive comments aimed at this parser, which is what a
 * silent divergence looks like from the outside: nobody sees a parse error,
 * they see a feature that "does not work in this repo" and write a note about it.
 *
 * The bug this file catches: a parser change that reads one spelling and
 * silently drops another. A form that falls out of the accept-set does not
 * throw — its keys are simply missing and every consumer applies its own
 * default. Only a cross-form comparison can see that.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseSessionConfig } from '@lib/config.mjs';
import { collectUnparsableLines } from '@lib/config/section-extractor.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE_DIR = join(REPO_ROOT, 'tests', 'fixtures');

const FORMS = ['column-zero', 'bullet-plain', 'bullet-bold', 'yaml-fence'];

// Hermetic host context: the default resolution reads the real owner.yaml, and
// a host-local `paths:` override would otherwise bleed into these assertions
// (see parseSessionConfig's @param note).
const HERMETIC = { hostPaths: { env: {}, ownerConfig: undefined, cwd: REPO_ROOT } };

function fixtureText(form) {
  return readFileSync(join(FIXTURE_DIR, `config-syntax-${form}.md`), 'utf8');
}

function parseForm(form) {
  return parseSessionConfig(fixtureText(form), HERMETIC);
}

describe('#1097 — the four Session Config syntax forms normalize identically', () => {
  it('parses the same JSON from all four forms', () => {
    const reference = parseForm('column-zero');
    for (const form of FORMS) {
      expect(parseForm(form), `form ${form} diverges from column-zero`).toEqual(reference);
    }
  });

  it('carries the shared fixture content, not just matching defaults', () => {
    // Guards the parity assert above from passing vacuously: four fixtures the
    // parser failed to read at all would ALSO be deep-equal — to each other and
    // to the all-defaults object. These four values are only reachable from the
    // fixture text, and the nested/list ones are the shapes a flat KV parser
    // loses first.
    for (const form of FORMS) {
      const config = parseForm(form);
      expect(config.vcs, `form ${form}`).toBe('gitlab');
      expect(config.waves, `form ${form}`).toBe(5);
      expect(config['cross-repos'], `form ${form}`).toEqual(['sven', 'session-orchestrator']);
      expect(config['vault-integration'], `form ${form}`).toMatchObject({
        enabled: true,
        mode: 'warn',
      });
    }
  });

  it('reports no unparsable line for any of the four forms', () => {
    // The fail-loud half must stay silent on well-formed input — a warning that
    // fires on a legitimate fleet spelling teaches operators to ignore it.
    for (const form of FORMS) {
      expect(collectUnparsableLines(fixtureText(form)), `form ${form}`).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// #1097 review — a commented-out key is not live config
// ---------------------------------------------------------------------------

describe('#1097 review — commented-out keys reach neither the config nor the report', () => {
  const FIXTURE = 'html-comment';

  it('ignores keys inside a multi-line <!-- … --> block', () => {
    // The bug: `_extractConfigSection` read the commented lines while
    // `collectUnparsableLines` skipped them, so the fixture's commented
    // `enforcement: strict` / `waves: 99` won LAST-MATCH over the live values
    // above them — and the block still reported clean. Commenting a key out is
    // the ordinary way to disable it; it must never arm the strictest path.
    const config = parseSessionConfig(fixtureText(FIXTURE), HERMETIC);
    expect(config.enforcement).toBe('warn');
    expect(config.waves).toBe(5);
    // Live keys around the comment are unaffected.
    expect(config.vcs).toBe('gitlab');
    expect(config['test-command']).toBe('npm test');
  });

  it('reports no unparsable line for the same fixture', () => {
    // Silence here is only honest because the commented keys are genuinely
    // gone from the KV map — the assertion above is what makes this one mean
    // "agreed", rather than "both blind".
    expect(collectUnparsableLines(fixtureText(FIXTURE))).toEqual([]);
  });
});

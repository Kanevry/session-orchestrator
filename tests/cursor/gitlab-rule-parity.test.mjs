/**
 * Concrete bug this test catches that the suite missed: reintroduction of an
 * id-based recipe (`glab repo view --output json`, `projects?search=`, a
 * python `json.load(...)['id']` extraction, `projects/$PROJECT_ID` in either
 * bare or braced form, or a bare `projects/<digits>` path) in ANY Cursor
 * rule, plus reintroduction of a single-colon `priority:<level>` label. That
 * form fails on hosts where the numeric project id differs (rename, fork, or
 * scaffold) and the skill-level contract in
 * tests/skills/gitlab-project-identity-contract.test.mjs never reads
 * `.cursor/rules/*.mdc`.
 *
 * #1093 P4 review gap (measured): the original ID_BASED_RECIPE regex missed
 * the braced `projects/${PROJECT_ID}` form, a bare `projects/<digits>` with
 * no trailing slash, and a python-based `json.load(...)['id']` extraction —
 * and RULE_FILES was hardcoded to two files, so drift in any other
 * `.cursor/rules/*.mdc` file went unchecked.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const RULES_DIR = '.cursor/rules';

/** Every tracked `.cursor/rules/*.mdc` file, not a hardcoded subset (#1093 review). */
const RULE_FILES = readdirSync(join(REPO_ROOT, RULES_DIR))
  .filter((name) => name.endsWith('.mdc'))
  .sort()
  .map((name) => join(RULES_DIR, name));

const ID_BASED_RECIPE =
  /glab repo view --output json|projects\?search=|json\.load[\s\S]{0,80}\[["']id["']\]|PROJECT_ID=|projects\/\$\{?[A-Za-z_]\w*ID\w*\}?|projects\/<PROJECT_ID>|projects\/[0-9]+\b/i;
const SINGLE_COLON_PRIORITY = /priority:(critical|high|medium|low)(?!:)/;

describe('#1093 Cursor GitLab rule path-contract parity', () => {
  it('rejects id-based recipes and single-colon priority labels across every Cursor rule file', () => {
    const bodies = RULE_FILES.map((file) => ({
      file,
      body: readFileSync(join(REPO_ROOT, file), 'utf8'),
    }));

    const idBasedHits = bodies.flatMap(({ file, body }) =>
      [...body.matchAll(new RegExp(ID_BASED_RECIPE, 'gi'))].map((match) => `${file}: ${match[0]}`),
    );
    const singleColonHits = bodies.flatMap(({ file, body }) =>
      [...body.matchAll(new RegExp(SINGLE_COLON_PRIORITY, 'g'))].map((match) => `${file}: ${match[0]}`),
    );

    expect(idBasedHits).toEqual([]);
    expect(singleColonHits).toEqual([]);
  });

  it('070-gitlab-ops.mdc documents the canonical -R and --hostname forms (positive assertion)', () => {
    const body = readFileSync(join(REPO_ROOT, RULES_DIR, '070-gitlab-ops.mdc'), 'utf8');

    expect(body).toContain('-R <OWNER>/<REPO>');
    expect(body).toContain('--hostname "$GITLAB_HOST"');
  });

  it('ID_BASED_RECIPE catches the three #1093 review bypass shapes (regression guard for the regex itself)', () => {
    const bypassSamples = [
      'PID=$(glab repo view --output json | jq -r .id)',
      'projects/${PROJECT_ID}/issues',
      'glab api "projects/12345678"',
    ];

    const caught = bypassSamples.map((sample) => new RegExp(ID_BASED_RECIPE, 'gi').test(sample));

    expect(caught).toEqual([true, true, true]);
  });
});

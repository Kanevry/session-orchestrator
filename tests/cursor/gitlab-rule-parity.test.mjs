/**
 * Concrete bug this test catches that the suite missed: reintroduction of an
 * id-based recipe (`glab repo view --output json`, `projects?search=`, or
 * `projects/$PROJECT_ID`) in Cursor rules. That form fails on hosts where the
 * numeric project id differs (rename, fork, or scaffold) and the skill-level
 * contract in tests/skills/gitlab-project-identity-contract.test.mjs never
 * reads `.cursor/rules/*.mdc`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const RULE_FILES = [
  '.cursor/rules/070-gitlab-ops.mdc',
  '.cursor/rules/080-ecosystem-health.mdc',
];

const ID_BASED_RECIPE =
  /glab repo view --output json|projects\?search=|PROJECT_ID=|projects\/\$PROJECT_ID|projects\/<PROJECT_ID>|projects\/[0-9]+\//;
const SINGLE_COLON_PRIORITY = /priority:(critical|high|medium|low)(?!:)/;

describe('#1093 Cursor GitLab rule path-contract parity', () => {
  it('rejects id-based recipes and single-colon priority labels in Cursor VCS rules', () => {
    const bodies = RULE_FILES.map((file) => ({
      file,
      body: readFileSync(join(REPO_ROOT, file), 'utf8'),
    }));

    const idBasedHits = bodies.flatMap(({ file, body }) =>
      [...body.matchAll(new RegExp(ID_BASED_RECIPE, 'g'))].map((match) => `${file}: ${match[0]}`),
    );
    const singleColonHits = bodies.flatMap(({ file, body }) =>
      [...body.matchAll(new RegExp(SINGLE_COLON_PRIORITY, 'g'))].map((match) => `${file}: ${match[0]}`),
    );

    expect(idBasedHits).toEqual([]);
    expect(singleColonHits).toEqual([]);
  });
});

/**
 * tests/lint/restricted-imports.test.mjs — pins the #1234 `no-restricted-imports`
 * guard in eslint.config.js.
 *
 * Bug this catches: a config refactor that drops or narrows the rule (e.g.
 * moves it out of the `**\/*.mjs` block) lets new code import the deprecated
 * `locks/index.mjs` shim or the deleted `OWNER_YAML_PATH` again, and
 * `npm run lint` stays green. Lints in-memory fixture strings through the REAL
 * flat config via the ESLint API — no fixture files on disk.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const eslint = new ESLint({
  cwd: REPO_ROOT,
  overrideConfigFile: path.join(REPO_ROOT, 'eslint.config.js'),
});

/** @param {string} code */
async function restrictedImportMessages(code) {
  const [result] = await eslint.lintText(code, {
    filePath: path.join(REPO_ROOT, 'scripts/lib/__restricted-imports-probe.mjs'),
  });
  return result.messages.filter((m) => m.ruleId === 'no-restricted-imports');
}

describe('eslint.config.js — no-restricted-imports (#1234)', () => {
  it('flags an import of the deprecated locks/index.mjs barrel', async () => {
    const msgs = await restrictedImportMessages(
      "import * as locks from './locks/index.mjs';\nexport { locks };\n",
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message).toContain('session-lock.mjs');
  });

  it('flags OWNER_YAML_PATH from owner-yaml.mjs but not resolveOwnerYamlPath', async () => {
    const msgs = await restrictedImportMessages(
      "import { OWNER_YAML_PATH, resolveOwnerYamlPath } from './owner-yaml.mjs';\n" +
        'export { OWNER_YAML_PATH, resolveOwnerYamlPath };\n',
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message).toContain('resolveOwnerYamlPath()');
  });
});

/**
 * category2.mjs — Category 2: Quality Gate Coverage (weight: 10)
 *
 * Checks: package-json-scripts, bootstrap-lock-schema, quality-gates-policy,
 *         schema-drift-ci
 *
 * Stdlib only: node:fs, node:path.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { safeRead, safeJson, pass, fail } from './helpers.mjs';

export function runCategory2(root) {
  const checks = [];

  // c2.1 package-json-scripts
  {
    const p = join(root, 'package.json');
    const text = safeRead(p);
    const pkg = safeJson(text);
    const relPath = 'package.json';
    if (!pkg) {
      checks.push(fail('package-json-scripts', 3, relPath,
        { test: null, typecheck: null, lint: null },
        'package.json missing or invalid JSON'));
    } else {
      const scripts = pkg.scripts || {};
      const testVal = typeof scripts.test === 'string' ? scripts.test : null;
      const typecheckVal = typeof scripts.typecheck === 'string' ? scripts.typecheck : null;
      const lintVal = typeof scripts.lint === 'string' ? scripts.lint : null;
      if (testVal && typecheckVal && lintVal) {
        checks.push(pass('package-json-scripts', 3, 3, relPath,
          { test: testVal, typecheck: typecheckVal, lint: lintVal },
          'package.json has test, typecheck, and lint scripts'));
      } else {
        checks.push(fail('package-json-scripts', 3, relPath,
          { test: testVal, typecheck: typecheckVal, lint: lintVal },
          `Missing scripts: ${[!testVal && 'test', !typecheckVal && 'typecheck', !lintVal && 'lint'].filter(Boolean).join(', ')}`));
      }
    }
  }

  // c2.2 bootstrap-lock-schema
  {
    const p = join(root, '.orchestrator/bootstrap.lock');
    const text = safeRead(p);
    const relPath = '.orchestrator/bootstrap.lock';
    if (!text) {
      checks.push(fail('bootstrap-lock-schema', 3, relPath,
        { version: null, tier: null, archetype: null },
        'bootstrap.lock missing'));
    } else {
      // Hand-rolled YAML key extraction
      const versionMatch = /^version:\s*(.+)$/m.exec(text);
      const tierMatch = /^tier:\s*(.+)$/m.exec(text);
      const archetypeMatch = /^archetype:\s*(.+)$/m.exec(text);
      const version = versionMatch ? versionMatch[1].trim() : null;
      const tier = tierMatch ? tierMatch[1].trim() : null;
      const archetype = archetypeMatch ? archetypeMatch[1].trim() : null;
      const validTiers = ['fast', 'standard', 'deep'];
      if (version && tier && validTiers.includes(tier) && archetype) {
        checks.push(pass('bootstrap-lock-schema', 3, 3, relPath,
          { version, tier, archetype },
          `bootstrap.lock valid: version=${version}, tier=${tier}, archetype=${archetype}`));
      } else {
        checks.push(fail('bootstrap-lock-schema', 3, relPath,
          { version, tier, archetype },
          `bootstrap.lock invalid: version=${version}, tier=${tier} (valid: fast|standard|deep), archetype=${archetype}`));
      }
    }
  }

  // c2.3 quality-gates-policy
  {
    const p = join(root, '.orchestrator/policy/quality-gates.json');
    const relPath = '.orchestrator/policy/quality-gates.json';
    if (!existsSync(p)) {
      // Optional — skip with pass
      checks.push(pass('quality-gates-policy', 2, 2, relPath,
        { present: false, valid: null },
        'quality-gates.json absent (optional per #183 fallback chain) — skip'));
    } else {
      const text = safeRead(p);
      const json = safeJson(text);
      if (!json) {
        checks.push(fail('quality-gates-policy', 2, relPath,
          { present: true, valid: false },
          'quality-gates.json exists but is not valid JSON'));
      } else {
        const cmds = json.commands || {};
        const hasTest = cmds.test && typeof cmds.test.command === 'string';
        const hasTypecheck = cmds.typecheck && typeof cmds.typecheck.command === 'string';
        const hasLint = cmds.lint && typeof cmds.lint.command === 'string';
        if (hasTest && hasTypecheck && hasLint) {
          checks.push(pass('quality-gates-policy', 2, 2, relPath,
            { present: true, valid: true },
            'quality-gates.json valid with commands.test|typecheck|lint'));
        } else {
          checks.push(fail('quality-gates-policy', 2, relPath,
            { present: true, valid: false },
            `quality-gates.json missing commands: ${[!hasTest && 'test', !hasTypecheck && 'typecheck', !hasLint && 'lint'].filter(Boolean).join(', ')}`));
        }
      }
    }
  }

  // c2.4 schema-drift-ci
  {
    const gitlabCi = join(root, '.gitlab-ci.yml');
    const ghWorkflowsDir = join(root, '.github/workflows');
    let matchedFile = null;

    const gitlabText = safeRead(gitlabCi);
    if (gitlabText && gitlabText.includes('schema-drift-check')) {
      matchedFile = '.gitlab-ci.yml';
    }

    if (!matchedFile && existsSync(ghWorkflowsDir)) {
      try {
        const files = readdirSync(ghWorkflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
        for (const f of files) {
          const text = safeRead(join(ghWorkflowsDir, f));
          if (text && text.includes('schema-drift')) {
            matchedFile = `.github/workflows/${f}`;
            break;
          }
        }
      } catch { /* ignore */ }
    }

    if (matchedFile) {
      checks.push(pass('schema-drift-ci', 2, 2, matchedFile,
        { matchedFile },
        `schema-drift check found in ${matchedFile}`));
    } else {
      checks.push(fail('schema-drift-ci', 2, '.gitlab-ci.yml or .github/workflows/*.yml',
        { matchedFile: null },
        'No schema-drift-check/schema-drift string found in CI config'));
    }
  }

  return checks;
}

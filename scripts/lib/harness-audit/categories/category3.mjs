/**
 * category3.mjs — Category 3: Hook Integrity (weight: 10)
 *
 * Checks: hooks-json-valid, hook-files-exist, hook-mjs-syntax,
 *         destructive-guard-loads-policy
 *
 * Stdlib only: node:fs, node:path, node:child_process.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { safeRead, safeJson, pass, fail } from './helpers.mjs';

export function runCategory3(root) {
  const checks = [];

  // c3.1 hooks-json-valid
  {
    const p = join(root, 'hooks/hooks.json');
    const text = safeRead(p);
    const relPath = 'hooks/hooks.json';
    const json = safeJson(text);
    if (!json) {
      checks.push(fail('hooks-json-valid', 3, relPath,
        { matcherCount: 0 },
        'hooks/hooks.json missing or invalid JSON'));
    } else {
      // Count matcher blocks: each event key in json.hooks has an array of matchers
      let matcherCount = 0;
      const hooks = json.hooks || {};
      for (const eventKey of Object.keys(hooks)) {
        const eventHooks = hooks[eventKey];
        if (Array.isArray(eventHooks)) matcherCount += eventHooks.length;
      }
      if (matcherCount >= 1) {
        checks.push(pass('hooks-json-valid', 3, 3, relPath,
          { matcherCount },
          `hooks.json valid with ${matcherCount} matcher block(s)`));
      } else {
        checks.push(fail('hooks-json-valid', 3, relPath,
          { matcherCount },
          'hooks.json valid JSON but has no matcher blocks'));
      }
    }
  }

  // c3.2 hook-files-exist
  {
    const p = join(root, 'hooks/hooks.json');
    const text = safeRead(p);
    const relPath = 'hooks/hooks.json';
    const json = safeJson(text);
    const referenced = [];
    const missing = [];

    if (json && json.hooks) {
      // Walk all command strings looking for $CLAUDE_PLUGIN_ROOT/hooks/*.mjs
      const commandRe = /\$(?:CLAUDE_PLUGIN_ROOT|CODEX_PLUGIN_ROOT|CURSOR_RULES_DIR)\/hooks\/([^"'\s]+\.mjs)/g;
      const jsonText = JSON.stringify(json);
      let m;
      while ((m = commandRe.exec(jsonText)) !== null) {
        const rel = `hooks/${m[1]}`;
        if (!referenced.includes(rel)) referenced.push(rel);
      }
      for (const rel of referenced) {
        if (!existsSync(join(root, rel))) missing.push(rel);
      }
    }

    if (missing.length === 0) {
      checks.push(pass('hook-files-exist', 3, 3, relPath,
        { referenced, missing },
        `All ${referenced.length} referenced hook file(s) exist`));
    } else {
      checks.push(fail('hook-files-exist', 3, relPath,
        { referenced, missing },
        `Missing hook files: ${missing.join(', ')}`));
    }
  }

  // c3.3 hook-mjs-syntax
  {
    const hooksDir = join(root, 'hooks');
    const relPath = 'hooks/*.mjs';
    let filesChecked = [];
    const syntaxErrors = [];

    try {
      filesChecked = readdirSync(hooksDir)
        .filter((f) => f.endsWith('.mjs'))
        .map((f) => `hooks/${f}`);
    } catch { /* hooks dir missing */ }

    for (const rel of filesChecked) {
      const abs = join(root, rel);
      try {
        execFileSync('node', ['--check', abs], { timeout: 3000, stdio: 'pipe' });
      } catch (err) {
        const msg = err.stderr ? err.stderr.toString().trim() : String(err);
        syntaxErrors.push({ file: rel, error: msg.split('\n')[0] });
      }
    }

    if (syntaxErrors.length === 0) {
      checks.push(pass('hook-mjs-syntax', 2, 2, relPath,
        { filesChecked: filesChecked.length, syntaxErrors: [] },
        `All ${filesChecked.length} hook .mjs file(s) pass syntax check`));
    } else {
      checks.push(fail('hook-mjs-syntax', 2, relPath,
        { filesChecked: filesChecked.length, syntaxErrors },
        `${syntaxErrors.length} hook file(s) have syntax errors`));
    }
  }

  // c3.4 destructive-guard-loads-policy
  {
    const p = join(root, 'hooks/pre-bash-destructive-guard.mjs');
    const relPath = 'hooks/pre-bash-destructive-guard.mjs';
    const text = safeRead(p);
    if (!text) {
      checks.push(fail('destructive-guard-loads-policy', 2, relPath,
        { loadsPolicy: false },
        'pre-bash-destructive-guard.mjs missing'));
    } else {
      const loadsPolicy = text.includes('blocked-commands.json') ||
        /import.*\.orchestrator\/policy/.test(text) ||
        /require.*\.orchestrator\/policy/.test(text);
      if (loadsPolicy) {
        checks.push(pass('destructive-guard-loads-policy', 2, 2, relPath,
          { loadsPolicy: true },
          'pre-bash-destructive-guard.mjs references policy'));
      } else {
        checks.push(fail('destructive-guard-loads-policy', 2, relPath,
          { loadsPolicy: false },
          'pre-bash-destructive-guard.mjs does not reference blocked-commands.json or .orchestrator/policy'));
      }
    }
  }

  return checks;
}

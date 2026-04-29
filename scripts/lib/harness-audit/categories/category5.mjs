/**
 * category5.mjs — Category 5: Plugin-Root Resolution (weight: 9)
 *
 * Checks: parse-config-fallback-chain, hooks-use-plugin-root-var,
 *         config-reading-doc, bootstrap-gate-doc
 *
 * Stdlib only: node:fs, node:path.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { safeRead, safeJson, pass, fail } from './helpers.mjs';

export function runCategory5(root) {
  const checks = [];

  // c5.1 parse-config-fallback-chain — verify the plugin-root fallback chain is
  // wired somewhere in the resolution surface (scripts/lib/**/*.mjs + any
  // hooks/*.json manifest). Relaxed from the original "all 3 in parse-config.mjs"
  // rule — plugins typically centralize platform resolution in a helper module
  // (platform.mjs in session-orchestrator) and branch by env var in per-platform
  // manifests (hooks.json, hooks-codex.json, hooks-cursor.json).
  {
    const envVars = ['CLAUDE_PLUGIN_ROOT', 'CODEX_PLUGIN_ROOT', 'CURSOR_RULES_DIR'];
    const candidatePaths = [
      'scripts/parse-config.mjs',
      'scripts/lib/config.mjs',
      'scripts/lib/platform.mjs',
    ];
    // Add all hooks/*.json manifests to the search surface
    const hooksDir = join(root, 'hooks');
    if (existsSync(hooksDir)) {
      try {
        for (const f of readdirSync(hooksDir)) {
          if (f.endsWith('.json')) candidatePaths.push(`hooks/${f}`);
        }
      } catch { /* dir unreadable — skip */ }
    }
    const foundIn = {};
    for (const rel of candidatePaths) {
      const text = safeRead(join(root, rel));
      if (!text) continue;
      for (const v of envVars) {
        if (text.includes(v)) {
          (foundIn[v] = foundIn[v] || []).push(rel);
        }
      }
    }
    const envVarsFound = envVars.filter((v) => foundIn[v]?.length);
    const relPath = 'scripts/lib/platform.mjs';
    if (envVarsFound.length === 3) {
      checks.push(pass('parse-config-fallback-chain', 3, 3, relPath,
        { envVarsFound, foundIn },
        'plugin-root env vars wired across resolution surface'));
    } else {
      const missing = envVars.filter((v) => !envVarsFound.includes(v));
      checks.push(fail('parse-config-fallback-chain', 3, relPath,
        { envVarsFound, foundIn },
        `plugin-root env var refs missing from resolution surface: ${missing.join(', ')}`));
    }
  }

  // c5.2 hooks-use-plugin-root-var
  {
    const p = join(root, 'hooks/hooks.json');
    const text = safeRead(p);
    const relPath = 'hooks/hooks.json';
    const json = safeJson(text);
    if (!json) {
      checks.push(fail('hooks-use-plugin-root-var', 3, relPath,
        { absolutePathCount: 0 },
        'hooks/hooks.json missing or invalid'));
    } else {
      const jsonText = JSON.stringify(json);
      // Find all "command" values
      const commandMatches = jsonText.match(/"command"\s*:\s*"[^"]+"/g) || [];
      let absolutePathCount = 0;
      for (const m of commandMatches) {
        const cmd = m.replace(/^"command"\s*:\s*"/, '').replace(/"$/, '');
        // Check if it uses an absolute path to a .mjs file without env var prefix
        // A command is "bad" if it contains /hooks/ without $VAR prefix
        if (/(?<!\$\w+)\/hooks\//.test(cmd) || /^node\s+\//.test(cmd)) {
          absolutePathCount++;
        }
      }
      if (absolutePathCount === 0) {
        checks.push(pass('hooks-use-plugin-root-var', 3, 3, relPath,
          { absolutePathCount: 0 },
          'All hook commands use env var prefix (no absolute paths)'));
      } else {
        checks.push(fail('hooks-use-plugin-root-var', 3, relPath,
          { absolutePathCount },
          `${absolutePathCount} hook command(s) use absolute paths instead of env var`));
      }
    }
  }

  // c5.3 config-reading-doc
  {
    const p = join(root, 'skills/_shared/config-reading.md');
    const relPath = 'skills/_shared/config-reading.md';
    const text = safeRead(p);
    if (!text) {
      checks.push(fail('config-reading-doc', 2, relPath,
        { present: false },
        'skills/_shared/config-reading.md missing'));
    } else {
      const hasPluginRoot = text.includes('PLUGIN_ROOT');
      if (hasPluginRoot) {
        checks.push(pass('config-reading-doc', 2, 2, relPath,
          { present: true },
          'config-reading.md present and contains PLUGIN_ROOT'));
      } else {
        checks.push(fail('config-reading-doc', 2, relPath,
          { present: true },
          'config-reading.md exists but does not contain PLUGIN_ROOT'));
      }
    }
  }

  // c5.4 bootstrap-gate-doc
  {
    const p = join(root, 'skills/_shared/bootstrap-gate.md');
    const relPath = 'skills/_shared/bootstrap-gate.md';
    const text = safeRead(p);
    if (!text) {
      checks.push(fail('bootstrap-gate-doc', 1, relPath,
        { present: false },
        'skills/_shared/bootstrap-gate.md missing'));
    } else {
      // CLAUDE.md is the canonical Claude-Code-side name; AGENTS.md is the
      // Codex CLI alias (skills/_shared/instruction-file-resolution.md).
      // bootstrap-gate.md must reference the canonical name; presence of the
      // alias is checked separately by the alias-coverage sweep test.
      const required = ['CLAUDE.md', 'Session Config', 'bootstrap.lock'];
      const found = required.filter((s) => text.includes(s));
      if (found.length === 3) {
        checks.push(pass('bootstrap-gate-doc', 1, 1, relPath,
          { present: true },
          'bootstrap-gate.md present with all required strings'));
      } else {
        const missing = required.filter((s) => !text.includes(s));
        checks.push(fail('bootstrap-gate-doc', 1, relPath,
          { present: true },
          `bootstrap-gate.md missing strings: ${missing.join(', ')}`));
      }
    }
  }

  return checks;
}

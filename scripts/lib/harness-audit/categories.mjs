#!/usr/bin/env node
/**
 * categories.mjs — 27 check implementations for harness-audit.mjs
 *
 * Each runCategory function returns an array of check result objects conforming
 * to the harness-audit output schema. File paths are relative to auditRoot.
 *
 * Stdlib only: node:fs, node:path, node:child_process.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse YAML-subset frontmatter from a string.
 * Returns null if no --- delimiters found.
 */
function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      if (start === -1) { start = i; }
      else { end = i; break; }
    }
  }
  if (start === -1 || end === -1) return null;
  const fm = {};
  for (let i = start + 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    fm[key] = val;
  }
  return fm;
}

/**
 * Read file contents safely. Returns null if missing or unreadable.
 */
function safeRead(p) {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

/**
 * Parse JSON safely. Returns null on failure.
 */
function safeJson(text) {
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Count lines in a string (including partial final line).
 */
function lineCount(text) {
  if (!text) return 0;
  const lines = text.split('\n');
  // Don't count trailing empty string from trailing newline
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/**
 * Parse a JSONL file into an array of parsed objects.
 * Returns { lines, validLines } where validLines are successfully parsed.
 */
function parseJsonl(text) {
  if (!text) return { lines: 0, validLines: [] };
  const rawLines = text.split('\n').filter((l) => l.trim().length > 0);
  const validLines = [];
  for (const l of rawLines) {
    try { validLines.push(JSON.parse(l)); } catch { /* skip */ }
  }
  return { lines: rawLines.length, validLines };
}

/**
 * Make a passing check result.
 */
function pass(checkId, points, maxPoints, path, evidence, message) {
  return { check_id: checkId, status: 'pass', points, max_points: maxPoints, path, evidence, message };
}

/**
 * Make a failing check result.
 */
function fail(checkId, maxPoints, path, evidence, message) {
  return { check_id: checkId, status: 'fail', points: 0, max_points: maxPoints, path, evidence, message };
}

// ---------------------------------------------------------------------------
// Category 1: Session Discipline (weight: 10)
// ---------------------------------------------------------------------------

export function runCategory1(root) {
  const checks = [];

  // c1.1 state-md-present
  {
    const candidates = [
      join(root, '.claude/STATE.md'),
      join(root, '.codex/STATE.md'),
      join(root, '.cursor/STATE.md'),
    ];
    const found = candidates.find((p) => existsSync(p));
    if (!found) {
      checks.push(fail('state-md-present', 3, '.claude/STATE.md',
        { path: null, hasYaml: false, schemaVersion: null, sessionType: null },
        'STATE.md not found in .claude/, .codex/, or .cursor/'));
    } else {
      const text = safeRead(found);
      const size = text ? text.length : 0;
      const fm = text ? parseFrontmatter(text) : null;
      const hasYaml = fm !== null;
      const sv = fm ? fm['schema-version'] : null;
      const st = fm ? fm['status'] : null;
      const stype = fm ? fm['session-type'] : null;
      const hasSchemaV1 = sv === '1';
      const relPath = relative(root, found).split(sep).join('/');
      if (size > 0 && hasYaml && hasSchemaV1 && st && stype) {
        checks.push(pass('state-md-present', 3, 3, relPath,
          { path: relPath, hasYaml: true, schemaVersion: sv, sessionType: stype },
          `STATE.md present, schema-version=${sv}, session-type=${stype}`));
      } else {
        checks.push(fail('state-md-present', 3, relPath,
          { path: relPath, hasYaml, schemaVersion: sv, sessionType: stype },
          `STATE.md found but missing required frontmatter fields (size=${size}, yaml=${hasYaml}, schema-version=${sv})`));
      }
    }
  }

  // c1.2 sessions-jsonl-growth
  {
    const p = join(root, '.orchestrator/metrics/sessions.jsonl');
    const text = safeRead(p);
    const relPath = '.orchestrator/metrics/sessions.jsonl';
    if (!text) {
      checks.push(fail('sessions-jsonl-growth', 3, relPath,
        { lineCount: 0, validLines: 0 }, 'sessions.jsonl missing'));
    } else {
      const { lines, validLines } = parseJsonl(text);
      const requiredKeys = ['session_id', 'session_type', 'started_at'];
      const wellFormed = validLines.filter((l) => requiredKeys.every((k) => k in l));
      if (lines >= 2 && wellFormed.length === lines) {
        checks.push(pass('sessions-jsonl-growth', 3, 3, relPath,
          { lineCount: lines, validLines: wellFormed.length },
          `sessions.jsonl has ${lines} valid lines`));
      } else {
        checks.push(fail('sessions-jsonl-growth', 3, relPath,
          { lineCount: lines, validLines: wellFormed.length },
          `sessions.jsonl: lines=${lines} (need ≥2), wellFormed=${wellFormed.length}/${lines}`));
      }
    }
  }

  // c1.3 learnings-jsonl-nonempty
  {
    const p = join(root, '.orchestrator/metrics/learnings.jsonl');
    const text = safeRead(p);
    const relPath = '.orchestrator/metrics/learnings.jsonl';
    if (!text) {
      checks.push(fail('learnings-jsonl-nonempty', 2, relPath,
        { lineCount: 0, validLines: 0 }, 'learnings.jsonl missing'));
    } else {
      const { lines, validLines } = parseJsonl(text);
      const requiredKeys = ['type', 'subject', 'confidence'];
      const wellFormed = validLines.filter((l) => requiredKeys.every((k) => k in l));
      if (lines >= 1 && wellFormed.length === lines) {
        checks.push(pass('learnings-jsonl-nonempty', 2, 2, relPath,
          { lineCount: lines, validLines: wellFormed.length },
          `learnings.jsonl has ${lines} valid lines`));
      } else {
        checks.push(fail('learnings-jsonl-nonempty', 2, relPath,
          { lineCount: lines, validLines: wellFormed.length },
          `learnings.jsonl: lines=${lines} (need ≥1), wellFormed=${wellFormed.length}/${lines}`));
      }
    }
  }

  // c1.4 orchestrator-layout
  {
    const requiredPaths = [
      '.orchestrator',
      '.orchestrator/bootstrap.lock',
      '.orchestrator/policy',
      '.orchestrator/metrics',
    ];
    const presentPaths = requiredPaths.filter((rp) => existsSync(join(root, rp)));
    if (presentPaths.length === requiredPaths.length) {
      checks.push(pass('orchestrator-layout', 2, 2, '.orchestrator/',
        { presentPaths },
        'All required .orchestrator/ paths present'));
    } else {
      const missing = requiredPaths.filter((rp) => !existsSync(join(root, rp)));
      checks.push(fail('orchestrator-layout', 2, '.orchestrator/',
        { presentPaths, missingPaths: missing },
        `Missing: ${missing.join(', ')}`));
    }
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Category 2: Quality Gate Coverage (weight: 10)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Category 3: Hook Integrity (weight: 10)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Category 4: Persistence Health (weight: 10)
// ---------------------------------------------------------------------------

export function runCategory4(root) {
  const checks = [];

  // c4.1 state-md-schema
  {
    const candidates = [
      join(root, '.claude/STATE.md'),
      join(root, '.codex/STATE.md'),
      join(root, '.cursor/STATE.md'),
    ];
    const found = candidates.find((p) => existsSync(p));
    const relPath = '.claude/STATE.md';
    if (!found) {
      checks.push(fail('state-md-schema', 3, relPath,
        { missingKeys: ['all'] },
        'STATE.md not found'));
    } else {
      const text = safeRead(found);
      const fm = text ? parseFrontmatter(text) : null;
      const requiredKeys = ['schema-version', 'session-type', 'branch', 'status', 'current-wave', 'total-waves'];
      const missingKeys = fm ? requiredKeys.filter((k) => !(k in fm)) : requiredKeys;
      if (missingKeys.length === 0) {
        checks.push(pass('state-md-schema', 3, 3, relative(root, found).split(sep).join('/'),
          { missingKeys: [] },
          'STATE.md has all required frontmatter keys'));
      } else {
        checks.push(fail('state-md-schema', 3, relative(root, found).split(sep).join('/'),
          { missingKeys },
          `STATE.md missing keys: ${missingKeys.join(', ')}`));
      }
    }
  }

  // c4.2 sessions-jsonl-recent
  {
    const p = join(root, '.orchestrator/metrics/sessions.jsonl');
    const text = safeRead(p);
    const relPath = '.orchestrator/metrics/sessions.jsonl';
    if (!text) {
      checks.push(fail('sessions-jsonl-recent', 3, relPath,
        { latestCompletedAt: null, ageInDays: null },
        'sessions.jsonl missing'));
    } else {
      const lines = text.split('\n').filter((l) => l.trim().length > 0);
      if (lines.length === 0) {
        checks.push(fail('sessions-jsonl-recent', 3, relPath,
          { latestCompletedAt: null, ageInDays: null },
          'sessions.jsonl is empty'));
      } else {
        const lastLine = lines[lines.length - 1];
        let lastObj = null;
        try { lastObj = JSON.parse(lastLine); } catch { /* ignore */ }
        const completedAt = lastObj ? lastObj.completed_at : null;
        if (!completedAt) {
          checks.push(fail('sessions-jsonl-recent', 3, relPath,
            { latestCompletedAt: null, ageInDays: null },
            'Last sessions.jsonl entry has no completed_at'));
        } else {
          const ageMs = Date.now() - new Date(completedAt).getTime();
          const ageInDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
          if (ageInDays <= 30) {
            checks.push(pass('sessions-jsonl-recent', 3, 3, relPath,
              { latestCompletedAt: completedAt, ageInDays },
              `Last session completed ${ageInDays} day(s) ago`));
          } else {
            checks.push(fail('sessions-jsonl-recent', 3, relPath,
              { latestCompletedAt: completedAt, ageInDays },
              `Last session ${ageInDays} days ago (> 30 day threshold)`));
          }
        }
      }
    }
  }

  // c4.3 learnings-prunable
  {
    const p = join(root, '.orchestrator/metrics/learnings.jsonl');
    const text = safeRead(p);
    const relPath = '.orchestrator/metrics/learnings.jsonl';
    if (!text) {
      checks.push(fail('learnings-prunable', 2, relPath,
        { totalLines: 0, allHaveExpires: false, confidenceInRange: false },
        'learnings.jsonl missing'));
    } else {
      const { lines, validLines } = parseJsonl(text);
      const allHaveExpires = validLines.length > 0 && validLines.every((l) => typeof l.expires_at === 'string');
      const confidenceInRange = validLines.length > 0 && validLines.every((l) => typeof l.confidence === 'number' && l.confidence >= 0 && l.confidence <= 1);
      if (allHaveExpires && confidenceInRange) {
        checks.push(pass('learnings-prunable', 2, 2, relPath,
          { totalLines: lines, allHaveExpires, confidenceInRange },
          `All ${lines} learnings have expires_at and confidence in [0,1]`));
      } else {
        checks.push(fail('learnings-prunable', 2, relPath,
          { totalLines: lines, allHaveExpires, confidenceInRange },
          `learnings not fully prunable: allHaveExpires=${allHaveExpires}, confidenceInRange=${confidenceInRange}`));
      }
    }
  }

  // c4.4 vault-sync-validator
  {
    const relPath = 'skills/vault-sync/validator.mjs';
    // Parse CLAUDE.md Session Config for vault-integration.enabled
    const claudeMd = safeRead(join(root, 'CLAUDE.md')) || safeRead(join(root, 'AGENTS.md')) || '';
    // Extract ## Session Config block
    const scMatch = /^## Session Config\s*\n([\s\S]*?)(?=^## |\s*$)/m.exec(claudeMd);
    const scBlock = scMatch ? scMatch[1] : '';
    const vaultEnabledMatch = /vault-integration\.enabled:\s*true/i.exec(scBlock) ||
      /vault-integration:\s*\n\s+enabled:\s*true/im.exec(scBlock);
    const vaultEnabled = Boolean(vaultEnabledMatch);

    if (!vaultEnabled) {
      checks.push(pass('vault-sync-validator', 2, 2, relPath,
        { vaultEnabled: false, validatorPresent: null },
        'vault-integration not enabled — skip'));
    } else {
      const validatorPresent = existsSync(join(root, relPath));
      if (validatorPresent) {
        checks.push(pass('vault-sync-validator', 2, 2, relPath,
          { vaultEnabled: true, validatorPresent: true },
          'vault-integration enabled and validator.mjs present'));
      } else {
        checks.push(fail('vault-sync-validator', 2, relPath,
          { vaultEnabled: true, validatorPresent: false },
          'vault-integration enabled but skills/vault-sync/validator.mjs missing'));
      }
    }
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Category 5: Plugin-Root Resolution (weight: 9)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Category 6: Config Hygiene (weight: 8)
// ---------------------------------------------------------------------------

export function runCategory6(root) {
  const checks = [];

  // c6.1 claude-md-line-count
  {
    const p = join(root, 'CLAUDE.md');
    const relPath = 'CLAUDE.md';
    const text = safeRead(p);
    if (!text) {
      checks.push(fail('claude-md-line-count', 3, relPath,
        { lineCount: 0 },
        'CLAUDE.md missing'));
    } else {
      const count = lineCount(text);
      if (count <= 250) {
        checks.push(pass('claude-md-line-count', 3, 3, relPath,
          { lineCount: count },
          `CLAUDE.md is ${count} lines (≤ 250)`));
      } else {
        checks.push(fail('claude-md-line-count', 3, relPath,
          { lineCount: count },
          `CLAUDE.md is ${count} lines (> 250 limit)`));
      }
    }
  }

  // c6.2 no-dead-branch-refs
  {
    const p = join(root, 'CLAUDE.md');
    const relPath = 'CLAUDE.md';
    const text = safeRead(p);
    if (!text) {
      checks.push(fail('no-dead-branch-refs', 3, relPath,
        { deadRefsFound: [] },
        'CLAUDE.md missing'));
    } else {
      const deadPatterns = ['windows-native-v3', 'legacy-bash-v2', 'feat/v3-'];
      const textLower = text.toLowerCase();
      const deadRefsFound = deadPatterns.filter((pat) => textLower.includes(pat.toLowerCase()));
      if (deadRefsFound.length === 0) {
        checks.push(pass('no-dead-branch-refs', 3, 3, relPath,
          { deadRefsFound: [] },
          'CLAUDE.md contains no dead branch refs'));
      } else {
        checks.push(fail('no-dead-branch-refs', 3, relPath,
          { deadRefsFound },
          `CLAUDE.md contains dead branch refs: ${deadRefsFound.join(', ')}`));
      }
    }
  }

  // c6.3 v2-features-section — plugin-repo-specific heading check. Consumer
  // repos never have this section, so we skip-as-pass when the audit target is
  // NOT the session-orchestrator plugin repo. Plugin repo is detected by the
  // presence of skills/session-start/SKILL.md (unique to this plugin).
  {
    const relPath = 'CLAUDE.md';
    const isPluginRepo = existsSync(join(root, 'skills/session-start/SKILL.md'));
    const text = safeRead(join(root, 'CLAUDE.md'));
    if (!isPluginRepo) {
      checks.push(pass('v2-features-section', 2, 2, relPath,
        { isPluginRepo: false, skipped: true },
        'consumer repo — plugin-specific heading check skipped'));
    } else if (!text) {
      checks.push(fail('v2-features-section', 2, relPath,
        { isPluginRepo: true, present: false },
        'CLAUDE.md missing'));
    } else if (text.includes('## v2.0 Features')) {
      checks.push(pass('v2-features-section', 2, 2, relPath,
        { isPluginRepo: true, present: true },
        'CLAUDE.md contains ## v2.0 Features heading'));
    } else {
      checks.push(fail('v2-features-section', 2, relPath,
        { isPluginRepo: true, present: false },
        'CLAUDE.md missing ## v2.0 Features heading'));
    }
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Category 7: Policy Freshness (weight: 10)
// ---------------------------------------------------------------------------

export function runCategory7(root) {
  const checks = [];

  // c7.1 blocked-commands-schema
  {
    const p = join(root, '.orchestrator/policy/blocked-commands.json');
    const relPath = '.orchestrator/policy/blocked-commands.json';
    const text = safeRead(p);
    const json = safeJson(text);
    if (!json) {
      checks.push(fail('blocked-commands-schema', 3, relPath,
        { version: null, ruleCount: 0 },
        'blocked-commands.json missing or invalid JSON'));
    } else {
      const version = json.version !== undefined ? json.version : null;
      const rationale = typeof json.rationale === 'string';
      const rules = Array.isArray(json.rules);
      const ruleCount = rules ? json.rules.length : 0;
      if (version !== null && rationale && rules) {
        checks.push(pass('blocked-commands-schema', 3, 3, relPath,
          { version, ruleCount },
          `blocked-commands.json valid: version=${version}, ${ruleCount} rules`));
      } else {
        checks.push(fail('blocked-commands-schema', 3, relPath,
          { version, ruleCount },
          `blocked-commands.json missing fields: ${[version === null && 'version', !rationale && 'rationale', !rules && 'rules'].filter(Boolean).join(', ')}`));
      }
    }
  }

  // c7.2 blocked-commands-min-rules
  {
    const p = join(root, '.orchestrator/policy/blocked-commands.json');
    const relPath = '.orchestrator/policy/blocked-commands.json';
    const text = safeRead(p);
    const json = safeJson(text);
    if (!json || !Array.isArray(json.rules)) {
      checks.push(fail('blocked-commands-min-rules', 3, relPath,
        { ruleCount: 0, wellFormedCount: 0 },
        'blocked-commands.json missing or has no rules array'));
    } else {
      const rules = json.rules;
      const validSeverities = ['block', 'warn'];
      const wellFormedRules = rules.filter((r) =>
        typeof r.id === 'string' &&
        typeof r.pattern === 'string' &&
        typeof r.severity === 'string' &&
        validSeverities.includes(r.severity)
      );
      if (rules.length >= 10 && wellFormedRules.length === rules.length) {
        checks.push(pass('blocked-commands-min-rules', 3, 3, relPath,
          { ruleCount: rules.length, wellFormedCount: wellFormedRules.length },
          `${rules.length} rules, all well-formed`));
      } else {
        checks.push(fail('blocked-commands-min-rules', 3, relPath,
          { ruleCount: rules.length, wellFormedCount: wellFormedRules.length },
          `${rules.length} rules (need ≥10), ${wellFormedRules.length} well-formed`));
      }
    }
  }

  // c7.3 parallel-sessions-rules
  {
    const p = join(root, '.claude/rules/parallel-sessions.md');
    const relPath = '.claude/rules/parallel-sessions.md';
    const text = safeRead(p);
    if (!text || statSync(join(root, relPath), { throwIfNoEntry: false })?.size === 0) {
      checks.push(fail('parallel-sessions-rules', 2, relPath,
        { psaCodesFound: [] },
        'parallel-sessions.md missing or empty'));
    } else {
      const psaCodes = ['PSA-001', 'PSA-002', 'PSA-003', 'PSA-004'];
      const psaCodesFound = psaCodes.filter((c) => text.includes(c));
      if (psaCodesFound.length === 4) {
        checks.push(pass('parallel-sessions-rules', 2, 2, relPath,
          { psaCodesFound },
          'parallel-sessions.md contains all 4 PSA codes'));
      } else {
        const missing = psaCodes.filter((c) => !text.includes(c));
        checks.push(fail('parallel-sessions-rules', 2, relPath,
          { psaCodesFound },
          `parallel-sessions.md missing PSA codes: ${missing.join(', ')}`));
      }
    }
  }

  // c7.4 ecosystem-schema-optional
  {
    const p = join(root, '.orchestrator/policy/ecosystem.schema.json');
    const relPath = '.orchestrator/policy/ecosystem.schema.json';
    if (!existsSync(p)) {
      checks.push(pass('ecosystem-schema-optional', 2, 2, relPath,
        { present: false, valid: null },
        'ecosystem.schema.json absent (optional) — skip'));
    } else {
      const text = safeRead(p);
      const json = safeJson(text);
      if (json !== null) {
        checks.push(pass('ecosystem-schema-optional', 2, 2, relPath,
          { present: true, valid: true },
          'ecosystem.schema.json present and valid JSON'));
      } else {
        checks.push(fail('ecosystem-schema-optional', 2, relPath,
          { present: true, valid: false },
          'ecosystem.schema.json present but invalid JSON'));
      }
    }
  }

  return checks;
}

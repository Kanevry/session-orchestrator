#!/usr/bin/env node
/**
 * Check: no fenced code block in `skills/**.md` imports `node:child_process`
 * (GitLab #1870). BLOCKING.
 *
 * ## Why
 *
 * On Windows, Node starts a bare program name (`git`) from the working
 * directory before PATH, so a `git.exe` dropped into the user's repo runs
 * instead of Git. #1864 moved every shipped `.mjs` module onto
 * `scripts/lib/native-command.mjs` and an ESLint ban guards those files. The
 * ban cannot see Markdown: skill snippets the model runs through `node -e` /
 * `node --input-type=module` in the USER's repo are exactly that cwd. #1870
 * rewrote the six snippets that started a program; this check keeps a new one
 * from re-introducing the import. A snippet imports the drop-in from
 * `${PLUGIN_ROOT}/scripts/lib/native-command.mjs` instead.
 *
 * ## Scope
 *
 * Only fenced code blocks count (the shared tracker `./markdown-fences.mjs`,
 * blockquoted fences included). Prose that names the module — e.g. a "stdlib
 * only (`node:child_process`)" note — is not executed and stays legal.
 *
 * @module scripts/lib/validate/check-skill-child-process
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { enumerateRepoFiles } from './enumerate-repo-files.mjs';
import { forEachLine } from './markdown-fences.mjs';
import { isMainModule } from '../is-main-module.mjs';

/**
 * Static `from '…'`, dynamic `import('…')`, `require('…')` and `createRequire(…)('…')` of child_process,
 * with or without `node:`. `\\?` before each quote also catches the escaped form a `node -e "…"` block uses.
 */
const CHILD_PROCESS_IMPORT_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\)\s*\(\s*)\\?["'`](?:node:)?child_process\\?["'`]/;

/**
 * Report every `child_process` import inside a fenced block of one Markdown text.
 *
 * @param {string} text Markdown source
 * @returns {{ line: number, text: string }[]} 1-based lines
 */
export function findFencedChildProcessImports(text) {
  const hits = [];
  forEachLine(
    text,
    (line, { lineNumber, inFence }) => {
      if (inFence && CHILD_PROCESS_IMPORT_RE.test(line)) hits.push({ line: lineNumber, text: line.trim() });
    },
    { stripBlockquotes: true },
  );
  return hits;
}

/**
 * Scan `skills/**.md` under a plugin root.
 *
 * @param {{ pluginRoot: string }} opts
 * @returns {{ ok: boolean, findings: { file: string, line: number, text: string }[], summary: { filesScanned: number } }}
 */
export function scanSkillChildProcess({ pluginRoot }) {
  const files = enumerateRepoFiles({ repoRoot: pluginRoot, dirs: ['skills'], exts: ['.md'] });
  const findings = [];
  for (const abs of files) {
    const rel = path.relative(pluginRoot, abs).split(path.sep).join('/');
    for (const hit of findFencedChildProcessImports(readFileSync(abs, 'utf8'))) findings.push({ file: rel, ...hit });
  }
  return { ok: findings.length === 0, findings, summary: { filesScanned: files.length } };
}

/**
 * Run the human-readable validator CLI.
 *
 * @param {string} pluginRoot absolute plugin root
 * @returns {number} 0 = clean, 1 = findings
 */
export function runCheckSkillChildProcess(pluginRoot) {
  console.log('--- Check: skill snippets start programs via native-command.mjs, not node:child_process ---');
  const inspection = scanSkillChildProcess({ pluginRoot });
  for (const f of inspection.findings) {
    console.log(
      `  FAIL: ${f.file}:${f.line} fenced snippet imports child_process — import the drop-in from ` +
        "'${PLUGIN_ROOT}/scripts/lib/native-command.mjs' (#1870)",
    );
  }
  if (inspection.ok) console.log(`  PASS: 0 fenced child_process imports in ${inspection.summary.filesScanned} skill file(s)`);
  console.log('');
  console.log(`Results: ${inspection.ok ? 1 : 0} passed, ${inspection.findings.length} failed`);
  return inspection.ok ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2).filter((arg) => arg !== '--json');
  const root = path.resolve(args[0] || process.cwd());
  if (process.argv.includes('--json')) {
    const inspection = scanSkillChildProcess({ pluginRoot: root });
    process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
    process.exitCode = inspection.ok ? 0 : 1;
  } else {
    process.exitCode = runCheckSkillChildProcess(root);
  }
}

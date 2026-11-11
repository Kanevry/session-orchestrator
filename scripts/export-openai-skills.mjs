#!/usr/bin/env node
/**
 * export-openai-skills.mjs — build or check the OpenAI skills-only package (#1931).
 *
 * Data on stdout, diagnostics on stderr. Exit 0 ok, 1 violations or bad
 * arguments, 2 system error. Rationale and skill selection:
 * docs/distribution/openai-skills-only.md.
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { isMainModule } from './lib/is-main-module.mjs';
import {
  DEFAULT_OUT_DIR,
  DEFAULT_REPO_ROOT,
  ExportRefusedError,
  PLUGIN_NAME,
  assertReplaceableZip,
  assertSafeOutDir,
  buildPackage,
  selectSkills,
  validatePackage,
} from './lib/openai-skills/package.mjs';
import { writeZip } from './lib/openai-skills/zip.mjs';

const HELP = `Usage: node scripts/export-openai-skills.mjs [--out <dir>] [--zip] [--check [<path>]] [--json]

Builds the skills-only package for the OpenAI plugin directory (ChatGPT, Codex):
one plugin root "${PLUGIN_NAME}/" with an Agent Plugins 1.0.0 plugin.json and the
allowlisted skills (scripts/lib/openai-skills/allowlist.json). No hooks, no MCP
configuration, no scripts.

Options:
  --out <dir>      Output directory, relative to the working directory
                   (default: <repo>/${DEFAULT_OUT_DIR}, gitignored). Refused
                   when it equals or contains the repo or your home directory.
                   An existing <out>/${PLUGIN_NAME} or .zip is only replaced
                   when it is an earlier export.
  --zip            Also write <out>/${PLUGIN_NAME}.zip (deterministic, one root);
                   without --zip a stale zip of an earlier export is removed
  --check [path]   Validate a build directory or .zip instead of building
                   (default: <out>/${PLUGIN_NAME}); lists every violation
  --json           Machine-readable output on stdout
  -h, --help       Show this help

Exit codes: 0 ok, 1 violations or bad arguments, 2 system error.`;

/**
 * @param {string[]} argv
 * @returns {Promise<number>} exit code
 */
export async function main(argv) {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        out: { type: 'string' },
        zip: { type: 'boolean', default: false },
        check: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    process.stderr.write(`export-openai-skills: ${err.message}\n${HELP}\n`);
    return 1;
  }
  const { values, positionals } = args;
  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (positionals.length > (values.check ? 1 : 0)) {
    process.stderr.write(`export-openai-skills: unexpected argument(s): ${positionals.join(' ')}\n`);
    return 1;
  }
  if (values.check && values.zip) {
    process.stderr.write('export-openai-skills: --check and --zip are mutually exclusive\n');
    return 1;
  }

  // Like --check's path, an explicit --out is relative to the caller's cwd.
  const outDir = values.out === undefined ? resolve(DEFAULT_REPO_ROOT, DEFAULT_OUT_DIR) : resolve(values.out);

  try {
    if (values.check) {
      const target = positionals[0] ? resolve(positionals[0]) : join(outDir, PLUGIN_NAME);
      if (!existsSync(target)) {
        process.stderr.write(`export-openai-skills: nothing to check at ${target}\n`);
        return 1;
      }
      const violations = await validatePackage(target);
      if (values.json) {
        process.stdout.write(`${JSON.stringify({ ok: violations.length === 0, target, violations }, null, 2)}\n`);
      } else if (violations.length === 0) {
        process.stdout.write(`ok: ${target} — 0 violations\n`);
      } else {
        for (const v of violations) process.stdout.write(`${v.code}\t${v.path}\t${v.message}\n`);
        process.stderr.write(`export-openai-skills: ${violations.length} violation(s) in ${target}\n`);
      }
      return violations.length === 0 ? 0 : 1;
    }

    const skills = selectSkills();
    assertSafeOutDir(outDir);
    const zipTarget = join(outDir, `${PLUGIN_NAME}.zip`);
    // Checked before building, so a refusal leaves nothing half-written.
    const zipExists = assertReplaceableZip(zipTarget);
    mkdirSync(outDir, { recursive: true });
    const { root, files } = buildPackage({ outDir, skills });
    let zipPath = null;
    if (values.zip) {
      zipPath = zipTarget;
      writeFileSync(zipPath, writeZip(files.map((f) => ({ path: `${PLUGIN_NAME}/${f.path}`, data: f.data }))));
    } else if (zipExists) {
      // A zip from an earlier build would no longer match the directory.
      unlinkSync(zipTarget);
    }
    // A build is only reported as ok after it passed its own check.
    const violations = await validatePackage(zipPath ?? root, { skills });
    const result = { ok: violations.length === 0, root, zip: zipPath, skills, files: files.map((f) => f.path), violations };
    if (values.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`built ${root} (${files.length} files, skills: ${skills.join(', ')})\n`);
      if (zipPath) process.stdout.write(`zip ${zipPath}\n`);
      for (const v of violations) process.stdout.write(`${v.code}\t${v.path}\t${v.message}\n`);
    }
    return violations.length === 0 ? 0 : 1;
  } catch (err) {
    if (err instanceof ExportRefusedError) {
      process.stderr.write(`export-openai-skills: ${err.message}\n`);
      return 1;
    }
    process.stderr.write(`export-openai-skills: ${err.stack ?? err}\n`);
    return 2;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}

#!/usr/bin/env node
/**
 * site-deploy.mjs — deploy the website (site/ + vercel.json) from a private source
 * commit with the Vercel CLI, without the public mirror (#2219).
 * Library: scripts/lib/site-deploy.mjs. File set: site-deploy.json at the repo root.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { createGitRunner } from './lib/github-export.mjs';
import { writeJsonAtomicSync } from './lib/io.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { commandOnPath, spawnSync } from './lib/native-command.mjs';
import {
  CONFIG_FILE,
  MODES,
  SiteDeployConfigError,
  STAGE_RECEIPT_DIR,
  SiteDeployExportError,
  buildStageReceipt,
  checkStageReceipt,
  deploymentUrlFrom,
  isVercelDeploymentUrl,
  loadSiteDeployConfig,
  materializeDeployDir,
  planDeploy,
  stageReceiptName,
  vercelArgs,
  writeVercelLink,
} from './lib/site-deploy.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIST_PREVIEW = 10;
const STDERR_TAIL = 20;

export const HELP = `Usage: node scripts/site-deploy.mjs [options]

Builds the website from one source commit of this private checkout and deploys it with
the Vercel CLI. The file set is ${CONFIG_FILE} (include/exclude, same entry rules as the
public-export policy: a trailing / is a directory prefix, anything else an exact path).
The export directory holds exactly the selected tracked files plus .vercel/project.json;
the working tree, the index and env files are never read into it.

Options:
  --source <rev>   source commit (default HEAD); not with promote
  --mode <mode>    ${MODES.join(' | ')} (default plan)
                   plan     print the source sha, file count, size and the first paths
                   preview  vercel deploy (preview URL, domains untouched)
                   stage    vercel deploy --prod --skip-domain (production build,
                            domains untouched; never promotes by itself)
                   promote  vercel promote <url> (run from a linked temp dir): the ONLY
                            mode that moves the domains, and only to a URL a stage
                            run of this checkout recorded in ${STAGE_RECEIPT_DIR}/
  --url <url>      deployment URL (https://<deployment>.vercel.app), required for promote
  --keep           keep the export directory and print its path (on failure too)
  --json           print one JSON object instead of the human summary
  -h, --help       show this help

Production reaches the domains only through --mode promote.
A stage receipt never expires: an older stage build stays promotable (the way back), and
the receipt is a record that this checkout staged the URL, not a security boundary.
Rollback: vercel rollback <previous url> --scope <scope>, run from a directory linked to
the project (e.g. the --keep export directory); in an unlinked checkout the CLI prompts
to link.

Exit codes:
  0  done
  1  usage error, or promote of a URL without a matching stage receipt
  2  system error: ${CONFIG_FILE} missing or invalid, vercel not on PATH, the source does
     not resolve, git/tar failed, the export differs from the plan, or a stage receipt
     could not be written
  3  vercel exited non-zero (its stderr tail is printed)
`;

function fail(code, message) {
  process.stderr.write(`site-deploy: ${message}\n`);
  return code;
}

function readConfig() {
  const file = join(REPO_ROOT, CONFIG_FILE);
  if (!existsSync(file)) return { error: `${CONFIG_FILE} missing at the repo root` };
  try {
    return { config: loadSiteDeployConfig(readFileSync(file, 'utf8')) };
  } catch (err) {
    if (err instanceof SiteDeployConfigError) return { error: `${CONFIG_FILE}: ${err.message}` };
    throw err;
  }
}

const tail = (text) => text.trim().split('\n').slice(-STDERR_TAIL).join('\n');

/**
 * The stage receipt for `url`: `{ receipt }` (null when no file exists) or `{ error }` when
 * the file exists but cannot be read or parsed. Promote refuses in both cases; only the
 * message differs, so a damaged receipt is not mistaken for a never-staged deployment.
 */
function readReceipt(url) {
  const name = stageReceiptName(url);
  try {
    return { receipt: JSON.parse(readFileSync(join(REPO_ROOT, STAGE_RECEIPT_DIR, name), 'utf8')) };
  } catch (err) {
    if (err?.code === 'ENOENT') return { receipt: null };
    return { error: `stage receipt unreadable: ${name}` };
  }
}

/** Atomic write of one stage receipt; returns the io envelope. */
function writeReceipt(receipt) {
  return writeJsonAtomicSync(join(REPO_ROOT, STAGE_RECEIPT_DIR, stageReceiptName(receipt.url)), receipt);
}

/**
 * Run vercel in `cwd`. stdout is captured for the URL; stderr is captured too (for the
 * exit-3 tail) and replayed after the run. Ceiling: no live upload progress; revisit if
 * an upload outgrows a silent wait.
 */
function runVercel(args, cwd) {
  const res = spawnSync('vercel', args, { cwd, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? res.error?.message ?? '');
  return { status: res.status, stdout, stderr };
}

function followUp(url, scope, mode) {
  return [
    `  check:   vercel curl ${url}/ --scope ${scope}   (run it in a linked dir, e.g. the --keep export dir)`,
    // Only a stage run writes the receipt promote requires.
    ...(mode === 'stage' ? [`  promote: node scripts/site-deploy.mjs --mode promote --url ${url}`] : []),
    `  rollback: vercel rollback <previous url> --scope ${scope}   (run it in a linked dir, e.g. the --keep export dir)`,
  ].join('\n');
}

export function main(argv = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        source: { type: 'string' },
        mode: { type: 'string', default: 'plan' },
        url: { type: 'string' },
        keep: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (err) {
    return fail(1, err.message);
  }
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const { mode } = values;
  if (!MODES.includes(mode)) return fail(1, `unknown mode '${mode}' (known: ${MODES.join(', ')})`);
  if (mode === 'promote' && !isVercelDeploymentUrl(values.url)) return fail(1, '--mode promote needs --url https://<deployment>.vercel.app');
  if (mode !== 'promote' && values.url !== undefined) return fail(1, '--url is only for --mode promote');
  // promote moves the domains to an EXISTING deployment; a source here would be ignored.
  if (mode === 'promote' && values.source !== undefined) return fail(1, '--source is not used by --mode promote (the stage receipt names the source)');

  const { config, error } = readConfig();
  if (error) return fail(2, error);
  const { scope, name } = config.project;
  const emit = (obj, text) => process.stdout.write(values.json ? `${JSON.stringify({ mode, project: { name, scope }, ...obj })}\n` : text);

  let staged = null;
  if (mode === 'promote') {
    const read = readReceipt(values.url);
    if (read.error) return fail(1, read.error);
    const check = checkStageReceipt(read.receipt, { url: values.url, config });
    if (!check.ok) return fail(1, check.reason);
    staged = check.receipt;
  }

  if (mode !== 'plan' && !commandOnPath('vercel')) return fail(2, 'vercel is not on PATH');

  if (mode === 'promote') {
    // A linked temp dir, never the checkout: promote's --yes would otherwise link the
    // cwd (writing .vercel/ into the repo, possibly to a project named after it).
    const linkDir = mkdtempSync(join(tmpdir(), 'so-site-promote-'));
    try {
      writeVercelLink(linkDir, config);
      const res = runVercel(vercelArgs('promote', { scope, url: values.url }), linkDir);
      if (res.status !== 0) return fail(3, `vercel promote exited ${res.status}:\n${tail(res.stderr)}`);
      process.stderr.write(res.stderr);
      emit({ url: values.url, sourceSha: staged.sourceSha }, `promoted ${values.url} (${scope}/${name}), source ${staged.sourceSha.slice(0, 12)}\n`);
      return 0;
    } finally {
      rmSync(linkDir, { recursive: true, force: true });
    }
  }

  const git = createGitRunner(REPO_ROOT);
  const plan = planDeploy({ git, source: values.source ?? 'HEAD', config });
  if (!plan.ok) return fail(2, plan.reason);
  const mib = (plan.bytes / 1048576).toFixed(1);

  const needsDir = mode !== 'plan' || values.keep;
  let dir = null;
  let succeeded = false;
  try {
    if (needsDir) {
      dir = mkdtempSync(join(tmpdir(), 'so-site-deploy-'));
      materializeDeployDir({ git, sourceSha: plan.sourceSha, files: plan.files, config, dir });
    }
    const summary = { sourceSha: plan.sourceSha, files: plan.files.length, bytes: plan.bytes, ...(values.keep ? { dir } : {}) };

    if (mode === 'plan') {
      const lines = [`site deploy plan: source ${plan.sourceSha.slice(0, 12)}, ${plan.files.length} files, ${mib} MiB`];
      for (const f of plan.files.slice(0, LIST_PREVIEW)) lines.push(`  ${f}`);
      if (plan.files.length > LIST_PREVIEW) lines.push(`  … ${plan.files.length - LIST_PREVIEW} more`);
      if (values.keep) lines.push(`export dir: ${dir}`);
      emit(summary, `${lines.join('\n')}\n`);
      succeeded = true;
      return 0;
    }

    const res = runVercel(vercelArgs(mode, { scope }), dir);
    if (res.status !== 0) return fail(3, `vercel deploy exited ${res.status}:\n${tail(res.stderr)}`);
    process.stderr.write(res.stderr);
    const url = deploymentUrlFrom(res.stdout);
    if (!url) return fail(3, 'vercel deploy exited 0 but printed no https://….vercel.app URL');
    if (mode === 'stage') {
      const written = writeReceipt(buildStageReceipt({ url, sourceSha: plan.sourceSha, files: plan.files.length, bytes: plan.bytes, config, at: new Date().toISOString() }));
      // The deployment exists either way; without the receipt promote refuses it later.
      if (!written.ok) return fail(2, `staged ${url} but could not write its receipt (${written.code ?? written.error}); promote will refuse it`);
    }
    const lines = [
      `${mode} deployment of ${plan.sourceSha.slice(0, 12)} (${plan.files.length} files, ${mib} MiB): ${url}`,
      mode === 'stage' ? '  domains untouched; production moves only with promote' : '  preview; domains untouched',
      followUp(url, scope, mode),
    ];
    if (values.keep) lines.push(`export dir: ${dir}`);
    emit({ ...summary, url }, `${lines.join('\n')}\n`);
    succeeded = true;
    return 0;
  } catch (err) {
    if (err instanceof SiteDeployExportError) return fail(2, err.message);
    throw err;
  } finally {
    if (dir && !values.keep) rmSync(dir, { recursive: true, force: true });
    else if (dir && !succeeded) process.stderr.write(`site-deploy: export dir kept: ${dir}\n`);
  }
}

if (isMainModule(import.meta.url)) process.exitCode = main();

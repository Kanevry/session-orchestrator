#!/usr/bin/env node
/**
 * github-export.mjs — build the curated public GitHub snapshot (`mirror: curated`, #1631).
 *
 * Usage:
 *   node scripts/github-export.mjs [--source <rev>] [--dry-run]
 *   node scripts/github-export.mjs --verify <export sha> --source <source sha>
 *   node scripts/github-export.mjs --plain-guard --mirror-key <github|unset>
 *
 * The parent is ALWAYS the public GitHub main: `refs/remotes/github/main`, required to
 * equal `git ls-remote github refs/heads/main` (one read-only network call). There is
 * deliberately no parent override, and refs/heads/github-export is only the output slot.
 *
 * Writes ONE snapshot commit to refs/heads/github-export (see scripts/lib/github-export.mjs);
 * session-end then pushes it to github main (skills/session-end/SKILL.md § 4.4).
 *
 * Exit codes:
 *   0  snapshot created (stdout: new sha) — or, with --dry-run, stats printed
 *   3  nothing to publish: the curated tree equals github main's (stdout: that sha;
 *      refs/heads/github-export is not touched)
 *   1  refused, one-line reason on stderr (replace refs or grafts present, github main
 *      not verifiable or tracking ref stale, source not descended from the published
 *      snapshot's source, non-exported path survived (excluded, or outside the policy's
 *      `include` allow-list), leakage scan failed, a public file still cites a path the
 *      export removed, push URL differs from fetch URL, compare-and-swap
 *      lost) — or a usage error
 *
 * --verify re-checks an already built snapshot BY SHA right before session-end pushes
 * that sha: graph integrity, push URL == fetch URL, github main verified via ls-remote,
 * exactly one commit on it with `Source-Commit: <source>`, no non-exported path in its tree.
 * Exit 0 ok, 1 refused. stdout stays empty in every mode except the sha lines above.
 *
 * --plain-guard answers whether a PLAIN push of source history (`git push github HEAD`)
 * is allowed: refused (exit 1, reason on stderr) when HEAD or origin's main carries
 * .orchestrator/policy/public-export.json, i.e. the repo has adopted the curated export
 * even if this checkout's Session Config predates `mirror: curated` (#1645), and — without
 * an `origin` remote to consult — unless `--mirror-key github` (explicit `mirror: github`).
 * Exit 0 allowed.
 */


import { buildGithubExport, createGitRunner, plainPushGuard, verifyExportCommit } from './lib/github-export.mjs';
import { spawnSync } from './lib/native-command.mjs';

function usage(msg) {
  if (msg) console.error(`github-export: ${msg}`);
  console.error('Usage: node scripts/github-export.mjs [--source <rev>] [--dry-run] | --verify <sha> --source <sha> | --plain-guard --mirror-key <github|unset>');
  process.exit(1);
}

const opts = { source: 'HEAD', dryRun: false };
let verifySha = null;
let plainGuard = false;
let mirrorKey = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--plain-guard') plainGuard = true;
  else if (a === '--mirror-key') {
    mirrorKey = args[++i];
    if (mirrorKey !== 'github' && mirrorKey !== 'unset') usage('--mirror-key must be github or unset');
  }
  else if (a === '--source' || a === '--verify') {
    const v = args[++i];
    if (!v || v.startsWith('--')) usage(`${a} requires a value`);
    if (a === '--source') opts.source = v;
    else verifySha = v;
  } else if (a === '--help' || a === '-h') usage();
  else usage(`unknown argument '${a}'`);
}

const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
if (top.status !== 0) {
  console.error('github-export: refused — not inside a git work tree');
  process.exit(1);
}

const git = createGitRunner(top.stdout.trim());

if (plainGuard) {
  if (args.length !== 3 || mirrorKey === null) usage('--plain-guard takes exactly --mirror-key <github|unset>');
  const verdict = plainPushGuard({ git, explicitGithub: mirrorKey === 'github' });
  if (!verdict.ok) {
    console.error(`github-export: plain push refused — ${verdict.reason}`);
    process.exit(1);
  }
  process.exit(0);
}

if (verifySha !== null) {
  if (opts.dryRun) usage('--verify does not combine with --dry-run');
  const verdict = verifyExportCommit({ git, sha: verifySha, source: opts.source });
  if (!verdict.ok) {
    console.error(`github-export: verify refused — ${verdict.reason}`);
    process.exit(1);
  }
  process.exit(0);
}

const result = buildGithubExport({ git, ...opts });

if (result.stats) {
  const s = result.stats;
  console.error(
    `github-export: source files ${s.sourceFiles}, excluded ${s.excludedFiles}, snapshot files ${s.snapshotFiles}, changed vs parent ${s.changedVsParent}`,
  );
}
for (const line of result.findings ?? []) console.error(line);
for (const line of result.warnings ?? []) console.error(`github-export: WARN — ${line} (a real export would refuse)`);

switch (result.status) {
  case 'created':
    console.log(result.sha);
    process.exit(0);
    break;
  case 'unchanged':
    console.log(result.sha);
    console.error('github-export: nothing to publish — snapshot tree equals github main, no new commit');
    process.exit(3);
    break;
  case 'dry-run':
    console.error(`github-export: dry-run — ${result.stats?.unchanged ? 'tree unchanged' : 'snapshot built and scanned'}, refs/heads/github-export not updated`);
    process.exit(0);
    break;
  default:
    console.error(`github-export: refused — ${result.reason}`);
    process.exit(1);
}

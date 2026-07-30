#!/usr/bin/env node
/**
 * fleet-instruction-scan.mjs — always-on instruction load across every repo on the host.
 *
 * `scripts/measure-context-overhead.sh` measures one directory precisely but
 * costs an API call per measurement. This scans the whole fleet for free by
 * counting bytes and classifying them the way `scripts/lib/rule-loader.mjs`
 * does: a rule file is always-on unless its frontmatter carries `globs:` or
 * `paths:` (issue #795), and it reaches wave agents unless it is tagged
 * `tier: coordinator-only` (issue #692).
 *
 * Token estimates use the ratio measured 2026-07-30 on claude-opus-5[1m]:
 * 108589 always-on bytes in this repo produced roughly 67396 context tokens,
 * i.e. about 1 token per 1.6 bytes. Treat the estimate as an order of
 * magnitude and confirm a specific repo with measure-context-overhead.sh.
 *
 * Usage:
 *   node scripts/fleet-instruction-scan.mjs
 *   node scripts/fleet-instruction-scan.mjs ~/Projects/intern ~/Projects/extern
 *   node scripts/fleet-instruction-scan.mjs --json
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const BYTES_PER_TOKEN = 1.6;

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const roots = argv.filter((a) => !a.startsWith('--'));
const ROOTS = roots.length
  ? roots
  : [
      join(homedir(), 'Projects', 'extern'),
      join(homedir(), 'Projects', 'intern'),
      join(homedir(), 'Projects', 'Ventures'),
      join(homedir(), 'Projects', 'Bernhard'),
    ];

/** Classify one rule file the way rule-loader.mjs does. */
function classify(path) {
  const body = readFileSync(path, 'utf8');
  const fmMatch = body.match(/^---\n([\s\S]*?)\n---/);
  const fm = fmMatch ? fmMatch[1] : '';
  const tierMatch = fm.match(/^tier:\s*(\S+)/m);
  return {
    scoped: /^(globs|paths):/m.test(fm),
    tier: tierMatch ? tierMatch[1] : 'always',
    bytes: Buffer.byteLength(body),
  };
}

function scanRepo(dir) {
  let alwaysBytes = 0;
  let waveBytes = 0;
  let files = 0;
  let scopedFiles = 0;
  const rulesDir = join(dir, '.claude', 'rules');
  if (existsSync(rulesDir)) {
    for (const f of readdirSync(rulesDir).filter((n) => n.endsWith('.md'))) {
      const c = classify(join(rulesDir, f));
      files++;
      if (c.scoped) {
        scopedFiles++;
        continue;
      }
      alwaysBytes += c.bytes;
      if (c.tier !== 'coordinator-only') waveBytes += c.bytes;
    }
  }
  const instructionFile = ['CLAUDE.md', 'AGENTS.md'].map((f) => join(dir, f)).find(existsSync);
  const cmBytes = instructionFile ? statSync(instructionFile).size : 0;
  return { files, scopedFiles, alwaysBytes, waveBytes, cmBytes, total: alwaysBytes + cmBytes };
}

const rows = [];
for (const root of ROOTS) {
  if (!existsSync(root)) continue;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!existsSync(join(dir, '.git'))) continue;
    rows.push({ repo: `${basename(root)}/${name}`, ...scanRepo(dir) });
  }
}
rows.sort((a, b) => b.total - a.total);

if (asJson) {
  console.log(JSON.stringify({ bytesPerToken: BYTES_PER_TOKEN, repos: rows }, null, 2));
  process.exit(0);
}

const pad = (s, n) => String(s).padStart(n);
console.log(
  'REPO'.padEnd(36),
  pad('RULES', 6),
  pad('SCOPED', 7),
  pad('ALWAYS_B', 9),
  pad('WAVE_B', 8),
  pad('INSTR_B', 8),
  pad('EST_TOK', 8),
);
for (const r of rows) {
  console.log(
    r.repo.padEnd(36),
    pad(r.files, 6),
    pad(r.scopedFiles, 7),
    pad(r.alwaysBytes, 9),
    pad(r.waveBytes, 8),
    pad(r.cmBytes, 8),
    pad(Math.round(r.total / BYTES_PER_TOKEN), 8),
  );
}

const totalFiles = rows.reduce((a, r) => a + r.files, 0);
const totalScoped = rows.reduce((a, r) => a + r.scopedFiles, 0);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const withRules = rows.filter((r) => r.files > 0);

console.log(`\nrepos scanned            : ${rows.length} (${withRules.length} with rule files)`);
console.log(`rule files               : ${totalFiles}  (${totalScoped} glob/path-scoped, ${totalFiles - totalScoped} always-on)`);
console.log(`median always-on bytes   : ${median(withRules.map((r) => r.alwaysBytes))}`);
console.log(`median est. tokens/session: ${Math.round(median(withRules.map((r) => r.total)) / BYTES_PER_TOKEN)}`);

// A value shared by many repos means a vendored rule set: trimming it at the
// source propagates everywhere, which is the cheapest lever in the fleet.
const byBytes = new Map();
for (const r of withRules) byBytes.set(r.alwaysBytes, (byBytes.get(r.alwaysBytes) || 0) + 1);
const shared = [...byBytes.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
if (shared.length) {
  console.log('\nidentical always-on totals (vendored rule sets — trim once, propagate widely):');
  for (const [bytes, n] of shared.slice(0, 5)) console.log(`  ${bytes} B  in ${n} repos`);
}

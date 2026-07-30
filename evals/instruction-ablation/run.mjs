#!/usr/bin/env node
/**
 * run.mjs — instruction-ablation eval runner.
 *
 * For each (case × instruction-variant × run) it builds a throwaway workdir
 * that carries ONLY the variant's instruction surface, plants the case
 * fixture, sends the case prompt through `claude -p`, and applies the case's
 * mechanical oracles to whatever the model left behind.
 *
 * It never writes to, and never deletes from, the source repository.
 * Everything lands under $TMPDIR/so-ablation-eval-<pid>/.
 *
 * See README.md for design, cost, and the three limits worth knowing.
 */

import { execFileSync, execSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const CASES_DIR = join(HERE, 'cases');
const RESULTS_DIR = join(HERE, 'results');

/** Instruction variants. `drop` lists rule basenames removed from the variant. */
const VARIANTS = [
  { id: 'v0-full', drop: [], dropClaudeMd: false },
  { id: 'v1-no-top3', drop: ['loop-and-monitor.md', 'parallel-sessions.md', 'security.md'], dropClaudeMd: false },
  { id: 'v2-no-rules', drop: ['*'], dropClaudeMd: false },
];

// ── args ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const RUNS = Number(val('--runs', '1'));
const ONLY_CASES = val('--cases', '').split(',').filter(Boolean);
const ONLY_VARIANTS = val('--variants', '').split(',').filter(Boolean);
const DRY = has('--dry-run');
const LIST = has('--list');

// ── load cases ──────────────────────────────────────────────────────
function loadCases() {
  if (!existsSync(CASES_DIR)) return [];
  return readdirSync(CASES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(CASES_DIR, f), 'utf8')))
    .filter((c) => ONLY_CASES.length === 0 || ONLY_CASES.includes(c.id));
}

const cases = loadCases();
const variants = VARIANTS.filter((v) => ONLY_VARIANTS.length === 0 || ONLY_VARIANTS.includes(v.id));

if (LIST) {
  console.log(`cases (${cases.length}):`);
  for (const c of cases) {
    console.log(`  ${c.id}`);
    console.log(`      guards : ${(c.guards || []).join(', ')} (${c.rule_bytes ?? '?'} B, tier=${c.tier ?? '?'})`);
    console.log(`      claim  : ${c.claim}`);
    console.log(`      oracles: ${(c.oracles || []).length}`);
  }
  console.log(`\nvariants (${variants.length}): ${variants.map((v) => v.id).join(', ')}`);
  const cells = cases.length * variants.length * RUNS;
  // Per-cell cost measured in the 2026-07-30 pilot: USD 0.68-2.72, mean 1.73.
  console.log(`\ncells at --runs ${RUNS}: ${cells}  (~USD ${(cells * 0.68).toFixed(2)}-${(cells * 2.72).toFixed(2)}, mean ~${(cells * 1.73).toFixed(2)})`);
  process.exit(0);
}

if (cases.length === 0) {
  console.error('no cases found');
  process.exit(1);
}

// ── workspace ───────────────────────────────────────────────────────
const ROOT = join(process.env.TMPDIR || '/tmp', `so-ablation-eval-${process.pid}`);
mkdirSync(ROOT, { recursive: true });

/** Build a workdir carrying the variant's instruction surface. */
function buildWorkdir(variant, caseId, run) {
  const wd = join(ROOT, `${variant.id}__${caseId}__r${run}`);
  mkdirSync(join(wd, '.claude', 'rules'), { recursive: true });
  if (!variant.dropClaudeMd && existsSync(join(REPO, 'CLAUDE.md'))) {
    cpSync(join(REPO, 'CLAUDE.md'), join(wd, 'CLAUDE.md'));
  }
  const srcRules = join(REPO, '.claude', 'rules');
  if (existsSync(srcRules) && !variant.drop.includes('*')) {
    for (const f of readdirSync(srcRules).filter((f) => f.endsWith('.md'))) {
      if (variant.drop.includes(f)) continue;
      cpSync(join(srcRules, f), join(wd, '.claude', 'rules', f));
    }
  }
  return wd;
}

/** Plant the case fixture inside a workdir. */
function plantFixture(wd, kase) {
  for (const step of kase.fixture || []) {
    if (step.type === 'file') {
      const p = join(wd, step.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, step.content);
    } else if (step.type === 'shell') {
      execSync(step.run, { cwd: wd, stdio: 'ignore' });
    }
  }
}

/** Apply one mechanical oracle. Returns {name, pass, detail}. */
function applyOracle(wd, o) {
  const p = join(wd, o.path);
  const name = `${o.type}:${o.path}${o.pattern ? `~/${o.pattern}/` : ''}`;
  if (o.type === 'file-exists') {
    const got = existsSync(p);
    return { name, pass: got === o.expect, detail: `exists=${got} expect=${o.expect}`, note: o.note };
  }
  if (o.type === 'file-matches') {
    if (!existsSync(p)) return { name, pass: false, detail: 'file missing', note: o.note };
    const body = readFileSync(p, 'utf8');
    const got = new RegExp(o.pattern).test(body);
    return { name, pass: got === o.expect, detail: `match=${got} expect=${o.expect}`, note: o.note };
  }
  return { name, pass: false, detail: `unknown oracle type ${o.type}`, note: o.note };
}

/** One cell: build, plant, run, judge. */
function runCell(variant, kase, run) {
  const wd = buildWorkdir(variant, kase.id, run);
  plantFixture(wd, kase);
  if (DRY) return { variant: variant.id, case: kase.id, run, dry: true, workdir: wd };

  let usage = {};
  let cost = 0;
  let text = '';
  let error = null;
  try {
    const out = execFileSync('claude', ['-p', kase.prompt, '--output-format', 'json'], {
      cwd: wd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    });
    const j = JSON.parse(out);
    usage = j.usage || {};
    cost = j.total_cost_usd || 0;
    text = typeof j.result === 'string' ? j.result : '';
  } catch (e) {
    error = String(e.message || e).slice(0, 300);
  }

  const oracles = (kase.oracles || []).map((o) => applyOracle(wd, o));
  const pass = error === null && oracles.length > 0 && oracles.every((o) => o.pass);
  const ctx =
    (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);

  return {
    ts: new Date().toISOString(),
    variant: variant.id,
    case: kase.id,
    run,
    pass,
    error,
    context_tokens: ctx,
    output_tokens: usage.output_tokens || 0,
    cost_usd: Number(cost.toFixed(4)),
    oracles,
    reply_excerpt: text.slice(0, 300),
    workdir: wd,
  };
}

// ── execute ─────────────────────────────────────────────────────────
mkdirSync(RESULTS_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = join(RESULTS_DIR, `${stamp}.jsonl`);
const records = [];

const total = cases.length * variants.length * RUNS;
let n = 0;
console.error(`running ${total} cell(s)${DRY ? ' (dry-run, no API calls)' : ''} -> ${outFile}`);

for (const kase of cases) {
  for (const variant of variants) {
    for (let run = 1; run <= RUNS; run++) {
      n++;
      process.stderr.write(`  [${n}/${total}] ${variant.id} × ${kase.id} r${run} ... `);
      const rec = runCell(variant, kase, run);
      records.push(rec);
      if (!DRY) appendFileSync(outFile, JSON.stringify(rec) + '\n');
      process.stderr.write(rec.dry ? 'built\n' : `${rec.pass ? 'PASS' : 'FAIL'} (${rec.cost_usd ?? 0} USD)\n`);
    }
  }
}

// ── summary ─────────────────────────────────────────────────────────
if (DRY) {
  console.log(`\nfixtures built under ${ROOT}`);
  process.exit(0);
}

console.log('\n=== pass rate by case × variant ===');
const head = ['case', ...variants.map((v) => v.id)];
console.log(head.join('\t'));
for (const kase of cases) {
  const row = [kase.id];
  for (const v of variants) {
    const cell = records.filter((r) => r.case === kase.id && r.variant === v.id);
    const passed = cell.filter((r) => r.pass).length;
    row.push(`${passed}/${cell.length}`);
  }
  console.log(row.join('\t'));
}

const spend = records.reduce((a, r) => a + (r.cost_usd || 0), 0);
const ctxAvg = (id) => {
  const c = records.filter((r) => r.variant === id && r.context_tokens);
  return c.length ? Math.round(c.reduce((a, r) => a + r.context_tokens, 0) / c.length) : 0;
};
console.log('\n=== mean context tokens by variant ===');
for (const v of variants) console.log(`${v.id}\t${ctxAvg(v.id)}`);
console.log(`\ntotal spend: USD ${spend.toFixed(2)}`);
console.log(`results:     ${outFile}`);
console.log(`workdirs:    ${ROOT}  (throwaway; inspect failures there, remove when done)`);

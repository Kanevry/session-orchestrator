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
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHostPaths, resolveHostPath } from '../../scripts/lib/config/host-paths.mjs';
import { resolveNamedBaseline } from '../../scripts/lib/named-baseline-resolver.mjs';

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
// --rules-source repo|baseline (default repo). `baseline` sources the rule
// corpus from the host-local projects-baseline instead of this repo — the
// fleet-wide ablation axis (T3, #936): a cut here is a single-repo fix, a cut
// in the baseline propagates to every repo rolled out from it.
const RULES_SOURCE = val('--rules-source', 'repo');
if (RULES_SOURCE !== 'repo' && RULES_SOURCE !== 'baseline') {
  console.error(`--rules-source must be 'repo' or 'baseline' (got '${RULES_SOURCE}')`);
  process.exit(1);
}

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

// ── rule-corpus source resolution ───────────────────────────────────
/** Expand a leading `~` to the user's home directory. */
function expandTilde(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** Measure a rules dir: file count + byte total of its `*.md` files. */
function measureRulesDir(dir) {
  let fileCount = 0;
  let bytes = 0;
  if (dir && existsSync(dir)) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      fileCount++;
      bytes += readFileSync(join(dir, f)).length;
    }
  }
  return { fileCount, bytes };
}

/**
 * Resolve the projects-baseline rule corpus host-locally — NEVER a hardcoded
 * path (the baseline location is machine-specific). Precedence mirrors
 * `plan-baseline-path` in scripts/lib/config.mjs:
 *   1. SO_BASELINE_PATH env
 *   2. owner.yaml `baselines:` match against cwd
 *   3. owner.yaml `paths.baseline-path`
 * Returns a plain descriptor and never throws; `available` is false when no
 * baseline is configured or its rules dir is absent.
 */
function resolveBaselineCorpus() {
  const { ownerConfig, env } = loadHostPaths();
  let baselineDir = null;
  let source = null;
  const named = resolveNamedBaseline({ cwd: process.cwd(), ownerConfig, env });
  if (named.source === 'match' && typeof named.path === 'string' && named.path.trim() !== '') {
    baselineDir = expandTilde(named.path);
    source = `owner.yaml baselines: "${named.name}"`;
  } else {
    const hostPath = resolveHostPath('baseline-path', undefined, { env, ownerConfig });
    if (typeof hostPath === 'string' && hostPath.trim() !== '') {
      baselineDir = expandTilde(hostPath);
      source =
        typeof env.SO_BASELINE_PATH === 'string' && env.SO_BASELINE_PATH.trim() !== ''
          ? 'SO_BASELINE_PATH env'
          : 'owner.yaml paths.baseline-path';
    }
  }
  if (!baselineDir) {
    return { baselineDir: null, rulesDir: null, source: null, available: false, fileCount: 0, bytes: 0 };
  }
  // Prefer the auto-loaded .claude/rules; fall back to the vendoring library rules/.
  const rulesDir =
    [join(baselineDir, '.claude', 'rules'), join(baselineDir, 'rules')].find((d) => existsSync(d)) || null;
  const { fileCount, bytes } = measureRulesDir(rulesDir);
  return { baselineDir, rulesDir, source, available: Boolean(rulesDir), fileCount, bytes };
}

const baselineInfo = RULES_SOURCE === 'baseline' ? resolveBaselineCorpus() : null;
const repoRulesDir = join(REPO, '.claude', 'rules');
// The directory the variants copy `*.md` from. CLAUDE.md is always sourced from
// this repo so the rule corpus is the ONLY variable across the repo/baseline axes.
const RULES_SRC_DIR = RULES_SOURCE === 'baseline' ? baselineInfo?.rulesDir : repoRulesDir;

if (LIST) {
  console.log(`cases (${cases.length}):`);
  for (const c of cases) {
    console.log(`  ${c.id}`);
    console.log(`      guards : ${(c.guards || []).join(', ')} (${c.rule_bytes ?? '?'} B, tier=${c.tier ?? '?'})`);
    console.log(`      claim  : ${c.claim}`);
    console.log(`      oracles: ${(c.oracles || []).length}`);
  }
  console.log(`\nvariants (${variants.length}): ${variants.map((v) => v.id).join(', ')}`);

  // Rule-corpus source (repo vs host-local projects-baseline — the T3/#936 axis).
  const repoCorpus = measureRulesDir(repoRulesDir);
  console.log(`\nrules-source: ${RULES_SOURCE}`);
  if (RULES_SOURCE === 'baseline') {
    if (baselineInfo?.available) {
      console.log(`  resolved via: ${baselineInfo.source}`);
      console.log(`  baseline    : ${baselineInfo.baselineDir}`);
      console.log(`  corpus      : ${baselineInfo.rulesDir}`);
      console.log(`  size        : ${baselineInfo.fileCount} rule files, ${baselineInfo.bytes} B  (repo corpus: ${repoCorpus.fileCount} files, ${repoCorpus.bytes} B)`);
      console.log(`  note        : a cut here propagates to every repo rolled out from this baseline; v0-full cells run a LARGER context than the repo axis, so v0 cells cost more.`);
    } else {
      console.log(`  UNAVAILABLE — no projects-baseline resolved. Set SO_BASELINE_PATH, or owner.yaml paths.baseline-path / baselines:.`);
      console.log(`  (--list is free and does not run; a real --runs against baseline would error until this resolves.)`);
    }
  } else {
    console.log(`  corpus      : ${repoRulesDir}`);
    console.log(`  size        : ${repoCorpus.fileCount} rule files, ${repoCorpus.bytes} B`);
    console.log(`  tip         : add --rules-source baseline to ablate the fleet-wide projects-baseline corpus (T3, #936).`);
  }

  const cells = cases.length * variants.length * RUNS;
  // Per-cell cost measured in the 2026-07-30 pilot: USD 0.68-2.72, mean 1.73.
  console.log(`\ncells at --runs ${RUNS}: ${cells}  (~USD ${(cells * 0.68).toFixed(2)}-${(cells * 2.72).toFixed(2)}, mean ~${(cells * 1.73).toFixed(2)})`);
  process.exit(0);
}

if (cases.length === 0) {
  console.error('no cases found');
  process.exit(1);
}

// Baseline axis (#936 T3): a real build needs a resolved corpus. --list already
// returned above; --dry-run still builds fixtures, so guard it here too.
if (RULES_SOURCE === 'baseline' && !baselineInfo?.available) {
  console.error(
    'rules-source=baseline but no projects-baseline corpus resolved.\n' +
      '  Set SO_BASELINE_PATH, or owner.yaml paths.baseline-path / baselines:.\n' +
      '  Run with --list to see the resolution (free, no API calls).',
  );
  process.exit(2);
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
  const srcRules = RULES_SRC_DIR;
  if (srcRules && existsSync(srcRules) && !variant.drop.includes('*')) {
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

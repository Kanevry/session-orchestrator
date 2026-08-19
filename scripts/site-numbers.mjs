#!/usr/bin/env node
/**
 * site-numbers.mjs — the census that fills the website's "Measured" block.
 *
 * ## Why this file exists
 *
 * `site/index.html` carries a proof block of counted repository facts, and that
 * block is the load-bearing evidence for the whole page's honesty argument. It
 * was counted BY HAND on 2026-08-03 and then drifted: measured on 2026-08-19 at
 * `3981267`, six of eight tiles disagreed with the repository they describe
 * (tests 556→580, sessions 210→252, learnings 95→135, and so on). A product whose
 * thesis is mechanical rigour was shipping stale measurements — the worst content
 * to get wrong, because a reader can check it in one command.
 *
 * The fix is not "recount more carefully". It is to stop hand-maintaining a
 * derived number: the page declares WHICH fact each slot holds, and this script
 * derives the value from the repository.
 *
 * ## The markup contract
 *
 *     <span class="num" data-metric="skills">46</span>
 *
 * Any element order / extra attributes are fine; only `data-metric` and the
 * element's text content are read. The metric ids are frozen in `METRIC_IDS` —
 * an unknown id is an ERROR, never a silent skip, because a typo'd
 * `data-metric="skils"` would otherwise leave a hand-maintained number on the
 * page forever, which is the exact failure this script exists to end.
 *
 * ## Where each number comes from
 *
 * Every count below mirrors an EXISTING census in this repo rather than
 * inventing a new one — `skills/claude-md-drift-check/checker.mjs` is the SSOT
 * for the four surface counts, and the per-metric `source` string (shipped in
 * `--json`) names the shell command that defines it. See METRIC_DEFS.
 *
 * ## The census snapshot (`site/_census.json`)
 *
 * Three of the thirteen metrics read a source that a FRESH CLONE does not have:
 * `.orchestrator/metrics/{sessions,learnings}.jsonl` are gitignored
 * (`.gitignore` — local-only observability data) and `counted-sha` needs a
 * `.git` directory that a tarball / `docker COPY` build does not carry. Those
 * three therefore carry `snapshotFallback: true` and fall back to a TRACKED
 * snapshot written by `--write`.
 *
 * Precedence is always LIVE FIRST, snapshot only when live returns `null` —
 * uniformly, including `counted-sha`. A snapshot that outranked the live source
 * would freeze the page on the last release's numbers, which is the same
 * hand-maintained-derived-number failure this file exists to end.
 *
 * The fallback is per-metric opt-in and NEVER blanket: the other ten stay loud.
 * A blanket fallback would make `collect()` blind to "wrong root" — any
 * directory carrying a copied snapshot would answer all thirteen and exit 0,
 * which is exactly what the "refusing to publish a partial census" guard below
 * exists to prevent.
 *
 * The snapshot is PUBLICLY SERVED (`vercel.json` `outputDirectory: "site"`) —
 * deliberately, it is the machine-readable receipt for the numbers on the page.
 * Its schema is therefore frozen to exactly `METRIC_IDS` under `metrics`, plus a
 * `$schema` tag: no paths, no hostnames, no cwd, no raw ledger lines. It is
 * written ONLY when the site directory is the repo's own `site/` (see `main()`),
 * so a `--write --site <tmpdir>` fixture run can never touch the real one.
 *
 * ## Modes
 *
 *   --check  read-only; exit 1 on drift. The CI/build guard.
 *   --write  rewrite the span contents in place, and refresh `site/_census.json`
 *            from the same measurement (only when --site is the repo's `site/`).
 *
 * Exit codes (`.claude/rules/cli-design.md`):
 *   0 — no drift (--check) / files updated or already current (--write)
 *   1 — drift found (--check), or a contract violation in either mode
 *       (no `data-metric` spans anywhere, unknown metric id, malformed cell)
 *   2 — tool error (bad argv, missing repo/site directory, unreadable census input)
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { writeStdoutLineSync, writeJsonAtomicSync } from './lib/io.mjs';

/** Machine-readable schema tag for the --json envelope. */
export const SCHEMA = 'site-numbers/1';

/**
 * The tracked census snapshot, relative to the repo root.
 *
 * Under `site/` and NOT `.orchestrator/metrics/` on purpose: `checkStaleArtifacts`
 * in `scripts/lib/project-hygiene.mjs` counts EVERY file below `.orchestrator/`
 * with an mtime older than 30 days as a prune candidate, with no tracked /
 * untracked distinction (#979) — a tracked snapshot living there would be
 * offered for deletion between releases, which is precisely when it matters.
 */
export const CENSUS_FILE = ['site', '_census.json'];

/** Schema tag written into the snapshot; mirrors `site/leaderboard.json`'s shape. */
export const CENSUS_SCHEMA = 'site-numbers/1 census snapshot';

const USAGE =
  'Usage: site-numbers.mjs [<repo-root>] [--check|--write] [--json] [--site <dir>]';

// ---------------------------------------------------------------------------
// Census primitives — each one mirrors an existing command, none invents a new
// counting basis. Every function returns `null` when its input surface is
// missing, which the caller turns into a LOUD tool error (exit 2) rather than a
// zero: "0 skills" is a plausible-looking number that would silently ship.
// ---------------------------------------------------------------------------

/** Recursively visit every file below `dir`, passing the absolute path. */
function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, visit);
    else if (entry.isFile()) visit(abs);
  }
}

function isDir(p) {
  return existsSync(p) && statSync(p).isDirectory();
}

/**
 * One entry per `skills/<name>/SKILL.md` — see this metric's `source` string in
 * METRIC_DEFS for the exact shell equivalent.
 *
 * A directory is a skill when it CARRIES a `SKILL.md`, not when it exists.
 * `skills/_shared/` is a support directory with no SKILL.md and is therefore not
 * a skill — counting bare directories yields 47 where the answer is 46, and that
 * off-by-one is exactly what a hand count produces. Same basis as
 * `countSkills()` in skills/claude-md-drift-check/checker.mjs.
 */
export function countSkills(root) {
  const dir = join(root, 'skills');
  if (!isDir(dir)) return null;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const f = join(dir, entry.name, 'SKILL.md');
    if (existsSync(f) && statSync(f).isFile()) n++;
  }
  return n;
}

/** `ls commands/*.md | wc -l` — same basis as checker.mjs `command-count`. */
export function countCommands(root) {
  const dir = join(root, 'commands');
  if (!isDir(dir)) return null;
  return readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('.')).length;
}

/**
 * `ls .claude/rules/*.md | wc -l`
 *
 * The site's Measured footnote claims a rule-file count. It drifted (page said
 * 29, repo has 30) for the same reason every other tile did — it was typed once.
 */
export function countRuleFiles(root) {
  const dir = join(root, '.claude', 'rules');
  if (!isDir(dir)) return null;
  return readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('.')).length;
}

/**
 * `grep -l 'generated-by: reconciliation-engine' .claude/rules/*.md | wc -l`
 *
 * The subset of rule files the reconciliation engine wrote rather than a human.
 * The page names this split, so it is a claim and needs the same treatment.
 */
export function countGeneratedRuleFiles(root) {
  const dir = join(root, '.claude', 'rules');
  if (!isDir(dir)) return null;
  let n = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md') || f.startsWith('.')) continue;
    try {
      if (readFileSync(join(dir, f), 'utf8').includes('generated-by: reconciliation-engine')) n += 1;
    } catch {
      // Unreadable file: not counted. Returning null for the whole metric would
      // turn one bad file into a missing number; a short count is caught by the
      // reviewer, a null is caught by nobody.
    }
  }
  return n;
}

/**
 * Rule count in `.orchestrator/policy/blocked-commands.json`.
 *
 * Parsed, never pattern-matched: a regex over the file would keep matching after
 * the schema changed and report a stale number as current.
 */
export function countBlockedCommands(root) {
  const file = join(root, '.orchestrator', 'policy', 'blocked-commands.json');
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) return parsed.length;
    if (Array.isArray(parsed?.rules)) return parsed.rules.length;
    return null;
  } catch {
    return null;
  }
}

/**
 * `ls agents/*.md | grep -v AGENTS.md | wc -l`
 *
 * `agents/AGENTS.md` is the AUTHORING SPEC for agent definitions, not an agent.
 * Same exclusion as `countAgents()` in checker.mjs.
 */
export function countAgents(root) {
  const dir = join(root, 'agents');
  if (!isDir(dir)) return null;
  return readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'AGENTS.md' && !f.startsWith('.'))
    .length;
}

/**
 * `ls hooks/*.mjs | wc -l` — ON-DISK hook files, deliberately NOT the
 * plugin-wired count.
 *
 * THE DECISION, because the two numbers differ and the page must pick one:
 * on-disk is 25, `hooks/hooks.json` wires 24 distinct handler files. The 25th,
 * `hooks/wave-scope-commit-guard.mjs`, is not dead code and not an oversight —
 * it is wired through a DIFFERENT channel, the repository's Husky Git
 * pre-commit hook (`.husky/pre-commit`), because it guards git index/commit
 * state rather than a plugin lifecycle event (#821, documented in
 * `.orchestrator/steering/structure.md`).
 *
 * On-disk wins on three grounds:
 *   1. It is what the page's own label says — "hook files".
 *   2. It is the census a sceptical reader reproduces in ONE command. A page
 *      claiming 24 is falsified by `ls hooks/*.mjs | wc -l`, and being
 *      falsifiable-by-one-command is the specific damage this script prevents.
 *   3. No dead file is counted: all 25 are wired, 24 via hooks.json and 1 via
 *      Husky. Only the claim "25 PLUGIN hooks" would be false, and the page
 *      does not make it.
 *
 * The cost of the choice, named: the tile pairs this number with "10 event
 * types", and one of the 25 has no event type. If the page ever rephrases the
 * label to "plugin hooks", this metric must switch to the hooks.json wiring
 * count (distinct `.mjs` filenames referenced inside `hooks/hooks.json`).
 */
export function countHookFiles(root) {
  const dir = join(root, 'hooks');
  if (!isDir(dir)) return null;
  return readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.startsWith('.')).length;
}

/** `find tests -name '*.test.mjs' | wc -l` — same basis as checker.mjs `countTestFiles()`. */
export function countTestFiles(root) {
  const dir = join(root, 'tests');
  if (!isDir(dir)) return null;
  let n = 0;
  walk(dir, (f) => {
    if (f.endsWith('.test.mjs')) n++;
  });
  return n;
}

/**
 * `grep -c . <file>` — non-empty lines of a JSONL ledger.
 *
 * Non-empty rather than `wc -l` so the count does not depend on whether the
 * file ends with a newline. Lines that do not parse as JSON are still COUNTED
 * (they are records, however broken) but reported in `malformed` so a corrupt
 * ledger surfaces as a warning instead of silently shrinking the number.
 *
 * @returns {{entries:number, malformed:number}|null}
 */
export function countJsonlEntries(file) {
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  let malformed = 0;
  for (const l of lines) {
    try {
      JSON.parse(l);
    } catch {
      malformed++;
    }
  }
  return { entries: lines.length, malformed };
}

/** `node -p "require('./package.json').version"` */
export function readPackageVersion(root) {
  const f = join(root, 'package.json');
  if (!existsSync(f)) return null;
  try {
    const v = JSON.parse(readFileSync(f, 'utf8')).version;
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** `git rev-parse --short HEAD`, or null outside a git repo. */
export function headRef(root) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Whether the working tree has uncommitted tracked changes.
 *
 * Load-bearing for `counted-sha`: the counts read the WORKING TREE, so stamping
 * them with HEAD on a dirty tree publishes a SHA at which nobody can reproduce
 * the numbers (PSA-006 "measured WHEN"). `--no-optional-locks` is required, not
 * tidiness — a plain `git status` refreshes and therefore LOCKS `.git/index`,
 * racing a parallel session's index write (PSA-007).
 *
 * @returns {boolean|null} null when git cannot answer
 */
export function isDirty(root) {
  try {
    const out = execFileSync(
      'git',
      ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'],
      { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out.split('\n').filter(Boolean).length > 0;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The metric table — the part that must never be re-derived by hand
// ---------------------------------------------------------------------------

/**
 * `provenance: true` marks a stamp about the PAST rather than a fact about the
 * present. See `collect()` for why those two are warn-only under --check.
 *
 * `snapshotFallback: true` marks a metric whose live source is absent from a
 * fresh clone, and which may therefore fall back to `site/_census.json` when —
 * and only when — the live read returns `null`. It is OPT-IN: an omitted field
 * means "no fallback", i.e. this metric stays loud and a missing source is a
 * tool error. Exactly three carry it; see the header for why a blanket fallback
 * would be a defect rather than a convenience.
 */
export const METRIC_DEFS = Object.freeze([
  {
    id: 'version',
    provenance: false,
    // BARE, no leading "v". The "v" is presentation and belongs to the markup,
    // which writes `v<span data-metric="version">3.20.0</span>`. A prefix baked
    // into the data layer produced `vv3.20.0` on the first --write against the
    // real page — caught before it shipped, but only because --check was run.
    // `site/llms.txt` agrees: it carries `Version: 3.20.0`.
    source: 'node -p "require(\'./package.json\').version"',
    compute: (root) => readPackageVersion(root),
  },
  {
    id: 'skills',
    provenance: false,
    source: 'ls -d skills/*/SKILL.md | wc -l',
    compute: (root) => fmtCount(countSkills(root)),
  },
  {
    id: 'commands',
    provenance: false,
    source: 'ls commands/*.md | wc -l',
    compute: (root) => fmtCount(countCommands(root)),
  },
  {
    id: 'agents',
    provenance: false,
    source: "ls agents/*.md | grep -v '^agents/AGENTS.md$' | wc -l",
    compute: (root) => fmtCount(countAgents(root)),
  },
  {
    id: 'hooks',
    provenance: false,
    source: 'ls hooks/*.mjs | wc -l   (on-disk, NOT the 24 wired in hooks/hooks.json — see countHookFiles)',
    compute: (root) => fmtCount(countHookFiles(root)),
  },
  {
    id: 'tests',
    provenance: false,
    source: "find tests -name '*.test.mjs' | wc -l",
    compute: (root) => fmtCount(countTestFiles(root)),
  },
  {
    id: 'sessions',
    provenance: false,
    // Gitignored ledger (`.gitignore`: local-only observability data) — absent
    // in every fresh clone, CI checkout and tarball build.
    snapshotFallback: true,
    source: 'grep -c . .orchestrator/metrics/sessions.jsonl',
    compute: (root) => {
      const r = countJsonlEntries(join(root, '.orchestrator', 'metrics', 'sessions.jsonl'));
      return r === null ? null : fmtCount(r.entries);
    },
  },
  {
    id: 'learnings',
    provenance: false,
    // Same gitignored ledger family as `sessions`.
    snapshotFallback: true,
    source: 'grep -c . .orchestrator/metrics/learnings.jsonl',
    compute: (root) => {
      const r = countJsonlEntries(join(root, '.orchestrator', 'metrics', 'learnings.jsonl'));
      return r === null ? null : fmtCount(r.entries);
    },
  },
  {
    id: 'rules',
    provenance: false,
    source: 'ls .claude/rules/*.md | wc -l',
    compute: (root) => fmtCount(countRuleFiles(root)),
  },
  {
    id: 'rules-generated',
    provenance: false,
    source: "grep -l 'generated-by: reconciliation-engine' .claude/rules/*.md | wc -l",
    compute: (root) => fmtCount(countGeneratedRuleFiles(root)),
  },
  {
    id: 'blocked-commands',
    provenance: false,
    source: 'jq length .orchestrator/policy/blocked-commands.json',
    compute: (root) => fmtCount(countBlockedCommands(root)),
  },
  {
    id: 'counted-at',
    provenance: true,
    source: 'date -u +%Y-%m-%d',
    compute: () => new Date().toISOString().slice(0, 10),
  },
  {
    id: 'counted-sha',
    provenance: true,
    // A tarball / `docker COPY` build carries the tree but not `.git`, so the
    // live read is null there. The fallback restores the SHA the snapshot was
    // stamped at — which is the honest answer for such a build, because that is
    // when these numbers were last counted. No special precedence: a real `.git`
    // still wins, like every other metric.
    snapshotFallback: true,
    source: 'git rev-parse --short HEAD',
    compute: (root) => headRef(root),
  },
]);

/** The frozen allowlist of `data-metric` values. Anything else is an error. */
export const METRIC_IDS = Object.freeze(METRIC_DEFS.map((m) => m.id));

/**
 * Plain integers, no locale grouping. `toLocaleString()` would make the output
 * depend on the build machine's locale — a generator that emits "1.234" on one
 * host and "1,234" on another manufactures drift instead of removing it.
 */
function fmtCount(n) {
  return n === null || n === undefined ? null : String(n);
}

/**
 * What a value is allowed to contain before it is written into HTML — and, since
 * the snapshot exists, before it is accepted OUT of `site/_census.json`.
 *
 * Eleven of the thirteen metrics are digits (`fmtCount`) or hex (`git
 * rev-parse --short`) by construction, but `version` is whatever
 * `package.json` says and `readPackageVersion` only checks that it is a
 * non-empty string. The `/[<>]/` test in `rewrite()` guards the OLD cell
 * content, never the NEW value — so nothing stopped a crafted version literal
 * from closing the span and opening a tag. The precondition is write access to
 * `package.json`, which in this repo's trust model already means full access,
 * so this is defence in depth rather than a live hole; it is cheap, and it is
 * the one place where the page's `script-src 'unsafe-inline'` would stop being
 * theoretical.
 */
const SAFE_VALUE_RE = /^[\w.+-]+$/;

/** Absolute path of the census snapshot for `root`. */
export function censusPath(root) {
  return join(root, ...CENSUS_FILE);
}

/**
 * Read the tracked snapshot's `metrics` map, or `null` when it is absent,
 * unparseable, or not shaped like a census.
 *
 * Deliberately forgiving about EXTRA keys and lenient about missing ones: the
 * lookup is per-metric, so a snapshot written by an older version that knows
 * eleven ids still serves those eleven, and the twelfth simply stays `missing`
 * (a loud tool error) instead of poisoning the whole read.
 *
 * Values are filtered through `SAFE_VALUE_RE` — the same allowlist `rewrite()`
 * applies before injecting a value into HTML. Rejecting here rather than at
 * write time turns a corrupt snapshot into "this metric has no value" (exit 2,
 * naming the metric) instead of "refusing to write this file" (exit 1, naming
 * the version literal), which is the accurate diagnosis.
 */
export function readCensusSnapshot(root) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(censusPath(root), 'utf8'));
  } catch {
    return null;
  }
  const metrics = parsed?.metrics;
  if (metrics === null || typeof metrics !== 'object' || Array.isArray(metrics)) return null;
  const out = {};
  for (const id of METRIC_IDS) {
    const v = metrics[id];
    if (typeof v === 'string' && v.length > 0 && SAFE_VALUE_RE.test(v)) out[id] = v;
  }
  return out;
}

/**
 * Write the snapshot for `root` from an already-computed `values` map.
 *
 * Takes `values` rather than re-running `collect()` on purpose: a second census
 * inside the same run can disagree with the first one — `counted-at` flips at
 * midnight, and any ledger appended to between the two reads shifts. The page
 * and its receipt must be produced from ONE measurement.
 *
 * Only the frozen `METRIC_IDS` are emitted, in table order. The file is served
 * publicly, so anything not on that list (paths, cwd, hostnames, raw records) is
 * dropped by construction rather than by review.
 *
 * Every VALUE is checked against `SAFE_VALUE_RE` here, at the write, rather than
 * inherited from `rewrite()`. That inheritance was the defect: `rewrite()` only
 * ever sees a metric that HAS a `data-metric` span, and three of the thirteen
 * (`rules`, `rules-generated`, `blocked-commands` — measured 2026-08-19: 10 ids
 * carry a span, 13 exist) have none. Their values reached this public file
 * unvetted, while the header above promises "no paths, no hostnames, no cwd" for
 * the WHOLE file. All three are counters today, so this is defence in depth and
 * not a live hole — but the promise is made per file, so the check belongs per
 * file, not per span.
 *
 * A violation refuses the ENTIRE write rather than dropping the offending key: a
 * census missing one id is a snapshot that silently stops answering that metric
 * in a fresh clone, which is the quiet-failure shape this file exists to end.
 *
 * @returns {{ ok: true } | { ok: false, reason: string, error?: string }}
 */
export function writeCensusSnapshot(root, values) {
  const metrics = {};
  const unsafe = [];
  for (const id of METRIC_IDS) {
    if (!Object.hasOwn(values, id)) continue;
    const v = String(values[id]);
    if (!SAFE_VALUE_RE.test(v)) {
      unsafe.push(id);
      continue;
    }
    metrics[id] = v;
  }
  if (unsafe.length > 0) {
    return {
      ok: false,
      reason: 'unsafe-value',
      error:
        `value(s) rejected by the safe-value allowlist: ${unsafe.join(', ')} — ` +
        'refusing to publish them in a served file',
    };
  }
  return writeJsonAtomicSync(censusPath(root), { $schema: CENSUS_SCHEMA, metrics }, { tmpPrefix: '.tmp-census' });
}

/**
 * Compute every metric for `root`.
 *
 * @returns {{values: Record<string,string>, missing: string[], warnings: string[],
 *            fromSnapshot: string[]}}
 *   `missing` lists metrics whose census input is absent — the caller MUST treat
 *   a non-empty `missing` as a tool error rather than writing a partial page.
 *   `fromSnapshot` lists the metrics answered by `site/_census.json` because
 *   their live source was absent.
 */
export function collect(root) {
  const values = {};
  const missing = [];
  const warnings = [];
  const fromSnapshot = [];
  // Read at most once, and only if some metric actually needs it — the common
  // case (a working copy) never touches the file at all.
  let snapshot;

  for (const def of METRIC_DEFS) {
    // LIVE FIRST, always. The snapshot is a fallback, never a cache: reading it
    // first (or memoising a live value into it) would freeze the page on the
    // last release's numbers while the repository moved on.
    let v = def.compute(root);
    if ((v === null || v === undefined || v === '') && def.snapshotFallback === true) {
      if (snapshot === undefined) snapshot = readCensusSnapshot(root);
      const s = snapshot?.[def.id];
      if (s !== undefined) {
        v = s;
        fromSnapshot.push(def.id);
      }
    }
    if (v === null || v === undefined || v === '') missing.push(def.id);
    else values[def.id] = String(v);
  }

  if (fromSnapshot.length > 0) {
    warnings.push(
      `${fromSnapshot.join(', ')} read from ${CENSUS_FILE.join('/')} — the live source is absent under ${root} ` +
        '(expected in a fresh clone / tarball build; the snapshot is only as current as the last --write)',
    );
  }

  for (const [name, file] of [
    ['sessions', 'sessions.jsonl'],
    ['learnings', 'learnings.jsonl'],
  ]) {
    const r = countJsonlEntries(join(root, '.orchestrator', 'metrics', file));
    if (r && r.malformed > 0) {
      warnings.push(`${file}: ${r.malformed} non-empty line(s) are not valid JSON — the ${name} count includes them`);
    }
  }

  return { values, missing, warnings, fromSnapshot };
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

/**
 * Matches `<span … data-metric="…" …>content</span>`.
 *
 * Groups: 1 = attrs before, 2 = quote char, 3 = metric id, 4 = attrs after,
 * 5 = text content. Capturing the attribute halves verbatim is what lets
 * `rewrite()` replace ONLY the content and hand the surrounding markup back
 * byte-for-byte.
 *
 * Assumption, named: no `>` inside an attribute value on these spans, and no
 * nested element inside the cell. A cell containing `<` is reported as
 * `malformed` rather than silently rewritten.
 */
export const SPAN_RE =
  /<span\b([^>]*?)\bdata-metric\s*=\s*(["'])([^"']*)\2([^>]*)>([\s\S]*?)<\/span>/gi;

function lineOf(html, index) {
  let n = 1;
  for (let i = 0; i < index; i++) if (html.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * Read every metric span out of one HTML document and judge it against `values`.
 *
 * `unresolved` is the third contract violation, next to `!known` and `malformed`:
 * a KNOWN metric id for which `values` carries nothing. It used to be the
 * quietest defect in the file — `expected` fell to `null`, so `differs` was
 * false, `rewrite()` handed the cell back byte-identical without counting it,
 * and `--check` printed "N metric cell(s) current" over a number nobody had
 * measured. It was unreachable through `main()` only because the exit-2
 * partial-census guard fired first; now that three metrics may be answered from
 * a snapshot instead, that guard is no longer the only thing standing between a
 * gap in `values` and a green report. So it is named and counted here.
 *
 * @returns {Array<{metric:string, actual:string, expected:string|null, line:number,
 *                  known:boolean, malformed:boolean, unresolved:boolean,
 *                  drift:boolean, stale:boolean}>}
 */
export function inspectHtml(html, values) {
  const out = [];
  for (const m of html.matchAll(SPAN_RE)) {
    const metric = m[3];
    const actual = m[5];
    const def = METRIC_DEFS.find((d) => d.id === metric);
    const known = def !== undefined;
    const malformed = /[<>]/.test(actual);
    const resolved = known && Object.hasOwn(values, metric);
    const expected = resolved ? values[metric] : null;
    const differs = known && !malformed && expected !== null && actual.trim() !== expected;
    out.push({
      metric,
      actual,
      expected,
      line: lineOf(html, m.index),
      known,
      malformed,
      unresolved: known && !resolved,
      // A provenance stamp that lags is NOT drift — see below.
      drift: differs && !(def && def.provenance),
      stale: differs && Boolean(def && def.provenance),
    });
  }
  return out;
}

/**
 * WHY `counted-at` / `counted-sha` are warn-only under --check:
 *
 * They are claims about the PAST ("counted on X at Y"), and a claim about the
 * past does not become false when HEAD moves. Treating them as drift would make
 * `--check` exit 1 on every single commit — a signal that is red always is a
 * signal nobody reads, and this script exists precisely because an ignored
 * measurement rots. They cannot silently diverge from the numbers either, since
 * `--write` stamps all ten together in one pass.
 *
 * Revisit trigger: if the page ever ships values that were NOT produced by
 * `--write` (a hand edit of a count), the stamp becomes a real lie and this must
 * become a hard failure.
 */

/**
 * Rewrite every KNOWN, well-formed metric span to its computed value.
 * The value allowlist it enforces is `SAFE_VALUE_RE`, declared above the census
 * functions because `readCensusSnapshot()` filters through the same one.
 *
 * @returns {{html:string, replaced:number, spans:number, rejected:number}}
 */
export function rewrite(html, values) {
  let replaced = 0;
  let spans = 0;
  let rejected = 0;
  const next = html.replace(SPAN_RE, (whole, pre, q, metric, post, content) => {
    spans++;
    // No computed value for this id. TWO distinct cases reach here, and the
    // caller errors out on BOTH: an id outside METRIC_DEFS (`known: false`) and
    // a known id absent from `values` (`unresolved: true`). The second used to
    // be undocumented here, which read as if it could not happen.
    if (!Object.hasOwn(values, metric)) return whole;
    if (/[<>]/.test(content)) return whole; // malformed cell → caller errors out
    const value = values[metric];
    if (!SAFE_VALUE_RE.test(value)) {
      rejected++;
      return whole; // caller errors out — never write an unvetted value
    }
    if (content === value) return whole;
    replaced++;
    return `<span${pre}data-metric=${q}${metric}${q}${post}>${value}</span>`;
  });
  return { html: next, replaced, spans, rejected };
}

/** Every `*.html` below `dir`, repo-relative-sorted for deterministic output. */
export function listHtmlFiles(dir) {
  if (!isDir(dir)) return null;
  const files = [];
  walk(dir, (f) => {
    if (f.endsWith('.html')) files.push(f);
  });
  return files.sort();
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const KNOWN = new Set(['--check', '--write', '--json', '--site', '--help', '--version']);
  const positionals = [];
  let check = false;
  let write = false;
  let json = false;
  let help = false;
  let version = false;
  let site = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    if (!KNOWN.has(a)) return { error: `Unknown flag: ${a}` };
    if (a === '--check') check = true;
    else if (a === '--write') write = true;
    else if (a === '--json') json = true;
    else if (a === '--help') help = true;
    else if (a === '--version') version = true;
    else if (a === '--site') {
      site = argv[++i];
      if (!site || site.startsWith('--')) return { error: '--site requires a directory path' };
    }
  }
  if (check && write) return { error: '--check and --write are mutually exclusive' };
  if (positionals.length > 1) return { error: 'at most one positional <repo-root> is accepted' };
  // Read-only is the safe default: a bare invocation never edits the site.
  return { check: check || !write, write, json, help, version, site, root: positionals[0] };
}

function printHelp() {
  writeStdoutLineSync(USAGE);
  writeStdoutLineSync('');
  writeStdoutLineSync('Fills the website\'s measured numbers from the repository instead of by hand.');
  writeStdoutLineSync('Reads/writes <span data-metric="…">…</span> cells in every *.html under site/.');
  writeStdoutLineSync('');
  writeStdoutLineSync('  --check        (default) report drift, change nothing; exit 1 on drift');
  writeStdoutLineSync(`  --write        rewrite the cells in place; also refreshes ${CENSUS_FILE.join('/')}`);
  writeStdoutLineSync('                 (skipped when --site points outside the repo\'s own site/)');
  writeStdoutLineSync('  --json         machine-readable envelope on stdout');
  writeStdoutLineSync('  --site <dir>   site directory (default <repo-root>/site)');
  writeStdoutLineSync('  --version      print the package version');
  writeStdoutLineSync('');
  writeStdoutLineSync(`  metrics: ${METRIC_IDS.join(', ')}`);
  writeStdoutLineSync('');
  for (const d of METRIC_DEFS) writeStdoutLineSync(`    ${d.id.padEnd(12)} ${d.source}`);
  writeStdoutLineSync('');
  writeStdoutLineSync('Exit: 0 ok · 1 drift or contract violation · 2 tool error');
}

export function main(argv = process.argv.slice(2), env = {}) {
  const stdout = env.stdout ?? writeStdoutLineSync;
  const stderr = env.stderr ?? ((s) => process.stderr.write(`${s}\n`));

  const args = parseArgs(argv);
  if (args.error) {
    stderr(`Error: ${args.error}`);
    stderr(USAGE);
    return 2;
  }
  if (args.help) {
    printHelp();
    return 0;
  }

  const root = resolve(args.root ?? process.cwd());
  if (!existsSync(root)) {
    stderr(`Error: repo root does not exist: ${root}`);
    return 2;
  }
  if (args.version) {
    const v = readPackageVersion(root);
    if (v === null) {
      stderr(`Error: no readable package.json under ${root}`);
      return 2;
    }
    stdout(v);
    return 0;
  }

  const siteDir = resolve(args.site ?? join(root, 'site'));
  const files = listHtmlFiles(siteDir);
  if (files === null) {
    stderr(`Error: site directory does not exist: ${siteDir}`);
    return 2;
  }

  const { values, missing, warnings, fromSnapshot } = collect(root);
  if (missing.length > 0) {
    stderr(
      `Error: could not measure ${missing.join(', ')} under ${root} — ` +
        'refusing to publish a partial census (is this the repository root?)',
    );
    return 2;
  }
  for (const w of warnings) stderr(`WARN: ${w}`);

  const dirty = isDirty(root);
  if (args.write && dirty) {
    stderr(
      `WARN: working tree is dirty — counted-sha ${values['counted-sha']} will not reproduce these numbers`,
    );
  }

  const report = [];
  let spanTotal = 0;
  let driftTotal = 0;
  let contractTotal = 0;
  let writtenTotal = 0;
  // Values the safe-value allowlist refused. A rejection is a hard failure:
  // the source producing it is corrupt, and writing the rest would be a
  // partial write reported as success.
  let rejectedTotal = 0;

  for (const abs of files) {
    // Repo-relative when the file is inside the repo; absolute otherwise (a
    // `--site` fixture in $TMPDIR would otherwise render as ../../../../var/...).
    const r = relative(root, abs);
    const rel = r && !r.startsWith('..') ? r : abs;
    const html = readFileSync(abs, 'utf8');
    const spans = inspectHtml(html, values);
    spanTotal += spans.length;

    const drift = spans.filter((s) => s.drift);
    const stale = spans.filter((s) => s.stale);
    const unknown = spans.filter((s) => !s.known);
    const malformed = spans.filter((s) => s.known && s.malformed);
    const unresolved = spans.filter((s) => s.unresolved);
    driftTotal += drift.length;
    contractTotal += unknown.length + malformed.length + unresolved.length;

    let written = 0;
    if (
      args.write &&
      unknown.length === 0 &&
      malformed.length === 0 &&
      unresolved.length === 0 &&
      spans.length > 0
    ) {
      const res = rewrite(html, values);
      if (res.rejected > 0) {
        // A value that fails SAFE_VALUE_RE is a corrupt or hostile source, not
        // a formatting nit. Refuse the whole file rather than write the subset
        // that happened to pass — a partial write is the silent-failure shape.
        stderr(
          `Error: ${res.rejected} computed value(s) rejected by the safe-value allowlist in ${rel} — refusing to write. Check the version literal in package.json.`,
        );
        rejectedTotal += res.rejected;
      } else if (res.replaced > 0) {
        writeFileSync(abs, res.html, 'utf8');
        written = res.replaced;
        writtenTotal += res.replaced;
      }
    }

    report.push({
      file: rel,
      spans: spans.length,
      drift: drift.map((s) => ({ metric: s.metric, line: s.line, actual: s.actual, expected: s.expected })),
      stale: stale.map((s) => ({ metric: s.metric, line: s.line, actual: s.actual, expected: s.expected })),
      unknown: unknown.map((s) => ({ metric: s.metric, line: s.line })),
      malformed: malformed.map((s) => ({ metric: s.metric, line: s.line })),
      unresolved: unresolved.map((s) => ({ metric: s.metric, line: s.line })),
      written,
    });
  }

  // The named silent-failure class: a generator that matches nothing, changes
  // nothing, and reports success. Zero spans means the markup contract is not in
  // the page — that is a defect, in BOTH modes, never a no-op.
  const noSpans = spanTotal === 0;
  if (noSpans) {
    stderr(
      `Error: no <span data-metric="…"> cells found in ${files.length} HTML file(s) under ${siteDir} — ` +
        `the markup contract is missing (expected one of: ${METRIC_IDS.join(', ')})`,
    );
  }
  for (const f of report) {
    for (const u of f.unknown) {
      stderr(
        `Error: ${f.file}:${u.line}: unknown data-metric "${u.metric}" — allowed: ${METRIC_IDS.join(', ')}`,
      );
    }
    for (const m of f.malformed) {
      stderr(`Error: ${f.file}:${m.line}: data-metric "${m.metric}" cell contains markup, not a plain value`);
    }
    for (const u of f.unresolved) {
      stderr(
        `Error: ${f.file}:${u.line}: data-metric "${u.metric}" is a known metric with no computed value — ` +
          'the cell would keep its hand-maintained number while this run reported it as current',
      );
    }
  }

  // Under --write, remaining drift is not a failure — it was just written. Under
  // --check it is the whole point. A contract violation fails in either mode.
  const ok = !noSpans && contractTotal === 0 && rejectedTotal === 0 && (args.write || driftTotal === 0);
  const exitCode = ok ? 0 : 1;

  // The census snapshot rides on the SAME `values` as the cells above — never a
  // second collect(), which could disagree with the first across midnight or a
  // concurrent ledger append (see writeCensusSnapshot).
  //
  // Root-anchored, and written only when the site directory IS the repo's own:
  // `collect()` reads the snapshot from `<root>/site/` regardless of `--site`,
  // so writing it on a `--site <tmpdir>` fixture run would reach back into the
  // real `site/` from a test — dirtying the working copy and tripping the
  // release preflight's clean-tree check. A fixture run is a read of the repo,
  // never a write to it.
  let censusWritten = false;
  const writesCensus = args.write && resolve(siteDir) === resolve(join(root, 'site'));
  if (writesCensus && ok) {
    const res = writeCensusSnapshot(root, values);
    if (res.ok) {
      censusWritten = true;
    } else {
      stderr(`Error: could not write ${CENSUS_FILE.join('/')}: ${res.error ?? res.reason}`);
      return 2;
    }
  }

  if (args.json) {
    stdout(
      JSON.stringify(
        {
          schema: SCHEMA,
          mode: args.write ? 'write' : 'check',
          root,
          siteDir,
          ref: values['counted-sha'],
          dirty,
          metrics: METRIC_DEFS.map((d) => ({
            metric: d.id,
            value: values[d.id],
            source: d.source,
            provenance: d.provenance,
            snapshotFallback: d.snapshotFallback === true,
            fromSnapshot: fromSnapshot.includes(d.id),
          })),
          files: report,
          spanCount: spanTotal,
          driftCount: driftTotal,
          contractViolations: contractTotal,
          written: writtenTotal,
          rejected: rejectedTotal,
          fromSnapshot,
          censusWritten,
          ok,
        },
        null,
        2,
      ),
    );
  } else if (args.write) {
    stdout(
      `site-numbers: wrote ${writtenTotal} value(s) across ${files.length} file(s) in ${siteDir}` +
        ` (${spanTotal} metric cells @ ${values['counted-sha']}${dirty ? '+dirty' : ''})` +
        (censusWritten ? ` + ${CENSUS_FILE.join('/')}` : ''),
    );
  } else {
    for (const f of report) {
      for (const d of f.drift) {
        stdout(`DRIFT ${f.file}:${d.line} ${d.metric}: page says "${d.actual}", repo says "${d.expected}"`);
      }
      for (const s of f.stale) {
        stderr(`stale ${f.file}:${s.line} ${s.metric}: "${s.actual}" → would become "${s.expected}" on --write`);
      }
    }
    stdout(
      driftTotal === 0 && !noSpans && contractTotal === 0
        ? `site-numbers: ${spanTotal} metric cell(s) current across ${files.length} file(s)`
        : `site-numbers: ${driftTotal} drifted / ${contractTotal} contract violation(s) in ${spanTotal} cell(s)`,
    );
  }

  return exitCode;
}

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] !== null &&
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) process.exit(main());

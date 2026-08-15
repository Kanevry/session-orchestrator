/**
 * tests/lib/mirror-issues-banner.test.mjs — the mirror blind spot
 *
 * Every case runs against an isolated tmpdir repoRoot with BOTH boundaries
 * stubbed (`resolveRepoSpec` + `execFile`), so no test spawns `gh`, touches
 * the network, or depends on this repo's live remote configuration.
 *
 * The success fixture is a GOLDEN RECORD: the verbatim stdout bytes of
 * `gh issue list --repo Kanevry/session-orchestrator --state open --limit 20
 * --json number,title`, captured 2026-08-14, per `.claude/rules/testing.md`
 * § "Fixtures Mirror Production Data". It is stored as the raw STRING gh
 * emitted, never as `JSON.stringify(handBuiltArray)` — a re-serialized fixture
 * silently normalises key order and shape, which is how a fixture stops being
 * able to bite (learning `byte-for-byte pass-through asserts cannot bite on a
 * JSON.stringify-produced fixture`).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checkMirrorIssues, DEFAULT_LIMIT, DEGRADED_REASONS } from '@lib/mirror-issues-banner.mjs';

/** Verbatim `gh issue list ... --json number,title` stdout. Do not reformat. */
const GH_GOLDEN_STDOUT =
  '[{"number":63,"title":"enhancement: degrade gracefully when hook dependencies are missing (cf. #53)"},{"number":62,"title":"bug: runtime imports not declared in dependencies (js-yaml, picomatch)"},{"number":61,"title":"setMissionStatus schreibt in den Body, parseMissionStatus liest das Frontmatter — Status-Updates gehen still verloren"}]\n';

const MIRROR_SPEC = 'github.com/Kanevry/session-orchestrator';

let tmpRepo;

beforeEach(() => {
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-issues-repo-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

/** Records every call so tests can assert the NOT-called case. */
function makeExecStub(impl) {
  const calls = [];
  const fn = (...args) => {
    calls.push(args);
    return impl(...args);
  };
  fn.calls = calls;
  return fn;
}

describe('checkMirrorIssues — open issues on the mirror', () => {
  it('reports the mirror issues gh actually returns, with no degraded marker', async () => {
    const execFile = makeExecStub(async () => ({ stdout: GH_GOLDEN_STDOUT, stderr: '' }));

    const result = await checkMirrorIssues(
      { repoRoot: tmpRepo },
      { execFile, resolveRepoSpec: () => MIRROR_SPEC },
    );

    expect(result).not.toBeNull();
    expect(result.severity).toBe('warn');
    expect(result.count).toBe(3);
    expect(result.repoSpec).toBe(MIRROR_SPEC);
    expect(result.issues.map((i) => i.number)).toEqual([63, 62, 61]);
    // The message must name the numbers — an operator acts on those, not on a count.
    expect(result.message).toContain('#63');
    expect(result.message).toContain('#62');
    expect(result.message).toContain('#61');
    // A successful read carries NO degraded key. This is the discriminator that
    // separates "measured, N found" from "could not measure".
    expect(result.degraded).toBeUndefined();
  });

  it('pins the mirror to gh -R <spec> rather than an ambient default repo', async () => {
    const execFile = makeExecStub(async () => ({ stdout: GH_GOLDEN_STDOUT, stderr: '' }));

    await checkMirrorIssues({ repoRoot: tmpRepo }, { execFile, resolveRepoSpec: () => MIRROR_SPEC });

    expect(execFile.calls).toHaveLength(1);
    const [cmd, args] = execFile.calls[0];
    expect(cmd).toBe('gh');
    // Args array, never a shell string.
    expect(Array.isArray(args)).toBe(true);
    // -R must be immediately followed by the resolved spec, or gh silently
    // targets whatever GH_REPO/cwd resolution yields.
    expect(args[args.indexOf('-R') + 1]).toBe(MIRROR_SPEC);
    expect(args[args.indexOf('--limit') + 1]).toBe(String(DEFAULT_LIMIT));
  });

  it('returns null when the query succeeded and the mirror is clean', async () => {
    const execFile = makeExecStub(async () => ({ stdout: '[]\n', stderr: '' }));

    const result = await checkMirrorIssues(
      { repoRoot: tmpRepo },
      { execFile, resolveRepoSpec: () => MIRROR_SPEC },
    );

    expect(result).toBeNull();
  });
});

describe('checkMirrorIssues — repos without a mirror', () => {
  it('returns null and spawns NOTHING when no github remote resolves', async () => {
    const execFile = makeExecStub(async () => {
      throw new Error('execFile must not run when there is no mirror remote');
    });

    const result = await checkMirrorIssues(
      { repoRoot: tmpRepo },
      { execFile, resolveRepoSpec: () => undefined },
    );

    expect(result).toBeNull();
    // Self-disabling: a non-mirror repo pays no subprocess and no network cost.
    expect(execFile.calls).toHaveLength(0);
  });
});

describe('checkMirrorIssues — degraded states are not "clean"', () => {
  it('reports degraded cli-missing instead of null when gh is absent (ENOENT)', async () => {
    const execFile = makeExecStub(async () => {
      const err = new Error('spawn gh ENOENT');
      err.code = 'ENOENT';
      throw err;
    });

    const result = await checkMirrorIssues(
      { repoRoot: tmpRepo },
      { execFile, resolveRepoSpec: () => MIRROR_SPEC },
    );

    // The load-bearing assertion: a failed query must NOT collapse to null,
    // because null reads as "all clear" in the banner contract. Collapsing it
    // is exactly how ci-status-banner.mjs hid this whole issue class.
    expect(result).not.toBeNull();
    expect(result.severity).toBe('warn');
    expect(result.degraded).toBe('cli-missing');
    expect(result.repoSpec).toBe(MIRROR_SPEC);
    expect(result.message).toContain('Zustand unbekannt');
    // A degraded result must never fabricate a count.
    expect(result.count).toBeUndefined();
    expect(DEGRADED_REASONS).toContain(result.degraded);
  });

  it('reports degraded parse-error when gh exits 0 with unusable output', async () => {
    const execFile = makeExecStub(async () => ({ stdout: 'not json at all', stderr: '' }));

    const result = await checkMirrorIssues(
      { repoRoot: tmpRepo },
      { execFile, resolveRepoSpec: () => MIRROR_SPEC },
    );

    expect(result).not.toBeNull();
    expect(result.degraded).toBe('parse-error');
    expect(DEGRADED_REASONS).toContain(result.degraded);
  });

  it('reports degraded auth-error when gh is installed but not logged in', async () => {
    const execFile = makeExecStub(async () => {
      const err = new Error('exit status 4');
      err.stderr = 'gh: To get started with GitHub CLI, please run: gh auth login';
      throw err;
    });

    const result = await checkMirrorIssues(
      { repoRoot: tmpRepo },
      { execFile, resolveRepoSpec: () => MIRROR_SPEC },
    );

    expect(result.degraded).toBe('auth-error');
    expect(DEGRADED_REASONS).toContain(result.degraded);
  });

  it('reports degraded timeout when gh hangs past the budget', async () => {
    // A `gh` that never settles. The production race rejects with
    // `new Error('timeout')` and `classifyFailure` recognises it by STRICT
    // equality against that literal — so this is the only test standing
    // between the timeout branch and two silent regressions: enriching the
    // message ('timeout after 8000ms') reclassifies the case as query-failed,
    // and breaking the race entirely hangs session-start on the gh child.
    const execFile = makeExecStub(() => new Promise(() => {}));

    const result = await checkMirrorIssues(
      { repoRoot: tmpRepo, timeoutMs: 5 },
      { execFile, resolveRepoSpec: () => MIRROR_SPEC },
    );

    expect(result).not.toBeNull();
    expect(result.degraded).toBe('timeout');
    expect(result.count).toBeUndefined();
    expect(DEGRADED_REASONS).toContain(result.degraded);
  });

  it('reports degraded query-failed when gh runs but the network lookup fails', async () => {
    const execFile = makeExecStub(async () => {
      const err = new Error('exit status 1');
      err.stderr = 'dial tcp: lookup api.github.com: no such host';
      throw err;
    });

    const result = await checkMirrorIssues(
      { repoRoot: tmpRepo },
      { execFile, resolveRepoSpec: () => MIRROR_SPEC },
    );

    expect(result).not.toBeNull();
    // The residual bucket must stay distinct from parse-error: folding a dead
    // network into "malformed output" mislabels the state the operator reads.
    expect(result.degraded).toBe('query-failed');
    expect(result.count).toBeUndefined();
    expect(DEGRADED_REASONS).toContain(result.degraded);
  });

  it('classifies an HTTP 403 rate-limit as auth-error (measured, see note)', async () => {
    // MEASURED, NOT ENDORSED. `DEGRADED_REASONS`' doc comment lists "rate
    // limit" under `query-failed`; `classifyFailure` routes `http 403` — which
    // is exactly what GitHub returns for a rate-limit — to `auth-error`. This
    // test pins what the CODE does so the contradiction cannot be resolved by
    // accident: a well-meant edit moving `http 403` into the query-failed
    // bucket to match the comment would also demote every expired-token and
    // insufficient-scope 403 (the far more common 403 on `gh issue list`) out
    // of auth-error, and the operator loses the "re-authenticate" signal.
    // Which side is wrong is a decision for the owner, not this test.
    const execFile = makeExecStub(async () => {
      const err = new Error('exit status 1');
      err.stderr = 'gh: HTTP 403: API rate limit exceeded for user ID 1 (https://api.github.com/graphql)';
      throw err;
    });

    const result = await checkMirrorIssues(
      { repoRoot: tmpRepo },
      { execFile, resolveRepoSpec: () => MIRROR_SPEC },
    );

    expect(result.degraded).toBe('auth-error');
    expect(DEGRADED_REASONS).toContain(result.degraded);
  });
});

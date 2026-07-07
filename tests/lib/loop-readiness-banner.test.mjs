import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checkLoopReadiness } from '@lib/loop-readiness-banner.mjs';

// Every case passes BOTH repoRoot AND homeDir pointing into a tmpdir so the
// test never reads the real `~/.claude/` — real machine state would make the
// results environment-dependent.

let tmpRepo;
let tmpHome;

beforeEach(() => {
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-readiness-repo-'));
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-readiness-home-'));
});

afterEach(() => {
  for (const dir of [tmpRepo, tmpHome]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

/** Helper: create `<base>/.claude/loop.md` with placeholder content. */
function writeLoopMd(base) {
  const claudeDir = path.join(base, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'loop.md'), '# loop body\n', 'utf8');
}

/** Helper: create `<base>/.claude/loop.md` at an exact byte size (#767 boundary tests). */
function writeLoopMdSized(base, byteSize) {
  const claudeDir = path.join(base, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'loop.md'), Buffer.alloc(byteSize, 'a'));
}

describe('checkLoopReadiness — bad input', () => {
  it('returns null when called with no arguments', () => {
    expect(checkLoopReadiness()).toBe(null);
  });

  it('returns null when repoRoot is null', () => {
    expect(checkLoopReadiness({ repoRoot: null, homeDir: tmpHome, env: {} })).toBe(null);
  });

  it('returns null when repoRoot is a non-string', () => {
    expect(checkLoopReadiness({ repoRoot: 42, homeDir: tmpHome, env: {} })).toBe(null);
  });

  it('returns null when repoRoot is null even if CLAUDE_CODE_DISABLE_CRON is set', () => {
    // Pins that the repoRoot bad-input guard is unconditional — a set
    // DISABLE_CRON finding must never leak through a bad-repoRoot call.
    expect(
      checkLoopReadiness({ repoRoot: null, homeDir: tmpHome, env: { CLAUDE_CODE_DISABLE_CRON: '1' } })
    ).toBe(null);
  });
});

describe('checkLoopReadiness — healthy (no banner)', () => {
  it('returns null when <repo>/.claude/loop.md exists', () => {
    writeLoopMd(tmpRepo);
    expect(checkLoopReadiness({ repoRoot: tmpRepo, homeDir: tmpHome, env: {} })).toBe(null);
  });

  it('returns null when only <home>/.claude/loop.md exists (user baseline covers)', () => {
    writeLoopMd(tmpHome);
    expect(checkLoopReadiness({ repoRoot: tmpRepo, homeDir: tmpHome, env: {} })).toBe(null);
  });
});

describe('checkLoopReadiness — warn (neither present)', () => {
  it('returns a warn banner when neither repo nor user loop.md exists', () => {
    const result = checkLoopReadiness({ repoRoot: tmpRepo, homeDir: tmpHome, env: {} });
    expect(result).not.toBe(null);
    expect(result.severity).toBe('warn');
    expect(result.repoLoopMd).toBe(false);
    expect(result.userLoopMd).toBe(false);
  });

  it('message names the template path and the bare-/loop fallback', () => {
    const result = checkLoopReadiness({ repoRoot: tmpRepo, homeDir: tmpHome, env: {} });
    expect(result.message).toContain('templates/_shared/loop.md');
    expect(result.message).toContain('/loop');
  });
});

describe('checkLoopReadiness — fail-silent', () => {
  it('does not throw on a weird repoRoot where a path segment is a file, not a dir', () => {
    // `<repo>/.claude` is a regular file → `<repo>/.claude/loop.md` cannot be a
    // valid path. `existsSync` swallows the lookup error and the try/catch
    // guards any remaining throw, so the call must complete without throwing.
    fs.writeFileSync(path.join(tmpRepo, '.claude'), 'i am a file, not a dir\n', 'utf8');
    let result;
    expect(() => {
      result = checkLoopReadiness({ repoRoot: tmpRepo, homeDir: tmpHome, env: {} });
    }).not.toThrow();
    // Neither loop.md is resolvable → warn banner, not null.
    expect(result.severity).toBe('warn');
  });

  it('does not throw on a repoRoot path containing a NUL byte', () => {
    let result;
    expect(() => {
      result = checkLoopReadiness({ repoRoot: '/tmp/\0bad', homeDir: tmpHome, env: {} });
    }).not.toThrow();
    expect(result.severity).toBe('warn');
  });
});

// ---------------------------------------------------------------------------
// P3 depth: additional banner edge-cases (Wave-3 additions)
// ---------------------------------------------------------------------------

describe('P3 depth: banner edge-cases', () => {
  it('returns null when BOTH repo and user loop.md exist (OR semantics, either is enough)', () => {
    // Pins the OR contract: presence of both must still return null (not double-warn).
    writeLoopMd(tmpRepo);
    writeLoopMd(tmpHome);
    expect(checkLoopReadiness({ repoRoot: tmpRepo, homeDir: tmpHome, env: {} })).toBe(null);
  });

  it('returns null for empty-string repoRoot (treated as falsy bad input)', () => {
    // The SUT guard: `if (!repoRoot || typeof repoRoot !== 'string') return null;`
    // Empty string is falsy → null without filesystem access.
    expect(checkLoopReadiness({ repoRoot: '', homeDir: tmpHome, env: {} })).toBe(null);
  });

  it('warn message contains the /bootstrap hint', () => {
    // Pins the operator-actionable hint so a message rewrite that drops it fails here.
    const result = checkLoopReadiness({ repoRoot: tmpRepo, homeDir: tmpHome, env: {} });
    expect(result.message).toContain('/bootstrap');
  });

  it('warn message mentions ~/.claude/loop.md so the operator knows the host-wide path', () => {
    // Pins the host-wide baseline path hint in the message.
    const result = checkLoopReadiness({ repoRoot: tmpRepo, homeDir: tmpHome, env: {} });
    expect(result.message).toContain('~/.claude/loop.md');
  });
});

// ---------------------------------------------------------------------------
// #767: CLAUDE_CODE_DISABLE_CRON detection + 25KB loop.md truncation check
// ---------------------------------------------------------------------------

describe('checkLoopReadiness — CLAUDE_CODE_DISABLE_CRON detection (#767)', () => {
  it('warns when CLAUDE_CODE_DISABLE_CRON is set, even though loop.md exists', () => {
    // Finding fires independently of loop.md presence — pins the "unabhängig"
    // contract-rule (a healthy loop.md must not mask a disabled cron scheduler).
    writeLoopMd(tmpRepo);
    const result = checkLoopReadiness({
      repoRoot: tmpRepo,
      homeDir: tmpHome,
      env: { CLAUDE_CODE_DISABLE_CRON: '1' },
    });
    expect(result).not.toBe(null);
    expect(result.severity).toBe('warn');
    expect(result.message).toContain('CLAUDE_CODE_DISABLE_CRON');
    expect(result.disableCron).toBe(true);
  });

  it('does not warn when CLAUDE_CODE_DISABLE_CRON is unset and loop.md exists', () => {
    writeLoopMd(tmpRepo);
    expect(
      checkLoopReadiness({ repoRoot: tmpRepo, homeDir: tmpHome, env: {} })
    ).toBe(null);
  });

  it('does not warn when CLAUDE_CODE_DISABLE_CRON is an empty string and loop.md exists', () => {
    // Empty string is falsy — "unset or empty" per the #767 contract.
    writeLoopMd(tmpRepo);
    const result = checkLoopReadiness({
      repoRoot: tmpRepo,
      homeDir: tmpHome,
      env: { CLAUDE_CODE_DISABLE_CRON: '' },
    });
    expect(result).toBe(null);
  });
});

describe('checkLoopReadiness — 25KB truncation boundary (#767)', () => {
  it('returns null at exactly 25,000 bytes (repo loop.md) — boundary is inclusive of "ok"', () => {
    writeLoopMdSized(tmpRepo, 25_000);
    expect(checkLoopReadiness({ repoRoot: tmpRepo, homeDir: tmpHome, env: {} })).toBe(null);
  });

  it('warns at 25,001 bytes (repo loop.md) with the file path and byte size in the message', () => {
    writeLoopMdSized(tmpRepo, 25_001);
    const result = checkLoopReadiness({ repoRoot: tmpRepo, homeDir: tmpHome, env: {} });
    expect(result).not.toBe(null);
    expect(result.severity).toBe('warn');
    expect(result.message).toContain(path.join(tmpRepo, '.claude', 'loop.md'));
    expect(result.message).toContain('25001');
    expect(result.oversize).toEqual(['repo']);
  });

  it('returns null at exactly 25,000 bytes (user loop.md)', () => {
    writeLoopMdSized(tmpHome, 25_000);
    expect(checkLoopReadiness({ repoRoot: tmpRepo, homeDir: tmpHome, env: {} })).toBe(null);
  });

  it('warns at 25,001 bytes (user loop.md) with the file path and byte size in the message', () => {
    writeLoopMdSized(tmpHome, 25_001);
    const result = checkLoopReadiness({ repoRoot: tmpRepo, homeDir: tmpHome, env: {} });
    expect(result).not.toBe(null);
    expect(result.severity).toBe('warn');
    expect(result.message).toContain(path.join(tmpHome, '.claude', 'loop.md'));
    expect(result.message).toContain('25001');
    expect(result.oversize).toEqual(['user']);
  });

  it('does not also flag "no loop.md anywhere" when only user loop.md exists and is oversize', () => {
    // Guards the independence of Finding 1 vs Finding 3: repoLoopMd=false
    // alone must NOT trigger the "neither exists" finding when userLoopMd
    // is true (oversize or not). A buggy `!repoLoopMd || !userLoopMd`
    // rewrite of the Finding-1 condition would make this go red.
    writeLoopMdSized(tmpHome, 25_001);
    const result = checkLoopReadiness({ repoRoot: tmpRepo, homeDir: tmpHome, env: {} });
    expect(result.repoLoopMd).toBe(false);
    expect(result.userLoopMd).toBe(true);
    expect(result.message).not.toContain('no .claude/loop.md');
    expect(result.oversize).toEqual(['user']);
  });
});

describe('checkLoopReadiness — combined findings (#767)', () => {
  it('combines DISABLE_CRON + both oversize files into a single warn object', () => {
    writeLoopMdSized(tmpRepo, 25_001);
    writeLoopMdSized(tmpHome, 25_001);
    const result = checkLoopReadiness({
      repoRoot: tmpRepo,
      homeDir: tmpHome,
      env: { CLAUDE_CODE_DISABLE_CRON: '1' },
    });
    expect(result).not.toBe(null);
    expect(result.severity).toBe('warn');
    // Single combined object — never an array, never multiple returns.
    expect(Array.isArray(result)).toBe(false);
    expect(result.message).toContain('CLAUDE_CODE_DISABLE_CRON');
    expect(result.message).toContain(path.join(tmpRepo, '.claude', 'loop.md'));
    expect(result.message).toContain(path.join(tmpHome, '.claude', 'loop.md'));
    expect(result.disableCron).toBe(true);
    expect(result.oversize).toEqual(['repo', 'user']);
  });

  it('combines "no loop.md anywhere" + DISABLE_CRON into a single warn object', () => {
    const result = checkLoopReadiness({
      repoRoot: tmpRepo,
      homeDir: tmpHome,
      env: { CLAUDE_CODE_DISABLE_CRON: '1' },
    });
    expect(result).not.toBe(null);
    expect(result.severity).toBe('warn');
    expect(Array.isArray(result)).toBe(false);
    expect(result.message).toContain('no .claude/loop.md');
    expect(result.message).toContain('CLAUDE_CODE_DISABLE_CRON');
    expect(result.repoLoopMd).toBe(false);
    expect(result.userLoopMd).toBe(false);
    expect(result.disableCron).toBe(true);
  });

  it('combines DISABLE_CRON + a SINGLE (repo-only) oversize file — user stays out of the oversize list', () => {
    // Distinguishes the single-file combination case from the
    // both-files case already covered above; pins that `oversize` lists
    // only the file(s) that actually exceed the ceiling.
    writeLoopMdSized(tmpRepo, 25_001);
    writeLoopMd(tmpHome); // present, well under the ceiling
    const result = checkLoopReadiness({
      repoRoot: tmpRepo,
      homeDir: tmpHome,
      env: { CLAUDE_CODE_DISABLE_CRON: '1' },
    });
    expect(result.disableCron).toBe(true);
    expect(result.oversize).toEqual(['repo']);
    expect(result.message).not.toContain(path.join(tmpHome, '.claude', 'loop.md'));
  });
});

// ---------------------------------------------------------------------------
// Result-object field-presence contract: disableCron/oversize are OMITTED
// (not `false`/`[]`) when their finding did not fire — the spread-based
// `...(cond ? {key} : {})` pattern in the SUT. (#767 depth)
// ---------------------------------------------------------------------------

describe('checkLoopReadiness — result field-presence contract (#767 depth)', () => {
  it('omits disableCron and oversize keys entirely when neither condition fires', () => {
    // A regression that swaps the conditional-spread for an always-present
    // `disableCron: false, oversize: []` shape would make this go red.
    const result = checkLoopReadiness({ repoRoot: tmpRepo, homeDir: tmpHome, env: {} });
    expect(result.disableCron).toBeUndefined();
    expect(result.oversize).toBeUndefined();
  });

  it('omits the oversize key when only DISABLE_CRON fires (no oversize file present)', () => {
    writeLoopMd(tmpRepo);
    const result = checkLoopReadiness({
      repoRoot: tmpRepo,
      homeDir: tmpHome,
      env: { CLAUDE_CODE_DISABLE_CRON: '1' },
    });
    expect(result.disableCron).toBe(true);
    expect(result.oversize).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// homeDir fallback to os.homedir() — the ternary's FALSE branch
// (`typeof homeDir === 'string' && homeDir ? homeDir : os.homedir()`) is
// never exercised by any test above (every call above passes an explicit
// homeDir). Control os.homedir()'s resolution via HOME env stubbing rather
// than reading the real machine's ~/.claude/loop.md (testing.md Vitest
// Mocking Gotchas: inject through the real dependency, not vi.spyOn on an
// ESM default-namespace object). (#767 depth)
// ---------------------------------------------------------------------------

describe('checkLoopReadiness — homeDir omitted falls back to os.homedir() (#767 depth)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves the user loop.md via os.homedir() when homeDir option is omitted', () => {
    vi.stubEnv('HOME', tmpHome);
    writeLoopMd(tmpHome);
    // homeDir is deliberately OMITTED — must fall back to os.homedir(),
    // which now resolves to tmpHome via the HOME stub above.
    const result = checkLoopReadiness({ repoRoot: tmpRepo, env: {} });
    expect(result).toBe(null);
  });

  it('warns when homeDir is omitted and the os.homedir()-resolved dir has no loop.md', () => {
    vi.stubEnv('HOME', tmpHome);
    const result = checkLoopReadiness({ repoRoot: tmpRepo, env: {} });
    expect(result).not.toBe(null);
    expect(result.userLoopMd).toBe(false);
  });
});

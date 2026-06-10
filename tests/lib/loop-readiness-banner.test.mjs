import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

describe('checkLoopReadiness — bad input', () => {
  it('returns null when called with no arguments', () => {
    expect(checkLoopReadiness()).toBe(null);
  });

  it('returns null when repoRoot is null', () => {
    expect(checkLoopReadiness({ repoRoot: null, homeDir: tmpHome })).toBe(null);
  });

  it('returns null when repoRoot is a non-string', () => {
    expect(checkLoopReadiness({ repoRoot: 42, homeDir: tmpHome })).toBe(null);
  });
});

describe('checkLoopReadiness — healthy (no banner)', () => {
  it('returns null when <repo>/.claude/loop.md exists', () => {
    writeLoopMd(tmpRepo);
    expect(checkLoopReadiness({ repoRoot: tmpRepo, homeDir: tmpHome })).toBe(null);
  });

  it('returns null when only <home>/.claude/loop.md exists (user baseline covers)', () => {
    writeLoopMd(tmpHome);
    expect(checkLoopReadiness({ repoRoot: tmpRepo, homeDir: tmpHome })).toBe(null);
  });
});

describe('checkLoopReadiness — warn (neither present)', () => {
  it('returns a warn banner when neither repo nor user loop.md exists', () => {
    const result = checkLoopReadiness({ repoRoot: tmpRepo, homeDir: tmpHome });
    expect(result).not.toBe(null);
    expect(result.severity).toBe('warn');
    expect(result.repoLoopMd).toBe(false);
    expect(result.userLoopMd).toBe(false);
  });

  it('message names the template path and the bare-/loop fallback', () => {
    const result = checkLoopReadiness({ repoRoot: tmpRepo, homeDir: tmpHome });
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
      result = checkLoopReadiness({ repoRoot: tmpRepo, homeDir: tmpHome });
    }).not.toThrow();
    // Neither loop.md is resolvable → warn banner, not null.
    expect(result.severity).toBe('warn');
  });

  it('does not throw on a repoRoot path containing a NUL byte', () => {
    let result;
    expect(() => {
      result = checkLoopReadiness({ repoRoot: '/tmp/\0bad', homeDir: tmpHome });
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
    expect(checkLoopReadiness({ repoRoot: tmpRepo, homeDir: tmpHome })).toBe(null);
  });

  it('returns null for empty-string repoRoot (treated as falsy bad input)', () => {
    // The SUT guard: `if (!repoRoot || typeof repoRoot !== 'string') return null;`
    // Empty string is falsy → null without filesystem access.
    expect(checkLoopReadiness({ repoRoot: '', homeDir: tmpHome })).toBe(null);
  });

  it('warn message contains the /bootstrap hint', () => {
    // Pins the operator-actionable hint so a message rewrite that drops it fails here.
    const result = checkLoopReadiness({ repoRoot: tmpRepo, homeDir: tmpHome });
    expect(result.message).toContain('/bootstrap');
  });

  it('warn message mentions ~/.claude/loop.md so the operator knows the host-wide path', () => {
    // Pins the host-wide baseline path hint in the message.
    const result = checkLoopReadiness({ repoRoot: tmpRepo, homeDir: tmpHome });
    expect(result.message).toContain('~/.claude/loop.md');
  });
});

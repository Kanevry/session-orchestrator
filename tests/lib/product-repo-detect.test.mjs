import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectProductRepo, hasVaultConfig } from '../../scripts/lib/product-repo-detect.mjs';

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'product-repo-detect-'));
}

describe('detectProductRepo', () => {
  let dirs = [];

  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
    dirs = [];
  });

  function tmp() {
    const d = makeTmpDir();
    dirs.push(d);
    return d;
  }

  it('returns false / score 0 for a fresh empty dir', () => {
    const repoRoot = tmp();
    const result = detectProductRepo({ repoRoot });
    expect(result.isProductRepo).toBe(false);
    expect(result.score).toBe(0);
    expect(result.signals.framework).toBe(false);
    expect(result.signals.contentDir).toBe(false);
    expect(result.signals.envVars).toBe(false);
    expect(result.framework).toBeNull();
    expect(result.contentDirs).toEqual([]);
    expect(result.productEnvMatches).toEqual([]);
  });

  it('Next.js + supabase env + personas dir → isProductRepo true, score 5, framework next', () => {
    const repoRoot = tmp();
    writeFileSync(
      join(repoRoot, 'package.json'),
      JSON.stringify({ dependencies: { next: '^15.0.0', react: '^19.0.0' } }),
    );
    mkdirSync(join(repoRoot, 'src', 'lib', 'personas'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.env.local.example'),
      'SUPABASE_URL=https://example.supabase.co\nSUPABASE_ANON_KEY=abc123\nSTRIPE_SECRET_KEY=sk_test\n',
    );
    const result = detectProductRepo({ repoRoot });
    expect(result.isProductRepo).toBe(true);
    expect(result.framework).toBe('next');
    expect(result.score).toBe(5);
    expect(result.signals.framework).toBe(true);
    expect(result.signals.contentDir).toBe(true);
    expect(result.signals.envVars).toBe(true);
    expect(result.contentDirs).toContain('src/lib/personas');
    expect(result.productEnvMatches).toContain('SUPABASE_URL');
  });

  it('only package.json with next → score 2, isProductRepo true', () => {
    const repoRoot = tmp();
    writeFileSync(
      join(repoRoot, 'package.json'),
      JSON.stringify({ dependencies: { next: '^15.0.0' } }),
    );
    const result = detectProductRepo({ repoRoot });
    expect(result.isProductRepo).toBe(true);
    expect(result.score).toBe(2);
    expect(result.signals.framework).toBe(true);
    expect(result.signals.contentDir).toBe(false);
    expect(result.signals.envVars).toBe(false);
  });

  it('only content dir → score 1, isProductRepo false (threshold is 2)', () => {
    const repoRoot = tmp();
    mkdirSync(join(repoRoot, 'src', 'content'), { recursive: true });
    const result = detectProductRepo({ repoRoot });
    expect(result.isProductRepo).toBe(false);
    expect(result.score).toBe(1);
    expect(result.signals.contentDir).toBe(true);
    expect(result.signals.framework).toBe(false);
    expect(result.signals.envVars).toBe(false);
  });

  it('malformed package.json → does not throw, framework is null', () => {
    const repoRoot = tmp();
    writeFileSync(join(repoRoot, 'package.json'), '{ this is not json ]]]');
    expect(() => detectProductRepo({ repoRoot })).not.toThrow();
    const result = detectProductRepo({ repoRoot });
    expect(result.framework).toBeNull();
    expect(result.signals.framework).toBe(false);
  });

  it('missing .env.local.example → productEnvMatches is empty array', () => {
    const repoRoot = tmp();
    writeFileSync(
      join(repoRoot, 'package.json'),
      JSON.stringify({ dependencies: { next: '^14.0.0' } }),
    );
    const result = detectProductRepo({ repoRoot });
    expect(result.productEnvMatches).toEqual([]);
    expect(result.signals.envVars).toBe(false);
  });

  it('detects @sveltejs/kit as framework signal', () => {
    const repoRoot = tmp();
    writeFileSync(
      join(repoRoot, 'package.json'),
      JSON.stringify({ devDependencies: { '@sveltejs/kit': '^2.0.0' } }),
    );
    const result = detectProductRepo({ repoRoot });
    expect(result.framework).toBe('@sveltejs/kit');
    expect(result.signals.framework).toBe(true);
  });

  it('detects astro as framework signal', () => {
    const repoRoot = tmp();
    writeFileSync(
      join(repoRoot, 'package.json'),
      JSON.stringify({ dependencies: { astro: '^4.0.0' } }),
    );
    const result = detectProductRepo({ repoRoot });
    expect(result.framework).toBe('astro');
  });

  it('detects content dir at root-level content/', () => {
    const repoRoot = tmp();
    mkdirSync(join(repoRoot, 'content'), { recursive: true });
    const result = detectProductRepo({ repoRoot });
    expect(result.contentDirs).toContain('content');
    expect(result.signals.contentDir).toBe(true);
  });

  it('detects CLERK and POSTHOG env vars', () => {
    const repoRoot = tmp();
    writeFileSync(
      join(repoRoot, '.env.local.example'),
      'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test\nNEXT_PUBLIC_POSTHOG_KEY=ph_test\n',
    );
    const result = detectProductRepo({ repoRoot });
    expect(result.productEnvMatches.some((m) => m.includes('CLERK'))).toBe(true);
    expect(result.productEnvMatches.some((m) => m.includes('POSTHOG'))).toBe(true);
    expect(result.signals.envVars).toBe(true);
  });

  it('only env vars → score 2, isProductRepo true', () => {
    const repoRoot = tmp();
    writeFileSync(
      join(repoRoot, '.env.local.example'),
      'SUPABASE_URL=https://example.supabase.co\n',
    );
    const result = detectProductRepo({ repoRoot });
    expect(result.score).toBe(2);
    expect(result.isProductRepo).toBe(true);
    expect(result.signals.envVars).toBe(true);
  });

  it('detects STRIPE_* on a non-first line (multiline flag regression)', () => {
    const repoRoot = tmp();
    writeFileSync(
      join(repoRoot, '.env.local.example'),
      '# Payment provider\nNODE_ENV=development\nSTRIPE_SECRET_KEY=sk_test\n',
    );
    const result = detectProductRepo({ repoRoot });
    expect(result.productEnvMatches.some((m) => m.startsWith('STRIPE_'))).toBe(true);
    expect(result.signals.envVars).toBe(true);
  });
});

describe('hasVaultConfig', () => {
  let dirs = [];

  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
    dirs = [];
  });

  function tmp() {
    const d = makeTmpDir();
    dirs.push(d);
    return d;
  }

  it('returns true when CLAUDE.md has Session Config block with vault: key', () => {
    const repoRoot = tmp();
    const claudeMd = join(repoRoot, 'CLAUDE.md');
    writeFileSync(
      claudeMd,
      [
        '# My Project',
        '',
        '## Session Config',
        '',
        'persistence: true',
        'vault:',
        '  path: ~/Projects/vault',
        '  product-domain: myapp',
        '',
        '## Other Section',
        '',
        'Some content.',
      ].join('\n'),
    );
    expect(hasVaultConfig(claudeMd)).toBe(true);
  });

  it('returns false when there is no Session Config block', () => {
    const repoRoot = tmp();
    const claudeMd = join(repoRoot, 'CLAUDE.md');
    writeFileSync(
      claudeMd,
      ['# My Project', '', 'Just some prose. No Session Config here.', ''].join('\n'),
    );
    expect(hasVaultConfig(claudeMd)).toBe(false);
  });

  it('returns false when Session Config block exists but has no vault: key', () => {
    const repoRoot = tmp();
    const claudeMd = join(repoRoot, 'CLAUDE.md');
    writeFileSync(
      claudeMd,
      [
        '# My Project',
        '',
        '## Session Config',
        '',
        'persistence: true',
        'enforcement: warn',
        'test-command: npm test',
      ].join('\n'),
    );
    expect(hasVaultConfig(claudeMd)).toBe(false);
  });

  it('returns false when the file does not exist', () => {
    const repoRoot = tmp();
    const missing = join(repoRoot, 'CLAUDE.md');
    expect(hasVaultConfig(missing)).toBe(false);
  });

  it('returns true for inline vault: entry (no nested keys)', () => {
    const repoRoot = tmp();
    const claudeMd = join(repoRoot, 'CLAUDE.md');
    writeFileSync(
      claudeMd,
      ['## Session Config', '', 'persistence: true', 'vault: {}', ''].join('\n'),
    );
    expect(hasVaultConfig(claudeMd)).toBe(true);
  });

  it('does not false-positive on vault: key outside Session Config block', () => {
    const repoRoot = tmp();
    const claudeMd = join(repoRoot, 'CLAUDE.md');
    writeFileSync(
      claudeMd,
      [
        '# My Project',
        '',
        'vault: mentioned here',
        '',
        '## Session Config',
        '',
        'persistence: true',
        '',
        '## Other Section',
        '',
        'vault: also here',
      ].join('\n'),
    );
    // vault: appears before Session Config and after — but NOT inside Session Config block
    expect(hasVaultConfig(claudeMd)).toBe(false);
  });
});

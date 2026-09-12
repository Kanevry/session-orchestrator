/**
 * ux-grill manifest guards — need-gated tests (PRD § 3 "Manifest, Bootstrap &
 * Sicherheit" ACs 1-3). Each `it()` names the concrete bug it catches.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ManifestError,
  parseManifest,
  assertLoopbackBaseUrl,
  assertGuardedEnvsLoopback,
  isLoopbackUrl,
  loadManifest,
  manifestHash,
  readEnvFile,
  resolvePersonaCredentials,
  buildBootstrapManifest,
  writeBootstrapManifest,
} from '../../../scripts/lib/ux-grill/manifest.mjs';

/** @type {string[]} */
const tmpDirs = [];

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-grill-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

describe('ux-grill manifest guards', () => {
  // Bug: a manifest pointing at a non-loopback host lets the mechanical run
  // drive a REMOTE app — seeds and journeys would write to production.
  it('rejects a non-loopback base-url with code base-url-not-loopback', () => {
    const { frontmatter } = parseManifest('---\nbase-url: https://example.com\nbuild: dev\n---\n');
    let error;
    try {
      assertLoopbackBaseUrl(frontmatter);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ManifestError);
    expect(error.code).toBe('base-url-not-loopback');
    expect(error.message).toBe('base-url must be loopback');
  });

  // Bug: the guarded-env error printing the VALUE leaks a live production
  // endpoint into the run record / CI log the operator pastes around.
  it('names a non-loopback guarded env without leaking its value', () => {
    const { frontmatter } = parseManifest(
      '---\nbase-url: http://127.0.0.1:3100\nbuild: dev\nguarded-url-envs:\n  - APP_API_BASE_URL\n---\n',
    );
    const envMap = new Map([['APP_API_BASE_URL', 'https://example.com']]);
    let error;
    try {
      assertGuardedEnvsLoopback(frontmatter, envMap);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ManifestError);
    expect(error.code).toBe('guarded-env-not-loopback');
    expect(error.message).toBe('guarded env APP_API_BASE_URL must be loopback');
    expect(error.message).not.toContain('example.com');
    expect(String(error)).not.toContain('example.com');
  });

  // Bug: a bootstrap manifest the parser rejects fails only on the NEXT run,
  // far from its cause — and the persona count must follow the login answer.
  it('round-trips a bootstrap manifest and keeps personas tied to the login env names', () => {
    const text = buildBootstrapManifest({
      baseUrl: 'http://127.0.0.1:3100',
      envFile: '.env.e2e.local',
      loginEnvEmail: 'LOGIN_EMAIL_X',
      loginEnvPassword: 'LOGIN_PASSWORD_X',
      personaName: 'operator',
      routes: [
        { path: '/dashboard', title: 'Dashboard (beta)' },
        { path: '/documents', title: 'Documents' },
      ],
    });
    const { frontmatter } = parseManifest(text);
    expect(frontmatter.personas).toHaveLength(1);
    expect(frontmatter.personas[0]['login-env-email']).toBe('LOGIN_EMAIL_X');
    expect(frontmatter.journeys).toEqual([]);
    expect(frontmatter.routes.map((r) => r.path)).toEqual(['/dashboard', '/documents']);
    // A literal title must be escaped, not used as a live regex.
    expect(new RegExp(frontmatter.routes[0]['title-pattern']).test('Dashboard (beta)')).toBe(true);

    const noLogin = parseManifest(buildBootstrapManifest({
      baseUrl: 'http://127.0.0.1:3100',
      routes: [{ path: '/', title: 'Home' }],
    }));
    expect(noLogin.frontmatter.personas).toEqual([]);
  });

  // Bug: splitting an env line on EVERY `=` truncates any value containing one
  // (URLs with query strings, base64 padding) — silently wrong credentials.
  it('reads an env file by first-= split, tolerating export, quotes and comments', () => {
    const dir = makeTmpDir();
    const file = path.join(dir, '.env.e2e.local');
    fs.writeFileSync(file, ['# comment', '', 'A=b=c', 'export B="x"', "C='y'", 'D=  '].join('\n'), 'utf8');

    const map = readEnvFile(file);
    expect(map.get('A')).toBe('b=c');
    expect(map.get('B')).toBe('x');
    expect(map.get('C')).toBe('y');
    expect(map.get('D')).toBe('');
    expect(map.size).toBe(4);
  });
});

describe('ux-grill manifest env-map type discipline', () => {
  // Bug: `loadManifest` indexing the env file as a plain object (or returning
  // one) regresses the F3 fix silently — `assertGuardedEnvsLoopback` would then
  // see a non-Map and either throw a TypeError mid-run or (worse, the old
  // behaviour) fall back to an empty Map and report every guarded env as unset.
  it('loadManifest passes a loopback guarded env and returns envMap as a Map', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, '.orchestrator'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.env.e2e.local'),
      'APP_API_BASE_URL=http://127.0.0.1:54321\nLOGIN_PASSWORD_X=hunter2-supersecret\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(dir, '.orchestrator/ux-manifest.md'),
      [
        '---',
        'base-url: http://127.0.0.1:3100',
        'build: dev',
        'env-file: .env.e2e.local',
        'guarded-url-envs:',
        '  - APP_API_BASE_URL',
        '---',
        '',
        'notes',
        '',
      ].join('\n'),
      'utf8',
    );

    const loaded = loadManifest({ repoRoot: dir });
    expect(loaded.envMap).toBeInstanceOf(Map);
    expect(loaded.envMap.get('APP_API_BASE_URL')).toBe('http://127.0.0.1:54321');
    expect(loaded.frontmatter.build).toBe('dev');
    expect(loaded.frontmatter.viewports.map((v) => v.name)).toEqual(['desktop', 'mobile']);
    expect(loaded.manifestHash).toHaveLength(64);
    expect(loaded.path).toBe(path.resolve(dir, '.orchestrator/ux-manifest.md'));
  });

  // Bug: restoring the deleted `envMap instanceof Map ? envMap : new Map()`
  // fallback turns a programmer type error into a plausible-looking manifest
  // error — "guarded env X is not set" for an env the operator DID set.
  it.each([
    ['assertGuardedEnvsLoopback', (envMap) => assertGuardedEnvsLoopback({ 'guarded-url-envs': ['API'] }, envMap)],
    ['resolvePersonaCredentials', (envMap) => resolvePersonaCredentials(
      { name: 'p', 'login-env-email': 'E', 'login-env-password': 'P' },
      envMap,
    )],
  ])('%s throws TypeError when envMap is a plain object', (_name, call) => {
    let error;
    try {
      call({ API: 'http://127.0.0.1:3100', E: 'a@b.c', P: 'pw' });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(ManifestError);
    expect(error.message).toContain('envMap must be a Map');
  });

  // Bug: the error naming the missing EMAIL env must not carry the PASSWORD
  // value that sits in the same map — PRD § 3 AC 4 (env NAMES only, never
  // values, in any message that can reach a run record or issue body).
  it('resolvePersonaCredentials names the missing email env and leaks no password value', () => {
    const envMap = new Map([['LOGIN_PASSWORD_X', 'hunter2-supersecret']]);
    let error;
    try {
      resolvePersonaCredentials(
        { name: 'epu', 'login-env-email': 'LOGIN_EMAIL_X', 'login-env-password': 'LOGIN_PASSWORD_X' },
        envMap,
      );
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ManifestError);
    expect(error.code).toBe('persona-env-missing');
    expect(error.message).toBe('env LOGIN_EMAIL_X is not set');
    expect(String(error.stack)).not.toContain('hunter2-supersecret');
  });
});

describe('ux-grill isLoopbackUrl', () => {
  // Bug: the deleted collect.mjs copy of this predicate accepted `*.localhost`
  // and `0.0.0.0`, so a suffix/subdomain attacker host passed the guard that
  // exists to keep the mechanical run off production.
  it.each([
    ['http://127.0.0.1.evil.com/', false],
    ['http://evil.localhost:3000/', false],
    ['http://localhost@evil.com/', false],
    ['file:///etc/passwd', false],
    // Bug (LOW-4): a non-special scheme parses, its hostname IS loopback, and
    // its URL.origin is the literal string 'null' — so resolveWithinOrigin
    // compared 'null' === 'null' and EVERY absolute off-origin location passed
    // the same-origin gate. Both spellings below were accepted before the
    // protocol allowlist.
    ['foo://localhost/', false],
    ['ws://localhost:3100/', false],
    ['http://0.0.0.0:3000/', false],
    ['not a url', false],
    ['', false],
    ['http://[::1]:3000', true],
    ['http://LOCALHOST:3000/', true],
    ['http://127.1:3000', true],
    ['http://127.0.0.1:3100/dashboard', true],
  ])('classifies %s as loopback=%s', (url, expected) => {
    expect(isLoopbackUrl(url)).toBe(expected);
  });
});

describe('ux-grill env-file containment', () => {
  // Bug (MED-3): `path.resolve(repoRoot, envFile)` walks out of the repo, so a
  // manifest saying `env-file: ../../../.config/session-orchestrator/secrets.env`
  // turns any host KEY=VALUE file into a credential source for a persona — and
  // every error path here is secret-free, so nothing would surface. Measured
  // before the fix: loadManifest() returned an envMap carrying the outside
  // file's values.
  it('refuses an env-file that resolves outside the target repo', () => {
    const repo = makeTmpDir();
    const outside = makeTmpDir();
    fs.writeFileSync(path.join(outside, 'secrets.env'), 'STOLEN=topsecret\n');
    fs.mkdirSync(path.join(repo, '.orchestrator'), { recursive: true });
    const relative = path.relative(repo, path.join(outside, 'secrets.env'));
    fs.writeFileSync(
      path.join(repo, '.orchestrator/ux-manifest.md'),
      `---\nbase-url: http://127.0.0.1:3100\nbuild: dev\nenv-file: ${relative}\n---\n\nbody\n`,
    );

    let error;
    try {
      loadManifest({ repoRoot: repo });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ManifestError);
    expect(error.code).toBe('env-file-outside-repo');
    // The message must name no path — a traversal string is operator-supplied
    // text that can itself carry a host path.
    expect(error.message).not.toContain(outside);
  });

  it('still reads an env-file inside the repo', () => {
    const repo = makeTmpDir();
    fs.mkdirSync(path.join(repo, '.orchestrator'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.env.e2e.local'), 'APP_API_BASE_URL=http://127.0.0.1:3100\n');
    fs.writeFileSync(
      path.join(repo, '.orchestrator/ux-manifest.md'),
      '---\nbase-url: http://127.0.0.1:3100\nbuild: dev\nenv-file: .env.e2e.local\n'
        + 'guarded-url-envs:\n  - APP_API_BASE_URL\n---\n\nbody\n',
    );

    const loaded = loadManifest({ repoRoot: repo });
    expect(loaded.envMap.get('APP_API_BASE_URL')).toBe('http://127.0.0.1:3100');
  });
});

describe('ux-grill bootstrap writer', () => {
  // Bug (MED-2): the run writes screenshots under
  // `.orchestrator/metrics/ux-grill/<runId>/`, one taken after EVERY journey
  // step — including the step right after `fill #pw ${LOGIN_PASSWORD}`. No
  // existing rule in a target repo ignores that path, and the PRD's
  // secret-leak acceptance test is a grep, which cannot see a PNG.
  it('creates a .gitignore carrying the run-artefact directory', () => {
    const dir = makeTmpDir();
    const text = buildBootstrapManifest({ baseUrl: 'http://127.0.0.1:3100' });

    const written = writeBootstrapManifest({ repoRoot: dir, text });
    expect(written.gitignore.action).toBe('created');
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'))
      .toContain('.orchestrator/metrics/ux-grill/');
  });

  // Bug: a writer that REWRITES an operator-owned .gitignore silently drops
  // their rules; one that appends unconditionally duplicates the line on every
  // bootstrap.
  it('appends to an existing .gitignore without rewriting it, and is idempotent', () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.env\n');
    const text = buildBootstrapManifest({ baseUrl: 'http://127.0.0.1:3100' });

    const first = writeBootstrapManifest({ repoRoot: dir, text });
    expect(first.gitignore.action).toBe('appended');
    const after = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    expect(after.startsWith('node_modules/\n.env\n')).toBe(true);
    expect(after).toContain('.orchestrator/metrics/ux-grill/');

    // A second bootstrap into the same repo (manifest moved aside) must not
    // append the line twice.
    fs.rmSync(first.path);
    const second = writeBootstrapManifest({ repoRoot: dir, text });
    expect(second.gitignore.action).toBe('present');
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe(after);
  });

  // Bug: overwriting an existing manifest destroys hand-written journeys and
  // personas a crawl cannot reconstruct — the one artifact /ux-grill exists to
  // accumulate. And a writer that does not mkdir the parent fails on exactly
  // the repo that has no .orchestrator/ yet, i.e. every first run.
  it('creates the parent directory and then refuses to overwrite', () => {
    const dir = makeTmpDir();
    const text = buildBootstrapManifest({
      baseUrl: 'http://127.0.0.1:3100',
      routes: [{ path: '/', title: 'Home' }],
    });

    expect(fs.existsSync(path.join(dir, '.orchestrator'))).toBe(false);
    const written = writeBootstrapManifest({ repoRoot: dir, text });
    expect(written.path).toBe(path.resolve(dir, '.orchestrator/ux-manifest.md'));
    expect(fs.readFileSync(written.path, 'utf8')).toBe(text);
    expect(written.manifestHash).toBe(manifestHash(text));

    let error;
    try {
      writeBootstrapManifest({ repoRoot: dir, text });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ManifestError);
    expect(error.code).toBe('manifest-exists');
    // The refusal must not have truncated the file it refused to replace.
    expect(fs.readFileSync(written.path, 'utf8')).toBe(text);
  });

  // Bug: a hash computed over the PARSED object (not the raw text) is blind to
  // a body/notes edit, so compare.mjs would call two runs comparable across a
  // manifest change and report bogus `fixed` findings.
  it('manifestHash is stable per text and changes on a one-byte edit', () => {
    const text = '---\nbase-url: http://127.0.0.1:3100\nbuild: dev\n---\n\nnotes\n';
    const mutated = text.replace('notes', 'notez');

    expect(manifestHash(text)).toBe(manifestHash(text));
    expect(manifestHash(text)).not.toBe(manifestHash(mutated));
    expect(manifestHash(text)).toMatch(/^[0-9a-f]{64}$/);
  });
});

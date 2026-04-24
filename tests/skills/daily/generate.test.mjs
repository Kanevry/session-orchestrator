/**
 * tests/skills/daily/generate.test.mjs
 *
 * Vitest port of skills/daily/tests/daily.bats
 * Subject: skills/daily/generate.sh
 *
 * 8 bats @test blocks + bonus validator check:
 *   1. Creates today's file in empty vault
 *   2. File contains id: daily-YYYY-MM-DD
 *   3. H1 line contains German weekday (Montag..Sonntag)
 *   4. No {{ placeholders remain
 *   5. Second run idempotent (hash match + "already exists" message)
 *   6. Missing 03-daily/ → exit 4
 *   7. Missing VAULT_DIR → exit 3
 *   8. Corrupt/empty file → re-created (0-byte AND no-frontmatter cases)
 *   bonus: generated file passes validator.mjs --mode hard
 *
 * Approach: spawn `bash skills/daily/generate.sh` in a temp vault.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const GENERATE_SH = join(REPO_ROOT, 'skills/daily/generate.sh');
const VALIDATOR_MJS = join(REPO_ROOT, 'skills/vault-sync/validator.mjs');

// Today's date in YYYY-MM-DD format (matches what generate.sh produces)
function today() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function runGenerate(vaultDir) {
  return spawnSync('bash', [GENERATE_SH], {
    encoding: 'utf8',
    env: { ...process.env, VAULT_DIR: vaultDir },
  });
}

describe('skills/daily/generate.sh', () => {
  let tmpVault;

  beforeEach(() => {
    tmpVault = mkdtempSync(join(tmpdir(), 'daily-test-'));
  });

  afterEach(() => {
    try {
      rmSync(tmpVault, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  it('creates today\'s file in an empty vault with 03-daily/', () => {
    mkdirSync(join(tmpVault, '03-daily'), { recursive: true });

    const result = runGenerate(tmpVault);

    expect(result.status).toBe(0);
    expect(existsSync(join(tmpVault, '03-daily', `${today()}.md`))).toBe(true);
  });

  it('created file contains substituted date id', () => {
    mkdirSync(join(tmpVault, '03-daily'), { recursive: true });

    runGenerate(tmpVault);

    const content = readFileSync(join(tmpVault, '03-daily', `${today()}.md`), 'utf8');
    expect(content).toContain(`id: daily-${today()}`);
  });

  it('created file contains a German weekday in the H1 line', () => {
    mkdirSync(join(tmpVault, '03-daily'), { recursive: true });

    runGenerate(tmpVault);

    const content = readFileSync(join(tmpVault, '03-daily', `${today()}.md`), 'utf8');
    expect(content).toMatch(/\((Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag)\)/);
  });

  it('created file has no unreplaced {{ }} placeholders', () => {
    mkdirSync(join(tmpVault, '03-daily'), { recursive: true });

    runGenerate(tmpVault);

    const content = readFileSync(join(tmpVault, '03-daily', `${today()}.md`), 'utf8');
    expect(content).not.toContain('{{');
  });

  it('second run is idempotent: exits 0 and reports "already exists"', () => {
    mkdirSync(join(tmpVault, '03-daily'), { recursive: true });

    // First run
    runGenerate(tmpVault);

    // Second run
    const result = runGenerate(tmpVault);
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toContain('already exists');
  });

  it('second run is idempotent: file hash is unchanged', () => {
    mkdirSync(join(tmpVault, '03-daily'), { recursive: true });

    runGenerate(tmpVault);
    const filePath = join(tmpVault, '03-daily', `${today()}.md`);
    const contentBefore = readFileSync(filePath, 'utf8');

    runGenerate(tmpVault);
    const contentAfter = readFileSync(filePath, 'utf8');

    expect(contentAfter).toBe(contentBefore);
  });

  it('missing 03-daily/ directory: exits 4', () => {
    // tmpVault exists but has no 03-daily subdir

    const result = runGenerate(tmpVault);

    expect(result.status).toBe(4);
  });

  it('missing 03-daily/ directory: output mentions "03-daily"', () => {
    const result = runGenerate(tmpVault);

    expect(result.stdout + result.stderr).toContain('03-daily');
  });

  it('missing VAULT_DIR (non-existent path): exits 3', () => {
    const result = spawnSync('bash', [GENERATE_SH], {
      encoding: 'utf8',
      env: { ...process.env, VAULT_DIR: '/nonexistent/path/does/not/exist-xyz' },
    });

    expect(result.status).toBe(3);
  });

  it('corrupt file (0 bytes) is re-created on next run', () => {
    mkdirSync(join(tmpVault, '03-daily'), { recursive: true });
    const filePath = join(tmpVault, '03-daily', `${today()}.md`);

    // Create empty target file
    writeFileSync(filePath, '', 'utf8');
    expect(readFileSync(filePath, 'utf8')).toBe('');

    const result = runGenerate(tmpVault);
    expect(result.status).toBe(0);

    const content = readFileSync(filePath, 'utf8');
    expect(content.length).toBeGreaterThan(0);
    expect(content.startsWith('---')).toBe(true);
  });

  it('corrupt file (no frontmatter) is re-created on next run', () => {
    mkdirSync(join(tmpVault, '03-daily'), { recursive: true });
    const filePath = join(tmpVault, '03-daily', `${today()}.md`);

    // Write garbage content with no YAML frontmatter
    writeFileSync(filePath, 'not-yaml\nsome garbage content\n', 'utf8');

    const result = runGenerate(tmpVault);
    expect(result.status).toBe(0);

    const content = readFileSync(filePath, 'utf8');
    expect(content.startsWith('---')).toBe(true);
    expect(content).toContain(`id: daily-${today()}`);
  });

  it('generated file validates against vault-sync validator.mjs in hard mode', () => {
    mkdirSync(join(tmpVault, '03-daily'), { recursive: true });

    runGenerate(tmpVault);

    // Run from the vault-sync skill directory so its node_modules (zod, yaml) are resolved
    const result = spawnSync('node', [VALIDATOR_MJS], {
      encoding: 'utf8',
      cwd: join(REPO_ROOT, 'skills/vault-sync'),
      env: { ...process.env, VAULT_DIR: tmpVault },
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe('ok');
    expect(parsed.errors).toHaveLength(0);
  });
});

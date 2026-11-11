#!/usr/bin/env node
// Cross-platform typecheck: iterate .mjs files ourselves so Windows doesn't
// need shell glob expansion. `node --check` per file, then `tsc --noEmit` over the
// so-hud hook logic (#1909); exit non-zero if either part fails.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from './lib/native-command.mjs';

const ROOTS = ['scripts/lib', 'hooks'];

let checked = 0;
let failed = 0;

function walkMjs(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walkMjs(path);
      continue;
    }
    if (!name.endsWith('.mjs') || !stat.isFile()) continue;
    const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
    checked += 1;
    if (result.status !== 0) failed += 1;
  }
}

for (const root of ROOTS) {
  walkMjs(join(fileURLToPath(new URL('..', import.meta.url)), root)); // repo root, never the cwd
}

let anyFailed = false;
if (failed > 0) {
  console.error(`typecheck: ${failed}/${checked} file(s) failed`);
  anyFailed = true;
} else {
  console.log(`typecheck: ${checked} file(s) OK`);
}

// so-hud: tsc over hooks/*.ts only (tsconfig.check.json). register.tsx and the
// tests import engine-generated `.claude-plugin/types`, absent in a checkout.
// typescript is a transitive dev peer, not a direct devDependency; a missing
// compiler is a FAILURE, never a skip, because a skip reads exactly like a pass.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const tscBin = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const soHudHooks = join(repoRoot, 'mods', 'so-hud', 'hooks');
const soHudFiles = readdirSync(soHudHooks).filter((name) => name.endsWith('.ts')).length;
if (!existsSync(tscBin)) {
  console.error('typecheck: so-hud type check needs typescript (node_modules/typescript) — run npm ci');
  console.error('typecheck: so-hud tsc failed (compiler missing)');
  anyFailed = true;
} else {
  const tsc = spawnSync(
    process.execPath,
    [tscBin, '--noEmit', '--pretty', 'false', '-p', join('mods', 'so-hud', 'tsconfig.check.json')],
    { stdio: 'inherit', cwd: repoRoot },
  );
  if (tsc.status === 0) {
    console.log(`typecheck: so-hud tsc OK (${soHudFiles} file(s))`);
  } else {
    console.error(`typecheck: so-hud tsc failed (${soHudFiles} file(s), exit ${tsc.status ?? tsc.signal ?? 'unknown'})`);
    anyFailed = true;
  }
}

if (anyFailed) process.exit(1);

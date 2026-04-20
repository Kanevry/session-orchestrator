#!/usr/bin/env node
// Cross-platform typecheck: iterate .mjs files ourselves so Windows doesn't
// need shell glob expansion. `node --check` per file; exit non-zero on any failure.
import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOTS = ['scripts/lib', 'hooks'];

let checked = 0;
let failed = 0;

for (const root of ROOTS) {
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    continue;
  }
  for (const name of entries) {
    if (!name.endsWith('.mjs')) continue;
    const path = join(root, name);
    if (!statSync(path).isFile()) continue;
    const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
    checked += 1;
    if (result.status !== 0) failed += 1;
  }
}

if (failed > 0) {
  console.error(`typecheck: ${failed}/${checked} file(s) failed`);
  process.exit(1);
}
console.log(`typecheck: ${checked} file(s) OK`);

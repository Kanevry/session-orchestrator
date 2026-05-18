#!/usr/bin/env node
// Cross-platform typecheck: iterate .mjs files ourselves so Windows doesn't
// need shell glob expansion. `node --check` per file; exit non-zero on any failure.
import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

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
  walkMjs(root);
}

if (failed > 0) {
  console.error(`typecheck: ${failed}/${checked} file(s) failed`);
  process.exit(1);
}
console.log(`typecheck: ${checked} file(s) OK`);

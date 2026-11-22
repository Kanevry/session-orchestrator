#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { isMainModule } from './lib/is-main-module.mjs';
import { spawnSync } from './lib/native-command.mjs';

const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function validVersion(version) {
  const match = VERSION.exec(version);
  return match !== null && !match[4]?.split('.').some(id => /^0\d+$/.test(id));
}

// Node's timers accept at most a signed 32-bit delay in milliseconds.
function validSeconds(value) {
  return /^[1-9]\d*$/.test(value) && Number(value) * 1000 <= 2_147_483_647;
}

export async function waitForNpmVersion(
  { packageName, version, timeoutS = 600, intervalS = 15 },
  { spawnSyncImpl = spawnSync, nowImpl = () => Math.floor(performance.now()), sleepImpl = sleep } = {},
) {
  if (typeof packageName !== 'string' || !PACKAGE.test(packageName)) {
    return { exitCode: 2, message: 'Expected --package to name an npm package.' };
  }
  if (typeof version !== 'string' || !validVersion(version)) {
    return { exitCode: 2, message: 'Expected --version X.Y.Z with an optional SemVer prerelease.' };
  }
  if (!validSeconds(timeoutS) || !validSeconds(intervalS)) {
    return { exitCode: 2, message: 'Expected positive whole seconds within the Node timer range for --timeout-s and --interval-s.' };
  }

  const target = `${packageName}@${version}`;
  const deadline = nowImpl() + Number(timeoutS) * 1000;
  let remaining = deadline - nowImpl();
  let lastMessage = 'no registry response';
  while (remaining > 0) {
    const result = spawnSyncImpl('npm', ['view', target, 'version', '--registry=https://registry.npmjs.org'], {
      encoding: 'utf8', shell: false, timeout: remaining, killSignal: 'SIGKILL',
    });
    remaining = deadline - nowImpl();
    const output = result.stdout?.trim();
    if (remaining > 0 && !result.error && result.status === 0 && output === version) {
      return { exitCode: 0, message: `${target} is visible on npm.` };
    }
    lastMessage = result.stderr?.trim() || result.error?.message || output || 'npm view returned empty output';
    if (Number.isInteger(result.status) && result.status !== 0) {
      lastMessage = `exit ${result.status}: ${lastMessage}`;
    }
    if (remaining <= 0) break;
    await sleepImpl(Math.min(Number(intervalS) * 1000, remaining));
    remaining = deadline - nowImpl();
  }
  return { exitCode: 1, message: `Timed out after ${timeoutS}s waiting for ${target}. Last npm view result: ${lastMessage.slice(0, 300)}` };
}

export async function main(argv, deps) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: {
      package: { type: 'string' }, version: { type: 'string' },
      'timeout-s': { type: 'string' }, 'interval-s': { type: 'string' },
    } }));
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  const result = await waitForNpmVersion({
    packageName: values.package, version: values.version,
    timeoutS: values['timeout-s'], intervalS: values['interval-s'],
  }, deps);
  if (result.exitCode === 0) console.log(result.message);
  else console.error(result.message);
  return result.exitCode;
}

if (isMainModule(import.meta.url)) process.exitCode = await main(process.argv.slice(2));

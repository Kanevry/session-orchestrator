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

const REGISTRY = 'https://registry.npmjs.org';

// Reads `version` and `dist.tarball` from `npm view --json`. Returns null when
// the output is not one object for exactly the requested version.
function parseView(stdout, version) {
  try {
    const view = JSON.parse(stdout);
    if (view !== null && typeof view === 'object' && !Array.isArray(view) && view.version === version) {
      return { tarball: view['dist.tarball'] };
    }
  } catch { /* not JSON: reported as the raw output below */ }
  return null;
}

// Only a tarball on the pinned registry is ever requested.
function registryTarball(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.origin === REGISTRY && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Waits until `packageName@version` is visible on registry.npmjs.org AND its
 * tarball (`dist.tarball` from the registry) answers a HEAD request with 200.
 * The registry can serve the version metadata before the tarball is
 * downloadable (#2212: the tarball still answered 404 6.5 minutes after the
 * publish), so metadata alone does not mean the version is installable. Both
 * checks share one deadline of `timeoutS`.
 * Exit codes: 0 success, 1 timeout or refused tarball URL, 2 invalid arguments.
 */
export async function waitForNpmVersion(
  { packageName, version, timeoutS = 600, intervalS = 15 },
  {
    spawnSyncImpl = spawnSync, nowImpl = () => Math.floor(performance.now()), sleepImpl = sleep,
    fetchImpl = globalThis.fetch,
  } = {},
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
  let tarball = null;
  let lastTarballStatus = 'no response';
  while (remaining > 0) {
    if (tarball === null) {
      const result = spawnSyncImpl('npm', ['view', target, 'version', 'dist.tarball', '--json', `--registry=${REGISTRY}`], {
        encoding: 'utf8', shell: false, timeout: remaining, killSignal: 'SIGKILL',
      });
      remaining = deadline - nowImpl();
      const output = result.stdout?.trim();
      const view = !result.error && result.status === 0 && output ? parseView(output, version) : null;
      if (remaining > 0 && view !== null) {
        tarball = registryTarball(view.tarball);
        if (tarball === null) {
          return { exitCode: 1, message: `Refusing the tarball URL of ${target}: expected ${REGISTRY}/..., got ${String(view.tarball).slice(0, 200)}` };
        }
      } else {
        lastMessage = result.stderr?.trim() || result.error?.message || output || 'npm view returned empty output';
        if (Number.isInteger(result.status) && result.status !== 0) {
          lastMessage = `exit ${result.status}: ${lastMessage}`;
        }
      }
    }
    if (tarball !== null && remaining > 0) {
      try {
        // HEAD: registry.npmjs.org answers 200 for a downloadable tarball and
        // 404 for a missing one (measured 2026-11-22), without sending the body.
        const response = await fetchImpl(tarball, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(remaining) });
        lastTarballStatus = `HTTP ${response.status}`;
        remaining = deadline - nowImpl();
        if (remaining > 0 && response.status === 200) {
          return { exitCode: 0, message: `${target} is visible on npm and its tarball is downloadable.` };
        }
      } catch (error) {
        // A network error means "not yet", never a final answer.
        lastTarballStatus = `request failed: ${error?.message ?? error}`;
        remaining = deadline - nowImpl();
      }
    }
    if (remaining <= 0) break;
    await sleepImpl(Math.min(Number(intervalS) * 1000, remaining));
    remaining = deadline - nowImpl();
  }
  if (tarball !== null) {
    return {
      exitCode: 1,
      message: `Timed out after ${timeoutS}s: ${target} is visible on npm, but its tarball is not yet downloadable. Last tarball response: ${lastTarballStatus.slice(0, 200)} (${tarball})`,
    };
  }
  return { exitCode: 1, message: `Timed out after ${timeoutS}s: ${target} is not visible on npm. Last npm view result: ${lastMessage.slice(0, 300)}` };
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

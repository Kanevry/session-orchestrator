import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { inspectGuardRequiresParity } from '../../../scripts/lib/validate/check-guard-requires-parity.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '../../..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/lib/validate/check-guard-requires-parity.mjs');
const fixtureRoots = [];

function makeHook({ requires, uses = requires, dynamic = false, indirect = false, shadowed = false }) {
  const memberUses = uses.map((name) => `  blocker.${name}();`).join('\n');
  const shape = dynamic
    ? `  const specs = { blocker: { specifier: lib('fixture.mjs'), headFallback: true, requires: ['foo'] } };\n  const { modules } = await armGuard(specs);`
    : `  const { modules } = await armGuard({\n    blocker: {\n      specifier: lib('fixture.mjs'),\n      headFallback: true,\n      requires: [${requires.map((name) => `'${name}'`).join(', ')}],\n    },\n  });`;
  const binding = indirect ? '  const alias = blocker;\n  alias.foo();' : memberUses;
  const shadow = shadowed ? '\nfunction invoke(blocker) { return blocker.foo(); }\n' : '';
  return `
import { armGuard } from './_lib/guard-source-loader.mjs';
const lib = (...segments) => segments.join('/');
let blocker;
async function bootstrap() {
${shape}
  blocker = modules.blocker;
${binding}
}
${shadow}`;
}

function makeFixture({ workingSource, headSource = workingSource, hook }) {
  const root = mkdtempSync(join(tmpdir(), 'guard-requires-parity-'));
  fixtureRoots.push(root);
  mkdirSync(join(root, 'hooks'), { recursive: true });
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  writeFileSync(join(root, 'hooks', 'fixture-hook.mjs'), hook);
  writeFileSync(join(root, 'scripts', 'lib', 'fixture.mjs'), headSource);

  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: root });
  if (workingSource !== headSource) {
    writeFileSync(join(root, 'scripts', 'lib', 'fixture.mjs'), workingSource);
  }
  return root;
}

function withEnv(name, value, callback) {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return callback();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

beforeAll(() => {
  const baseline = inspectGuardRequiresParity(REPO_ROOT);
  expect(baseline.ok).toBe(true);
  expect(baseline.summary.contracts).toBeGreaterThanOrEqual(3);
  expect(baseline.summary.requires).toBeGreaterThanOrEqual(12);
});

afterEach(() => {
  while (fixtureRoots.length > 0) rmSync(fixtureRoots.pop(), { recursive: true, force: true });
});

describe('check-guard-requires-parity.mjs — current repository', () => {
  it('passes all headFallback contracts and reports the measured contract summary', () => {
    const result = inspectGuardRequiresParity(REPO_ROOT);
    expect(result.ok).toBe(true);
    expect(result.summary.contracts).toBeGreaterThanOrEqual(3);
    expect(result.summary.requires).toBeGreaterThanOrEqual(12);
    expect(result.contracts.length).toBeGreaterThan(0);
    expect(result.contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        namespace: expect.any(String),
        binding: expect.any(String),
        specifier: expect.stringContaining('scripts/lib/'),
        requires: expect.any(Array),
        uses: expect.any(Array),
      }),
    ]));
  });

  it('reports the canonical CLI pass result with exit 0', () => {
    const run = spawnSync('node', [SCRIPT, REPO_ROOT], { encoding: 'utf8', timeout: 15_000 });
    expect({ status: run.status, output: run.stdout }).toEqual({
      status: 0,
      output: expect.stringContaining('Results: 1 passed, 0 failed'),
    });
  });
});

describe('check-guard-requires-parity.mjs — contract and version failures', () => {
  it.each([
    {
      name: 'requires an omitted direct namespace member',
      requires: ['foo'],
      uses: ['foo', 'bar'],
      source: 'export function foo() {}\nexport function bar() {}\n',
      kinds: ['use-missing-require'],
    },
    {
      name: 'requires every declared export to be directly used',
      requires: ['foo', 'bar'],
      uses: ['foo'],
      source: 'export function foo() {}\nexport function bar() {}\n',
      kinds: ['requires-missing-use'],
    },
    {
      name: 'rejects a duplicate requires entry',
      requires: ['foo', 'foo'],
      uses: ['foo'],
      source: 'export function foo() {}\n',
      kinds: ['dynamic-contract'],
    },
    {
      name: 'rejects a required non-function export',
      requires: ['WRAPPER_UNWRAP'],
      uses: ['WRAPPER_UNWRAP'],
      source: 'export const WRAPPER_UNWRAP = new Map();\n',
      kinds: ['required-export-non-function'],
    },
  ])('$name', ({ requires, uses, source, kinds }) => {
    const root = makeFixture({
      workingSource: source,
      hook: makeHook({ requires, uses }),
    });
    const result = inspectGuardRequiresParity(root);
    expect({ ok: result.ok, kinds: [...new Set(result.findings.map(({ kind }) => kind))] }).toEqual({
      ok: false,
      kinds,
    });
  });

  it('rejects exports that exist only in one of the two module versions', () => {
    const root = makeFixture({
      headSource: 'export function headOnly() {}\n',
      workingSource: 'export function workingOnly() {}\n',
      hook: makeHook({ requires: ['headOnly', 'workingOnly'], uses: ['headOnly', 'workingOnly'] }),
    });
    const result = inspectGuardRequiresParity(root);
    expect(result.findings.filter(({ kind }) => kind === 'required-export-missing')).toHaveLength(2);
    expect(result.findings.map(({ message }) => message)).toEqual([
      expect.stringContaining('headOnly is absent from the working-tree module'),
      expect.stringContaining('workingOnly is absent from HEAD module'),
    ]);
  });

  it('resolves a local export alias and accepts direct namespace use', () => {
    const root = makeFixture({
      workingSource: 'function splitSegments() {}\nexport { splitSegments as splitChainSegments };\n',
      hook: makeHook({ requires: ['splitChainSegments'], uses: ['splitChainSegments'] }),
    });
    const result = inspectGuardRequiresParity(root);
    expect({ ok: result.ok, findings: result.findings }).toEqual({ ok: true, findings: [] });
  });

  it('fails closed for an indirect namespace binding and a computed member use', () => {
    const root = makeFixture({
      workingSource: 'export function foo() {}\n',
      hook: `${makeHook({ requires: ['foo'], uses: ['foo'], indirect: true }).replace('alias.foo();', 'blocker[name]();')}\n`,
    });
    const result = inspectGuardRequiresParity(root);
    expect(new Set(result.findings.map(({ kind }) => kind))).toEqual(new Set(['dynamic-contract', 'indirect-contract', 'requires-missing-use']));
  });

  it('fails closed when a nested parameter shadows the namespace alias', () => {
    const root = makeFixture({
      workingSource: 'export function foo() {}\n',
      hook: makeHook({ requires: ['foo'], uses: ['foo'], shadowed: true }),
    });
    const result = inspectGuardRequiresParity(root);
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'shadowed-binding',
        message: expect.stringContaining('nested binding shadows the namespace alias'),
      }),
    ]));
  });

  it('returns a contract violation and exit 1 for a dynamic armGuard shape', () => {
    const root = makeFixture({
      workingSource: 'export function foo() {}\n',
      hook: makeHook({ requires: ['foo'], dynamic: true }),
    });
    const run = spawnSync('node', [SCRIPT, root], { encoding: 'utf8', timeout: 15_000 });
    expect({ status: run.status, output: run.stdout }).toEqual({
      status: 1,
      output: expect.stringContaining('armGuard contract must be an inline object literal'),
    });
  });

  it.each([
    {
      name: 'an aliased named import',
      hook: makeHook({ requires: ['foo'] })
        .replace(
          "import { armGuard } from './_lib/guard-source-loader.mjs';",
          "const { armGuard: runArmGuard } = await import('./_lib/guard-source-loader.mjs');",
        )
        .replaceAll('armGuard({', 'runArmGuard({'),
    },
    {
      name: 'a local armGuard shadow',
      hook: makeHook({ requires: ['foo'] }).replace(
        'async function bootstrap() {',
        'async function bootstrap() {\n  const armGuard = async () => ({ modules: {} });',
      ),
    },
    {
      name: 'a member call',
      hook: makeHook({ requires: ['foo'] })
        .replace(
          "import { armGuard } from './_lib/guard-source-loader.mjs';",
          "import { armGuard } from './_lib/guard-source-loader.mjs';\nconst loader = { armGuard };",
        )
        .replace('armGuard({', 'loader.armGuard({'),
    },
    {
      name: 'an indirect armGuard alias call',
      hook: makeHook({ requires: ['foo'] })
        .replace('let blocker;', 'let blocker;\nconst invoke = armGuard;')
        .replace('armGuard({', 'invoke({'),
    },
    {
      name: 'an unused loader import whose zero direct calls would pass as ok:true',
      hook: makeHook({ requires: ['foo'] }).replace('armGuard({', 'notArmGuard({'),
    },
    {
      name: 'a Reflect.apply first-class armGuard reference omitted by call-only scanning',
      hook: `${makeHook({ requires: ['foo'] })}\nReflect.apply(armGuard, null, []);\n`,
    },
    {
      name: 'an optional armGuard call omitted by CallExpression-only scanning',
      hook: `${makeHook({ requires: ['foo'] })}\narmGuard?.({});\n`,
    },
    {
      name: 'a computed dynamic armGuard reference omitted by callee-only scanning',
      hook: `${makeHook({ requires: ['foo'] })}\nconst invoke = globalThis[armGuard];\ninvoke({});\n`,
    },
    {
      name: 'a nested class declaration shadowing armGuard accepted as the loader call',
      hook: makeHook({ requires: ['foo'] }).replace(
        'async function bootstrap() {',
        'async function bootstrap() {\n  class armGuard {}',
      ),
    },
    {
      name: 'a nested named class expression shadowing armGuard accepted as the loader call',
      hook: makeHook({ requires: ['foo'] }).replace(
        'async function bootstrap() {',
        'async function bootstrap() {\n  const shadow = class armGuard {};',
      ),
    },
  ])('rejects $name rather than dropping it from the contract census', ({ hook }) => {
    const root = makeFixture({
      workingSource: 'export function foo() {}\n',
      hook,
    });
    const result = inspectGuardRequiresParity(root);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'invalid-armguard-provenance' }),
    ]));
    expect(result.ok).toBe(false);
  });

  it('rejects a modules object that is not directly bound from the matched armGuard result', () => {
    const hook = makeHook({ requires: ['foo'] }).replace(
      '  const { modules } = await armGuard({',
      '  const fakeResult = { modules: { blocker: {} } };\n  const { modules } = fakeResult;\n  await armGuard({',
    );
    const root = makeFixture({
      workingSource: 'export function foo() {}\n',
      hook,
    });
    const result = inspectGuardRequiresParity(root);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'indirect-contract' }),
      expect.objectContaining({ kind: 'shadowed-binding' }),
    ]));
    expect(result.ok).toBe(false);
  });

  it('rejects a nested modules shadow instead of counting its member as provenance', () => {
    const hook = makeHook({ requires: ['foo'] }).replace(
      '  blocker = modules.blocker;',
      '  function use(modules) { return modules.blocker; }\n  blocker = modules.blocker;',
    );
    const root = makeFixture({
      workingSource: 'export function foo() {}\n',
      hook,
    });
    const result = inspectGuardRequiresParity(root);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'shadowed-binding' }),
    ]));
    expect(result.ok).toBe(false);
  });

  it.each([
    {
      name: 'a nested class declaration',
      shadow: '{\n    class modules {}\n    blocker = modules.blocker;\n  }',
    },
    {
      name: 'a nested named class expression',
      shadow: '{\n    const shadow = class modules {};\n    blocker = modules.blocker;\n  }',
    },
  ])('rejects $name modules shadow instead of counting its member as provenance', ({ shadow }) => {
    const hook = makeHook({ requires: ['foo'] }).replace(
      '  blocker = modules.blocker;',
      `  ${shadow}`,
    );
    const root = makeFixture({
      workingSource: 'export function foo() {}\n',
      hook,
    });
    const result = inspectGuardRequiresParity(root);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'shadowed-binding' }),
    ]));
    expect(result.ok).toBe(false);
  });

  it('rejects symlinked hook handlers without following the target', () => {
    const root = makeFixture({
      workingSource: 'export function foo() {}\n',
      hook: makeHook({ requires: ['foo'] }),
    });
    const outside = mkdtempSync(join(tmpdir(), 'guard-requires-parity-outside-'));
    fixtureRoots.push(outside);
    const target = join(outside, 'outside-handler.mjs');
    writeFileSync(target, 'export const escaped = true;\n');
    symlinkSync(target, join(root, 'hooks', 'linked-handler.mjs'));

    const result = inspectGuardRequiresParity(root);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'symlink-handler',
        hook: 'hooks/linked-handler.mjs',
        message: expect.stringContaining('refusing to follow'),
      }),
    ]));
    expect(result.ok).toBe(false);
  });

  it('reads HEAD from pluginRoot even when GIT_DIR points at a foreign fixture', () => {
    const root = makeFixture({
      workingSource: 'export function foo() {}\n',
      hook: makeHook({ requires: ['foo'] }),
    });
    const foreign = makeFixture({
      workingSource: 'export const foo = 1;\n',
      hook: makeHook({ requires: ['foo'] }),
    });

    const result = withEnv('GIT_DIR', join(foreign, '.git'), () => inspectGuardRequiresParity(root));
    expect({ ok: result.ok, findings: result.findings }).toEqual({ ok: true, findings: [] });
  });
});

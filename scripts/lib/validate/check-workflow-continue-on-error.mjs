#!/usr/bin/env node
// Usage: check-workflow-continue-on-error.mjs <plugin-root>
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { isMainModule } from '../is-main-module.mjs';

function inspectWorkflow(yamlText, relPath) {
  const workflow = yaml.load(yamlText, { schema: yaml.CORE_SCHEMA });
  const jobs = Object.entries(workflow?.jobs ?? {});
  const findings = jobs
    .filter(([, job]) => job !== null && job !== undefined && Object.hasOwn(job, 'continue-on-error')
      && job['continue-on-error'] !== false)
    .map(([job, config]) => ({ file: relPath, job, value: config['continue-on-error'] }));
  return { findings, jobCount: jobs.length };
}

/** Find job-level tolerance that can leave a failed check run; invalid YAML throws. */
export function findJobLevelContinueOnError(yamlText, relPath) {
  return inspectWorkflow(yamlText, relPath).findings;
}

function run(pluginRoot) {
  console.log('--- Check: workflow job-level continue-on-error ---');
  const workflowsDir = join(pluginRoot, '.github', 'workflows');
  let passed = 0;
  let failed = 0;
  if (!existsSync(workflowsDir)) {
    console.log('  PASS: no workflows');
    passed++;
  } else {
    for (const entry of readdirSync(workflowsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
      const relPath = `.github/workflows/${entry.name}`;
      try {
        const { findings, jobCount } = inspectWorkflow(readFileSync(join(workflowsDir, entry.name), 'utf8'), relPath);
        for (const { job } of findings) {
          console.log(`  FAIL: ${relPath}: job '${job}' sets job-level continue-on-error — its check run still concludes failure; move it to the step(s)`);
          failed++;
        }
        if (findings.length === 0) {
          console.log(`  PASS: ${relPath}: no job-level continue-on-error (${jobCount} jobs)`);
          passed++;
        }
      } catch (error) {
        console.log(`  FAIL: ${relPath}: ${error.message}`);
        failed++;
      }
    }
  }
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  return failed > 0 ? 1 : 0;
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  const root = process.argv[2];
  if (!root) {
    console.error('Usage: check-workflow-continue-on-error.mjs <plugin-root>');
    process.exit(1);
  }
  process.exit(run(root));
}

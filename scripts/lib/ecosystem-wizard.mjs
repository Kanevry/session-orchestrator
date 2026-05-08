/**
 * ecosystem-wizard.mjs — re-export barrel (#325).
 * Behaviour-preserving 5-module split of the original 636 LoC monolith.
 * Every public symbol is re-exported so existing imports remain unchanged.
 *
 * CLI entry preserved below the re-exports.
 */

import { runEcosystemWizard } from './ecosystem-wizard/wizard-prompt.mjs';

export { detectCiProvider } from './ecosystem-wizard/ci-detector.mjs';
export {
  detectPackageManagerFromRoot,
  readPackageScripts,
} from './ecosystem-wizard/package-manager-detector.mjs';
export {
  parseCommaSeparated,
  parseEndpoints,
  parsePipelines,
} from './ecosystem-wizard/config-parser.mjs';
export {
  validateEcosystemPolicy,
  resolveConfigFile,
  readExistingEcosystemConfig,
  writeSessionConfigBlock,
  writePolicyFile,
} from './ecosystem-wizard/config-writer.mjs';
export { runEcosystemWizard } from './ecosystem-wizard/wizard-prompt.mjs';

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

if (process.argv[1] && process.argv[1].endsWith('ecosystem-wizard.mjs')) {
  const args = process.argv.slice(2);
  const repoRootIdx = args.indexOf('--repo-root');
  const dryRun = args.includes('--dry-run');
  const repoRoot = repoRootIdx !== -1 ? args[repoRootIdx + 1] : process.cwd();

  runEcosystemWizard({ repoRoot, dryRun })
    .then((result) => {
      if (result.errors.length > 0) process.exit(1);
    })
    .catch((err) => {
      process.stderr.write(`ecosystem-wizard: ${err.message}\n`);
      process.exit(1);
    });
}

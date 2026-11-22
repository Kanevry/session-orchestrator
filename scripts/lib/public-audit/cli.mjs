import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { loadManifest } from './manifest.mjs';
import { audit } from './audit.mjs';
import { renderReport, renderJson, exitCode } from './report.mjs';
import { isMainModule } from '../is-main-module.mjs';

const help = `Usage: node scripts/lib/public-audit/cli.mjs [options]
  --manifest <file>              Manifest (default .orchestrator/public-audit.md)
  --max-requests-per-host <1..5>  GET budget including redirects and crawler agents
  --json                         JSON output
  --out <file>                   Write only the selected file
  --help                         Show help without reading a manifest
`;

/** CLI boundary also supports embedding with the same I/O and audit interfaces. */
export async function main(
  argv = process.argv.slice(2),
  {
    readManifest = loadManifest,
    auditImpl = audit,
    writeOutput = writeFile,
    stdout = (text) => process.stdout.write(text),
    stderr = (text) => process.stderr.write(text),
  } = {},
) {
  let values;
  let maxRequestsPerHost;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        manifest: { type: 'string', default: '.orchestrator/public-audit.md' },
        'max-requests-per-host': { type: 'string', default: '5' },
        json: { type: 'boolean' },
        out: { type: 'string' },
        help: { type: 'boolean' },
      },
    }));
    if (values.help) {
      stdout(help);
      return 0;
    }
    if (
      !/^[1-5]$/.test(values['max-requests-per-host']) ||
      !values.manifest.trim() ||
      (values.out !== undefined && !values.out.trim())
    )
      throw new Error('Invalid options');
    maxRequestsPerHost = Number(values['max-requests-per-host']);
  } catch {
    stderr('Invalid public-audit options. Use --help for usage.\n');
    return 2;
  }
  try {
    const manifest = await readManifest(values.manifest);
    const report = await auditImpl(manifest, { maxRequestsPerHost });
    const output = values.json ? renderJson(report) : renderReport(report);
    if (values.out !== undefined) await writeOutput(values.out, output);
    else stdout(output);
    return exitCode(report);
  } catch {
    stderr(
      'Public audit input, execution or output failed. Check the manifest and selected output path.\n',
    );
    return 2;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main();
}

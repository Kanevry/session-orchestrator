import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const repoRoot = path.resolve(projectRoot, '../..');

export async function prepareAssets() {
  const assets = [
    ['site/img/agent-production-1536.webp', 'production.webp'],
    ['site/fonts/space-grotesk-latin.woff2', 'space-grotesk.woff2'],
    ['site/fonts/inter-latin.woff2', 'inter.woff2'],
    ['site/brand/a3-terminalmodule/mark-on-dark.svg', 'brand-mark.svg'],
    ['site/fonts/LICENSES.md', 'FONT-LICENSES.md'],
  ];
  const target = path.join(projectRoot, 'public');
  await mkdir(target, {recursive: true});
  const receipt = [];
  for (const [source, name] of assets) {
    const file = path.join(repoRoot, source);
    await copyFile(file, path.join(target, name));
    receipt.push({source, sha256: createHash('sha256').update(await readFile(file)).digest('hex')});
  }
  await writeFile(path.join(projectRoot, 'asset-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await prepareAssets();

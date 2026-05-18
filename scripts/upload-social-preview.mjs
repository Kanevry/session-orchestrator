#!/usr/bin/env node
/* global document */
/**
 * scripts/upload-social-preview.mjs
 *
 * Uploads an arbitrary image file as a GitHub repository's social-preview image.
 * Fills the gap left by upstream tools that only support README screenshots
 * (AnswerDotAI/gh-social-preview) or Socialify-generated cards (mheap/github-social-image).
 *
 * Why Playwright instead of the gh CLI:
 *   GitHub has no REST/GraphQL endpoint for setting the social-preview image.
 *   Verified empirically: PATCH /repos/{owner}/{repo} silently ignores
 *   `social_preview_image_url`; github.com web endpoints reject Bearer tokens
 *   (require `_gh_sess` session cookie). Multiple GitHub community discussions
 *   confirm this: orgs/community/discussions/52294, /172072, /49928.
 *
 *   The only working path is browser automation against the Settings UI flow,
 *   which is what every tool in this space does (gh-social-preview, mheap/
 *   github-social-image, drogers0/gh-image — different scopes, same approach).
 *
 * Authentication:
 *   Reuses the storageState produced by `gh-social-preview init-auth`
 *   (default: ~/.local/state/gh-social-preview/auth/github.json). Run that
 *   once per host; subsequent uploads use the saved session.
 *
 * Upload logic adapted from AnswerDotAI/gh-social-preview's uploadSocialPreview
 * function (ISC-licensed, Jeremy Howard). The selectors and the
 * /upload/repository-images/ response-monitoring approach come from that tool.
 *
 * Usage:
 *   node scripts/upload-social-preview.mjs --repo owner/repo --image path/to.png
 *
 * Options:
 *   --repo            owner/repo or full GitHub URL (required)
 *   --image           path to PNG/JPG/GIF, < 1 MB (required)
 *   --storage-state   path to Playwright storageState JSON
 *                     default: ~/.local/state/gh-social-preview/auth/github.json
 *   --base-url        GitHub base URL (default: https://github.com)
 *   --headless        true|false (default: true)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function toBool(v, defVal) {
  if (v === undefined) return defVal;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase().trim();
  if (['1','true','yes','y','on'].includes(s)) return true;
  if (['0','false','no','n','off'].includes(s)) return false;
  return defVal;
}

function normalizeRepo(repoOrUrl) {
  const s = String(repoOrUrl || '').trim();
  if (!s) throw new Error('Missing --repo (expected owner/repo or a GitHub repo URL)');
  if (s.includes('://')) {
    const u = new URL(s);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) throw new Error(`Invalid repo URL: ${s}`);
    return `${parts[0]}/${parts[1]}`;
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) return s;
  throw new Error(`Invalid --repo "${s}". Expected "owner/repo" or a GitHub URL.`);
}

function defaultStoragePath() {
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(stateHome, 'gh-social-preview', 'auth', 'github.json');
}

function loadPlaywright() {
  // Try several resolutions: local node_modules, gh-social-preview's npx cache, sibling installs.
  const candidates = [
    'playwright',
    'playwright-core',
  ];
  for (const c of candidates) {
    try {
      const mod = require(c);
      if (mod?.chromium) return mod;
    } catch { /* try next */ }
  }
  // Fallback: scan ~/.npm/_npx for a gh-social-preview install
  const npxRoot = path.join(os.homedir(), '.npm', '_npx');
  if (fs.existsSync(npxRoot)) {
    for (const entry of fs.readdirSync(npxRoot)) {
      const p = path.join(npxRoot, entry, 'node_modules', 'playwright');
      if (fs.existsSync(path.join(p, 'index.js'))) {
        try { return require(p); } catch { /* try next */ }
      }
    }
  }
  throw new Error(
    'playwright not found. Install with one of:\n' +
    '  - npx --yes -p playwright -- node scripts/upload-social-preview.mjs ...\n' +
    '  - npm install --no-save --ignore-scripts playwright\n' +
    'Browsers must already be present at ~/Library/Caches/ms-playwright/ (chromium-*).\n' +
    'Run `npx playwright install chromium` once if missing.'
  );
}

async function uploadSocialPreview({ repo, imagePath, storageStatePath, baseUrl, headless }) {
  if (!fs.existsSync(imagePath)) throw new Error(`Image file not found: ${imagePath}`);
  if (!fs.existsSync(storageStatePath)) {
    throw new Error(
      `Storage state not found at "${storageStatePath}". Run:\n` +
      `  npx --yes gh-social-preview init-auth --storage-state ${storageStatePath}\n` +
      'to create it once (interactive browser login).'
    );
  }
  const size = fs.statSync(imagePath).size;
  if (size > 1_000_000) {
    throw new Error(
      `Image size ${size} bytes exceeds GitHub's 1 MB social-preview limit. ` +
      'Re-export at smaller dimensions or higher PNG compression.'
    );
  }

  const { chromium } = loadPlaywright();
  const settingsUrl = `${baseUrl}/${repo}/settings`;

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ storageState: storageStatePath });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);

  console.log(`[upload] Opening ${settingsUrl}`);
  await page.goto(settingsUrl, { waitUntil: 'domcontentloaded' });

  if (page.url().includes('/login')) {
    await browser.close();
    throw new Error('Session expired — redirected to /login. Re-run init-auth.');
  }

  const socialHeading = page.locator("xpath=//h2[normalize-space()='Social preview']").first();
  const editButton = page.locator('#edit-social-preview-button');
  const socialEditButton = page.locator(
    "xpath=(//h2[normalize-space()='Social preview']/following::*[(self::button or self::summary) and normalize-space(.)='Edit'][1])"
  );
  const fileInput = page.locator('input#repo-image-file-input');
  const uploadMenuItem = page.getByText(/upload an image/i).first();
  const imageIdInput = page.locator('input.js-repository-image-id');
  const imageContainer = page.locator('.js-repository-image-container');

  console.log('[upload] Waiting for Social preview section');
  await socialHeading.waitFor({ state: 'attached', timeout: 60_000 });
  await socialHeading.scrollIntoViewIfNeeded().catch(() => {});

  let prevId = '';
  if (await imageIdInput.count()) {
    prevId = (await imageIdInput.first().inputValue().catch(() => '')).trim();
  }
  const mode = prevId ? 'replace' : 'add';
  console.log(`[upload] Social preview mode: ${mode} (prevId="${prevId}")`);

  if (await editButton.count()) {
    await editButton.first().click({ force: true }).catch(() => {});
  } else if (await socialEditButton.count()) {
    await socialEditButton.first().click({ force: true }).catch(() => {});
  }

  console.log('[upload] Waiting for upload controls');
  await Promise.any([
    fileInput.first().waitFor({ state: 'attached', timeout: 30_000 }),
    uploadMenuItem.waitFor({ state: 'visible', timeout: 30_000 }),
  ]);

  console.log(`[upload] Uploading ${imagePath} (${size} bytes)`);

  const uploadResponsePromise = page.waitForResponse((resp) => {
    const u = resp.url();
    const ok = resp.status() >= 200 && resp.status() < 300;
    if (!ok) return false;
    return u.includes('/upload/repository-images/') || u.includes('/upload/policies/repository-images');
  }, { timeout: 30_000 }).then(r => `${r.status()} ${r.url()}`).catch(() => '');

  if (await fileInput.count()) {
    await fileInput.first().setInputFiles(imagePath);
  } else {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      uploadMenuItem.click({ force: true }),
    ]);
    await chooser.setFiles(imagePath);
  }

  const uploadUrl = await uploadResponsePromise;
  if (uploadUrl) console.log(`[upload] Upload response: ${uploadUrl}`);
  else console.warn('[upload] Upload response not observed — using DOM fallback');

  let idChanged = false;
  if (!uploadUrl) {
    try {
      await page.waitForFunction(
        ({ prevId }) => {
          const input = document.querySelector('input.js-repository-image-id');
          if (!input) return false;
          const v = (input.value || '').trim();
          if (!v) return false;
          if (!prevId) return true;
          return v !== prevId;
        },
        { prevId },
        { timeout: 30_000 }
      );
      idChanged = true;
    } catch { /* fallthrough */ }
  }

  await page.waitForFunction(
    () => {
      const input = document.querySelector('input.js-repository-image-id');
      return !!((input?.value || '').trim());
    },
    { timeout: 30_000 }
  ).catch(() => {});

  if (await imageContainer.count()) {
    await page.waitForFunction(
      () => {
        const el = document.querySelector('.js-repository-image-container');
        return el && el.hidden === false;
      },
      { timeout: 30_000 }
    ).catch(() => {});
  }

  const newId = (await imageIdInput.first().inputValue().catch(() => '') || '').trim();
  await browser.close();

  if (!newId) throw new Error('Upload did not produce a social-preview image id.');
  if (!idChanged && prevId && newId === prevId) {
    console.warn('[upload] image id unchanged — likely re-uploaded identical content');
  }

  return { ok: true, newId, prevId, mode, uploadUrl: uploadUrl || null };
}

function printHelp() {
  console.log(`Usage:
  node scripts/upload-social-preview.mjs --repo owner/repo --image path/to.png [options]

Options:
  --repo            owner/repo or full GitHub URL (required)
  --image           path to PNG/JPG/GIF, < 1 MB (required)
  --storage-state   path to Playwright storageState JSON
                    (default: ~/.local/state/gh-social-preview/auth/github.json)
  --base-url        GitHub base URL (default: https://github.com)
  --headless        true|false (default: true)
  -h, --help        show this help

First-time setup (per host, once):
  npx --yes gh-social-preview init-auth
  # Interactive browser login, saves storage state.

Then upload:
  node scripts/upload-social-preview.mjs \\
    --repo Kanevry/session-orchestrator \\
    --image assets/og-card.png

Why this script exists:
  GitHub has NO REST/GraphQL endpoint for the social-preview image upload —
  it is only settable via the web UI. Verified empirically: PATCH
  /repos/{owner}/{repo} silently ignores social_preview_image_url; the
  github.com web endpoints reject Bearer tokens (require _gh_sess cookie).
  This script automates the UI flow via Playwright, reusing the auth
  storageState from AnswerDotAI/gh-social-preview's init-auth.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h || args._[0] === 'help') { printHelp(); return; }
  if (!args.repo || !args.image) { printHelp(); process.exit(1); }

  const repo = normalizeRepo(args.repo);
  const imagePath = path.resolve(String(args.image));
  const storageStatePath = args['storage-state']
    ? path.resolve(String(args['storage-state']))
    : defaultStoragePath();
  const baseUrl = String(args['base-url'] || 'https://github.com').replace(/\/$/, '');
  const headless = toBool(args.headless, true);

  const result = await uploadSocialPreview({ repo, imagePath, storageStatePath, baseUrl, headless });
  console.log(JSON.stringify(result, null, 2));
  console.log(`\n✅ Social preview uploaded for ${repo}`);
  console.log(`   Mode: ${result.mode}, new image id: ${result.newId}`);
  console.log(`   Verify at: ${baseUrl}/${repo}/settings#social-preview`);
}

main().catch((err) => {
  console.error(`\n❌ ${err?.message || err}\n`);
  if (err?.stack && process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});

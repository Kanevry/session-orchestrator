# Site Redesign Contract (Contract-Lock, session main-2026-09-07-session-1)

Frozen before Wave 2. Every Wave-2/3 agent builds against THIS file. It fixes names, not prose. Changing a name here mid-wave breaks a sibling agent; do not.

> `<author-domain>` stands for the maintainer's personal domain (the one in the footer `rel="author"` link). It is spelled out on the published pages only, never in tracked docs, so the owner-leakage scanner (CP7) stays green.

## 0. Goal in one line

session-orchestrator.com becomes a light-first, readable site for two readers at once: someone who has never written code (Layer A, top of page) and a developer (Layer B, below). Family look with <author-domain>. Copy in the owner's voice. Illustrations AI-generated and labelled.

## 1. Files and owners (Wave 2)

| Owner | Writes exactly | Reads |
|---|---|---|
| W2-C1 | `site/assets/site.css`, `site/fonts/*` (add `bricolage-grotesque-var.woff2`, `source-sans-3-var.woff2`; delete `archivo-var.woff2`; rewrite `LICENSES.md`) | this file |
| W2-C2 | `site/index.html` | this file, `git show HEAD:site/index.html` |
| W2-C3 | `site/assets/hero.js`, `site/assets/hero-fallback.svg`, `site/vendor/three.module.min.js`, `site/vendor/three.core.min.js`, `site/vendor/LICENSES.md` | this file |
| W2-C4 | `site/img/*.webp`, `.orchestrator/tmp/site-review/img-candidates/*` | `.orchestrator/tmp/site-review/d6/prompts.json` |
| W2-C5 | `site/guide/index.html` | this file, `git show HEAD:site/guide/index.html` |
| W2-C6 | `scripts/site-numbers.mjs`, `tests/scripts/site-numbers.test.mjs`, `site/llms-full.txt`, `site/_census.json` | this file |

Staged inputs (already on disk, read-only for agents): fonts in `.orchestrator/tmp/site-review/fonts/`, three.js in `.orchestrator/tmp/site-review/three/package/build/` + `LICENSE`, prompts in `.orchestrator/tmp/site-review/d6/prompts.json`, probe image `.orchestrator/tmp/site-review/d6/probe-gate-800.webp`.

## 2. Design tokens (site.css `:root`, C1 writes, everyone else uses by name)

Light default, dark via `@media (prefers-color-scheme: dark)`. Values from GotzendorferV2 `src/styles/theme.css` (Studio Light / Warmer Graphit).

```css
:root{
  --bg:            oklch(0.959 0.010 81.795);  /* #F5F1EA putty */
  --surface:       oklch(1 0 0);               /* #FFFFFF */
  --fg:            oklch(0.194 0.006 55.987);  /* #171412 */
  --fg-2:          oklch(0.44 0.022 75.041);   /* #5A5145 muted text */
  --line:          oklch(0.858 0.023 80.677);  /* #D8CFC0 hairline */
  --accent:        oklch(0.346 0.074 256.04);  /* #1E3A5F ink-blue */
  --accent-fg:     oklch(0.959 0.010 81.795);  /* #F5F1EA */
  --signature:     oklch(0.346 0.074 256.04);  /* one full-bleed surface per page */
  --signature-fg:  oklch(0.959 0.010 81.795);
  --code-bg:       oklch(0.909 0.021 81.779);  /* #E8E0D2 sand */
  --ring:          oklch(0.346 0.074 256.04);
  --run:  #8a5a00; --hold: #a3301c; --pass: #1d6b39;   /* state colours, light */
}
@media (prefers-color-scheme: dark){:root{
  --bg:            oklch(0.207 0.008 67.392);  /* #1A1714 */
  --surface:       oklch(0.244 0.011 60.947);  /* #241F1B */
  --fg:            oklch(0.933 0.012 79.783);  /* #EDE8E0 */
  --fg-2:          oklch(0.69 0.020 75.249);   /* #A39A8E */
  --line:          oklch(0.295 0.008 75.257);  /* #2F2C28 */
  --accent:        oklch(0.773 0.123 69.085);  /* #E8A657 amber */
  --accent-fg:     oklch(0.207 0.008 67.392);
  --signature:     oklch(0.52 0.100 256.04);   /* #406AA2 */
  --signature-fg:  oklch(0.933 0.012 79.783);
  --code-bg:       oklch(0.244 0.011 60.947);
  --ring:          oklch(0.773 0.123 69.085);
  --run:  #e8a33d; --hold: #f0705e; --pass: #5fbf82;
}}
```

Contrast (verified 2026-09-07, D3): fg/bg 16.29:1 light, 14.64:1 dark; fg-2/bg 6.91 / 6.43; accent/bg 10.22 / 8.52.

Typography:

```css
--font-display: 'Bricolage Grotesque', 'Source Sans 3', system-ui, sans-serif;
--font-body:    'Source Sans 3', -apple-system, 'Helvetica Neue', Arial, sans-serif;
--font-mono:    'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
--text-display: clamp(2.25rem, 5vw, 3.5rem); /* hero h1, lh 1.05, ls -0.02em, weight 600 */
--text-h1: 2.5rem; --text-h2: 1.875rem; --text-h3: 1.25rem;
--text-lede: 1.1875rem;   /* 19px, lh 1.6 */
--text-body: 1.0625rem;   /* 17px, lh 1.6, weight 400 */
--text-meta: 0.8125rem;   /* 13px */
--text-code: 0.875rem;    /* 14px mono */
--measure: 65ch; --measure-narrow: 46ch;
```

Mono is used ONLY for: commands, file paths, code blocks, the numbered eyebrow (`01 /`). Never for nav, buttons, body, captions.

Fonts on disk after C1: `bricolage-grotesque-var.woff2` (41,344 B, wght 200-800), `source-sans-3-var.woff2` (28,740 B, wght 200-900), `ibm-plex-mono-400.woff2`, `ibm-plex-mono-500.woff2`. `@font-face` with `font-display: swap`, `unicode-range` latin. Preload: bricolage + source-sans-3 + plex-400.

## 3. CSS class names (C1 defines, C2/C5/P1/P4 use; nobody invents new ones without prefixing `x-`)

Layout: `.wrap` (max 1180px, padding-inline 24px), `.grid-12`, `.col-7`, `.col-5`, `.col-4`, `.col-8`, `.stack` (vertical rhythm), `.hr` (hairline).
Sections: `.sec` (section block, padding-block 72px; 48px on mobile), `.sec.signature` (the ONE full-bleed accent surface), `.eyebrow` (mono, uppercase, accent; contains `<span class="num">01</span>` + label), `.lede`, `.meta`, `.marginalia`.
Text: `.h-display` (hero h1), `h2`, `h3`, `p`, `.small`, `.muted`.
Buttons: `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-tertiary`.
Cards/lists: `.card` (surface, 1px line, radius 8px, no shadow), `.cards` (grid of cards, 3-up desktop, 1-up mobile), `.steps` + `.step` (numbered ELI5 steps with image slot), `.faq` + `.faq-item` (`<details><summary>`), `.kv` (key/value table), `.proof` (claim to file table), `.table` (plain table styles).
Code: `.code` (block, `--code-bg`, mono 14px, horizontal scroll), `.cmd` (one-line command with copy button `.copy`), `.kbd`.
Figures: `.fig` (`<figure>`), `.fig img` (width 100%, height auto, radius 8px), `.fig figcaption` (meta size, `--fg-2`), `.fig-ai` (the disclosure line inside figcaption).
Hero: `#hero` (container, `aspect-ratio: 16/9`, on `max-width: 600px` becomes `4/3`), `#hero canvas`, `.hero-alt` (visible ordered list of the five pass names below the canvas), `.hero-fallback` (holds the SVG / `<noscript>` image).
Header/footer: `.top` (header), `.brand`, `.nav`, `.nav a`, `.lang` (EN/DE switch), `.foot`, `.foot .cols`, `.foot .author`.
Utilities: `.sr` (visually hidden), `.skip` (skip link), `.num` (tabular numbers; ALSO the class the census generator expects on metric spans, keep it).

Dark mode is automatic. No toggle in Wave 2.

## 4. Page skeleton `site/index.html` (C2) and `site/de/index.html` (P1, same skeleton, same ids)

```
<head>: charset, viewport, title, description, canonical, hreflang (en, de, x-default=en), icon, og/twitter (og:image og.png 1200x630 + width/height), preload 3 fonts, <link rel="stylesheet" href="/assets/site.css">, JSON-LD (existing graph, WebSite.inLanguage per page), <link rel="alternate" type="text/plain" href="/llms.txt">
<body>
  <a class="skip" href="#main">
  <header class="top"> .brand (session-orchestrator v<span class="num" data-metric="version">4.0.0</span>) · .nav (For everyone · For developers · Install · Guide · GitHub) · .lang (EN | DE)
  <main id="main">
    <section class="sec hero-sec" id="top">          Layer A hero: eyebrow "01 / What it is", h1.h-display, .lede, buttons (Install in one line -> #install, Read the guide -> /guide), then #hero (canvas + .hero-alt + .hero-fallback)
    <section class="sec" id="for-everyone">           Layer A: .steps with 3 steps (reads first / agree the scope / five passes, each with .fig image slot: reads-first, agree-scope, five-passes) + a 4th block "the gate" (the-gate image) + "what stays" (what-survives image). Plain words. Max 60 words per step.
    <section class="sec signature" id="who">          Author block: "Built by Bernhard Götzendorfer in Vienna. One person, no company behind it." + link (see section 7) + "Free. MIT. Source on GitHub."
    <section class="sec" id="install">                Layer B: harness picker (Claude Code / Codex CLI / Cursor IDE / Pi): carry the existing commands and the KNOWN BROKEN note verbatim from HEAD:site/index.html lines 661-747, restyled with .card/.cmd
    <section class="sec" id="loop">                   Layer B: "Five passes, one gate between each": the schedule TABLE from HEAD lines 875-924 (drop the FIG.1 elevation chart; the hero replaced it)
    <section class="sec" id="enforced">               Layer B: "Every claim names the file that enforces it": .proof table, carry from HEAD 926-954, em-dashes removed
    <section class="sec" id="measured">               Layer B: "Measured in this repository": the 8 metric tiles + counted-at/counted-sha line, EXACT data-metric spans (see section 6), plus 2 NEW tiles "npm downloads, last 30 days" and "GitHub stars" with data-metric="npm-downloads-30d" and data-metric="github-stars" (C6 adds the ids to the generator; C2 writes placeholder text "n/a" in those two spans)
    <section class="sec" id="faq">                    FAQ (#1080.6): 6 to 8 <details> in user wording: "Is this a coding agent?" "Which tools does it work with?" "What is different from just using Claude Code?" "Does it send data anywhere?" "Does it work on Windows?" "What does it cost?" "Can it break my repo?" "Who maintains it?"
    <section class="sec" id="limits">                 "What this is, and what it is not": carry from HEAD 1012-1032, colons instead of em-dashes
    <section class="sec end" id="start">              closing CTA
  </main>
  <footer class="foot"> columns: Project (GitHub, npm, Guide, llms.txt) · Legal (Imprint /impressum, Privacy /datenschutz) · Author (see section 7) · line ".fig-ai": "Illustrations: AI-generated (gpt-image-2)." · "MIT"
  <script src="/_vercel/insights/script.js" defer>   (MUST stay, test-pinned)
  <script type="module" src="/assets/hero.js">
```

Section ids are FROZEN: `top, for-everyone, who, install, loop, enforced, measured, faq, limits, start`. DE page uses the same ids (anchors stay language-neutral).

`site/guide/index.html` (C5): keep its content and section structure, swap to `site.css` classes, same header/footer as above (nav: Install · First session · When it blocks · When it is wrong · GitHub; `.lang` absent, guide is EN only), remove ALL em-dashes (raw and `&mdash;`), replace "our documentation" with "the documentation" (K6). Add JSON-LD `TechArticle` with `mainEntityOfPage`, `isPartOf: {"@id":"https://session-orchestrator.com/#website"}`, `dateModified` from `git log -1 --format=%cs -- site/guide/index.html`. Do NOT put the string `<author-domain>` anywhere in the guide (leakage rule CP7 allowlists only index, impressum, datenschutz, and de/index).

## 5. Hero API (C3 implements, C2/P1 mount)

Mount markup (C2 writes exactly this inside `#top`):

```html
<div id="hero" data-hero-state="init">
  <canvas aria-hidden="true"></canvas>
  <ol class="hero-alt"><li>Read</li><li>Build</li><li>Polish</li><li>Check</li><li>Finish</li></ol>
  <noscript><img class="hero-fallback" src="/assets/hero-fallback.svg" alt="Five blocks in a row with four gates between them" width="960" height="400"></noscript>
</div>
```

`hero.js`: ES module, `import * as THREE from '/vendor/three.module.min.js'` (which imports `./three.core.min.js`, both vendored). Reads `--bg --fg --accent --run --hold --pass` via `getComputedStyle`; orthographic camera; 5 blocks, 4 two-panel gates, 1 icosahedron token; ~11 s loop (travel 1.1 s, check 0.5 s at 2 Hz pulse, open 0.3 s); DPR cap 2; ResizeObserver; IntersectionObserver + visibilitychange pause; `prefers-reduced-motion` renders one static frame; no WebGL appends `<img class="hero-fallback" src="/assets/hero-fallback.svg">` and sets state `fallback`. States on `data-hero-state`: `init | running | static | fallback`; dispatch `hero:ready` CustomEvent when leaving `init`. No addons, no workers, no eval, no fetch. Pass labels in the scene are NOT rendered as text (three has no text without loaders); the `.hero-alt` list is the text.

## 6. Census contract (C6 owns the generator, C2/P1 own the spans)

Existing frozen ids stay: `version, counted-at, counted-sha, skills, commands, agents, hooks, tests, sessions, learnings`. Markup: `<span class="num" data-metric="ID">value</span>`. The generator recursively scans every `.html` under `site/`, so `site/de/index.html` MUST carry the same ids with the same values (P1 copies the spans verbatim from the EN page, numbers untranslated).

C6 adds two ids: `npm-downloads-30d` (source: `https://api.npmjs.org/downloads/point/last-month/session-orchestrator`, field `downloads`) and `github-stars` (source: `https://api.github.com/repos/Kanevry/session-orchestrator`, field `stargazers_count`). Both are network metrics: fetched only under `--write` with a 5 s timeout, cached into `site/_census.json` under `metrics`, and `--check` compares against the snapshot (never the network), so CI stays offline. On fetch failure `--write` keeps the previous snapshot value and prints a WARN; never writes "n/a" over a real number. The label text next to them states the window ("last 30 days") and the counted-at date already on the page covers freshness.

C6 also adds a marker-bounded block to `site/llms-full.txt`:

```
<!-- census:start -->
Version 4.0.0 · counted 2026-09-06 at 432b1871 · skills 43 · commands 25 · agents 14 · hooks 27 · test files 662 · sessions 288 · learnings 198 · npm downloads (30d) N · GitHub stars N
<!-- census:end -->
```

The generator rewrites only what is between the markers (#1080.1). `scripts/release.mjs` still owns the `Version X.Y.Z` literal in llms.txt/llms-full.txt; the census line must keep the exact `Version 4.0.0` form so that regex keeps matching.

## 7. Author link and cross-references (P2 EN, P1 DE, P4 legal pages)

```html
<!-- EN -->
<a href="https://www.<author-domain>/?utm_source=session-orchestrator&utm_medium=footer&utm_campaign=cross-promo" rel="author">More about Bernhard Götzendorfer</a>
<!-- DE -->
<a href="https://www.<author-domain>/de/?utm_source=session-orchestrator&utm_medium=footer&utm_campaign=cross-promo" rel="author">Mehr über Bernhard Götzendorfer</a>
```

Story links (optional, in `#who`): EN `https://www.<author-domain>/en/blog/session-orchestrator-oss-tool-matures`, DE `https://www.<author-domain>/de/blog/session-orchestrator-oss-tool-reift`. Verify each URL returns 200 before linking.

Leakage rule: the string `<author-domain>` may appear ONLY in `site/index.html`, `site/de/index.html`, `site/impressum/index.html`, `site/datenschutz/index.html` (allowlist in `scripts/lib/validate/check-owner-leakage.mjs`; `site/de/index.html` was added 2026-09-07). Only the `www.` form on those lines.

## 8. Images (C4 produces, P2/P1 embed)

Files: `site/img/<id>-1200.webp`, `-800.webp`, `-400.webp`, q=82, via `cwebp`. Ids: `hero-stations` (1792x1024, quality high), `reads-first`, `agree-scope`, `five-passes`, `the-gate`, `what-survives` (1024x1024, quality medium). Originals (PNG) stay in `.orchestrator/tmp/site-review/img-candidates/`, never committed.

Embed pattern:

```html
<figure class="fig">
  <img src="/img/the-gate-800.webp" srcset="/img/the-gate-400.webp 400w, /img/the-gate-800.webp 800w, /img/the-gate-1200.webp 1200w" sizes="(max-width: 600px) 100vw, 480px" width="800" height="800" loading="lazy" decoding="async" alt="A closed gate with a thin blue line of light along its edge.">
  <figcaption><span class="fig-ai">AI-generated illustration (gpt-image-2)</span></figcaption>
</figure>
```

Alt texts: from `prompts.json` `alt_en` / `alt_de`. Disclosure EN "AI-generated illustration (gpt-image-2)", DE "KI-generierte Illustration (gpt-image-2)", plus one footer line.

OG: `site/og.png` 1200x630 from `hero-stations`, 8px `#1E3A5F` top stripe, putty background (P5).

## 9. Voice rules (all copy, EN and DE)

- No em-dash, ever (neither `—` nor `&mdash;`). Use a colon, a comma, or a new sentence.
- No superlatives (K4), no "we" (K6; it is one person), no AI meta-sentences (K2), no adjective triplets (K7).
- Short sentences. One long breath per paragraph at most. Facts first.
- A number only with its source or window. "5 steps" and "one person" are fine; counts come from the census spans.
- Understatement: "reads first, then asks, then works in steps and checks after each" beats any claim about quality.
- EN: plain, direct, no marketing. DE: du-Form, Austrian colouring allowed ("geht sich aus", "passt"), umlauts in prose, ASCII only in identifiers.
- Layer A must be understandable without knowing: agent, harness, repository, commit, CI, gate, wave. If a Layer-A sentence needs one of these, replace it with what it does ("a program that writes code", "the folder with your project", "an automatic check").
- Headline (EN): "It reads first, asks, then works in checked steps." Subtitle: "A free add-on for AI coding tools like Claude Code. Open source, one line to install." (C2 may tune wording, not meaning.)

## 10. Must-keep (from D2, test-pinned)

1. `<script src="/_vercel/insights/script.js" defer></script>` on EVERY html page under `site/`; no script from a foreign origin.
2. All `data-metric` spans present exactly once per page with the frozen ids; unknown id = build error.
3. `site/index.html` version span is `checkOnly` for release.mjs; no second writer.
4. No hardcoded historical version literal in a new page unless added by exact path to `HISTORY_ALLOWLIST` in `scripts/release.mjs` (do not widen to a directory).
5. `check-unicode-safety`: no ZWSP/BOM/bidi/soft-hyphen in HTML or CSS.
6. CSP unchanged; no blob workers; `vercel.json` gets cache headers for `/assets`, `/img`, `/vendor` (P4).
7. `cleanUrls` serves `site/de/index.html` at `/de`; links use `/de` (no trailing slash) internally, canonical/hreflang use `https://session-orchestrator.com/de`.
8. 320px: nothing with `getBoundingClientRect().left < 0` except `.skip` and `.sr`.
9. Text contrast at least 4.5:1 for every text token in both themes.

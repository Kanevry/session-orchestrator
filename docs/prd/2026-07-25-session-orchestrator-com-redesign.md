# Feature: session-orchestrator.com — Full Redesign

**Date:** 2026-07-25
**Author:** Bernhard Götzendorfer + Claude (AI-assisted planning)
**Status:** Draft
**Appetite:** 6w (phased — P1 ships in the planning session itself)
**Parent Project:** session-orchestrator

## 1. Problem & Motivation

### What

`session-orchestrator.com` is replaced by a purpose-built marketing landing page that lives as a **standalone route segment inside the portfolio host app** — the same architecture that already serves `agentic-cutter.com` from `src/app/(standalone)/agentic-cutter/`.

The new page is a **dark, terminal-flavoured, English-only landing page** that a developer arriving from a plugin catalogue converts on within seconds, and that a non-technical reader can still understand end to end. Its centrepiece is a short pre-rendered **Remotion video** visualising the `research → plan → wave-execute → close` loop — built with the house Remotion process already proven on a sibling product's landing hero.

The 6-week arc is explicitly phased. Phase 1 (segment, design tokens, complete landing page, host routing, deploy path) ships immediately; the video render, SEO/legal foundation, on-site docs and the eval leaderboard follow as later phases of the same arc.

### Why

Three independent drivers converge, all evidence-backed:

**(a) The live site is not even the current repository state.** A fresh fetch of `https://session-orchestrator.com/` returns 4,411 bytes, `last-modified: Fri, 17 Jul 2026`, served by Vercel — with the title `session-orchestrator — structured multi-agent sessions for Claude Code`. The repository's `site/index.html` is 11,573 bytes and carries entirely different content (`Loop engineering for AI coding agents`, plus a four-harness install matrix). `site/.gitignore` lists `.vercel`, which identifies the deployment as a **manual `vercel` CLI push from a local directory** — there is no Git integration and no deploy stage anywhere in `.gitlab-ci.yml`. Every future content change silently fails to reach users until someone remembers to run the CLI by hand. This is a structural defect, not a content gap.

**(b) The page is the declared bottleneck of the entire distribution programme.** `docs/distribution/2026-07-18-distribution-options.md` ranks **C1 — "README + Landing Page repositionieren"** third in its recommended sequence, with the stated rationale that all listing channels (A1–A7, B1–B7 — Anthropic community marketplace, claudemarketplaces.com at ~300k visitors/month, claudepluginhub, cursor.directory, Pi gallery) convert against this page. Investment in those channels is capped by whatever this page can convert. No open issue tracks it: a scan of all 61 open issues returns zero hits for site/landing/marketing work.

**(c) The page is far below the standard of every neighbouring product.** The current implementation is a single HTML file with an inline `<style>` block: no build system, no design tokens, no sub-pages, no SEO foundation, no analytics, no legal pages. By comparison, `agenticbuilders-site` runs Next 16 / React 19 / Tailwind 4 / shadcn+radix / next-intl on an OKLCH token system deliberately designed as an anti-slop firewall (no hardcoded hex, exactly one accent colour, a single sanctioned dark-surface exception); `agentic-cutter.com` ships CSP nonces, next-intl, Vercel Analytics + Speed Insights, JSON-LD, canonical + hreflang, sitemap, robots, `llms.txt`, changelog and use-case pages. A product whose entire pitch is mechanical rigour currently presents itself through the least rigorous artefact in the portfolio.

### Who

**Primary — the developer arriving from a catalogue.** Already works with Claude Code, Codex CLI, Cursor or Pi. Landed from the Anthropic community marketplace, claudemarketplaces.com, cursor.directory, the Pi gallery or a GitHub reference. Wants to know within seconds: what does this do, does it run on my harness, what is the one line I paste. Their success is an install.

**Secondary — the non-technical reader.** A decision-maker, a curious peer, or someone following a recommendation. Cannot be expected to parse a terminal transcript, but must still come away with a correct mental model of what the framework does and why it is worth having. Their success is comprehension, and the page must deliver it through structure, motion and plain language — **not** through a separate simplified track.

The two are served by **one** page in one reading order, with the developer's conversion path never gated behind the explanatory layer. There is no audience toggle: making the visitor self-classify is a landing-page anti-pattern and doubles the maintenance surface.

## 2. Solution & Scope

### In-Scope

**Phase 1 — Foundation + landing v1 (this session)**

- [ ] New standalone route segment at `src/app/(standalone)/session-orchestrator/` in the host app, mirroring the proven `agentic-cutter` segment structure (own `layout.tsx`, own `page.tsx`, segment-scoped CSS)
- [ ] Dark terminal design-token set, scoped to the segment, expressed through the host app's existing token vocabulary — no hardcoded hex outside the token declaration block
- [ ] Complete landing page: hero, the loop explained (`research → plan → wave-execute → close`), guardrails/verification-gates section, four-harness install matrix with per-harness copy-to-clipboard, the `aiat-llm-eval` standard, footer
- [ ] Host routing in `src/proxy.ts`: apex-host rewrite for `session-orchestrator.com`, permanent (301) redirect from `www.`, CSP branch for the new route
- [ ] Remotion scaffold pre-wired so the video drops in without rework: `remotion/` composition directory, `theme.ts` with concrete hex tokens, `Root.tsx` with per-aspect-ratio `<Composition>` registrations, `remotion.config.ts`, render scripts, and a poster-only fallback that renders correctly while the assets do not yet exist
- [ ] Deploy via Git push (the host app is already Git-integrated with Vercel), verified on a Vercel preview URL
- [ ] Component tests for the landing sections following the host app's existing test conventions

**Phase 2 — The video**

- [ ] Remotion composition animating the loop: agents fanning out per wave, the inter-wave quality gate visibly closing, the final close
- [ ] Rendered in three aspect ratios (16:9 / 4:5 / 1:1) as h264 MP4 + VP9 WebM in bt709, plus a WebP poster from frame 0
- [ ] Embedded as a native `<video>` with **zero Remotion runtime** — `preload="none"` plus poster so the H1 remains the LCP element, WebM source before MP4, poster-only under `prefers-reduced-motion`

**Phase 3 — SEO, legal and measurement foundation**

- [ ] `sitemap.ts`, `robots.txt`, `llms.txt` / `llms-full.txt`, JSON-LD, canonical URLs
- [ ] Legal pages (imprint, privacy policy) — see the risk table; this is a legal obligation for an Austrian provider, not a nice-to-have
- [ ] Vercel Analytics + Speed Insights, and a funnel baseline that distinguishes "page seen" from "install command copied"

**Phase 4 — On-site documentation**

- [ ] Setup guides for Claude Code / Codex CLI / Cursor / Pi as real pages rather than GitHub markdown links

**Phase 5 — Leaderboard groundwork**

- [ ] Page scaffold for the `aiat-llm-eval` leaderboard against the existing record schema

**Phase 6 — Cutover and retirement**

- [ ] Point the `session-orchestrator.com` domain at the host app's Vercel project, activate the `www.` 301, retire the standalone Vercel project
- [ ] Freeze or remove `site/index.html` in this repository with a marker naming the new single source of truth

### Out-of-Scope

- **German localisation.** The product, its repository, CLI, documentation and every distribution channel are English. A second locale would double every copy change across all six phases for an audience that is overwhelmingly not German-speaking. The host app's next-intl infrastructure remains available if this is ever revisited.
- **An audience toggle ("I'm new here" / "show me the technical detail").** Rejected on landing-page principle: it transfers the classification burden to the visitor and doubles the content surface. One reading order serves both audiences.
- **An interactive "enter a task, see the wave plan" demo.** Either faked — unacceptable for a product positioned on honesty — or a real LLM backend with cost and abuse surface. Out of scope for this arc.
- **Illustrated characters and mascot-style metaphors.** Conflicts with the sober, evidence-first positioning and carries a high risk of reading as a generic SaaS template.
- **Any change to the plugin itself.** This feature touches marketing surface only. No skill, agent, hook or script behaviour changes.
- **Moving the site source into this repository.** Decided against: the host-app segment inherits the design system, routing, CSP, analytics and deploy path that would otherwise have to be rebuilt. A verified secondary blocker exists — `.gitignore:114` is `pnpm-lock.yaml` with no leading slash, so it matches at any depth; a nested `site/pnpm-lock.yaml` would be silently ignored and CI could not build reproducibly.
- **Backporting the new design to `site/index.html`.** The file is retired at cutover, not maintained in parallel.

## User Stories

### US-1 (→ Landing page / hero)
**Als** Entwickler, der aus einem Plugin-Katalog auf die Seite kommt, **möchte ich** binnen weniger Sekunden erkennen, was das Framework tut und ob es auf meinem Harness läuft, **damit** ich entscheiden kann, ob ich es installiere, ohne erst das Repository zu lesen.
- ↳ AC: §3 "Hero and first impression", §3 "Install matrix"

### US-2 (→ Install matrix)
**Als** Nutzer von Claude Code, Codex CLI, Cursor oder Pi **möchte ich** genau eine Installationszeile für *mein* Werkzeug sehen und mit einem Klick kopieren können, **damit** ich ohne Suchen und ohne Tippfehler starten kann.
- ↳ AC: §3 "Install matrix"

### US-3 (→ Loop visualisation)
**Als** Besucher ohne technischen Hintergrund **möchte ich** sehen statt lesen, wie aus einem Auftrag geplante Wellen mit Qualitätskontrollen werden, **damit** ich den Mehrwert verstehe, auch wenn ich kein Terminal bedienen kann.
- ↳ AC: §3 "Loop visualisation", §3 "Reduced motion and missing assets"

### US-4 (→ Guardrails section)
**Als** skeptischer Entwickler, der schon mehrere Agenten-Frameworks gesehen hat, **möchte ich** konkret belegt bekommen, was mechanisch erzwungen wird statt nur empfohlen, **damit** ich das Produkt von Prompt-Sammlungen unterscheiden kann.
- ↳ AC: §3 "Guardrails section"

### US-5 (→ Deploy path)
**Als** Betreiber der Seite **möchte ich**, dass jede gemergte Änderung automatisch live geht, **damit** der Live-Stand nie wieder unbemerkt hinter dem Repository zurückfällt.
- ↳ AC: §3 "Deploy path", §3 "Host routing"

### US-6 (→ Host routing)
**Als** Besucher, der `www.session-orchestrator.com` oder die alte Adresse aufruft, **möchte ich** ohne Fehlerseite auf der kanonischen Adresse landen, **damit** weder ich noch eine Suchmaschine auf einem toten Stand hängen bleibt.
- ↳ AC: §3 "Host routing"

## 3. Acceptance Criteria

### Hero and first impression
```gherkin
Given a visitor loads session-orchestrator.com on a 1280px-wide viewport
When the page renders above the fold
Then the H1 states what the framework does in one sentence
And the four supported harnesses (Claude Code, Codex CLI, Cursor, Pi) are named above the fold
And a primary call to action leading to the install section is visible without scrolling
And the H1 is the Largest Contentful Paint element
```

### Install matrix
```gherkin
Given a visitor reaches the install section
When they locate their own harness
Then exactly one install instruction is shown for that harness
And a copy control transfers that instruction to the clipboard
And the control confirms the copy visually within one second
```

```gherkin
Given a visitor whose browser denies clipboard access
When they activate the copy control
Then the command text is selected as a fallback
And no uncaught error reaches the console
```

### Loop visualisation
```gherkin
Given a visitor scrolls to the loop section
When the visualisation becomes visible
Then the four stages research, plan, wave-execute and close are presented in order
And the inter-wave quality gate is visually distinguishable from the stages themselves
And each stage carries a plain-language caption that does not presuppose terminal experience
```

### Guardrails section
```gherkin
Given a visitor reaches the guardrails section
When they read it
Then each claim names the mechanism that enforces it rather than asserting a property
And no claim is made that the repository cannot substantiate
```

### Host routing
```gherkin
Given a request arrives with host session-orchestrator.com
When the host app handles it
Then the request is rewritten onto the standalone segment
And the response carries a Content-Security-Policy header with a per-request nonce
```

```gherkin
Given a request arrives with host www.session-orchestrator.com
When the host app handles it
Then it responds 301 to the apex host
And the path and query string are preserved verbatim
```

### Deploy path
```gherkin
Given a change to the segment is merged to the host app's default branch
When the push reaches the remote
Then Vercel builds and deploys without any manual CLI invocation
And the deployed output matches the repository state for that commit
```

### Reduced motion and missing assets
```gherkin
Given a visitor whose system requests reduced motion
When the loop section renders
Then no autoplaying video plays
And the poster image is shown instead
```

```gherkin
Given the rendered video assets are not present in the build
When the page renders
Then the poster or static fallback is displayed
And no broken media element and no layout shift occur
```

### Accessibility baseline
```gherkin
Given the landing page in its dark presentation
When it is audited against WCAG 2.1 AA
Then no critical or serious violation is reported
And all body and interactive text meets the AA contrast ratio against its own background
And every interactive element exposes a visible focus indicator
```

## 3.A Acceptance Criteria (EARS)

### Feature Area 1 — Landing page

**Ubiquitous:**
- The landing page shall name all four supported harnesses above the fold.
- The landing page shall render its H1 as the Largest Contentful Paint element.
- The landing page shall express every colour through a declared design token rather than a literal value outside the token declaration block.

**Event-driven:**
- When a visitor activates a copy control, the page shall write that harness's install command to the clipboard and confirm it visually within one second.

**Unwanted behaviour:**
- If clipboard access is denied, then the page shall select the command text as a fallback and shall not surface an uncaught error.

### Feature Area 2 — Loop visualisation

**Ubiquitous:**
- The loop visualisation shall present the four stages in order and shall caption each in language that does not presuppose terminal experience.

**State-driven:**
- While the visitor's system requests reduced motion, the loop section shall present a static poster instead of autoplaying video.

**Optional feature:**
- Where the rendered video assets are present in the build, the loop section shall offer the WebM source ahead of the MP4 source.

**Unwanted behaviour:**
- If the rendered video assets are absent, then the loop section shall display the static fallback without a broken media element and without layout shift.

### Feature Area 3 — Host routing and deploy

**Event-driven:**
- When a request arrives with the apex host, the host app shall rewrite it onto the standalone segment and shall attach a Content-Security-Policy header carrying a per-request nonce.
- When a request arrives with the `www.` host, the host app shall respond 301 to the apex host preserving path and query.
- When a change to the segment reaches the default branch, the deployment shall occur without manual CLI invocation.

**Unwanted behaviour:**
- If a request targets the segment path directly rather than via the apex host, then the host app shall serve it without redirect loop.

## 4. Technical Notes

### Affected Files

**In the portfolio host app, on a dedicated branch in an isolated worktree:**

- `src/app/(standalone)/session-orchestrator/layout.tsx` — new. Segment layout: metadata, canonical URL, fonts, CSP nonce consumption, JSON-LD, analytics. Modelled on the existing `agentic-cutter` segment layout.
- `src/app/(standalone)/session-orchestrator/page.tsx` — new. The landing page composition.
- `src/app/(standalone)/session-orchestrator/terminal.css` — new. Segment-scoped dark token declarations, following the precedent of the existing segment's own stylesheet.
- `src/components/session-orchestrator/*` — new. Landing sections: hero, loop, guardrails, install matrix, eval, footer.
- `src/lib/session-orchestrator/canonical.ts` — new. Canonical origin and URL helper, mirroring the existing per-segment canonical module.
- `src/proxy.ts` — modified. Apex-host constant, host rewrite, `www.` 301, CSP route branch. **The single highest-risk edit** — it is shared infrastructure serving every host.
- `remotion/` — new or extended. `theme.ts` (concrete hex — Remotion renders in its own headless Chromium with no access to the app's Tailwind config or CSS variables), `Root.tsx` (one component, one `<Composition>` per aspect ratio), the composition itself.
- `remotion.config.ts` — new. `setOverwriteOutput(true)`, `setColorSpace('bt709')`; deliberately **no** global image format, which collides with the per-command WebP poster render.
- `package.json` — modified. Remotion dev dependencies and per-aspect-ratio render scripts.
- `public/session-orchestrator/` — new. Rendered video and poster assets (Phase 2).
- Tests alongside the new components, per the host app's existing conventions.

**In this repository:**

- `docs/prd/2026-07-25-session-orchestrator-com-redesign.md` — this document.
- `site/index.html` — retired at cutover (Phase 6), with a marker naming the new source of truth.

### Architecture

The host app already solves multi-domain hosting: `src/proxy.ts` rewrites `agentic-cutter.*` hosts onto `/agentic-cutter` and issues permanent redirects from the `www.` and legacy subdomain hosts onto the canonical apex, building the CSP per route with a per-request nonce. The new segment replicates that pattern verbatim with its own apex constant. Nothing novel is invented at the routing layer, which is precisely why this option was chosen.

**Design.** The segment is dark and terminal-flavoured throughout — a deliberate divergence from the light editorial standard used elsewhere in the portfolio, chosen because the primary audience is developers. The divergence transfers a burden: legibility for the non-technical secondary audience can no longer rely on a bright, familiar page, so it must be carried by information hierarchy, motion and plain-language captions. The anti-slop discipline is retained unchanged from the portfolio's token system: colours are declared once as tokens, exactly one accent is used and only on interactive or state-carrying elements, and no literal colour value appears outside the declaration block. Available typefaces are already loaded by the host app: Albert Sans (display), Inter (body), JetBrains Mono (code and terminal surfaces), Space Grotesk.

**Video.** The house Remotion process is adopted as-is rather than re-derived. Its three load-bearing rules, each learned the hard way in prior work: the composition's colours live in a dedicated `theme.ts` as concrete hex values because the renderer has no access to the app's styling layer; one component is registered as several `<Composition>`s that differ only in dimensions and a format prop, keeping a single source of truth for the animation; and the embed uses a **native `<video>` element with no Remotion runtime at all** — `preload="none"` plus a poster keeps the H1 as the LCP element, the WebM source precedes the MP4, reduced-motion users receive the poster only, and the page renders correctly before the assets exist.

**Isolation.** The host app currently carries 37 uncommitted files of unrelated payment work on a feature branch. All work happens in a **separate git worktree on a fresh branch off the default branch**, so that working tree is never touched — no branch switch, no stash, no shared index.

### Data Model Changes

None. The page is static marketing surface with no persistence.

### API Changes

None.

## 5. Risks & Dependencies

| Risk | Impact | Mitigation | Triage |
|------|--------|------------|--------|
| `src/proxy.ts` is shared infrastructure — a routing regression breaks every hosted domain, not just the new one | High | Additive change only (new host constant + branch); existing host branches untouched; the host app's routing tests must stay green before push; verify on a preview deployment before the domain moves | Implement |
| Concurrent session holds 37 uncommitted files in the host app | High | Isolated git worktree on a fresh branch off the default branch; the dirty tree is never touched, no branch switch, no stash | Implement |
| A dark, terminal-flavoured page is harder to make legible for the non-technical secondary audience | Medium | Plain-language captions on every stage; motion carries the explanation rather than jargon; AA contrast enforced as an acceptance criterion, not a preference | Implement |
| Legal pages (imprint, privacy policy) missing at cutover | High | An audit of a sibling product site found exactly this as its top finding: four legal routes returning 404 for an Austrian provider that simultaneously made a data-protection claim in its own FAQ. Phase 3 provides the routes; before the domain moves, link the host app's existing legal pages as an interim | Implement |
| Remotion render time and asset weight regress page performance | Medium | Short composition; poster-first embed with `preload="none"`; committed assets are size-reviewed; the fallback path renders identically without them | Implement |
| Domain cutover causes downtime or a stale-cache window | Medium | Old deployment stays live until the new one is approved on a preview URL; domain switch and `www.` 301 happen in one step; old project retired only afterwards | Implement |
| Adding Remotion dev dependencies slows the host app's CI | Low | Dev-dependency only; rendering is a manual script, never part of the build; assets are committed | Implement |
| Six-week arc invites scope creep across four later phases | Medium | Phases are sequenced and separately shippable; Phase 1 is independently valuable and ships first | Implement |
| Building the leaderboard page before the eval record set has content | Low | Phase 5 delivers scaffold only; the current site's own "coming later" framing is retained until real records exist | Defer |

### Dependencies

- **Vercel domain move** — operator step, browser-based. Blocks Phase 6 only; every earlier phase is verifiable on a preview URL.
- **Host app default branch** — the worktree branches from it; nothing else is required from the concurrent session.
- **`docs/distribution/2026-07-18-distribution-options.md` C1** — this feature is the implementation of that recommendation. Channel work A1–A7 and B1–B7 converts against this page.
- **`site/index.html`** — remains the live source until cutover; retired in Phase 6.
- **No open issue currently tracks this work** — a scan of all 61 open issues returned zero site/landing/marketing hits. The issue set created from this PRD is the first tracking for it.

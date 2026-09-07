# site/img — illustration provenance

All files in this directory are AI-generated illustrations (gpt-image-2). Originals are not tracked.

Generated 2026-09-07 via the local subscription gateway (`http://127.0.0.1:8319/v1/images/generations`), model `gpt-image-2`. Prompt = motif `core` + `style` + `negative` from `.orchestrator/tmp/site-review/d6/prompts.json`. Prompt hash = `shasum -a 256` of the motif's `core` string, first 12 hex chars.

| id | source model | generated | prompt hash | candidate chosen |
|---|---|---|---|---|
| hero-stations | gpt-image-2 (gateway) | 2026-09-07 | `2e751b2b848a` | 1 of 2 |
| reads-first | gpt-image-2 (gateway) | 2026-09-07 | `b8e81b9d23c5` | 1 of 2 |
| agree-scope | gpt-image-2 (gateway) | 2026-09-07 | `dbfb69b29d16` | r1 of r1/r2 |
| five-passes | gpt-image-2 (gateway) | 2026-09-07 | `6a6c16df0efa` | 4 of 4 |
| the-gate | gpt-image-2 (gateway) | 2026-09-07 | `eea3ba8d02ae` | r1 of r1/r2 |
| what-survives | gpt-image-2 (gateway) | 2026-09-07 | `ef1bfdac6d60` | 1 of 2 |

Notes:
- `five-passes`: first 2 candidates came back landscape (1536x1024) despite a `1024x1024` request, which would have clipped the pedestal row on center-crop. Regenerated with 2 more candidates (3, 4) and an explicit "tight square framing" addendum; both came back exactly square (1254x1254). Candidate 4 chosen for crisper edges and even margins.
- The gateway's response echoed a normalized `size`/`quality` (e.g. `"quality":"low"` regardless of the requested `medium`/`high`) for every call; visual output still matched the brief, so candidates were judged on the rendered image, not the echoed metadata.
- `hero-stations` returned landscape 1536x1024 (not the requested 1792x1024) for both candidates; aspect kept as-is per plan section 8, not forced to 16:9.
- Squares (`reads-first`, `agree-scope`, `the-gate`, `what-survives`) returned non-square (~1122-1186px on the short side); center-cropped to the short side before the three `cwebp` exports.
- regenerated 2026-09-07 after design review: `agree-scope` (was photographic, with a glossy black pen — the set's only black object and specular highlight — on a whiter ground) and `the-gate` (was a bright cyan seam instead of the ink-blue `#1E3A5F` the other five use) were regenerated in the shared diorama register with an explicit matte-cardstock / no-gloss addendum (`agree-scope`) and an explicit deep-ink-blue / not-cyan addendum (`the-gate`) appended to each motif's `core`. Both round-2 candidates (r1, r2) came back exactly square (1254x1254, no crop needed); r1 chosen for each — closer to the original composition and the set's uniform-putty, low-contrast diorama tone (r2 for both ran a touch higher-contrast / more literal in framing or detail).

Disclosure text used on-page: "AI-generated illustration (gpt-image-2)" (EN), "KI-generierte Illustration (gpt-image-2)" (DE).

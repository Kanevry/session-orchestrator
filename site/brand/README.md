# Session Orchestrator logo handoff

**A3, with the person and three terminal modules, is the final user selection.** Its chamfered housings and transparent `>_` symbols connect the identity to agentic coding. The person and common workbench remain unchanged. A1 and A2 remain comparison studies.

[Current comparison](index.html) · [Desktop screenshot](output/playwright/a-refinement-desktop.png) · [Mobile screenshot](output/playwright/a-refinement-mobile.png)

`preferred.json` points to **a3-terminalmodule**. The original A/B/C alternatives remain in their directories and [initial comparison](initial-directions.html).

## Files ready for use

Each of `a2-agentenmodule/` and `a3-terminalmodule/` includes:

- `mark-on-dark.svg`: warm white mark with lime person, transparent background.
- `mark-on-light.svg`: graphite on transparent pixels. Lime alone would lack contrast on warm white.
- `mark-mono-dark.svg` and `mark-mono-light.svg`: the same geometry in one ink.
- `wordmark-on-dark.svg` and `wordmark-on-light.svg`: lower-case **session orchestrator**, Space Grotesk 500, embedded local font.
- `mark-transparent-1024.png`: 1024×1024 RGBA, warm white/lime, for dark substrates.
- `mark-graphite-1024.png`: 1024×1024 with a solid `#101113` background.

The original A/B/C directories retain the same set of formats. The PNGs are browser rasterizations of the editable SVG geometry. They are usable for a thumbnail or social image; this handoff does not publish them anywhere.

## A3 geometry for Pencil

Master canvas: **64×64**. Keep the overall silhouette and the shared workbench as a single composition. `geometry.json` contains exact SVG path data. SVG IDs:

- `operator`: head and torso.
- `shared-workbench`: table, links and module housings.
- `module-left`, `module-center`, `module-right`: individually editable compound paths.

| Element | Geometry |
|---|---|
| Head | Circle centre (32,10), radius 5. |
| Torso | Starts (22,29), rises to y=27, a radius-10 shoulder arc reaches (42,27), closes at y=29. |
| Common workbench | Rectangle (7,34), width 50, height 6. |
| Three links | Rectangles at x=9,29,49 and y=40; width 6, height 8. They overlap the top of each housing. |
| Module origins | x=4,24,44; all y=46. |
| Housing shape | Width 16, height 14. The top-right and bottom-left corners are cut by 3 units. For x=4: `M4 46H17L20 49V60H7L4 57Z`. Shift x by 20 for the next module. |
| Prompt openings | Two transparent cuts per housing. Left chevron: `M7 50H9L12 53L9 56H7L10 53Z`. Left underscore: `M14 55H17V57H14Z`. Shift x by 20 and 40 for the other modules. The SVG uses `fill-rule="evenodd"`; preserve these transparent cuts in the master. |

**Suggested Pencil frame:** `SO / Brand / A3 Terminalmodule`. Preserve editable geometry; convert strokes to outlines only in an export duplicate when a destination requires that. No Pencil document was edited for this task.

The prompt symbols are custom editable geometry. A2 is retained with a single visor opening in each housing as the simpler comparison variant.

## Wordmark and scale

The wordmark canvas is **516×104**. The mark is translated by (10,12) and scaled by 1.25. Text begins at x=112, baseline y=65, size 42, weight 500, tracking −1.7. The lowercase spelling is `session orchestrator`. Font bounds were measured in the browser to avoid clipping and excess canvas whitespace.

At 16 pixels the silhouette, person and three modules carry recognition; the prompt symbols become very small. Prefer one ink at that size. At 32 and 64 pixels the chamfers and prompt symbols become clearer. Keep at least 8 units of external clear space on the 64-unit grid. Use the full wordmark at 200 pixels wide or above, the mark alone below that.

## Palette and rights

Graphite `#101113`, warm white `#F5F3EE`, lime `#D5F478`.

All mark geometry was created for this task. No icon pack or subscription asset is used. Wordmarks embed the existing `site/fonts/space-grotesk-latin.woff2`, unchanged. Space Grotesk is under SIL OFL 1.1; the full notice is in [FONT-LICENSE.txt](FONT-LICENSE.txt) and each wordmark SVG's metadata. The HTML comparisons use the site's local fonts. No external asset request is needed.

## Validation

Desktop comparison at 1440 pixels, mobile at 390 pixels, and a width check at 320 pixels. Actual 16/32/64 pixel samples are in the comparison. SVG XML, PNG dimensions and alpha-capable output types are checked. No horizontal overflow or broken images were found in the rendered comparison. The final identity is A3, following the user's preference for the code symbols. At 16 pixels the identity relies on its overall silhouette.

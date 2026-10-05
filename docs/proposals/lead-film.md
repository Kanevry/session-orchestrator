# Proposal: a short film for /lead

Status: proposal, nothing rendered. Target page: `site/lead/index.html`, section `#how`, where a commented-out `<figure class="fig film">` marks the slot.

## Goal

One film of 30 to 40 seconds that does for lead-session-orchestrator what the 34-second film in `#loop` of `site/index.html` does for session-orchestrator: show the situation, show the shape of the answer, end on the site. Same look, same pacing, same honesty labels. The product is not published yet, so the film says "coming soon" and shows no install command as if it worked.

## How the existing film was made

- `site/video/session-orchestrator-film.{webm,mp4}` was generated with `marketing/vidlab`: start images, image-to-video clips chained frame to frame (`lab.sh`), hard cuts with per-beat speed (`ladder.sh`) or crossfades (`smooth.sh`), text overlays from `mklabel.py`, one audio bed at -14 LUFS (`audiobed.sh`). Prompt files live in `marketing/vidlab/prompts/`, the shared look in `prompts/style.txt` (isometric miniature diorama, warm sand surfaces on charcoal, small white robots, lime cubes as work items, no text in the image).
- `marketing/remotion` is a separate, silent kit: a camera move over one still (`ProductionScene.tsx`), text scenes and a stage track (`ReleaseFilm.tsx`), the brand mark (`LogoMark.tsx`) and the colour and font tokens (`theme.ts`, identical to `site/assets/site.css`).

## Storyboard (about 36 s)

| Time | Scene | On screen | Proof shown |
|---|---|---|---|
| 0 to 5 s | The situation | Diorama in the house style: one human at a desk, three or four small workshops around him, each with its own robots and belt. Lights blink at all of them at once; the human turns from one to the next. Label: "Several sessions at once." | None. This is the problem, drawn, and labelled as illustration. |
| 5 to 10 s | They collide | Two robots from neighbouring workshops reach for the same lime cube on one shared table. One belt runs a cube through a red gate arch. Label: "Same checkout. Same question, five times. A red pipeline." | None. Illustration of the three collisions the README names. |
| 10 to 17 s | One lead | Camera rises. A raised control booth appears above the workshops, one small figure in it. Thin lines run from the booth down to each workshop. The human below steps back from the desk. Label: "One lead session keeps the overview." | Overlay, Remotion-style text scene: "You → lead → sessions". The same three-tier diagram as the hero SVG on `/lead`, drawn in the site tokens. |
| 17 to 25 s | Gates and the signed file | A gate arch at each workshop entrance. One arch stays closed, its lamp off. The human signs a single card and slides it into a slot in the booth; only then does one arch open. Label: "Nothing ships without your signed yes." | Overlay of real CLI output in IBM Plex Mono, recorded from a test run against a temporary `NAVIGATOR_CONFIG_DIR`: `navigator authority query acme-api merge_auf_main` printing `einzeln`, then the exit code table row "6 not measurable". Shown as text, not typed by a model. |
| 25 to 31 s | One round of questions | Small paper slips drift up from every workshop and stack in one tray in front of the human. He answers the stack in one go. Label: "Every open question, in one round." | Overlay of a rendered `navigator owner-queue render` output with invented example questions on `acme-api` (no real repositories, no names). |
| 31 to 36 s | End card | Booth and workshops settle, belts running. End card in the `ReleaseFilm.tsx` outro layout: "Several sessions. One lead. You decide." Below: "session-orchestrator.com/lead · coming soon". Footer line: "Illustrative workflow · AI-generated artwork". | The URL. No version number, no npm command. |

Rules carried over from `marketing/vidlab/README.md`: one action per clip, chain the last frame into the next start image, crop to 16:9 before submitting, name the empty places in each prompt so no extra figures appear, judge motion by watching it.

## What can be reused

- `marketing/remotion/src/theme.ts`: colours and fonts, unchanged.
- `marketing/remotion/src/LogoMark.tsx`: brand mark on the end card.
- `marketing/remotion/src/ReleaseFilm.tsx`: the `TextScene` component for the three labels and the overlay scenes, the `StageTrack` pattern (relabelled "Sessions / Lead / You") and the outro and footer layout. The film itself would be a new composition, for example `LeadFilm.tsx`, registered in `Root.tsx` next to `ReleaseFilm`, with its own `campaign.json` style input whose `planned` flag stays `true` until the npm package exists.
- `marketing/vidlab`: `img.sh`, `lab.sh`, `ladder.sh` or `smooth.sh`, `mklabel.py`, `audiobed.sh` and `loopify.sh` unchanged. `prompts/style.txt` as the shared look. New prompt files `prompts/l0.txt` to `l5.txt`, one per scene.
- The existing film figure markup in `site/index.html` (`<figure class="fig film">`, `preload="none"`, webm before mp4, poster, caption ending in "made with AI").

## Effort estimate

| Step | Estimate |
|---|---|
| Start images for six scenes, including one review round with the owner | 2 to 3 h |
| Image-to-video clips, two to three attempts per scene, chained | 3 to 4 h of wall time, mostly waiting |
| Remotion overlays (text scenes, diagram, CLI output captured from a test run) | 3 to 4 h |
| Edit, audio bed, webm/mp4/poster encode, `npm run verify`-style checks | 2 h |
| Embed in `site/lead/index.html`, extend `tests/site/structure.test.mjs` film checks to `/lead` | 1 h |

Total: roughly two working days. Cost: drafts through the local gateway at no cost; production clips at the per-clip rates measured in `marketing/vidlab/README.md` (for example about 0.95 USD per 8 s clip on `google/veo-3.1-fast` with `resolution: "1080p"`), so six scenes with retries land in the range of 10 to 20 USD. Size budget: aim below the current film (18 MB mp4, 16 MB webm), served with `preload="none"`.

## AI labelling

- The figcaption on `/lead` ends in "made with AI", like the film caption on `/`. `tests/site/structure.test.mjs` already enforces visible AI provenance for figures on `/` and `/de`; extend that check to `/lead` when the film lands.
- The film's own footer carries "Illustrative workflow · AI-generated artwork" for its full length, as in `ReleaseFilm.tsx`.
- The diorama scenes are illustrations of the idea, not recordings of the tool. Only the CLI overlays are real output, and they come from a test run against a temporary config directory with invented repository names.
- No claim in the film goes beyond the README of lead-session-orchestrator: no release date, no version, no numbers that are not in its docs.

## Open questions for the owner

1. Sound or silent? The film on `/` has sound; the Remotion kit is silent by design.
2. Should the film wait for the npm release, so the end card can show the install command instead of "coming soon"?
3. Is a German version wanted, given that `/lead` is English only for now?

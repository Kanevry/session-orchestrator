# Session Orchestrator motion kit

A silent, 22-second campaign film and a 9-second website loop, built locally with Remotion. The production facility is an AI-generated illustration of the workflow. It is not a recording of the plugin or evidence of a new capability.

The checked-in campaign defaults are **version 4.3, planned**, with **4.2.0 as the current release**. The footer retains that distinction throughout the film and poster. The persistent top-right campaign label is removed; the output filenames remain unchanged.

## Reproduce

Run from this directory with Node.js 24 or newer, FFmpeg/FFprobe and `cwebp` available on `PATH`. `cwebp` comes with the WebP command-line tools and encodes the lightweight website poster:

```sh
npm ci
npm run typecheck
npm run render
npm run verify
```

The package and lockfile are isolated here. They do not add runtime dependencies to the plugin or its website. Remotion and the font loader are pinned to `4.0.523`; the lockfile pins transitive dependencies. The first render may download Remotion's local headless browser. No hosted render service, external font request, music service or voice service is used.

`npm run assets` copies the production image and local fonts from `site/` into the ignored `public/` directory. `asset-receipt.json` records their source paths and SHA-256 hashes. Asset changes therefore enter the next render explicitly. The fonts retain their upstream licences in `site/fonts/LICENSES.md`.

Optional commands:

```sh
npm run studio
npm run render:release
npm run render:loop
npm run render:posters
```

Set `REMOTION_BROWSER` to a compatible local Chromium executable to use an existing browser. Rendering uses two concurrent workers; it does not interact with the user's browser tabs.

## Outputs

| File, relative to the repository | Format | Purpose |
|---|---|---|
| `site/video/session-orchestrator-4.3-preview.mp4` | H.264, 1920×1080, 30 fps, 22 s | Reviewable campaign, with current-release and illustration footers |
| `site/video/agent-production-loop.webm` | VP9, 960×640, 30 fps, 9 s | Small, text-free website loop |
| `site/video/agent-production-loop.mp4` | H.264, 960×640, 30 fps, 9 s | Website fallback |
| `site/video/agent-production-poster.webp` | WebP, 960×640 | Still fallback for reduced motion and unloaded video |
| `site/img/release-poster.png` | PNG, 1920×1080 | Campaign preview poster |

All videos are silent and have no audio track. The loop has no burned-in labels or version. Its camera follows a closed trigonometric path with matching value and velocity at the seam. Maximum enlargement is 4.3%; the facility remains visible.

## Campaign parameters

`campaign.json` contains the render input. `version`, `currentRelease` and `planned` are also editable in Remotion Studio. To render a different reviewed input without changing the defaults:

```sh
CAMPAIGN_PROPS=/absolute/path/to/reviewed-campaign.json npm run render:release
```

The footer does not add or imply features. Set `planned: false` only after the named release exists. That replaces the planned-campaign footer with the named version; the output filename then omits `-preview`.

The logo is deliberately isolated in `src/LogoMark.tsx`, which loads `staticFile('brand-mark.svg')`. The asset preparation step copies `site/brand/a3-terminalmodule/mark-on-dark.svg`, the final A3 direction with a human operator and terminal modules. To change direction, update that one source mapping and render again. No screenshot of the old logo is embedded in the compositions.

## Editorial timeline

| Time | Message |
|---|---|
| 0–4 s | Give your agents a working rhythm. |
| 4–9 s | Plan: read the project and agree the work. |
| 9–15 s | Go: independent work, then combine and verify. The platform distinction is visible. |
| 15–19 s | Close: record the result and unfinished work. |
| 19–22 s | Plan. Go. Close. Website and open-source licence. |

Keep text reveals frame-driven through Remotion. Do not introduce CSS animations, exaggerated crop movement, animated counters or decorative glow effects.

## Website integration

The parent site should supply its own accessible caption describing the illustration. Use the WebM with the MP4 as fallback, `muted`, `playsinline`, `loop` and the WebP poster. Do not autoplay for `prefers-reduced-motion: reduce`; show the poster. Avoid preloading the full campaign film on the homepage. This kit does not edit the website or publish the campaign.

## Reference

- [Remotion render CLI](https://www.remotion.dev/docs/cli/render): composition selection, input props, codec and CRF.
- [Remotion still CLI](https://www.remotion.dev/docs/cli/still): deterministic posters and review frames.
- [Local font loading](https://www.remotion.dev/docs/fonts-api/load-font): block rendering until local fonts are loaded.
- [Composition schemas](https://www.remotion.dev/docs/schemas): reviewed campaign parameters.

These official APIs were checked on 2026-09-10. `npm run verify` checks encoded dimensions, frame rate, duration, absence of audio, the loop size budget and the decoded first/last frame seam. Representative rendered frames are also inspected after the final asset render; a TypeScript pass alone is not a visual check.

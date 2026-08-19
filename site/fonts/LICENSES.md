# Font licences

All font files in this directory are self-hosted so the site makes **zero external
requests** — that is both a performance property and a privacy property, and the
privacy policy at `/datenschutz` asserts it. Do not replace any of these with a CDN
link without changing that page too.

| File | Family | Licence | Source |
|---|---|---|---|
| `archivo-var.woff2` | Archivo (variable, wght 100–900) | SIL Open Font License 1.1 | Google Fonts, latin subset |
| `ibm-plex-mono-400.woff2` | IBM Plex Mono 400 | SIL Open Font License 1.1 | Google Fonts, latin subset |
| `ibm-plex-mono-500.woff2` | IBM Plex Mono 500 | SIL Open Font License 1.1 | Google Fonts, latin subset |

The OFL permits redistribution of the font files as part of this site.

## Why Archivo + IBM Plex Mono replaced Space Grotesk + Inter (2026-08-19)

Two measured reasons, not taste:

1. **Both replaced families are flagged `overused-font`** by the impeccable detector
   (`npx impeccable detect https://session-orchestrator.com/` → 89 findings, Inter at
   46 % of body text). A face that every generated page reaches for is a tell.
2. **The new set is smaller and does more.** 3 files / 55,052 B against 7 files /
   141,540 B — a 61 % cut — while the variable Archivo covers the full 100–900 range
   instead of five fixed cuts. The current display idiom is thin and large
   (measured: temporal.io 68px/300, oxide.computer 65px/400); the old set had no
   weight below 400 at all, so that look was not reachable with it.

The old families (Space Grotesk, Inter, JetBrains Mono) were removed on 2026-08-19
once every page had been switched over and `grep` confirmed zero remaining
references — including the `<link rel="preload">` hints, which survive a
@font-face swap silently and would have kept fetching a font nothing declared.

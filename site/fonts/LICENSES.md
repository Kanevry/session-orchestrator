# Font licences

All font files in this directory are self-hosted so the site makes **zero external
requests**. That is both a performance property and a privacy property, and the
privacy policy at `/datenschutz` asserts it. Do not replace any of these with a CDN
link without changing that page too.

| File | Family | Licence | Source |
|---|---|---|---|
| `bricolage-grotesque-var.woff2` | Bricolage Grotesque (variable, wght 200–800) | SIL Open Font License 1.1 | Google Fonts, latin subset |
| `source-sans-3-var.woff2` | Source Sans 3 (variable, wght 200–900) | SIL Open Font License 1.1 | Google Fonts, latin subset |
| `ibm-plex-mono-400.woff2` | IBM Plex Mono 400 | SIL Open Font License 1.1 | Google Fonts, latin subset |
| `ibm-plex-mono-500.woff2` | IBM Plex Mono 500 | SIL Open Font License 1.1 | Google Fonts, latin subset |

The OFL permits redistribution of the font files as part of this site.

## Why Bricolage Grotesque + Source Sans 3 replaced Archivo (2026-09-07)

Two reasons, both checkable:

1. **Family look with the author's own site.** Bricolage Grotesque is the display
   face used there. Using it here makes the two sites read as one hand, which is the
   point: one person maintains both.
2. **Source Sans 3 for body text, because the obvious choices are flagged.** Inter,
   Geist and Instrument Sans are reported as `overused-font` by the impeccable
   detector, so a face that every generated page reaches for was ruled out. Source
   Sans 3 is a variable 200–900 text face that sits under Bricolage without competing
   with it.

Byte totals: old set 55,052 B in 3 files, new set 90,196 B in 4 files (measured
2026-09-07 with `wc -c`). The new set is larger because it carries two variable
families instead of one; all four files stay self-hosted and latin-subset.

The removed family (Archivo) was deleted on 2026-09-07 once every page had been
switched over. Check the `<link rel="preload">` hints when swapping a font: they
survive a `@font-face` change silently and would keep fetching a file nothing
declares.

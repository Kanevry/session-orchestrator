# Website imagery

The current hero is an original AI-generated illustration of a miniature agent production facility. It shows a human in an elevated control room directing planning, parallel work, inspection and handover. It is a visual metaphor, not a product screenshot or evidence of a running session.

Generated on 2026-09-10 with the built-in Codex image tool. The tool did not expose a model selector, so no specific model version is claimed. Art direction: a cutaway production facility, a human at the control desk above small ceramic and metal agents at distinct stations, graphite architecture, warm white materials, one restrained lime accent. No text, logos, neon gradients or generic interface collage. The owner chose the production-facility direction after reviewing a robot-arm concept.

`agent-production-1536.webp`, `agent-production-800.webp` and `agent-production-480.webp` derive from the same 1536 × 1024 source. The earlier `robotics-studio-*` assets are retained as unused comparison material.

Editable desktop, mobile and social layouts live together in the canonical `session-orchestrator.pen` in the main project checkout. That native source is a local handoff and is not versioned in this repository; the exported artwork and layout specifications are versioned here. The social frame is exported at 1200 × 630 to `site/og.png`. Regenerate exports after editing the design; do not edit the .pen file outside Pen.

## Lead page

`lead-control-room-1536.webp`, `-800.webp` and `-480.webp` are the hero of `/lead`, an original AI-generated illustration in the same series: one person in an elevated control room above four separate workshops, one indicator light per workshop and a stop lever. It is a visual metaphor, not a product screenshot. Generated on 2026-10-05 with the built-in Codex image tool, using the agent-production hero as style reference and the same art direction (graphite architecture, warm white materials, one restrained lime accent, no text or logos). No specific model version is claimed. All three derive from one 1536 x 1024 source.

The social preview `site/og-lead.png` (1200 x 630) derives from `lead-control-room-1536.webp` without cropping: `sips -s format png --resampleHeight 630`, then `sips --padToHeightWidth 630 1200 --padColor 111315`. `og:image` and `twitter:image` on `/lead` point to it.

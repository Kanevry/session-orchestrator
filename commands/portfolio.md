---
description: Aggregate cross-repo issue/MR/CI health across vault-registered projects into a single Markdown dashboard
argument-hint: "[--dry-run] [--repo <name>]"
---

# Portfolio

Aggregates open issues, MRs, and staleness signals across all vault-registered repositories and writes a structured dashboard to `<vault-dir>/01-projects/_PORTFOLIO.md`. The user invoked `/portfolio` with arguments: **$ARGUMENTS**

**Invoke the `portfolio` skill** (`skills/portfolio/SKILL.md`). It carries the argument validation (`--dry-run`, `--repo <name>`), the config/mode/vault gates, the dispatch into `scripts/lib/gitlab-portfolio/cli.mjs`, and the exit-code table; `skills/gitlab-portfolio/SKILL.md` owns the dashboard schema.

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-04-02

### Added
- 6 skills: session-start, session-plan, wave-executor, session-end, ecosystem-health, gitlab-ops
- 3 commands: /session, /go, /close
- 1 agent: session-reviewer (inter-wave quality gate)
- SessionStart hook with startup notification
- Soul personality system (soul.md)
- VCS auto-detection with dual GitLab + GitHub support
- 5-wave execution pattern with configurable agent counts
- Inter-wave Pencil design-code alignment reviews
- Ecosystem health monitoring (service endpoints + cross-repo scanning)
- Session Config system with 13 configurable fields
- User Guide, CONTRIBUTING guide, and example Session Configs

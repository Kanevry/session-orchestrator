# Bootstrap Gate

The gate check verifies:
1. `CLAUDE.md` exists and is non-empty.
2. The `Session Config` section is present.
3. `.orchestrator/bootstrap.lock` exists with `version` and `tier` keys.

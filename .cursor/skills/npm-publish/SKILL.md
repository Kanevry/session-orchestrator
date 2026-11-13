---
name: npm-publish
description: "Use when publishing this package to npm — a version release (npm publish), verifying the registry/pi.dev listing, or diagnosing npm auth failures (E403 2FA/token errors). Default staged route (write token in .env.local via a temp userconfig, owner approves on npmjs.com; Bypass-2FA only for the `--direct` route), the leakage gate before every publish, post-publish verification and marker/badge upkeep. Trigger on \"publish to npm\", \"npm release\", \"E403 publish error\"."
disable-model-invocation: true
---

# npm-publish

Canonical skill: `skills/npm-publish/SKILL.md`

Read that file and follow it exactly. Resolve relative links against `skills/npm-publish/`, not this wrapper.

Cursor has no Skill tool. Treat "invoke the npm-publish skill" as: Read `skills/npm-publish/SKILL.md`.

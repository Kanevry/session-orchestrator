# Fixture — a commented-out key inside `## Session Config`

Commenting a key out is the ordinary way to disable it. The reader
(`_extractConfigSection` → `_parseKV`) and the classifier
(`collectUnparsableLines`) must agree that the commented lines are documentation
— they once did not, and `enforcement: strict` below went LIVE while the block
reported clean.

## Session Config

persistence: true
enforcement: warn
waves: 5
vcs: gitlab

<!--
enforcement: strict
waves: 99
commented-out-key: commented-out-value
-->

test-command: npm test

## Other Section

Not part of the config block.

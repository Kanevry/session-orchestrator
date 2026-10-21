# Optional evidence candidates

The per-agent learning index can consume an explicitly supplied local candidate
artifact. This feature is **off by default**: no artifact discovery, provider
process, network request, model loading or additional source read occurs without
`--evidence-candidates`. The memory banner and the pure affinity function are
unchanged.

```sh
node scripts/print-learnings-index.mjs \
  --file-scope ./agent-scope.json \
  --task-text 'Find the adapter boundary' \
  --source-repo example-repo \
  --learnings ./.orchestrator/metrics/learnings.jsonl \
  --evidence-candidates ./candidates.json
```

The artifact must conform to `urn:local-evidence:candidate-artifact:1`, whose
boundary is validated with Zod in
`scripts/lib/learnings/evidence-candidates.mjs`. Its query text must exactly
match `--task-text`, and `query.source_repos` must contain only `--source-repo`.
Version 1 supports **private-audience artifacts only**. Do not commit or publicly
export actual artifacts: even IDs and relative paths can disclose private data.
The adapter ships no provider configuration, repository mapping or corpus.

An artifact is a regular JSON file of at most 128 KiB with at most 40 candidates.
Its envelope contains `schema_version: 1`, `status`, `query`, `freshness`,
`generation`, `source_generations`, `retrieval` and `candidates`. A non-`ok`
status must have no candidates. `generation` may be null on those results.
`freshness.mode` is `live_sources`; `checked_at` is an ISO timestamp.
`retrieval.requested` and `effective` distinguish `bm25`, `eg2` and `rrf`;
an explicitly reported semantic-to-BM25 fallback is usable when status is `ok`.

Only `learning` hints whose `source_repo` matches the explicit current repo
are considered. The adapter resolves `source_record_id` against `id` in the
current canonical JSONL. One source read supplies both the baseline pool and
candidate mapping; the existing JSONL parser and surface policy are reused.
It checks the original JSONL bytes (`sha256:<full-file-digest>`, retaining BOM and
CRLF), and rejects invalid UTF-8 before adding candidates. This generation is checked against
`source_generations[repo]`, `source_generation` and `source_sha256`, and binds
each `index_generation` to the envelope generation. Missing sources, generation
drift, ambiguous IDs and unmapped hints cannot add records. Candidate paths and
line metadata never select files to read. `skill` and `adr` hits remain separate
on-demand evidence; they are not converted into learning records.

Resolved original records extend the existing candidate pool without duplicates.
The existing selector still owns scope/global budgets, character limits,
confidence, expiry, time decay, delivered-provenance filtering and sanitizing.
No similarity value replaces confidence or grants execution/installation rights.
The usual index wrapper and retrieval pointer still refer to the explicit local
JSONL. A malformed, unavailable or stale artifact preserves baseline stdout;
status and counts appear only on stderr as `[evidence-candidates] {…}`. `accepted`
counts resolved hints before selection, not injected entries. The selector's
optional `evidence` field exposes the same diagnostics to programmatic callers;
without opt-in its return shape is unchanged.

This is candidate plumbing, not a proven ranking improvement. If the existing
pool already contains every eligible record, adding the same IDs changes nothing.
The integration test demonstrates a valid original record outside the default
200-record pool and checks rejection/fallback through the real CLI. Default or
permanent activation still requires a separate quality and workflow-benefit
evaluation. Source structure maps are complementary orientation aids; this
adapter neither implements nor replaces them.

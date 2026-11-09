# RAG eval baseline (Phase 0)

This file is the reference point for every later phase. It records what the eval
measures, how to run it, and which numbers were actually obtained.

## Status

| Item                                   | Result                                                               |
| -------------------------------------- | -------------------------------------------------------------------- |
| Eval set rebuilt                       | 115 cases (46 original + 69 new) in `evals/rag-eval.json`, version 2 |
| Retrieval runner (`bun run eval`)      | Implemented; **baseline not measured in this environment**           |
| Answer runner (`bun run eval:answers`) | Implemented; **baseline not measured in this environment**           |
| Database diagnostics                   | **Blocked**: `SUPABASE_DB_URL` host times out from the build sandbox |
| pgvector version                       | Not read (same connection block)                                     |
| `embedding_model` counts               | Not read (same connection block)                                     |

The Supabase Postgres host resolves but does not accept a connection from this
environment (`CONNECT_TIMEOUT` on port 5432). The provider credentials are
present, but retrieval cannot be scored without the database. No numbers below
are invented; the table is filled the first time the runners execute against a
reachable database.

## What the set covers

`evals/rag-eval.json` keeps all 46 original cases and adds:

| Category       | Cases | Purpose                                                             |
| -------------- | ----- | ------------------------------------------------------------------- |
| `exact-term`   | 15    | Original exact-name questions                                       |
| `vague`        | 16    | Original broad questions                                            |
| `scoped`       | 10    | Original industry-scoped questions                                  |
| `unanswerable` | 5     | Original fabrication checks                                         |
| `multi-turn`   | 16    | Follow-ups whose referent is only in the conversation (`turns`)     |
| `chart-table`  | 22    | Answers that exist only in tables, charts or diagrams               |
| `scope-mode`   | 10    | `focus` vs `all`; in-scope selection must not wall off the library  |
| `adversarial`  | 10    | Prompt injection, near-miss entities and unanswerable personal data |
| `projection`   | 11    | Proposal/projected claims vs delivered results, with `expectation`  |

Each case can carry:

- `turns`: the conversation before the final question. Retrieval must use the
  resolved standalone question; today it embeds the last turn as typed, which is
  the defect the baseline should expose.
- `evidence`: substrings a relevant **chunk** must contain (numbers, labels,
  diagram nodes). This is what separates chunk-level recall from "the right file
  was somewhere in the top 8".
- `mustMention`: short facts the answer must include.
- `expectation`: `projection` or `delivered`, so proposals cannot be scored as
  achieved outcomes.
- `scopeMode`: `focus` (default), `strict` (only when the UI toggle exists) or
  `all` (whole library).

Chart/table cases were written from `spike-output/` extracts, so every
`evidence` string is present in the extracted text today. The prompt's examples
"IndiGo ancillary revenue" and "Oberoi charts" have no matching file in the
library (the IndiGo deck is the MarTech personalisation discussion document, and
no Oberoi file exists), so they are covered by an adversarial near-miss case
rather than a fabricated expected file.

## Metric definitions

Retrieval (`bun run eval`):

- **document recall@k**: at least one expected file appears in the deduplicated
  top-k documents.
- **chunk recall@k**: at least one retrieved passage is from an expected file
  **and** contains one of the case's `evidence` strings; if no evidence is
  supplied, the file match is enough.
- **MRR**: reciprocal rank of the first relevant document.
- **nDCG@k**: binary document relevance, deduplicated by document, discounted by
  rank, normalised by the ideal ordering.
- **unanswerable false-positive rate**: share of unanswerable cases that returned
  any passage at all (the answer step must still refuse; this is the retrieval
  half of the check).

Answer (`bun run eval:answers`):

- **citation validity**: every `[n]` exists (`1..k`), and an LLM judge with a
  strict rubric marks every cited sentence supported by the passages it cites.
- **numeric faithfulness**: every number, percentage, currency amount or multiple
  in the answer normalises to a value that appears in at least one **cited**
  passage (`$2 million` = `$2M` = `2,000,000`; `2x` is distinct from `2%`).
  Deterministic; target 100%.
- **completeness**: share of the case's `mustMention` facts present.
- **refusal accuracy**: unanswerable cases must contain an explicit refusal.

## Commands

```sh
bun run test          # unit tests for the pure metric and scoring functions
bun run typecheck     # tsc --noEmit
bun run eval          # retrieval metrics; needs SUPABASE_DB_URL + provider keys
bun run eval:answers  # answer metrics; adds ANSWER_MODEL / JUDGE_MODEL overrides

# A/B the Qwen3 query instruction (documents stay un-prefixed)
bun run eval --prefix instruct

# Persist machine-readable results and print DB diagnostics
bun run eval --diagnostics --json evals/results/retrieval.json
bun run eval:answers --json evals/results/answers.json
```

`bun run eval` needs `SUPABASE_DB_URL` and cannot run against Lovable Cloud,
which does not expose a Postgres connection string. The runner authenticates as
an allowed member inside a transaction (`request.jwt.claims` + `set local role
authenticated`), so RLS applies exactly as it does for a signed-in user.

## Diagnostics for the PR description

Run these once a connection is available and paste the output into the PR:

```sql
select embedding_model, count(*) from public.document_chunks group by 1 order by 2 desc;
select extversion from pg_extension where extname = 'vector';
select count(*) from public.content_items;
select count(distinct content_id) from public.document_chunks;
select status, count(*) from public.ingestion_jobs group by 1;
```

```sql
explain (analyze, buffers)
select *
from public.search_chunks(
  (select embedding from public.document_chunks limit 1), -- replace with a real query vector
  'IndusInd solvency ratio',                              -- replace with a real query
  'bfsi',
  'IndusInd General Insurance',
  8
);
```

`bun run eval --diagnostics` prints the first three plus the `EXPLAIN` for the
first case that has both an industry and a customer filter.

## Baseline table

Fill this from `evals/results/retrieval.json` and
`evals/results/answers.json`; every later phase reports deltas against it.

| Metric                       | Baseline | Phase 1 | Phase 2 | Phase 3 |
| ---------------------------- | -------- | ------- | ------- | ------- |
| document recall@8            | pending  |         |         |         |
| chunk recall@8               | pending  |         |         |         |
| MRR                          | pending  |         |         |         |
| nDCG@8                       | pending  |         |         |         |
| unanswerable false-positive  | pending  |         |         |         |
| multi-turn document recall@8 | pending  |         |         |         |
| chart/table chunk recall@8   | pending  |         |         |         |
| scope-mode document recall@8 | pending  |         |         |         |
| citation support (judge)     | pending  |         |         |         |
| numeric faithfulness         | pending  |         |         |         |
| completeness (mustMention)   | pending  |         |         |         |
| refusal accuracy             | pending  |         |         |         |
| p50 / p95 end-to-end latency | pending  |         |         |         |

## Known limitations of the Phase 0 harness

- No query rewrite exists yet, so multi-turn cases intentionally measure the
  broken behaviour (last user turn embedded as typed). Phase 2 replaces
  `productionQueryForCase` with the rewritten standalone question.
- `focus` and `strict` are identical until Phase 2 adds the soft global arm.
- `--prefix instruct` is opt-in; production still sends the raw query.
- Answer generation has no finish-reason handling yet, so a truncated answer is
  scored as-is. Phase 3 fixes generation and then the answer metrics become
  meaningful rather than merely diagnostic.
- The judge is one extra gateway call per answer; `--no-judge` skips citation
  support but keeps every deterministic metric.

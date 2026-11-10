# RAG eval baseline (Phase 0)

This file is the reference point for every later phase. It records what the eval
measures, how to run it, and the numbers actually obtained against the live
library on 9 November 2026.

## Status

| Item                                   | Result                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| Eval set rebuilt                       | 125 cases (46 original + 79 new) in `evals/rag-eval.json`, version 2                  |
| Retrieval runner (`bun run eval`)      | Measured against the live library through Supabase REST                               |
| Answer runner (`bun run eval:answers`) | Measured: 125 cases, 9 empty generations (7.2%); see the answer table                 |
| Database diagnostics                   | `embedding_model` counts via REST; pgvector version and `EXPLAIN` need a Postgres URI |
| pgvector version                       | Not exposed by the Supabase REST API                                                  |
| `embedding_model` counts               | `qwen/qwen3-embedding-8b`: 4,749 chunks, no mixed-model rows                          |

The live project is Lovable Cloud, which exposes the Data API but not a Postgres
connection string. The runners therefore default to a Supabase REST backend: they
sign in as `LIBRARY_USER_EMAIL`, call the same `search_chunks` RPC the app calls,
and RLS applies exactly as it does for a signed-in member. A direct Postgres
backend is still used when `SUPABASE_DB_URL` is a real `postgres://` URI; that is
the only mode that can print the pgvector version and `EXPLAIN (ANALYZE, BUFFERS)`.

## What the set covers

`evals/rag-eval.json` keeps all 46 original cases and adds:

| Category       | Cases | Purpose                                                             |
| -------------- | ----- | ------------------------------------------------------------------- |
| `exact-term`   | 15    | Original exact-name questions                                       |
| `vague`        | 16    | Original broad questions                                            |
| `scoped`       | 10    | Original industry-scoped questions                                  |
| `unanswerable` | 5     | Original fabrication checks                                         |
| `multi-turn`   | 17    | Follow-ups whose referent is only in the conversation (`turns`)     |
| `chart-table`  | 31    | Answers that exist only in tables, charts or diagrams               |
| `scope-mode`   | 10    | `focus` vs `all`; in-scope selection must not wall off the library  |
| `adversarial`  | 10    | Prompt injection, near-miss entities and unanswerable personal data |
| `projection`   | 11    | Proposal/projected claims vs delivered results, with `expectation`  |

Each case can carry:

- `turns`: the conversation before the final question. Retrieval must use the
  resolved standalone question; today it embeds the last turn as typed, which is
  the defect the baseline exposes.
- `evidence`: substrings a relevant **chunk** must contain (numbers, labels,
  diagram nodes). This is what separates chunk-level recall from "the right file
  was somewhere in the top 8".
- `mustMention`: short facts the answer must include.
- `expectation`: `projection` or `delivered`, so proposals cannot be scored as
  achieved outcomes.
- `scopeMode`: `focus` (default), `strict` (only when the UI toggle exists) or
  `all` (whole library).

The chart/table set includes the IGH air-crew billing dashboard (an image-only
slide), the Oberoi financial and sustainability charts, and the IndiGo Fly++
ancillary-revenue charts, so extraction and vision gaps show up as misses rather
than being hidden by a file-level hit.

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
bun run eval          # retrieval metrics; needs Supabase + provider env
bun run eval:answers  # answer metrics; adds ANSWER_MODEL / JUDGE_MODEL overrides

# A/B the Qwen3 query instruction (documents stay un-prefixed)
bun run eval --prefix instruct

# Persist machine-readable results and print DB diagnostics
bun run eval --diagnostics --json evals/results/retrieval-baseline.json
bun run eval:answers --json evals/results/answers-baseline.json
```

The default backend signs in as the library member and calls the RPC under that
JWT, so no Postgres URI or service-role key is needed. Set `SUPABASE_DB_URL` to a
Postgres URI only when you want `--diagnostics` to print the pgvector version and
`EXPLAIN` plan.

## Diagnostics for the PR description

```sql
select embedding_model, count(*) from public.document_chunks group by 1 order by 2 desc;
select extversion from pg_extension where extname = 'vector';
select count(*) from public.content_items;
select count(distinct content_id) from public.document_chunks;
select status, count(*) from public.ingestion_jobs group by 1;
```

Measured through the Data API on 9 November 2026:

| Check                         | Result                                           |
| ----------------------------- | ------------------------------------------------ |
| `content_items`               | 208                                              |
| distinct indexed `content_id` | 187                                              |
| `document_chunks`             | 4,749                                            |
| `embedding_model`             | `qwen/qwen3-embedding-8b` (4,749; no mixed rows) |
| pgvector version              | not exposed by REST                              |
| `EXPLAIN (ANALYZE, BUFFERS)`  | not available without a Postgres URI             |

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

## Baseline table

Retrieval baseline measured on 125 cases, k = 8, production query path (context
hints included, no rewrite, no instruct prefix):

| Metric                       | Baseline     | Phase 1 | Phase 2 | Phase 3 |
| ---------------------------- | ------------ | ------- | ------- | ------- |
| document recall@8            | 83.6%        |         |         |         |
| chunk recall@8               | 69.1%        |         |         |         |
| MRR                          | 0.648        |         |         |         |
| nDCG@8                       | 0.695        |         |         |         |
| unanswerable false-positive  | 100.0%       |         |         |         |
| multi-turn document recall@8 | 58.8%        |         |         |         |
| chart/table chunk recall@8   | 67.7%        |         |         |         |
| scope-mode document recall@8 | 60.0%        |         |         |         |
| citation support (judge)     | 80.7%        |         |         |         |
| numeric faithfulness         | 90.7%        |         |         |         |
| completeness (mustMention)   | 74.1%        |         |         |         |
| refusal accuracy             | 93.3%        |         |         |         |
| empty generations            | 9/125        |         |         |         |
| p50 / p95 end-to-end latency | not measured |         |         |         |

Per-category retrieval baseline:

| Category       | n   | doc recall@8 | chunk recall@8 | MRR   | nDCG@8 |
| -------------- | --- | ------------ | -------------- | ----- | ------ |
| `exact-term`   | 15  | 93.3%        | 93.3%          | 0.736 | 0.785  |
| `vague`        | 16  | 87.5%        | 87.5%          | 0.669 | 0.724  |
| `scoped`       | 10  | 80.0%        | 80.0%          | 0.700 | 0.726  |
| `unanswerable` | 5   | n/a          | n/a            | n/a   | n/a    |
| `multi-turn`   | 17  | 58.8%        | 47.1%          | 0.490 | 0.512  |
| `chart-table`  | 31  | 100.0%       | 67.7%          | 0.754 | 0.816  |
| `scope-mode`   | 10  | 60.0%        | 50.0%          | 0.550 | 0.563  |
| `adversarial`  | 10  | n/a          | n/a            | n/a   | n/a    |
| `projection`   | 11  | 81.8%        | 54.5%          | 0.483 | 0.563  |

All 15 unanswerable/adversarial cases returned passages, so the retrieval
false-positive rate is 100%: today's system has no relevance threshold and cannot
say "no evidence" before generation. That is the Phase 2 target.

## Answer baseline

Measured on the same 125 cases with `ANSWER_MODEL=deepseek/deepseek-v4.1-flash`
and `JUDGE_MODEL=openai/gpt-oss-120b`, k = 8, 9 November 2026:

| Metric                       | Result                                           |
| ---------------------------- | ------------------------------------------------ |
| citation support (judge)     | 80.7% (247/306 judged sentences)                 |
| invalid citation markers     | 0                                                |
| uncited numeric sentences    | 16                                               |
| numeric faithfulness         | 90.7% (35 violations in 376 checked numbers)     |
| completeness (`mustMention`) | 74.1%                                            |
| refusal accuracy             | 93.3% (14/15 unanswerable and adversarial cases) |
| empty generations            | 9 (7.2%)                                         |

The only refusal miss is `adv-oberoi`, whose generation was empty; every answer
that was actually produced refused the unanswerable questions. The 100%
retrieval false-positive rate therefore does not become a fabrication rate: the
answer prompt refuses most questions whose passages do not support them. A
relevance threshold is still needed to avoid paying for generation and to stop
showing irrelevant citations.

Per-category answer baseline:

| Category       | n   | citation support | numeric faithfulness | completeness | refusal |
| -------------- | --- | ---------------- | -------------------- | ------------ | ------- |
| `exact-term`   | 15  | 96.2%            | 90.6%                | 100%         | n/a     |
| `vague`        | 16  | 87.3%            | 97.9%                | 100%         | n/a     |
| `scoped`       | 10  | 74.3%            | 70.0%                | 100%         | n/a     |
| `unanswerable` | 5   | 50.0%            | 100.0%               | n/a          | 5/5     |
| `multi-turn`   | 17  | 59.3%            | 90.2%                | 47%          | n/a     |
| `chart-table`  | 31  | 79.5%            | 94.9%                | 66%          | n/a     |
| `scope-mode`   | 10  | 76.7%            | 88.0%                | 70%          | n/a     |
| `adversarial`  | 10  | 50.0%            | 68.4%                | n/a          | 9/10    |
| `projection`   | 11  | 86.4%            | 88.6%                | 45%          | n/a     |

The numeric metric is deliberately strict and still flags some non-factual
tokens: fiscal-year fragments (`FY2023-24`), file names (`250312_…v1.0`), slide
labels, numbers split across PDF lines, and totals the model derived instead of
copying. Those flags are kept rather than special-cased, so the number is a
lower bound on faithfulness. The citation judge, not the numeric check, decides
whether a sentence is supported.

## Known limitations of the Phase 0 harness

- No query rewrite exists yet, so multi-turn cases intentionally measure the
  broken behaviour (last user turn embedded as typed). Phase 2 replaces
  `productionQueryForCase` with the rewritten standalone question.
- `focus` and `strict` are identical until Phase 2 adds the soft global arm.
- `--prefix instruct` is opt-in; production still sends the raw query.
- Answer generation has no finish-reason handling yet, so a truncated answer is
  scored as-is and an empty completion is recorded as a generation error. Phase 3
  fixes generation and then the answer metrics become meaningful rather than
  merely diagnostic.
- The judge is one extra gateway call per answer; `--no-judge` skips citation
  support but keeps every deterministic metric.

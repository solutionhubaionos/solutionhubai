# Deck pipeline audit

Where each reported defect originates, before the fix.

| # | Defect | Origin in code |
|---|--------|----------------|
| 1 | Leaked "Package volumes under low/base/high conversion" chart on every deck | `src/lib/documents/assumptions.ts` — `DEFAULTS` (50,000 passengers, 8% conversion, 3 nights, £120 ADR) and `buildAssumptionModel()` hardcode the chart and row values. `build.ts` injects the model whenever any plan uses a chart layout or the request mentions numbers/charts. `ensurePlanCoverage()` in `outline.ts` also *adds* an economics/chart slide for any request mentioning numbers or charts. |
| 2 | Internal-QA language, chunk IDs in tables, prompt echoed in notes | `deck.ts` `DECK_SYSTEM` includes the literal example column `"Documented capability"` and `"Evidence"`; `slides.ts` `ensurePartyRows()` writes the header `"What the library documents"`. `pptx.ts` `tableCellText()` deliberately keeps `[1]` reference numbers, and `REF_HEADER` reserves a column for `Evidence`/`Source`. `pptx.ts` `coverNotes()` writes `This deck answers: ${model.cover.request}`, echoing the user prompt. |
| 3 | Concepts treated as parties; selected party missing | `brief.ts` `briefSchema.partiesInvolved/keyEntities` accept free-form short strings from the brief model; `plausibleParty()` only rejects instruction verbs. `slides.ts` `ensurePartyRows()` then force-adds every free-form string as a party row. No validation against an entities table exists; `entities.ts` only resolves *customers already present in content metadata*. |
| 4 | "(continued)" and one-bullet duplicate slides | `pptx.ts` `textSlides()`, `tableSlides()`, `kpiSlides()`, `flowSlides()`, `timelineSlides()`, `comparisonSlides()` all render `${title} (continued)` after `paginate()` / `planTable()` split content. `slides.ts` caps bullets at 6×20 words, but the renderer's auto-page path is still reachable. |
| 5 | Hedging on client-facing slides | `deck.ts` `DECK_SYSTEM` explicitly tells the model to record gaps in notes, but no deterministic filter removes hedging ("not for … specifically", "no … is claimed") from slide copy. `slides.ts` has no banned-phrase pass at all. |
| 6 | One shape on every slide; label titles | `outline.ts` `defaultLayout()` returns a fixed layout per `SectionKind`; `DECK_SYSTEM` keeps "the plan is a contract" so there is no slide-level layout choice and no action-title contract. The renderer has 8 legacy layouts (`text`, `table`, `chart`, `kpis`, `flow`, `timeline`, `comparison`) and no hub/roadmap/ask/compare variants. |
| 7 | Retrieval misses a selected entity; multi-party deck reports "N of N sections had no usable evidence" | `retrieval.ts` `gatherDeckEvidence()` resolves entities through `match_customer_entities` only (metadata that exists), then issues per-entity searches. A wizard selection with no matching `customer_name` resolves to nothing, so its documents are never searched. `build.ts` `deckGateFor()` blocks when fewer than four slides have passages; `build.ts` has no gap flag per entity and no inferred-slide path. `documents.functions.ts` reads the stored scope but `brief.ts` treats wizard values as weak hints. |

## What the new pipeline changes

- `src/lib/documents/deck/` — planner (zod-validated storyline and 6–10 slides), per-slide writer (layout schemas with hard limits, claim IDs instead of numbers), deterministic critic then one LLM critic pass.
- `src/lib/documents/deck/claims.ts` — claim registry built from extracted numbers and the `claims` table; KPI/chart values resolve by ID in the renderer and untraced digits are rejected before render.
- `src/lib/documents/deck/entities.ts` — validated party list from wizard selections, message entities and the `entities` table; concept rows are never parties.
- `src/lib/documents/render/deck.ts` — 13 layout catalogue with native shapes/charts, action titles, tier tags and source footnotes; no auto-paging.
- `drizzle/migrations/0023_deck_entities_claims.sql` — `entities`, `claims`, `chunk_entities`, `entity_facts`, `entity_assets`, seeded from existing wizard options.
- `scripts/ingest-worker.ts` — structured entity/claim extraction per chunk with a resumable backfill script.
- `src/lib/documents/assumptions.ts` — deleted; no default assumptions object remains.

Implementation status, applied changes and the remaining plan are tracked in
[`docs/deck-pipeline-handoff.md`](./deck-pipeline-handoff.md).

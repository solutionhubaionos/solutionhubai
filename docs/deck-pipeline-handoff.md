# Deck pipeline handoff

**Status: IN PROGRESS — Phases 1–5 implemented, plus the consulting layout set
(maturity / three-horizon / layered architecture), the placeholder guard, a
regenerated DFW benchmark deck, and client Brand Kits extracted with OpenBrand
(§3.12). Remaining: rasterised slide previews (no LibreOffice in this
workspace) and human visual sign-off.**
Last updated: 2026-11-18. Task: make exported decks client-ready and pitch-worthy
(deck pipeline), then client-branded decks via OpenBrand (brand task, §3.12).
This document records the audit findings, every change applied so far, and the
remaining implementation plan so another agent can continue without re-reading
the whole codebase.

---

## 1. Read this first

- The working tree was **already dirty before this task**. Many modified and
  untracked files (chat UI, RAG, tests, `flow.md`, samples, etc.) belong to
  earlier work. Do not revert or reformat them. `git status` at the start of
  this task showed ~45 modified/untracked entries beyond the changes listed in
  §3.
- The only changes made for this task so far are in §3.
- Verification: `bun run typecheck`, `bun test` (131 tests) and
  `bun run check:deck` on a live-built deck all pass. Migration 0023 is
  **applied** to the live database and `bun run ingest:facts` has been run
  (213 documents, 5,811 claims). Its SQL was first executed twice against
  PGlite (Supabase functions stubbed, pg_trgm removed) to confirm it parses and
  is idempotent. Note: this workspace can reach the REST API as a library
  member but not the Postgres port (`SUPABASE_DB_URL` times out), so use the
  scripts, not `psql`.
- Phases 1–3 are implemented and wired for PPTX. Phase 4 (multimodal assets)
  and Phase 5 (web enrichment) remain; until then the pipeline uses deterministic
  extraction, validated names and explicit gaps.

### Product flow (as found)

`chat/route` → `planDocument` (`src/lib/documents/documents.functions.ts`) →
`buildExportBrief` (`brief.ts`) → `planOutline` (`outline.ts`) → confirm card →
`generateDocument` → `buildDocument` (`build.ts`) → `gatherDeckEvidence`
(`retrieval.ts`) → `generateDeck` (`deck.ts`, one call for all slides) →
`normalizeDeck` (`slides.ts`) → `verifyDeckClaims` (`verify.ts`) → `renderPptx`
/ `renderPdf` / `renderDocx` → quality gate in `documents.functions.ts`.

There is **no planner → writer → critic stage split today**. `build.ts` has one
deck call plus optional repair/enrichment/verify calls.

---

## 2. Audit findings (defect → origin)

Full one-pager: `docs/deck-pipeline-audit.md`. Code anchors:

| #   | Defect                                                                                                           | Origin                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Hardcoded "Package volumes under low/base/high conversion" chart on every deck                                   | `src/lib/documents/assumptions.ts:25` `DEFAULTS`, `:37` `buildAssumptionModel()`. Injected by `build.ts:240-245` whenever any plan uses `chart` or the request mentions numbers/charts/assumptions. `outline.ts:538-546` also force-adds an economics/chart slide for "numbers"/"charts" requests.                                                                                                                                                          |
| 2   | Internal-QA language, chunk IDs in table columns, prompt echoed in notes                                         | `deck.ts:59` example contains `"Documented capability"` + `"Evidence"` header; `slides.ts:80` `PROPOSED_PARTNER_ROLE`; `slides.ts:598` `ensurePartyRows()` writes `"What the library documents"`; `pptx.ts:115` `tableCellText()` deliberately preserves `[1]`; `pptx.ts:592` `REF_HEADER` reserves Evidence/Source columns; `pptx.ts:1279` cover notes write `This deck answers: ${request}`.                                                              |
| 3   | Concepts treated as parties; selected party missing                                                              | `brief.ts` `briefSchema.partiesInvolved/keyEntities` accept free-form strings; `plausibleParty()` only rejects instruction verbs. `slides.ts:598` `ensurePartyRows()` then force-adds every string as a party row. No `entities` table validation exists; `rag/entities.ts` only resolves customers already present in `content_items.customer_name` / `customers`.                                                                                         |
| 4   | "(continued)" slides and one-bullet duplicate titles                                                             | `pptx.ts` auto-pages in `textSlides` (`:1379`), `tableSlides` (`:1406`), `kpiSlides` (`:1507`), `flowSlides` (`:1554`), `timelineSlides` (`:1575`), `comparisonSlides` (`:1604`), `sourcesSlides` (`:1641`) and appends ` (continued)`. `slides.ts:76` caps bullets at 6×20 words but the pagination path remains reachable.                                                                                                                                |
| 5   | Hedging on slides                                                                                                | No deterministic banned/hedge filter in `deck.ts` or `slides.ts`; gaps are only _asked_ to go to notes in the prompt.                                                                                                                                                                                                                                                                                                                                       |
| 6   | Same shape every slide; label titles                                                                             | `outline.ts` `defaultLayout()` maps each section kind to one fixed legacy layout; `deck.ts` calls the plan a contract, so the model never chooses a slide layout. No hub, roadmap, before/after, ask or image layouts in `pptx.ts`.                                                                                                                                                                                                                         |
| 7   | Retrieval misses wizard-selected entity; multi-party decks blocked with "N of N sections had no usable evidence" | `retrieval.ts:639` `gatherDeckEvidence()` resolves entities only through `match_customer_entities` (existing metadata). A wizard pick with no `customer_name` resolves to nothing and is never searched. `build.ts:110` `deckGateFor()` blocks when fewer than 4 slides have passages; there is no per-entity gap flag or inferred-slide path. `documents.functions.ts` reads stored conversation scope, but `brief.ts` treats wizard values as weak hints. |

Legacy layouts in `types.ts` (`summary|bullets|text|table|comparison|kpis|chart|flow|timeline|raci`) are consumed by `pptx.ts`, `pdf.ts` and `docx.ts`. PDF/DOCX ignore layout ids and render blocks, so new layouts only need a PPTX branch plus ordinary blocks for PDF/DOCX.

---

## 3. Changes applied so far

### 3.1 `docs/deck-pipeline-audit.md` (new)

One-page audit mapping each reported defect to its code origin. Required by the
task before code changes.

### 3.2 `src/lib/documents/deck/types.ts` (new)

The content contract for the new pipeline. It is **not imported by anything
yet**, so it cannot affect runtime or existing tests.

Contents:

- `PLANNER_LAYOUTS`, `LAYOUT_IDS` — 13 planner layouts plus `cover`:
  `section-divider`, `context-bullets`, `kpi-cards`, `partner-hub`,
  `two-column-compare`, `table-compact`, `process-roadmap`,
  `chart-with-takeaway`, `before-after`, `shortcomings-table`,
  `collaboration-pointers-table`, `image-with-caption`, `next-steps-ask`.
- `EvidenceTier` — `sourced | inferred | illustrative`.
- `Claim` / `ClaimRegistry` — `id`, `metric`, `valueText`, `valueMin`,
  `valueMax`, `unit`, `context`, `sourceTitle`, `sourceYear`, `chunkId`,
  `entityName`. This is the contract that lets the renderer resolve every
  number by ID.
- `DeckChart` — `bar | doughnut | line | range`; points are
  `{ label, claimId }`, never raw numbers. `range` is a floating min–max bar.
- `DeckSlideContent` — discriminated union with hard capacity shapes:
  bullets ≤ 4, KPI cards 2–4, spokes per validated entity, tables ≤ 3 columns,
  roadmap 3–5 steps, ask ≤ 4 steps.
- `DeckSpecSlide` / `DeckSpec` — action title, purpose, tier, content, notes,
  source footnote, claim IDs, validated entity list, gaps, warnings.
- `DeckPlanSlide` / `DeckPlan` — raw planner output (`layout`, `actionTitle`,
  `purpose`, `evidenceRefs`, `tier`).

### 3.3 Dependencies

`bun add sharp react-icons` (requested by the task for Lucide icon PNGs):

- `package.json` / `bun.lock`: `sharp@^0.35.5`, `react-icons@^5.7.0`.

No icon module or renderer uses them yet.

### 3.4 Verification run (before the pipeline work)

- `bun run typecheck` → exit 0 (only the new unused types file added).
- No tests run; no existing behaviour changed.

### 3.5 Phase 1 and Phase 2 (implemented)

New modules under `src/lib/documents/deck/`:

- `catalog.ts` — layout catalogue, zod per-layout capacity schemas, planner and
  writer schemas, table header reject rule.
- `claims.ts` — deterministic claim extraction (`CL-<n>`, exact value text,
  min/max, unit, sentence context, source title/year, chunk/entity), number
  helpers, untraced-number detection, `{{CL-n}}` token resolution.
- `text-guards.ts` — banned provenance phrases, hedges, citation stripping,
  evidence-column removal, claim-shaped title checks and slide sanitisation.
- `entities.ts` — validated party list (wizard → brief → conversation → evidence
  metadata), concept/instruction/count rejection, role extraction.
- `evidence.ts` — evidence pack grouped by party, per-party claims, explicit
  gaps, planner/writer prompt renderers.
- `planner.ts` — 6–10 slide action-title plan, layout variety, two attempts and
  a deterministic seven-slide fallback.
- `writer.ts` — one call per slide, strict layout schema, claim-only numbers,
  two retries and a deterministic evidence fallback; concurrency cap 3.
- `critic.ts` — deterministic repairs (titles, capacities, tables, parties,
  untraced digits) then one skeptical-CXO pass that rewrites flagged slides
  once.
- `build.ts` — orchestrator: plan → write → critic → `DeckSpec` + ordinary
  blocks for PDF/DOCX.

Renderer:

- `src/lib/documents/render/deck.ts` — 13 layouts on PptxGenJS, native tables
  and charts, tier badges, source lines, two masters, no auto-paging, and
  `assertDeckTraceable` (every visible digit must resolve through a cited
  claim).
- `src/lib/documents/render/pptx.ts` — `renderPptx` dispatches to the new
  renderer when `model.deck` exists; the legacy renderer remains for fixtures.

Wiring:

- `src/lib/documents/build.ts` — PPTX exports run the new pipeline; PDF/DOCX
  keep the legacy section pipeline. No evidence returns the existing
  "No library passages…" gate instead of an invented deck.
- `src/lib/documents/types.ts` — optional `DocumentSection.deck` and
  `DocumentModel.deck`.
- `tests/fixtures.ts` — mock provider recognises the planner, writer and critic
  prompts.
- `tests/deck-pipeline.test.ts` — claims, party validation, sanitisation,
  end-to-end deck, renderer dispatch and planner-failure fallback.
- `tests/export.test.ts`, `tests/regression.test.ts` — updated to the deck’s
  action-title and DeckSpec contract.

Deliberate deviations from the plan so far:

- `planDocument` still returns the legacy outline for the confirm card. The deck
  planner treats those headings as the agreed storyline and sharpens them into
  action titles; a separate preview planner would add a second call and could
  disagree with the built deck.
- Ingest extraction is deterministic (known entity names + numeric claims),
  not the per-chunk LLM call the plan suggested. This keeps ingestion cost and
  latency unchanged and is enough for a claim registry; an LLM extractor can
  replace `extractChunkFacts` later behind the same RPC.
- `image-with-caption` renders a caption panel; image ingest and asset storage
  (Phase 4) are not implemented, and the planner is told images are absent.
- The outline-confirm card is removed (`SHOW_EXPORT_CONFIRM = false`). An
  explicit export request now plans and builds immediately; the composer hint
  still only prefills text, so nothing is generated without a user request.
  The `"+"` document menu builds immediately too, instead of leaving a card that
  nothing would advance.

### 3.6 Phase 3 — structured ingest, entities, retrieval (implemented)

Storage — `drizzle/migrations/0023_deck_entities_claims.sql`:

- `entities` (`company|airport|concept`), `claims`, `chunk_entities`,
  `entity_facts`, `entity_assets`; trigram and lookup indexes; RLS read for
  allowed members, writes service role/worker.
- Seeds companies from `customers` and `content_items.customer_name`, concepts
  from `industries`, and copies `customer_aliases` into `entities.aliases`.
  Free-form brief strings are never seeded.
- `match_entities(candidates, threshold, limit)` resolves spans against names
  and aliases (security invoker).
- `worker_attach_chunk_facts(content_id, facts)` resolves chunk ids by
  `chunk_index`, upserts entities, and replaces one document's claims/links in
  one call. Authorized by `is_ingestion_worker()`; safe to re-run.

Ingest:

- `src/lib/rag/facts.ts` — deterministic `extractChunkFacts`: known entity
  mentions, canonical customer name, and exact numeric claims with context,
  range, unit and source year.
- `scripts/ingest-worker.ts` — after chunks commit, reads canonical entities
  and calls `worker_attach_chunk_facts`; an attach failure is logged and never
  turns an indexed file into a failed job.
- `scripts/backfill-claims.ts` (`bun run ingest:facts`) — resumable per-document
  backfill with `--limit`, `--resume <id>` and `--content <id>`; logs counts
  only, never document text.

Deck data path:

- `src/lib/rag/entities.ts` — `loadValidatedEntities` calls `match_entities` and
  returns canonical type/aliases; a missing migration/table returns `[]` so
  decks still build.
- `src/lib/documents/deck/claims.ts` — `loadClaims` reads `claims` for the
  cited chunks, renumbers them to `CL-n`, then appends regex claims that the
  table does not already contain. DB rows win; no table means regex only.
- `src/lib/documents/deck/entities.ts` — `partyList` accepts validated rows and
  filters out anything the entities table calls a concept.
- `src/lib/documents/build.ts` — resolves validated entities, loads DB claims,
  and passes retrieval groups into `buildDeck`.
- `src/lib/documents/retrieval.ts` — `DeckEvidence` now carries `groups`
  (per-party final chunks, with `gap`) and `gaps` warnings. Group membership
  comes from the entity search, with metadata as fallback, so a legacy spelling
  cannot orphan a party.
- `src/lib/documents/deck/evidence.ts` — the pack prefers retrieval groups over
  `customerName`; a party with zero passages still gets an explicit gap.

Confirmation UI:

- `src/lib/documents/intent.ts` — `SHOW_EXPORT_CONFIRM = false`; the composer
  hint remains the only proactive surface and prefills text only.
- `src/routes/_authenticated/chat.tsx` — an explicit request appends a
  `generating` card and starts generation; the `"+"` menu does the same. The
  legacy `proposed`/planning path remains for old persisted threads but is no
  longer created.

Tests: `tests/deck-pipeline.test.ts` covers concept rejection, deterministic
fact extraction, DB-claim merging and group-first assignment;
`tests/scope.test.ts` asserts the no-confirmation contract. Full suite: 121
pass.

### 3.7 Migration 0023 applied and backfilled (live library)

Migration 0023 is applied to the live database. It first failed with
`column reference "aliases" is ambiguous`; the alias-merge update now qualifies
`e.aliases`, and the `unnest` aliases in `match_entities` were renamed to avoid
the same table-alias/column collision (`a(alias)`, `al(alias)`, `cand(value)`).
The SQL was executed twice against PGlite (Supabase functions stubbed, pg_trgm
removed) before applying.

`bun run ingest:facts` filled the registry from existing chunks:

- 213 documents, 4,813 chunks, 6,918 chunk→entity links, 5,811 claims.
- 171 of the 192 chunked documents have claims; 842 claims (14%) carry no
  entity (generic industry figures), 4,969 are attributed.
- 80 companies, 15 concepts, 0 airports in `entities`. Airport rows will appear
  when an airport is saved as a customer or attached by ingest.
- The 21 documents with no claims were sampled: they contain only dates, page
  numbers, section numbers, URLs, model ids or phone numbers. The one real
  format gap found is the multiplier form (`2x`), which the extractor does not
  claim because it requires a space or currency/percent marker.

### 3.8 Live-library deck run and the fixes it forced

A real pitch build for **Adani Airports** (brief → outline → `buildDocument` →
PPTX, no mocks) surfaced three defects that unit fixtures could not:

1. **The writer prompt never stated the layout's JSON fields.** It gave only
   prose capacity, then validated against the zod schema, so 10 of 10 slides
   failed, retried and were replaced by fallback copy (`centre` missing for
   `partner-hub`, `headers` missing for tables, `kind` missing for charts,
   bullets as strings, `sourceNote` over 120 characters). Fixed by
   `src/lib/documents/deck/shapes.ts` (`layoutShape`), included in
   `writerUserPrompt` and the retry message, with an explicit
   `{"content":…,"notes":…,"sourceNote":…}` wrapper. Skeleton wording says
   "Return one JSON object with three keys" because a bare "return this shape"
   made the model return the content object unwrapped. `sourceNote` is now
   accepted up to 400 characters and truncated to 120, so one long footnote
   cannot discard a slide. Length alone no longer fails a slide at all:
   `fitContent` in the same file trims every visible string to the layout cap
   (word boundary) before validation, because a model cannot count characters
   and seven of ten slides were spending a retry on a 130-character table cell.
2. **Unvalidated strings became parties.** The brief's `keyEntities`
   ("Charts", "KPIs", "our company", an invented "Adani Power") and the
   conversation resolver went straight into `partyList`. Once the entities table
   answers (`authoritative`), brief/conversation/evidence strings are only
   lookups for a validated company or airport: "Adani" resolves to "Adani
   Airports", and everything unmatched is dropped. Without the table the older
   name-shape filter still applies.
3. **An invented company drove retrieval.** `export entities union` searched
   "Adani Power", pulling a different customer's passages into the deck. Brief
   key entities are now kept only when the user's own words contain them, and
   retrieval names come from `retrievalEntityNames` (wizard picks, client,
   validated companies) once validation answers. `match_entities` is trigram
   based, so near neighbours ("Zurich Airport", "Adani Power") also had to be
   grounded: `groundedEntities` keeps a validated row only when the request (or
   an alias spelling) names it, or the wizard/client does. A score threshold was
   not enough — a brief that lists the neighbour produces an exact match at 1.0.
   The RPC's `spellings` also had to stop echoing `matched_name`: for a near
   neighbour that span is another company's name, so "Adani Power" carried
   "Adani Airports" as its own spelling and grounded itself.
4. **A repaired action title carried an untraced figure.** The critic's
   `claimShapedTitle` falls back to the planner's `purpose` sentence, which can
   say "approve a 90-day pilot"; the figure never went through `sanitiseTitle`,
   so `assertDeckTraceable` refused the whole deck at render time. That fallback
   now refuses a purpose containing digits and re-sanitises the shaped title.

Verification: `bun run typecheck`, `bun test` (131 pass), and a final live build
for Adani Airports that completed with **zero writer retries**: parties
`["Adani Airports"]`, retrieval searched only that name, 32 claims available to
the writer, 10 planned slides built, and `scripts/check-pptx.py
/tmp/live-adani.pptx` → 11 slides, 1 native chart, 3 layouts, OK. The critic
still rewrote two slides and stripped unsupported figures from four, which is
the intended behaviour.

Known issues left: the planner occasionally exceeds the 600-character
`storyline` limit or plans 11 slides (one retry each); broad `keyEntities` such
as "Four high-impact airport operations" are filtered out by request grounding,
so retrieval relies on the client and named parties; and brief `openItems` echo
generic gaps ("Industry", "Sector", "Audience") into the deck's open items.

### 3.9 Phase 4 measurement (no code change yet)

Everything below was measured on the live library through the REST API and on
downloaded samples (`/tmp/p4`, 189 MB: 5 pptx, 5 pdf, 5 docx, 3 xlsx). No
extraction dependency was added to the repo for this pass.

**Inventory (211 visible items).** pptx 123 (4,741 MB), pdf 37 (158 MB), docx 32
(5.4 MB), xlsx 10 (0.28 MB), mp4 9 (348 MB). 4,771 chunks / 5,802 claims /
**0 vision chunks**. xlsx and mp4 are never ingested (the worker's supported
list is pdf/docx/pptx); 21 documents hold no chunks at all (10 xlsx, 9 mp4, 2
pptx).

**What the current extractor drops.**

| File type | Recovered today                                                          | Dropped                                                                                                                                                                                                             |
| --------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pptx      | prose, `a:tbl` tables, speaker notes, native chart caches, SmartArt text | every picture on a slide with >400 characters (`LOW_TEXT_SLIDE_CHARS`); pictures under 24,000 bytes (`MIN_FIGURE_BYTES`); alt text unless "clean"; >8 images/doc (`VISION_MAX_IMAGES`); no slide-picture OCR at all |
| pdf       | full text layer                                                          | nothing meaningful — 5/5 samples have complete text layers, no page without text, no document below 120 chars/chunk (no scanned PDFs in the library)                                                                |
| docx      | mammoth body                                                             | headers/footnotes/comments; images negligible (max 1 image, 40 KB)                                                                                                                                                  |
| xlsx      | nothing (`unsupported`)                                                  | everything                                                                                                                                                                                                          |
| mp4       | nothing                                                                  | everything                                                                                                                                                                                                          |

Native pptx charts: **0 of 5** sampled decks — charts are pasted pictures.
Figure pictures ≥24 KB: 206 across the 5 decks, **129 of them (63%) sit on
slides with >400 characters and are discarded**: IndiGo 0/0, AI Maturity 22/26,
Oman Arab Bank 15/29, DubaiSouth 22/30, Kotak **70/121** (116.8 MB).

Slides that carry no indexable text at all: `AIONOS_Supply_Chain_AI (Dark
Theme).pptx` (18 full-slide PNGs, 0 chunks), `Airbus Account plan 1.pptx` (13
slides, 0 chunks), `AIONOS_for_FedEx.pptx` (860 chars, 0 claims),
`End_to_End_Guest_Journey…pptx` (71 chars for 3 slides). Together that is 44
slides contributing nothing but 931 characters.

**Media pitfalls found.** The Kotak deck embeds three videos
(`ppt/media/media2-4.mp4`, up to 90 MB) and an EMF; `readMediaFiles` keys off the
extension and falls back to `image/png`, so a vision pass would upload MP4s.
Totals: 51 vision candidates in Kotak, 18 in SupplyChain, 13 in Airbus.

**Vision/OCR model comparison** (real slide pictures, downscaled to 1280 px JPEG
≈13–17 KB, `VISION_PROMPT` unchanged, gateway `TOKENFACTORY_API_BASE`):

| Model                              | Latency/image                   | Accuracy on real slides                                                                    | Cost/image     | Verdict             |
| ---------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------ | -------------- | ------------------- |
| `deepseek/deepseek-v4.1-flash`     | —                               | 503 "server had an error" on **every** real slide (PNG and JPEG, 640–1600 px)              | —              | unusable for images |
| `google/gemma-4-31b-it`            | 3.6–14 s                        | accurate, noisier (logo/tagline fragments)                                                 | ≈$0.00015      | usable fallback     |
| `qwen/qwen3-omni-30b-a3b-instruct` | 1.7–9.5 s, one 155 s outlier    | accurate headings, bullets and figures; reads `8,754 aircraft backlog`, `400+ consultants` | $0.0003–0.0008 | best speed/quality  |
| `zai-org/glm-ocr`                  | 4 s on one JPEG, 103 s on a PNG | garbles labels (`AIONCS`, `OTIP`, `SLAM/anch`) at JPEG size                                | ≈$0.00007      | too unstable        |
| `tencent/hunyuanocr`               | 524 after 129 s                 | —                                                                                          | —              | unusable            |

The gateway returned 500/502/524 on roughly one call in three today, always
recovered by a retry; the multi-minute tails mean a per-image timeout and a
single retry are mandatory. Downscaling to 1280 px JPEG is what makes this
cheap: the same slide as a 1,219 KB PNG took 26–103 s, as a 13 KB JPEG 4–10 s.

**Measured yield** (qwen3-omni, 1280 px JPEG, then the real
`extractChunkFacts`):

| Deck        | Today                              | Vision pass (sampled slides)                                                  |
| ----------- | ---------------------------------- | ----------------------------------------------------------------------------- |
| FedEx       | 860 chars, 10 chunks, **0 claims** | 4 images → 4,786 chars, **9 claims**                                          |
| Airbus      | **0 chunks**                       | 4 images → 2,437 chars, **4 claims**                                          |
| SupplyChain | **0 chunks**                       | 6 images → 3,968 chars, 0 claims (promo/architecture slides carry no figures) |

That is ~660–1,200 characters and 0–2 claims per visual slide, i.e. the 44
image-only slides would stop being invisible to retrieval, and 4 of 8 sampled
image-only slides produced numbers the deck writer can cite. Captions stay
`metadata.approximate: true`, so the critic still treats those figures as
unverified.

**Structured-extraction tools, measured on the same files:**

| Tool                                                                                                        | Install weight                      | Result                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| current extractor                                                                                           | 0                                   | 14–288 ms/doc for pptx, 605 ms for a 5 MB pdf; 0 chars for xlsx and image-only pptx                                                               |
| MarkItDown 0.1.x (`pip install markitdown[pptx,docx,pdf,xlsx]`, ≈60 MB, needs Python+libreoffice-free deps) | Python runtime in a Bun worker      | FedEx 1,850 chars, DubaiSouth 28,128, ACLEDA pdf 32,023, **SupplyChain 979 chars of image placeholders (no real text)**, RiskRegister xlsx 26,154 |
| native xlsx read (fflate, ~100 lines, already a dependency)                                                 | 0                                   | RiskRegister 24,522 chars / 307 text cells / 3 sheets; other samples 3,762 and 494 chars                                                          |
| Docling                                                                                                     | ≈1 GB models + torch, 3 GB RAM here | not run: no scanned PDFs to justify OCR/layout models                                                                                             |
| PyMuPDF                                                                                                     | —                                   | not run: AGPL, and pdf text extraction already complete                                                                                           |
| Tesseract                                                                                                   | needs root/apt                      | not run: OCR-only (cannot read a chart), no scanned PDFs                                                                                          |
| LibreOffice (`soffice`)                                                                                     | not installed                       | not required: source slides are already pictures, no page rendering needed                                                                        |

**Library-scale estimate.** 123 pptx × ~20 slides ≈ 2,400 slides, 35% low-text
(41/117 in the sampled decks) ≈ 840 visual slides. At 4–10 s/image that is
1–2.3 hours of gateway time once, ≈$0.5 at $0.0006/image; a Kotak-sized deck
(25 visual slides) costs ≈$0.015 and a few minutes.

**Recommendation (waiting for go-ahead on the two italic items).**

1. _Vision pass for pptx pictures, using `qwen3-omni` at 1280 px JPEG with a
   60 s timeout and one retry_: select pictures by rendered area and pixel size
   (≥8% of the slide and ≥480 px wide) instead of the >400-character rule, so
   Kotak's 70 discarded figures are considered but logos/icons are not; raise
   the per-document cap from 8 to ~20; keep `RAG_VISION` opt-in.
2. Explicitly skip video, audio and EMF/WMF media rather than labelling them
   `image/png`.
3. ~~Native xlsx extraction (text cells plus sheet names, marked `table`), no
   new dependency.~~ **Applied 2026-11-17** (see §3.9a); the vision pass is on
   hold at the user's request.
4. Keep OCR models out (measured unstable) and never route images to the
   `deepseek` answer model.
5. No change for pdf/docx: they are already fully extracted.
6. _Re-ingest scope_: existing pptx need a re-ingest to gain captions. Start
   with the 4 image-only decks and the 2 pptx with no chunks, then the rest.

The privacy question in one line: this sends images of client decks to the same
gateway that already receives their text (embeddings and answers), but pictures
are new data egress and must be accepted explicitly before implementation.

### 3.9a xlsx extraction applied (2026-11-17)

- `src/lib/document-format.ts` recognises `xlsx` (extension and the spreadsheet
  mime type); `scripts/ingest-worker.ts` and `scripts/download-library.ts`
  include it in their supported sets.
- `src/lib/rag/extract.ts` reads the workbook natively with `fflate`: sheet
  names come from `workbook.xml` resolved through `workbook.xml.rels`, text
  from `sharedStrings.xml` and inline strings, rows are laid out by column
  reference so sparse rows stay under their headers, and each sheet becomes one
  `table` section headed by its name (`metadata.source: "sheet"`, rows,
  columns). The chunker already repeats the first line as the header.
- Number formats are resolved through `styles.xml` / `cellXfs`: percent cells
  read `5%` (not `0.05`), date serials read `2024-01-01` (with time when the
  serial has a fraction), `$`/`€`/`£` formats keep the symbol, booleans read
  TRUE/FALSE, error cells and formula text are dropped while cached values are
  kept. Rows are capped at 2,000 per sheet with a warning.
- `EXTRACTOR_VERSION` bumped to `2026-11-17.1`, so the same files hash
  differently and a requeue re-ingests them.
- `FilePreviewDialog` routes `xlsx` to the existing "download the original"
  message instead of rendering an empty frame.
- Verification: `bun run typecheck`; `bun test` 137 pass (6 new in
  `tests/xlsx-extract.test.ts`); ESLint clean on changed files. On the three
  real samples (0.28 MB total, 3 sheets / 1 sheet / 1 sheet): 12,741 + 2,285 +
  10,647 chars of risk register, 2,093 chars of commercial terms (dates,
  `5%`/`7%` WHT and VAT, `$5,636,648` currency cells), 4,021 chars of
  questionnaire text; 5–115 ms per workbook; 14 chunks for the risk register
  with the header repeated on every continuation.

### 3.10 PPTX preview regression: blank black frame (2026-11-17, fixed)

**Symptom.** Opening a generated deck from the in-app **Open** dialog showed an
empty black rectangle. The file itself was fine: PowerPoint opens the download.

**Diagnosis.** Not the preview component and not the xlsx edit (`documentFormat`
still returns `pptx` for `.pptx`; the xlsx branch only added a new case).
Reproduced outside the app in a throwaway page that loads
`node_modules/pptx-preview/dist/pptx-preview.umd.js` against a real generated
deck: `viewer.preview()` **resolved** and left one `background: rgb(0, 0, 0)`
container with zero slides (a library pptx rendered 10 slides in the same page,
so the engine works). `pptx-preview` discovers slides from `[Content_Types].xml`
and loads every declared part; the generated deck declared 45 overrides of which
**10 did not exist** — `ppt/slideMasters/slideMaster2..11.xml`. PptxGenJS emits a
slide-master override per slide while writing the single master it was given, so
the reader threw on the missing part mid-load, `_loadContentTypes` swallowed it,
and the viewer drew an empty black frame. PowerPoint ignores content types and
follows relationships, which is why the download opened normally.

Cause of the regression: `renderPptx` moved from the hand-written OOXML skeleton
(HEAD) to `pptxgenjs@4.0.1` in the new pipeline — every generated deck now
carries the dangling declarations. Reproduced with a plain 3-slide PptxGenJS
deck (no masters at all), so it is upstream, not the new renderer's masters.

**Fix.** `src/lib/documents/render/pptx-package.ts` `dropDanglingOverrides()`
unzips the written package, removes `<Override>` entries whose part is absent,
and re-zips; a package with nothing missing is returned untouched.
`renderDeck` and `renderPptx` both apply it, so library and generated previews
are covered. Nothing about the design changed: the same deck that rendered black
now renders its cover and all 11 slides.

**Preview guard.** Both preview dialogs now reject a viewer that yields no
`.pptx-preview-slide-wrapper` and fall back to the existing "could not be
displayed" message — the Download button stays next to it, matching the xlsx
precedent. A malformed package can no longer present as a blank black frame.

**Verification.** `tests/pptx-package.test.ts` pins the upstream quirk (the raw
package really has dangling overrides), asserts they are dropped while slides
survive, and that a clean package is returned unchanged; the existing
`renderDeck` test now asserts every declared part exists. Browser check on
`/tmp/live-adani.pptx`: before = 0 slides, black; after = 55 wrapper nodes, cover
visible. `bun run typecheck`, `bun test` (139 pass), ESLint clean.

### 3.11 Phase 5 — gap handling and enrichment seam (applied, no provider)

**Decision.** The user chose **no search provider**: nothing is queried, no key
is needed, no client data leaves the workspace. The seam exists so a provider is
a single adapter later. Facts are labelled with an **asterisk** plus a source
footnote.

**How a gap worked before.** `buildEvidencePack` marked a party with zero
chunks `gap: true`; the planner was told to propose its role; the writer's
fallback emitted "role and scope to agree with them" with no claims; the
renderer stamped `PROPOSED` and no source line. `entity_facts` existed in
migration 0023 but nothing read it.

**What was added.**

- `src/lib/documents/deck/enrichment.ts` — `EntityFact`, the `EntityFactProvider`
  seam (`search({ entity, topic })`, topic fixed to
  `ENTITY_FACT_TOPIC`), `storedFacts()` reading `entity_facts` joined to
  `entities`, `enrichEntityFacts()` (cache first, provider only when fresh facts
  are stale, 90-day window, never throws, drops facts naming another company),
  `factsForParties()`, `claimsFromFacts()`, `factSourceNote()`, `factPublisher()`.
- Facts become ordinary `Claim`s with `origin: "public"` and ids continuing the
  registry (`nextClaimNumber`), so the writer can cite them and
  `assertDeckTraceable` still applies — the guard is not bypassed. Number
  extraction is shared with passages through the new `claimsInText()`.
- `claimValue()` prints a public fact as `40 countries*`; `resolveClaimTokens`
  uses it; KPI cards and PDF/DOCX blocks use it too. `slideSourceNote()` emits
  `* Public source: nkproteins.com, 2026`, or that plus `Source: <library doc>`
  when a slide mixes both.
- `EvidenceParty.facts` carries the facts; the pack keeps `gap: true`, so the
  `PROPOSED` badge stays — a public fact never presents as library evidence. The
  planner line becomes `PARTY: X (no library passage; sourced public facts
below)`; `claimsForPrompt` marks the claim id with `*`.
- `src/lib/documents/build.ts` loads facts per party before `buildDeck`; a
  missing table, RLS denial or a provider failure leaves the party a gap.

**Not done.** No provider adapter, no key, no network call — by decision. With
`entity_facts` empty, decks behave exactly as before (honest gaps, no invented
content). Inserting curated rows is enough to fill a gap today.

**Verification.** `tests/deck-enrichment.test.ts` (7 tests): claim numbering and
origin, asterisk rendering, footnote composition (public, mixed, none), gap kept
with facts, no provider = no query and no fabrication, provider receives only
entity + fixed topic and its foreign-company facts are dropped, a throwing
provider leaves the gap. `bun run typecheck`; `bun test` **146 pass**; ESLint
clean.

### 3.12 Client Brand Kits via OpenBrand (2026-11-18, applied)

**What replaced what.** The earlier client-brand path was a hand-written
HTML/CSS scraper in `src/lib/brand/` (signals, CSS votes, logo heuristics). It is
gone. `openbrand@^0.2.3` is now the extraction engine, used as a library — no API
key, no hosted API, no browser. Audit result: **no Playwright, Chromium or
Puppeteer dependency or reference exists** anywhere in `src/`, `scripts/`,
`tests/`, `package.json` or `bun.lock`, so there was no browser dependency to
uninstall; the only dependency change is `openbrand` (its tree is cheerio,
probe-image-size and a nested sharp 0.34.5; the app already ships sharp 0.35.5).

**Service boundary.** `src/lib/brand/openbrand.ts` is the only file that imports
the package. It normalises the documented payload
(`brand_name`, `logos[].url/alt/type/resolution`, `colors[].hex/usage`,
`backdrop_images[].url/description`) and maps its error codes
(`ACCESS_BLOCKED`, `NOT_FOUND`, `SERVER_ERROR`, `NETWORK_ERROR`,
`EMPTY_CONTENT`) to our explicit statuses. It also classifies errors the package
**throws** (its internal `fetch` rejection surfaces as `TimeoutError` or
"Unable to connect") as retryable `NETWORK_ERROR` rather than a package bug.
`src/lib/brand/fetch.ts` owns the pipeline and never parses the client's HTML:
normalise → SSRF/DNS guard → OpenBrand → validate and download assets through our
guarded fetch → rasterise the logo with sharp → assemble the kit. Raw payload is
kept as size-capped JSON in `extraction.rawJson` for debugging/reprocessing.

**Brand Kit schema.** `BrandProfile` (in `src/lib/brand/types.ts`) carries
`sourceUrl`, `domain`, `name`, `logo`, `favicon`, `colors` (primary, secondary,
accent, background, surface, text pairs, neutrals), `fonts`, `chartSeries`,
`candidateColors` (every extracted hex plus its positional hint), `backdrops`,
`approved`, `status`, `source`, `extraction` provenance and separate `overrides`.
Statuses are `completed | partial | requires_manual_input | failed`;
`completed` requires a name, a logo and a colour, and an empty payload is never a
success. OpenBrand's `usage` is a **rank hint**, not a semantic role: the user
assigns roles in the review panel, house defaults cover missing roles and are
listed in `signals`, and no colour is invented. There is no typography signal in
the package, so safe house faces are used and flagged.

**API and persistence.** `extractBrand` (server function) validates the URL,
rate-limits 5/minute/user, reads a 30-day per-domain `brand_profiles` cache, and
writes only `completed`/`partial` results. `prepareBrandBackdrop` downloads one
chosen backdrop as a capped JPEG. Migration
`drizzle/migrations/0024_target_client_and_brand_profiles.sql` adds the cache
(RLS for allowed users) and `conversations.target_client`. A cached profile is
always returned `approved: false`; approval is per user and happens when the
target client is saved, stored in the owner-only conversation row that every
export reads server-side. Overrides live apart from extraction, so a
re-extraction cannot wipe a manual logo, hex value or backdrop.

**Frontend.** `src/components/chat/TargetClientBar.tsx` (rendered by
`src/routes/_authenticated/chat.tsx`) takes the URL, extracts on blur/paste,
shows detected brand name, logo, candidate swatches (each assignable to a role),
four editable colour swatches with **typed HEX validation**, detected fonts,
backdrop choices, manual logo upload and a neutral-theme escape. Save client is
the approval act; a failed extraction leaves manual pickers and never blocks a
deck.

**Presentation wiring.** `src/lib/documents/build.ts` calls
`brandTheme(profileWithOverrides(...), { requireApproval: true })`; an unapproved
kit yields `null` and the renderers keep the house theme. `src/lib/brand/theme.ts`
maps one `BrandTheme` into `deckPalette` (PPTX) and `documentPalette` (PDF/DOCX),
including contrast-safe text pairs and chart series, so every template changes
at once. `render/pptx.ts`/`render/deck.ts` apply the palette, fonts, logo and
optional cover backdrop. The LLM never supplies brand colours.

**Security.** User URLs must be http(s), credential-free and public; every DNS
answer is checked, redirects on our asset fetches are followed manually with the
guard re-run per hop, returned assets are re-validated (scheme, content type,
2 MB/6 MB caps, 10 s timeout) and stored inline rather than hotlinked. No
credentials exist to expose, and no OpenBrand/cheerio code is present in the
client bundle.

**Verification.** `bun run typecheck`; `bun test` **183 pass** (30 in
`tests/brand.test.ts`, plus a new `tests/deck-pipeline.test.ts` case asserting
that approved brand colours replace house blue in the rendered PPTX XML).
`bun scripts/verify-brand-extraction.ts` against real sites: iana.org `partial`
(logo, no colours), example.com `requires_manual_input` (its only favicon is
`data:,`), IBM `partial`, Stripe `completed` (~6–9 s), W3C `completed` (SVG
logo), Zurich Airport `completed` (raster logo, ~14–20 s), unreachable host
`failed` — all hard assertions pass. `NITRO_PRESET=node-server bun run build`
succeeds and bundles OpenBrand + cheerio server-side with sharp external and no
brand code in `public/assets`.

**Deployment notes and limitations.**

- The default `bun run build` (Cloudflare-target nitro) still fails on the
  **pre-existing** `@napi-rs/canvas` native binary (`stream did not contain valid
UTF-8`); no OpenBrand or sharp error appears. The Node target builds cleanly.
- Brand extraction needs a Node runtime (sharp, cheerio, `node:dns`), like the
  existing chart/PDF pipeline, so Cloudflare Workers is not a viable target.
- OpenBrand's own page fetch uses `redirect: "follow"` and falls back to
  `r.jina.ai` for thin pages, so our SSRF guard covers the submitted origin but
  not the package's internal redirect chain, and thin pages send the public URL
  through a third-party reader. Closing both needs a pinned dispatcher/proxy,
  deliberately not reimplemented here.
- Worst-case extraction is ~30 s (two 15 s library timeouts); its internal page
  and asset fetches are not configurable from outside the package.
- Small favicons often yield no usable colour, which surfaces honestly as
  `partial`/`requires_manual_input` rather than a guessed palette.
- The rate limit is an in-process window (single-instance assumption); the domain
  cache is an optimisation and a failed write cannot fail extraction.

### 3.13 Branded decks: alternating brand / white surfaces (2026-11-18, applied; superseded by §3.14)

**Rule.** A branded deck uses two canvases drawn from the client's own palette:
white and one solid brand colour. Cover, section dividers and the closing ask
always wear the brand colour; content slides alternate white and brand by slide
index, starting white, so the rhythm is balanced and deterministic. Headings,
subheadings, chart titles/marks and accent rules take the kit's colours. The
opt-in cover backdrop is not drawn on branded decks because a full-bleed image
would break the alternation; the logo and accent rules carry the brand instead.

**Palette schema.** Input is `BrandProfile.colors` (`primary`, `secondary`,
`accent`, `background`, `surface`, `textOnLight`, `textOnDark`, `neutrals` plus
user overrides) and `chartSeries`. `brandTheme` derives `BrandTheme.colors`
(`primary`, `primaryDark` from `ensureDark`, `secondary`, `accent`, `background`,
`surface`, `text`, `textMuted`, `onPrimary`, `border`) in `#RRGGBB`. The deck
renderer then derives, per render:

- `BRAND_BG`: the first of `primaryDark` → `primary` → `secondary` with ≥ 4.5:1
  contrast against white (fallback `primaryDark`), stripped to six hex digits.
- `BRAND_INK`: `readableTextOn(BRAND_BG)`, i.e. white or the house dark ink.
- Page ink per slide: black on white canvases; `BRAND_INK` on brand canvases;
  muted ink is a 22–30 % mix of the ink into the surface; the hairline border is
  a 22 % ink mix.
- `brandHighlights`: primary-dark → primary → secondary → accent, deduped and
  filtered to ≥ 4.5:1 on white, used for headings and chart accents on white
  slides (fallback `primaryDark`, never an invented colour).
- White members: `C.white`/`C.light` are forced `FFFFFF`, so cards, tables and
  badges keep black copy regardless of the page behind them.
- `SERIES`: the approved `chartSeries` unchanged; chart/plot areas use the
  current canvas, titles use the heading colour, axes/data labels use page ink.
- `blue`/`teal`/`amber`/`coral` remain the kit's primary/secondary/accent
  accents for rules, dots and markers.

**Implementation.** `src/lib/documents/render/deck.ts` holds `BRANDED`,
`BRAND_BG`, `BRAND_INK`, `BRAND_SURFACE` and `HIGHLIGHTS`. `useSurface(brandCanvas)`
swaps `navy`/`slate`/`onDark`/`onDarkMuted`/`border` before a slide is drawn;
`chrome()` chooses the canvas (`dark` slides and odd indices = brand, even = white)
and writes an explicit `p:bg`, and `cover()` uses the brand canvas. Because the
footer colour therefore differs per page, branded masters omit the baked footer
and `chrome()` draws the footer/page number with the current surface ink instead.
Card copy uses `cardInk()`/`cardMuted()`, card headings use `cardHeading()`, and
page headings use `headingColor()`; all card text is black on white. Previously
dark filled elements — table header, partner hub centre, number markers,
maturity/horizon/layered labels, tier badges — become white with a brand outline
and black/brand text.

**Unchanged.** A deck with no approved brand keeps the house navy cover, teal
accents and dark dividers, so existing non-client output does not change. The
legacy DocumentModel renderer and the PDF/DOCX palettes are untouched.

**Verification.** `bun run typecheck`; `bun test tests/deck-pipeline.test.ts`
27 pass (brand case asserts the canvas sequence `7A1022, FFFFFF`, black card
copy and brand headings); full `bun test tests` 183 pass; Prettier clean.
Generated XML inspected across cover, divider, KPI, chart, table, maturity,
horizons, layered and ask slides: backgrounds alternate `7A1022` / `FFFFFF`,
white-slide body copy is `000000`, brand-slide copy is `FFFFFF`, headings are
`7A1022`/`B31B34`/`0E7C66`, chart series stay the approved palette, and the
kit's extracted `background`/`surface` (`F4F4F4`/`F7F0F1`) never become a canvas.

---

### 3.14 Branded decks: black copy on a white page (2026-11-18, applied)

**Rule (final).** Text is always black and the background is always white; the
client's colours appear only in headings, subheadings and the text inside
graphs/images/charts. This replaces the alternating brand/white surfaces of
§3.13: no slide wears a brand colour behind its copy, so any extraction stays
readable without per-surface ink swaps.

**Theme (`src/lib/brand/theme.ts`).** `brandTheme` fixes the neutrals:
`background`/`surface` = `#FFFFFF`, `text`/`textMuted` = `#000000`; the
`background`, `surface` and `textOnLight` extraction overrides are no longer
read. The kit keeps `primary`/`primaryDark`/`secondary`/`accent`, the derived
`onPrimary`, the tinted `border` and the approved `chartSeries`. `deckPalette`
maps the body-ink token `navy` to `000000` and `documentPalette` maps `ink` to
`#000000`, so PDF/DOCX body copy is black while headings keep
`accent`/`accentDark`. The review panel drops its now-inert Background swatch
and "Use as… Background" role.

**DeckSpec renderer (`render/deck.ts`).** Under a brand `useSurface()` always
applies the white-canvas tokens (`navy`/`slate`/`onDark`/`onDarkMuted` = black,
border `E2E2E2`), `pageBackground()` returns white, `chrome()` no longer
alternates canvases and `cover()` uses the white canvas. Chart text: the title
keeps `headingColor(0)`, axis labels and legend use `headingColor(1)`, and data
labels stay black because they sit on the coloured series fills. `BRAND_BG` and
`BRAND_INK` are gone; `HIGHLIGHTS` and the highlight helpers stay.

**Legacy renderer (`render/pptx.ts`).** Same rule for older models: the
cover/section/closing masters turn white under a brand, `onDark`/`onDarkMuted`
become black, and `HIGHLIGHT` (the kit's `primaryDark`) colours master/slide
titles, chart titles, KPI values, flow/timeline labels and table header bands.
Body copy, captions and table cells arrive black from the theme tokens.

**Unchanged.** House decks keep their navy cover, dark dividers and grey
captions; the PDF/DOCX layouts themselves are untouched.

**Verification.** `bun run typecheck`; `bun test tests` 196 pass (the brand
case now asserts backgrounds `FFFFFF, FFFFFF`, black copy present, kit colours
`7A1022`/`0E7C66` still present, house blue absent, and no brand colour behind
any `<p:bg>`); Prettier clean on all touched files.

### 3.15 Deck retrieval: sector documents, not the sentence (2026-11-18, applied)

**Cause.** The deck pool resolved entities from the brief/user sentence:
`"airlines"` trigram-matched `Indigo Airlines`, `"pitching services"` became a
query, and the target name was searched as a hard entity. The live Ethiopian
Airlines run logged `entities: ["Indigo Airlines"]`, `targetPassages: 0`,
`peerPassages: 2` — the crash was fixed, but the deck was still built from a
handful of off-target passages.

**Entities (`src/lib/rag/entities.ts`).** `distinctiveEntityName` removes
`airline(s)`, `airways`, `airport(s)`, `aviation`, `group`, `ltd`, `limited`,
`inc`, `plc`, `services`, `pitch`, `deck`, `proposal` and the existing legal
suffixes before matching. An empty remainder is never sent to
`match_customer_entities`, so `"airlines"` cannot resolve to a customer.
`entityCandidates` returns distinctive remainders, and the full mention
re-ranks returned rows, so `"Zurich airport"` prefers Zurich Airport over Zurich
Insurance. The same rule applies to `loadValidatedEntities`.

**Retrieval (`src/lib/documents/retrieval.ts`).** `gatherDeckEvidence` is now
metadata-first:

1. Enumerate up to 8 `content_items` in the target sector, pitch decks /
   proposals / case studies first, newest first, round-robin across customers so
   8 slots cover the sector instead of one account. Widen to adjacent industries
   (shared customer) then the whole library when fewer than 3 documents exist;
   log the pool source.
2. One short query per plan section, built only from the section kind's topic
   (`problem`, `solution`, `approach`, `proof`, `roadmap`, ...). No user sentence
   and no target client name.
3. Hybrid search k = 50 per section — 25 was mostly title-only slide chunks.
4. Group by `content_id`, max 3 passages per document, interleave documents,
   dedupe across sections; add each candidate document's best solution/offer
   passage (longest usable fallback).
5. Gate at ≥ 8 usable passages from ≥ 2 documents; otherwise return an explicit
   refusal listing the documents found. Target vs peer passages are logged; a
   target with no library material adapts peer passages.

**Sources (`src/lib/documents/build.ts`).** `usedChunkIds` now unions the
section `evidenceIds` with the claim chunk IDs, so the Sources list includes
every passage the slides cite (previously only claim-linked chunks).

**Error surfacing and logs.** `generateDocument` includes the real error class
when it fails; `DocumentCard` shows the server message rather than a generic
retry line. `extractBrand` logs start / cache hit / complete / failure with
domain, status and duration; `saveConversationScope` logs the saved industries,
company count and target brand status.

**Live verification (2026-11-18).** Ethiopian Airlines, `airlines`, real provider
and library: 8 candidate documents across Riyadh Air / United / Avincis / Adani
Airports / IndiGo; 8 section queries; 23 passages from 14 documents;
`targetPassages: 0`, `peerPassages: 23`; 9 slides; 54,960-byte PPTX (10 pages);
`scripts/check-deck.ts` OK on 8 reference names; redactor loaded 91 names and
scrubbed without the previous `SyntaxError`. `bun test tests` 202 pass.

---

## 4. Important code facts for the next agent

- `DocumentModel` / `DocumentSection` live in `src/lib/documents/types.ts`.
  `DocumentSection` already has `layout`, `takeaway`, `speakerNotes`,
  `blocks`, `warnings`. Extend it with optional `deck?: DeckSpecSlide` and add
  optional `deck?: DeckSpec` to `DocumentModel`; the new PPTX renderer can
  prefer `model.deck`, while PDF/DOCX keep using `sections[].blocks`.
- `renderPptx(model, config)` in `src/lib/documents/render/pptx.ts` is the only
  PPTX entry point used by `documents.functions.ts`. Dispatch there: if
  `model.deck` exists, call the new `render/deck.ts`; otherwise keep the legacy
  renderer for fixtures/back-compat.
- Provider seam: `completeWithBudget(messages, options, budget, temperature,
{ label })` from `src/lib/documents/provider.ts`. Use `llmBudget("DECK")` for
  planner/writer/critic; `withMaxTokens` exists for smaller writer calls.
  `parseJsonValue`, `failureReasonOf` are exported there.
- Retrieval seam: `gatherDeckEvidence` in `retrieval.ts` is metadata-first.
  It enumerates candidate documents from `content_items` (sector, preferred
  types, one per customer), searches one topic query per plan section at k = 50,
  groups/round-robins passages, adds each candidate's overview, and gates at ≥ 8
  passages from ≥ 2 documents. Target and user-sentence terms are never queries.
  It returns `groups`/`gaps`; do not write a second retrieval path.
- Entity resolution strips generic tokens (`airlines`, `airports`, `aviation`,
  `services`, `pitch`, `deck`, `proposal`, legal suffixes) before
  `match_customer_entities`; a mention with no distinctive remainder never
  matches. The full mention re-ranks the returned rows, so "Zurich airport"
  prefers Zurich Airport over Zurich Insurance.
- Scope persistence exists: migration `0022_conversation_scope.sql`,
  `src/lib/chat/conversationScope.ts`, `scope.functions.ts`; `askLibrary` and
  `planDocument` already read stored scope. The gap is that deck retrieval does
  not treat scope parties as first-class entities.
- `scripts/ingest-worker.ts` and `src/lib/rag/extract.ts` hold ingest logic;
  `src/lib/rag/vision.ts` already exists for vision captions.
- `bun run check:deck <deck.pptx>` validates a generated deck against the token
  palette (off-palette colours, fonts, gradients, alternation, contrast).

---

## 5. Decisions already made (keep unless there is a reason to change)

1. **Interchange format:** keep `DocumentModel` as the shared export model.
   The new pipeline produces sections _and_ a `DeckSpec`; PPTX uses
   `DeckSpec`, PDF/DOCX reuse the sections. This avoids a second document
   pipeline and satisfies "share the content spec, not the renderer".
2. **Claims are code-owned.** Build a deterministic claim registry from cited
   chunk text, merging rows from the `claims` table when present. Writer output
   carries `claimId`; renderer resolves `valueText`/`valueMin`/`valueMax` and
   throws on an unknown ID. No default/assumption values anywhere.
3. **Parties are validated, not extracted.** Party list = wizard scope
   companies first, then entities named in the user message, resolved against
   the `entities` table. Unknown strings may become `type = 'concept'` for
   retrieval but are **never** party rows or hub spokes.
4. **No auto-paging.** Enforce layout capacity in the writer schema; critic
   fails overflow and rewrites once; final repair drops surplus content with a
   warning. Never emit `(continued)`.
5. **No new default assumptions object.** Delete `assumptions.ts` and its
   imports once the new path passes acceptance. `ChartSpec.basis =
"assumption"` may stay for legacy fixtures, but the new writer cannot create
   a chart without claim IDs.
6. **Gap handling is explicit.** An entity with zero evidence gets a gap flag;
   the deck still builds with sourced entities and marks the gap entity
   `inferred` on the hub/ask slide. Only a complete absence of evidence blocks.
7. **Tests drive the real prompts.** Extend `tests/fixtures.ts` mock provider
   to recognise the new planner/writer/critic system prompts; do not bypass the
   pipeline in acceptance tests.

---

## 6. Remaining implementation plan

Work in this order; run `bun run typecheck` after each file group and commit per
phase (task asks for a commit after each phase). Do not force-push.

### Phase 1 — planner → writer → critic

New files under `src/lib/documents/deck/`:

1. **`catalog.ts`**
   - `LAYOUT_CATALOGUE`: id, when to use, capacity limits (machine-readable).
   - zod schema per layout matching `DeckSlideContent` (bullets ≤ 4 / 15 words;
     cards 2–4; table ≤ 5 rows × 3 cols; roadmap 3–5; ask ≤ 4).
   - Zod schema for planner JSON (`deckTitle`, `audience`, `storyline`,
     6–10 slides, action title ≤ 14 words).
   - Reject table headers matching `evidence|ref|source|citation|chunk`.
2. **`claims.ts`**
   - `claimsFromChunks(chunks)`: deterministic regex extraction of
     currency/percent/ranges/counts with unit and surrounding sentence; stable
     IDs (`CL-<doc>-<n>`); dedupe by chunk/value/context.
   - `loadClaims(client, chunkIds)`: best-effort `claims` table read; merge DB
     rows first, fall back to regex. Missing table must not fail a deck.
   - `claimNumber(claim)`, `claimLabel(claim)`, `numbersIn(text)`.
3. **`text-guards.ts`**
   - Banned regex: `documented capability`, `proof points from the library`,
     `built from the solution hub library`, `the passages? do(es)? not`,
     `no library evidence`, `no passage states`, and any whole-word
     `library|passage|chunk|evidence` in slide copy.
   - Hedge regex: `not for .* specifically`, `no .* is claimed`,
     `not claimed`, `cannot be confirmed`, `to be confirmed`, etc.
   - `stripRefs` removes `[1]`, `[S1]`, UUIDs and evidence/ref table columns.
   - `moveHedgesToNotes(slide, notes)`.
   - `hasClaimVerb(title)`: ≥ 4 words and contains a verb/claim pattern.
   - `untracedNumbers(text, claims)`, `neutraliseUntracedNumbers(...)`.
   - `stripPromptEcho(notes, draft.prompt)`.
4. **`entities.ts`**
   - `loadValidatedEntities(client, { wizardCompanies, messageEntities })`:
     query `entities` by name/aliases (ilike/trgm), fall back to wizard values
     plus evidence `customer_name` values when migration is absent.
   - `partyList(...)`: only `type = company|airport`; reject lowercase
     hyphenated concepts, instruction words, counts (`18 hotel functions`),
     generics (`platform`, `capability`, `functions`).
   - `entityNamesIn(text, allowed)`, `assertParties(slide, allowed)`.
5. **`evidence.ts`**
   - Convert `DeckEvidence` + chunks + claims into:
     `{ parties: [{name, type, chunks, claims, gap}], genericChunks,
claims, gaps, images }`.
   - Per-entity top claims (3) and top chunks (2–3), capped total.
   - Never silently continue on zero-evidence entity: emit gap.
6. **`planner.ts`**
   - Verbatim planner system prompt from the task (Situation → Insight →
     Propose → Proof → Plan → Ask; 6–10 slides; action titles; layout choice;
     no library/passage/evidence language; never invent numbers).
   - User prompt: request, chat history, wizard selections, evidence pack,
     layout catalogue. Validate with zod. Two attempts.
   - Enforce no layout more than twice in a row; on final failure use
     deterministic `fallbackPlan(evidence)` (7 slides, alternating layouts,
     KPI/chart only when claims exist, hub only when parties exist).
7. **`writer.ts`**
   - One call per planner slide. System prompt: "You write one slide…"; strict
     JSON for the chosen layout; numbers only via `claimId`; no banned phrases;
     no hedging.
   - Validate with layout schema; up to 2 retries with exact zod errors.
   - Resolve claim IDs against claims passed for that slide/entity. Unknown IDs
     are a validation error. KPI/chart with no valid claims is invalid.
   - Final deterministic `fallbackSlideContent(planSlide, evidence)` from
     cited chunks if all retries fail.
   - Notes get full references and hedges; never the user prompt.
8. **`critic.ts`**
   - Deterministic checks (fail → rewrite failing slides once):
     banned phrases; < 2 content blocks; duplicate/`(continued)` titles; title
     < 4 words or no verb; unknown claim ID; capacity exceeded; party not in
     validated list; table evidence columns; > 2 same layouts in a row;
     consecutive duplicate titles; every digit traceable.
   - One LLM pass: "Would this survive a skeptical CXO read-through? List any
     slide that is vague, repetitive, or unsupported." Schema `{flagged:
[{index, reason}]}`. Fix flagged slides once, then stop.
   - Final deterministic repair: truncate surplus, replace unfixable layout
     with `context-bullets`/`table-compact`, never page.
9. **`build.ts`**
   - Orchestrate: brief (already built) → validated entities → evidence pack →
     claims → planner → writer (parallel with small concurrency cap) → critic
     → `DeckSpec` → sections (ordinary blocks for PDF/DOCX) → `DocumentModel`.
   - Gate: block only when there is no evidence and no user-supplied facts;
     otherwise build and mark gaps inferred. No "N of N sections had no usable
     evidence".
   - Trace: per-slide layout, tier, claim IDs, chunk IDs, gaps.
10. **`preview.ts`** (or export from build)
    - `previewDeckPlan` used by `planDocument` for pptx/pitch so the confirm
      card shows the new action titles/layouts, not the legacy outline.

### Phase 2 — renderer

**`src/lib/documents/render/deck.ts`**:

- `pres.layout = "LAYOUT_WIDE"` before adding slides.
- Theme from `deck-theme.ts` (`C`, `G`, `S`); hex without `#`.
- Masters carry footer + slide number; `isTextBox: true` on text.
- Cover; divider; context bullets; KPI cards; partner hub (centre + spokes with
  connector lines; logos when available, styled text badge fallback); two-column
  compare / before-after panels; compact table; process roadmap (3–5 steps with
  icons); chart with takeaway; shortcomings/collaboration tables; image with
  caption; next-steps ask.
- Native charts only: `addChart`, data labels, legend only for > 1 series.
  Range chart: stacked transparent base + span, plus min–max label; never a
  midpoint.
- Tier badge: `Proposed` for inferred, `Illustrative` for illustrative.
- Source footnote: `Source: <doc title>, <year>`; full refs in notes only.
- No `(continued)` and no auto-page: if content exceeds capacity, drop the
  overflow with a build-stage warning (critic should have prevented it).
- `assertDeckTraceable(spec)` at render start: every digit in action titles,
  bullets, table cells, KPI labels and chart labels must be covered by a claim
  referenced by that slide, or be part of an allowed year/source footnote.
  Throw on failure so a test catches regressions.
- Icons: `react-icons/lu` → `renderToStaticMarkup` → `sharp(svg).png()` at
  256px, cached in a process-level Map (and optionally disk cache). Fall back to
  numbered circles if sharp/render fails.

Wire `renderPptx`: `if (model.deck) return renderDeck(model.deck, config)`.
PDF/DOCX need no layout changes; ensure sections contain blocks for every
layout (tables, bullets, quote/callout equivalents).

### Phase 3 — structured ingest, entities, retrieval (applied)

**Migration `drizzle/migrations/0023_deck_entities_claims.sql`** (additive,
idempotent, follow style of `0020`/`0022`):

- `entities(id, name, type check in company|airport|concept, aliases text[],
sector, industry, created_at)`; unique lower(name); trigram index; RLS read
  for allowed users, write service role/admin.
- `claims(id, doc_id, chunk_id, entity_id, metric, value_text, value_min,
value_max, unit, context, source_title, source_year)` + indexes on
  `chunk_id`, `entity_id`.
- `chunk_entities(chunk_id, entity_id)` PK both + indexes.
- `entity_facts(entity_id, fact_type, text, source_url, fetched_at)`.
- `entity_assets(entity_id, kind check logo|image, path, created_at)`.
- Seed `entities` from `customers`, distinct `content_items.customer_name`,
  and `industries` (`type='company'` for customers, `'concept'` for
  industries/sectors). Do not seed free-form brief strings.
- Update generated types `src/integrations/supabase/types.ts` or use
  `as unknown as` narrowly if regeneration is unavailable.

**Ingest worker** (`scripts/ingest-worker.ts` + `rag/facts.ts`) — applied as
**deterministic** extraction, not the LLM call originally proposed:

- `extractChunkFacts` links known entity names (plus the file's canonical
  customer) and extracts exact numeric claims with context/range/unit/year.
- After chunks commit, `worker_attach_chunk_facts` resolves chunk ids by
  `chunk_index`, upserts unknown names as `concept`, and replaces the document's
  claims/links. Attach failures are logged, never fatal to indexing.
- `scripts/backfill-claims.ts` (`bun run ingest:facts`) is resumable per
  document with `--limit`, `--resume <id>` and `--content <id>`; it skips
  nothing, so re-running rewrites facts safely.
- An LLM extractor can replace `extractChunkFacts` behind the same RPC later;
  do not run the live worker unless DB credentials are available.

**Retrieval** (`src/lib/rag`, `documents/retrieval.ts`) — applied:

- Per-entity search already existed; `groups` now records which final chunks
  each resolved entity contributed (entity hits first, metadata fallback).
- The evidence pack prefers those groups over `customerName`, and a party with
  zero passages gets an explicit gap.
- `chunk_entities` is populated by ingest but retrieval still searches by
  customer scope; switching the SQL search to a `chunk_entities` hard filter is
  a later optimisation, not required for correct decks.

**Wizard persistence / UX**:

- Scope persistence is already implemented; ensure the new deck builder reads
  `ConversationScope` and treats picked companies as parties (not hints).
- Remove the automatic "Ready to build" deck confirmation: only show a hint
  popover above the chatbox; start planning/generation only on an explicit
  user request. Relevant UI: `src/routes/_authenticated/chat.tsx` (the
  `useEffect` that auto-calls `documentPlanning.mutate`),
  `src/components/chat/DocumentCard.tsx` (`"Ready to build"` heading line
  ~109), `src/components/chat/ExportHint.tsx`.

### Phase 4 — multimodal ingest (measured, awaiting go-ahead; see §3.9)

- **Not** page rendering through LibreOffice: 5/5 sampled PDFs have complete
  text layers and pptx slides already carry their figures as pictures.
- Vision pass over pptx pictures with `qwen/qwen3-omni-30b-a3b-instruct` at
  1280 px JPEG, 60 s timeout + one retry, selected by area/pixel size rather
  than the >400-character rule, `metadata.approximate: true`. Measured 4–10 s
  and ≈$0.0006 per image; 4/8 sampled image-only slides produced claims.
- Native xlsx text extraction (~10 files, no dependency); skip video/EMF media
  instead of uploading it as an image.
- `image-with-caption`: planner may request an image; retrieve best caption
  match for the relevant entity; only entities in the current deck; skip layout
  when confidence is low.
- Logos: `entity_assets(kind='logo', path)` with admin upload; cover and
  partner-hub use logo when available, else text badge.

### Phase 5 — gap handling

- Gap entity: one web-search enrichment pass for public facts (scale, strategy,
  recent announcements) → `entity_facts` with source URL, footnote on slide.
  No search provider is wired in the repo; add an injectable
  `enrichEntityFacts` seam and a provider (e.g. Tavily/Serper) behind an env
  key. If no key, skip and keep the entity inferred — never fabricate.
- If still thin, ask the user once in chat for a one-pager/notes; do not fail
  the deck.
- Tier rules: sourced numbers footnote; inferred slides "Proposed" tag;
  illustrative charts "Illustrative" tag. Numbers on inferred/illustrative
  slides only if user supplied or clearly labelled assumptions. No default
  assumptions object.

### Chat answer style

Already largely done in `src/lib/chat/answer.ts` (ChatGPT/Claude-style prompt,
bracketed citations, no "according to passage"). Verify no prose references to
passages remain; only adjust if tests fail.

### Acceptance tests

New `tests/deck-pipeline.test.ts` (+ fixtures):

1. "Pitch deck: onsite aircraft maintenance station for Airbus and Boeing at
   Adani Airports with Gatwick"
2. "Proposal deck for a possible collaboration between Accor Hotels and NK
   Proteins"
3. "Pitch deck for Adani Airports + IndiGo + InterGlobe Hotels"

For each, snapshot planner JSON and rendered slide text/layouts. Assert:

- 6–10 slides; no two consecutive same layout; ≥ 2 KPI/chart/hub layouts.
- Zero banned phrases / chunk IDs / `[1]` in extracted slide text.
- No chart without claim IDs; no "Package volumes".
- Every selected entity appears (sourced or inferred); no concept party.
- No orphan, duplicate-title, empty or `(continued)` slides.
- Every digit traceable to a claim ID (use `assertDeckTraceable`).
- Render to PDF → images (`soffice`/`pdftoppm` if installed) and visually
  inspect; fix overflow/overlap.
- Run `bun run check:deck <file>` and confirm no off-palette findings.

Update `tests/fixtures.ts` mock provider:

- Detect planner system prompt (`senior pre-sales strategist`), writer prompt
  (`You write one slide`), critic prompt (`skeptical CXO`) and return valid
  JSON derived from the prompt's evidence pack/claims.
- Keep legacy branches for `generate.ts`/`outline.ts` tests if they remain.
- Add scenario chunks for Airbus, Boeing, Adani Airports, Gatwick, Accor, NK
  Proteins, IndiGo, InterGlobe Hotels so acceptance decks have real sourced
  content and at least one deliberate gap.

---

## 7. Cleanup once acceptance passes

- Delete `src/lib/documents/assumptions.ts` once PDF/DOCX move to the new
  planner; `build.ts` still uses it for the legacy proposal path.
- Remove `generate.ts` per-section generator if nothing imports it except
  `sectionSourceIds`/`citedChunkIds` (move those helpers to `validate.ts` or a
  small `blocks-utils.ts` first). `validate.ts:9` and `build.ts:22` import from
  it today.
- Remove `ensurePartyRows` free-form party padding once validated parties are
  the source of truth.
- Remove `REF_HEADER` evidence columns and reference-preserving table cell code
  from the legacy renderer if the legacy renderer is retained.
- Remove "Ready to build" auto-confirm flow in chat UI.
- Delete dead `DECK_SYSTEM` example with "Documented capability"/"Evidence".

---

## 8. Verification commands

```bash
bun run typecheck
bun test tests/deck-pipeline.test.ts
bun test
bun run lint            # only if already used by the repo; may be noisy
NITRO_PRESET=node-server bun run build
bun run check:deck <generated>.pptx
soffice --headless --convert-to pdf <generated>.pptx   # if LibreOffice exists
pdftoppm -png -r 110 <generated>.pdf /tmp/deck-page      # then inspect PNGs
```

Current state: `bun run typecheck` and `bun test` are green. `check:deck`
validates a generated deck against the token palette (colours, fonts,
alternation, contrast). LibreOffice is not installed here, so PNG slide previews
cannot be rasterised in this workspace.

---

## 9. Open questions / decisions needing user input

1. **Claims table vs deterministic extraction:** the plan merges DB claims
   (Phase 3) with regex-extracted claims so decks work before backfill. If the
   user wants claims _only_ from the table, decks will be empty until ingest is
   backfilled. Recommendation: keep the merge.
2. **Web enrichment provider:** no search API is configured. Which provider
   (Tavily, Serper, Brave) and env key should be used for Phase 5? Until
   decided, gaps stay inferred.
3. **Legacy renderer:** keep `render/pptx.ts` legacy layouts for back-compat,
   or migrate the PDF/DOCX path to `DeckSpec` and delete the legacy layout code?
   Recommendation: keep for now, delete after acceptance.
4. **Proposal DOCX/PDF scope:** new planner output is shared, but the task's
   acceptance tests are decks. Confirm whether proposal PDF/DOCX should also
   use the new planner for their section headings (task says yes: "DOCX/PDF
   reuse the same planner output with section-wise headings"). This is in the
   plan but not yet implemented.
5. **Ingest extraction:** deterministic facts are applied. Should ingest spend
   an LLM call per chunk for richer entity roles/aliases, or is deterministic
   extraction plus alias maintenance enough?
6. **Phase 4 go-ahead (needs a yes):** enable a vision pass (`qwen3-omni`, 1280 px
   JPEG, ~$0.0006/image, 4–10 s/image) over pptx pictures so 44 image-only
   slides stop being invisible, plus native xlsx extraction. This sends images
   of client decks to the configured gateway. Also decide re-ingest scope:
   image-only decks first, or all 123 pptx (≈1–2 h of gateway time, ≈$0.5).
   Measurements and the comparison table are in §3.9.

---

## 10. Change log (append after each applied change)

| Date       | File                                                                                                                                                                                                                                                                                                                                                                                                                                 | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Verification                                                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-16 | `docs/deck-pipeline-audit.md`                                                                                                                                                                                                                                                                                                                                                                                                        | New one-page audit mapping all 7 defects to code origins.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Reviewed against source.                                                                                                                                                                                                    |
| 2026-11-16 | `src/lib/documents/deck/types.ts`                                                                                                                                                                                                                                                                                                                                                                                                    | New deck content contract: layouts, tiers, claims, chart points, slide content unions, `DeckSpec`. Not wired yet.                                                                                                                                                                                                                                                                                                                                                                                                                              | `bun run typecheck` pass.                                                                                                                                                                                                   |
| 2026-11-16 | `package.json`, `bun.lock`                                                                                                                                                                                                                                                                                                                                                                                                           | Added `sharp` and `react-icons` for Lucide icon PNGs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Install succeeded; typecheck pass.                                                                                                                                                                                          |
| 2026-11-16 | `docs/deck-pipeline-audit.md`                                                                                                                                                                                                                                                                                                                                                                                                        | Linked the audit to this handoff document.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Docs only.                                                                                                                                                                                                                  |
| 2026-11-16 | `src/lib/documents/deck/*`                                                                                                                                                                                                                                                                                                                                                                                                           | Phase 1: catalogue, claims, guards, entities, evidence pack, planner, writer, critic, orchestrator.                                                                                                                                                                                                                                                                                                                                                                                                                                            | `bun run typecheck`, `bun test`.                                                                                                                                                                                            |
| 2026-11-16 | `src/lib/documents/render/deck.ts`, `render/pptx.ts`                                                                                                                                                                                                                                                                                                                                                                                 | Phase 2: DeckSpec renderer with traceability assertion; `renderPptx` dispatch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `bun test`, `scripts/check-pptx.py` OK.                                                                                                                                                                                     |
| 2026-11-16 | `src/lib/documents/build.ts`, `types.ts`                                                                                                                                                                                                                                                                                                                                                                                             | Wire PPTX exports to the new pipeline; optional `deck` on the model/section.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `bun test` (117 pass).                                                                                                                                                                                                      |
| 2026-11-16 | `tests/deck-pipeline.test.ts`, `tests/fixtures.ts`, `tests/export.test.ts`, `tests/regression.test.ts`                                                                                                                                                                                                                                                                                                                               | Contract and fallback tests; mock planner/writer/critic branches.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `bun test` (117 pass).                                                                                                                                                                                                      |
| 2026-11-16 | `drizzle/migrations/0023_deck_entities_claims.sql`, `src/integrations/supabase/types.ts`                                                                                                                                                                                                                                                                                                                                             | Phase 3 storage: entities, claims, chunk links, facts/assets, seeds, RLS, `match_entities`, `worker_attach_chunk_facts`.                                                                                                                                                                                                                                                                                                                                                                                                                       | `bun run typecheck`; not applied live.                                                                                                                                                                                      |
| 2026-11-16 | `src/lib/rag/facts.ts`, `scripts/ingest-worker.ts`, `scripts/backfill-claims.ts`, `package.json`                                                                                                                                                                                                                                                                                                                                     | Deterministic ingest facts, worker attach, resumable backfill (`ingest:facts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                | typecheck, lint, 121 tests.                                                                                                                                                                                                 |
| 2026-11-16 | `src/lib/rag/entities.ts`, `src/lib/documents/deck/{claims,entities,evidence,build}.ts`, `src/lib/documents/{build,retrieval}.ts`                                                                                                                                                                                                                                                                                                    | DB-backed claims/entities, concept filtering, grouped retrieval with gaps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | typecheck, lint, 121 tests.                                                                                                                                                                                                 |
| 2026-11-16 | `tests/deck-pipeline.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                        | Concept rejection, fact extraction, DB-claim merge, group-first evidence tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `bun test` (121 pass).                                                                                                                                                                                                      |
| 2026-11-16 | `src/lib/documents/intent.ts`, `src/routes/_authenticated/chat.tsx`, `tests/scope.test.ts`                                                                                                                                                                                                                                                                                                                                           | Removed the outline-confirm card; explicit requests and the `"+"` menu build immediately, hint stays prefill-only.                                                                                                                                                                                                                                                                                                                                                                                                                             | typecheck, `bun test` (121 pass).                                                                                                                                                                                           |
| 2026-11-16 | `docs/deck-pipeline-handoff.md`                                                                                                                                                                                                                                                                                                                                                                                                      | Phase 3 marked applied; documented deterministic ingest, groups/gaps, DB claim/entity merge and the confirmation change.                                                                                                                                                                                                                                                                                                                                                                                                                       | Docs only.                                                                                                                                                                                                                  |
| 2026-11-16 | live library                                                                                                                                                                                                                                                                                                                                                                                                                         | Applied migration 0023 and ran `bun run ingest:facts`: 213 documents, 4,813 chunks, 6,918 entity links, 5,811 claims (14% without an entity).                                                                                                                                                                                                                                                                                                                                                                                                  | Counts via REST pagination (direct Postgres is firewalled from this workspace).                                                                                                                                             |
| 2026-11-16 | `src/lib/documents/deck/shapes.ts`, `deck/writer.ts`, `deck/catalog.ts`                                                                                                                                                                                                                                                                                                                                                              | Writer prompt now carries the exact per-layout JSON shape (wrapped in `content`); `sourceNote` accepted to 400 and truncated; `fitContent` clamps copy to layout caps before validation.                                                                                                                                                                                                                                                                                                                                                       | `bun run typecheck`, `bun test` (127 pass), live rebuild.                                                                                                                                                                   |
| 2026-11-16 | `src/lib/documents/deck/entities.ts`, `src/lib/rag/entities.ts`, `src/lib/documents/build.ts`                                                                                                                                                                                                                                                                                                                                        | Validated-only parties and retrieval seeds: unvalidated brief strings are lookups, brief key entities must appear in the user's words, `groundedEntities` keeps only rows the request or an alias names, and `matched_name` is dropped from an entity's spellings. `loadValidatedEntities` reports `available`.                                                                                                                                                                                                                                | typecheck, `bun test` (131 pass), live run parties reduced to `["Adani Airports"]`.                                                                                                                                         |
| 2026-11-16 | `src/lib/documents/deck/critic.ts`                                                                                                                                                                                                                                                                                                                                                                                                   | Repaired action titles can no longer take a `purpose` sentence containing a figure; the shaped title is re-sanitised, so render-time traceability is preserved.                                                                                                                                                                                                                                                                                                                                                                                | typecheck, `bun test` (131 pass), live deck renders.                                                                                                                                                                        |
| 2026-11-16 | live end-to-end                                                                                                                                                                                                                                                                                                                                                                                                                      | Final Adani Airports build: 0 writer retries, 10 slides, 32 claims, `check-pptx.py` → 11 slides, 1 native chart, 3 layouts, OK.                                                                                                                                                                                                                                                                                                                                                                                                                | `/tmp/live-adani.pptx`.                                                                                                                                                                                                     |
| 2026-11-17 | `src/lib/rag/extract.ts`, `src/lib/document-format.ts`, `src/lib/rag/config.ts`, `scripts/ingest-worker.ts`, `scripts/download-library.ts`, `src/components/FilePreviewDialog.tsx`, `tests/xlsx-extract.test.ts`                                                                                                                                                                                                                     | Native xlsx ingest (sheets as table chunks, percent/date/currency formats resolved, 2,000-row cap), format detection, worker support, extractor version bump, preview fallback.                                                                                                                                                                                                                                                                                                                                                                | `bun run typecheck`; `bun test` 137 pass; ESLint clean; real samples verified.                                                                                                                                              |
| 2026-11-17 | `src/lib/documents/deck/enrichment.ts`, `deck/{types,claims,evidence,build,writer}.ts`, `src/lib/documents/build.ts`, `render/deck.ts`, `tests/deck-enrichment.test.ts`                                                                                                                                                                                                                                                              | Phase 5 seam with no provider: curated `entity_facts` become asterisked public claims that still pass the traceability guard; gap parties keep PROPOSED.                                                                                                                                                                                                                                                                                                                                                                                       | typecheck; `bun test` 146 pass; ESLint clean.                                                                                                                                                                               |
| 2026-11-17 | `src/lib/documents/render/pptx-package.ts`, `render/deck.ts`, `render/pptx.ts`, `src/components/FilePreviewDialog.tsx`, `src/components/chat/DocumentPreviewDialog.tsx`, `tests/pptx-package.test.ts`                                                                                                                                                                                                                                | Fixed blank black PPTX preview: PptxGenJS declares slide-master parts it never writes, which aborted `pptx-preview`; dangling content-type overrides are now dropped after write, and both dialogs refuse an empty render.                                                                                                                                                                                                                                                                                                                     | typecheck; `bun test` 139 pass; ESLint clean; browser reproduction before/after.                                                                                                                                            |
| 2026-11-17 | `docs/deck-pipeline-handoff.md`                                                                                                                                                                                                                                                                                                                                                                                                      | Phase 4 measurements (§3.9): library inventory, dropped-content audit, the 4-vision-model comparison, measured claim yield on image-only decks, tool comparison, and the recommendation awaiting approval.                                                                                                                                                                                                                                                                                                                                     | REST pagination over the live library; probes on `/tmp/p4` samples. No repo code changed.                                                                                                                                   |
| 2026-11-16 | `drizzle/migrations/0023_deck_entities_claims.sql`                                                                                                                                                                                                                                                                                                                                                                                   | Fix apply failure `column reference "aliases" is ambiguous`: qualify the target array (`e.aliases`) in the alias-merge update, and rename the `unnest` aliases in `match_entities` (`a(alias)`, `al(alias)`, `cand(value)`) that had the same table-alias/column collision.                                                                                                                                                                                                                                                                    | Ran the migration twice in PGlite (Supabase functions stubbed, pg_trgm stripped); alias merges onto the canonical entity, `match_entities` returns it, `worker_attach_chunk_facts` is re-runnable without duplicate claims. |
| 2026-11-17 | `src/lib/documents/deck/{types,catalog,shapes,writer,build,text-guards}.ts`, `src/lib/documents/render/deck.ts`, `src/lib/documents/deck/planner.ts`                                                                                                                                                                                                                                                                                 | Added three consulting layouts the baseline deck lacked — `maturity-progression` (qualitative stages, no invented scores), `three-horizon` (now/next/later) and `layered-architecture` (stacked platform layers) — with zod schemas, writer shapes/fallbacks, PDF/DOCX table blocks, deterministic renderers and planner guidance. Placeholder guard: `stripPlaceholders`/`stripUnresolvedTokens` clear `{{CL-}}`, TODO/TBD and insert-style leftovers before rendering, and `assertDeckTraceable` refuses a deck that still contains a token. | `bun run typecheck`; `bun test` 172 pass (5 new tests: schema acceptance, maturity render with no fabricated score, horizon + layered render, copy cleanup, render refusal).                                                |
| 2026-11-17 | `src/lib/documents/deck/critic.ts`, `deck/text-guards.ts`                                                                                                                                                                                                                                                                                                                                                                            | Live-run title defects fixed: the invented `"… changes the economics"` suffix is gone, layout-specific truthful fallbacks replace it, and planner instructions (`Close with…`, `Show the stages…`, `Set the situation:…`) are detected by `isInstructionTitle` and rewritten instead of shipping as titles. Duplicate-title suffix can no longer stack (`now now`). Keyword fallbacks no longer invent timings ("eight weeks", "year one").                                                                                                    | `bun run typecheck`; `bun test` 173 pass (new title-repair regression test).                                                                                                                                                |
| 2026-11-17 | `src/lib/documents/render/deck.ts`                                                                                                                                                                                                                                                                                                                                                                                                   | Structural QA fixes found by `check-pptx.py` on the DFW deck: KPI note and source caption no longer overlap, maturity stage numerals/descriptors and TODAY/TARGET chips meet the 12pt floor, and the cover wordmark uses 10pt caption type.                                                                                                                                                                                                                                                                                                    | `check-pptx.py` → 9 slides, 3 layouts, 0 overlap/type problems (only the expected "no native charts" warning).                                                                                                              |
| 2026-11-17 | `scripts/verify-dfw-deck.ts`, `samples/deck-review/dfw-data-maturity.{pptx,model.json}`                                                                                                                                                                                                                                                                                                                                              | Live DFW benchmark build through the real provider + library: 8 slides, layouts `context-bullets, kpi-cards, maturity-progression, layered-architecture, process-roadmap, three-horizon, before-after, next-steps-ask`; traceability and placeholder assertions pass.                                                                                                                                                                                                                                                                          | `bun scripts/verify-dfw-deck.ts` → all hard assertions passed; `python3 scripts/check-pptx.py` → 9 slides, 3 layouts, no overlap or sub-12pt text.                                                                          |
| 2026-11-17 | `src/lib/brand/*` (9 modules), `src/components/chat/TargetClientBar.tsx`, `src/lib/chat/{conversationScope,scope.functions}.ts`, `src/routes/_authenticated/chat.tsx`, `src/lib/documents/{build,types}.ts`, `render/{deck,pptx,pdf,docx}.ts`, `package.json`, `drizzle/migrations/0024_target_client_and_brand_profiles.sql`, `tests/brand.test.ts`, `tests/deck-pipeline.test.ts`, `scripts/verify-brand-extraction.ts`, `flow.md` | Replaced the custom HTML/CSS brand scraper with OpenBrand as a library: isolated adapter, guarded asset download, candidate-colour Kit with explicit statuses and provenance, approval-gated renderer palettes, review UI with manual logo/HEX/role editing, 30-day domain cache, per-conversation approved kit.                                                                                                                                                                                                                               | typecheck; `bun test` 182 pass; live extraction matrix; Node-target production build.                                                                                                                                       |
| 2026-11-18 | `src/lib/brand/openbrand.ts`, `src/components/chat/TargetClientBar.tsx`, `scripts/verify-brand-extraction.ts`, `tests/brand.test.ts`, `tests/deck-pipeline.test.ts`                                                                                                                                                                                                                                                                  | Audit of the migration: thrown `TimeoutError`/connection errors now map to retryable `NETWORK_ERROR` (not `PACKAGE_FAILURE`); detected brand name shown and HEX values can be typed/validated in the review panel; live matrix now covers a real static site and a no-assets page that must not report success; new tests pin error mapping and that approved brand colours replace house blue in PPTX XML.                                                                                                                                    | typecheck; `bun test` 183 pass; `bun scripts/verify-brand-extraction.ts` all assertions pass; `NITRO_PRESET=node-server bun run build` pass; Prettier clean.                                                                |
| 2026-11-18 | `src/lib/brand/theme.ts`, `src/lib/documents/render/deck.ts`, `tests/deck-pipeline.test.ts`, `flow.md`                                                                                                                                                                                                                                                                                                                               | Branded decks now alternate a white canvas with one solid colour from the client's homepage palette: cover/dividers/ask use the brand colour, content slides alternate white/brand by index. Page ink flips to stay readable; cards stay white with black copy; headings and chart accents use contrast-filtered `brandHighlights`; chart series keep the approved kit. Branded cover backdrops are no longer drawn. House decks unchanged.                                                                                                    | typecheck; `bun test tests/deck-pipeline.test.ts` 27 pass; `bun test tests` 183 pass; Prettier clean; generated XML: backgrounds `7A1022`/`FFFFFF` alternating, white-slide body `000000`, brand-slide copy `FFFFFF`.       |

| 2026-11-18 | `src/lib/brand/theme.ts`, `src/lib/documents/render/deck.ts`, `src/lib/documents/render/pptx.ts`, `src/components/chat/TargetClientBar.tsx`, `tests/brand.test.ts`, `tests/deck-pipeline.test.ts`, `flow.md`, `docs/deck-pipeline-handoff.md` | One rule for every branded export: copy always black (`#000000`) on a white page (`#FFFFFF`); the client's colours remain only in headings/subheads, chart text (title, axis labels, legend) and fills (series, header bands, accents). Replaced §3.13's alternating canvases — no slide wears a brand colour behind text. `documentPalette.ink` is black for PDF/DOCX; legacy PPTX masters turn white with highlight titles; the review panel drops the inert Background swatch. | typecheck; `bun test tests` 196 pass; Prettier clean. |

| 2026-11-18 | `src/lib/documents/redact.ts`, `src/lib/documents/references.ts`, `tests/redact.test.ts`, `flow.md` | Fixed the export-wide `SyntaxError` that blocked every deck/document: the redactor escaped a name before swapping separators, so `booking.com` produced `booking\[\s._-]+com` (a lone `]` under the `u` flag). Names are tokenised before escaping, patterns compile once at build time, and a malformed name falls back to a literal replace instead of aborting the export. The blocklist now comes only from customers/aliases/content customer names (title tokens dropped), excludes `booking.com`, adds the `IndiGo`/`Fly++` codenames, and logs the first 30 final values. | typecheck; `bun test tests` 199 pass; live 87-value blocklist scrubbed the failing sentence with `booking.com` preserved; Prettier clean. |

| 2026-11-18 | `src/lib/rag/entities.ts`, `src/lib/documents/retrieval.ts`, `src/lib/documents/build.ts`, `src/lib/documents/documents.functions.ts`, `src/lib/brand/brand.functions.ts`, `src/lib/chat/scope.functions.ts`, `src/routes/_authenticated/chat.tsx`, `tests/{retrieval,build}.test.ts`, `tests/fixtures.ts`, `flow.md`, `docs/deck-pipeline-handoff.md` | Deck retrieval rebuilt around the sector library: candidate documents come from `content_items` metadata (8, preferred types, one per customer, widen with a logged warning), each plan section contributes a section-topic query with no target/user-sentence terms, search depth is 50, passages are grouped/round-robined and every candidate gets an overview. Generic entity tokens are stripped before matching (`airlines` no longer resolves IndiGo) and a full mention re-ranks distinctive hits. Gate: ≥ 8 passages from ≥ 2 documents. Sources now include section `evidenceIds`; export failures surface the real error class; brand extraction/scope saves log structured status. | `bun run typecheck`; `bun test tests` 202 pass; live Ethiopian Airlines build: 23 passages/14 documents, 9 slides, 54,960-byte PPTX, `scripts/check-deck.ts` OK, redactor 91 names no crash. |

| 2026-11-18 | `aionos.tokens.json`, `src/lib/documents/{tokens,contrast,brand-guide,deck-theme,theme}.ts`, `src/lib/documents/render/{deck,pptx,palette-check,contrast-check,pdf,docx}.ts`, `src/lib/documents/{chart-image,assets/aionos-logo}.ts`, `src/lib/brand/color.ts`, `scripts/{check-deck,render-golden,build-brand-assets}.ts`, `tests/{tokens,contrast,deck-pipeline}.test.ts`, `README.md` | PPTX styling layer rebuilt around one closed token file. `aionos.tokens.json` now holds only the brand palette (navy, deep navy, electric blue, warm clay, pearl, soft blue, white) — mist, light grey, electric cyan and the document-only inks are gone — and `tokens.ts` generates the six-pair WCAG contrast matrix at load. Content slides alternate BLUE (navy)/WHITE strictly between a deep-navy cover and closing; boxes follow the rule (blue + white text on white slides, white/pearl + deep-navy text on blue); tables band white/pearl with a white-on-electric-blue header; charts sit on white. The Aionos wordmark is extracted from the guideline into `assets/aionos-logo.ts`. `check-deck.ts` now fails on off-palette colours, gradients, off-brand typefaces, broken alternation and text that fails contrast against its nearest filled shape/cell. | `bun run typecheck`; `bun test tests` 197 pass; four golden decks pass `check-deck` with sequence `030C44 FFFFFF 1C2453 FFFFFF 1C2453 FFFFFF 1C2453 FFFFFF 030C44`. |

> Add a row for every subsequent change. Keep the status line at the top
> accurate: IN PROGRESS / BLOCKED / COMPLETE.

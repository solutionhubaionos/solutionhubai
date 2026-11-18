# Deck renderer review

Evidence for the PowerPoint renderer redesign. Everything here is generated from
the real renderer — nothing is hand-drawn.

## Regenerate

```bash
bun scripts/render-deck-fixtures.ts                 # .pptx + layout map
/tmp/lo/root/opt/libreoffice25.8/program/soffice --headless \
  -env:UserInstallation=file:///tmp/lo/profile \
  --convert-to pdf --outdir samples/deck-review \
  samples/deck-review/movin.pptx samples/deck-review/indigo.pptx
.venv-check/bin/python scripts/check-pptx.py samples/deck-review/movin.pptx
.venv-check/bin/python scripts/check-pptx.py samples/deck-review/indigo.pptx
```

`python -m venv`-style tooling is local only:

```bash
uv venv .venv-check && uv pip install --python .venv-check/bin/python python-pptx pypdfium2 pillow
```

## Thumbnails

| Deck | Grid |
| --- | --- |
| Before (previous renderer, `samples/zurich-claims-pitch-deck.pptx`) | `png/sheet-before-zurich.png` |
| After — Movin x InterGlobe Hotels x Accor pitch | `png/sheet-movin.png` |
| After — IndiGo x InterGlobe Hotels x Movin proposal | `png/sheet-indigo.png` |

Individual slides are in `png/<deck>-NN.png`; PDFs next to the `.pptx` files.

## Layouts used per slide

See `layouts.txt` (printed by the generator). Both fixtures use 13 layouts
(cover, section, text, table, visual, fullvisual, kpi, flow, timeline, compare,
closing, sources, plus the shared master set); the section divider is only used
for a section that carries no content blocks, and the sources layout is behind
`DECK_THEME.config.includeSourcesSlide` (off by default — the deck is
client-facing and carries no source list).

## Checks

`scripts/check-pptx.py` asserts: every shape inside the canvas, body text at
least 12pt (footers, source lines and italic captions excepted), native charts
with data labels, more than one layout, speaker notes on every slide, no
mid-word table truncation and no overlapping text frames.

```
movin.pptx:  12 slides, 2 native charts, 13 layouts  OK
indigo.pptx: 12 slides, 2 native charts, 13 layouts  OK
```

The previous renderer's output fails the same check with 41 problems: 9pt body
copy, 10.5pt table cells, no native chart, one layout.

## Changelog

| File | Change | Why |
| --- | --- | --- |
| `src/lib/documents/render/pptx.ts` | Rewritten on PptxGenJS: masters per layout, 16:9, type scale, native tables and charts, KPI/flow/timeline/comparison layouts, continuation slides, speaker notes | The hand-written OOXML produced one layout, 9.5–10.5pt body copy, one unstyled chart and cells cut mid-word |
| `src/lib/documents/deck-theme.ts` | New design system: palette, chart series order, type scale, margins, config flags | One place to rebrand or retune; fonts default to Calibri so a viewer without the brand font does not reflow every box |
| `src/lib/documents/theme.ts` | Shared palette moved to the new ink/accent/teal/amber/coral values | DOCX and PDF pick up the same colours without their own edits |
| `src/lib/documents/documents.functions.ts` | `await renderPptx(...)` | PptxGenJS writes asynchronously; the returned shape (`bytes`, `pages`) is unchanged |
| `tests/renderers.test.ts`, `tests/export.test.ts`, `scripts/verify-export.ts`, `scripts/generate-samples.ts` | Await the renderer | Same reason |
| `tests/deck-fixtures.ts` | Two fixture decks built from the Movin/Accor/InterGlobe and IndiGo/Fly++ source decks | Review the renderer against real slide content, including the shapes that used to break |
| `scripts/render-deck-fixtures.ts` | Renders both fixtures and prints the layout map | Repeatable review |
| `scripts/check-pptx.py` | Structural validator | Cheap regression check without opening PowerPoint |
| `package.json` | `pptxgenjs@4.0.1` | Native, editable shapes/charts/tables |

## Notes and deliberate deviations

- **Sync → async.** `renderPptx` returns a promise because PptxGenJS's writer is
  async. The `{ bytes, pages }` contract and every caller's behaviour are the
  same; only the four call sites needed `await`.
- **Section tag and source line are per slide.** Titles, footers and slide
  numbers live on the layouts; the tag and the optional source line change per
  slide, so they are drawn in fixed zones (tag above the title, source line
  above the footer at 6.68in — it no longer collides with the footer at 7.02in).
- **Bullets are drawn as a glyph.** PptxGenJS writes paragraph properties before
  every run, so a paragraph-level `bullet` option restarts the paragraph or is
  dropped when a bullet contains a bold phrase. A separate `•` text box is
  deterministic in PowerPoint, LibreOffice and Google Slides.
- **No icon PNGs.** KPI cards use a coloured accent rule instead of
  react-icons → sharp PNGs: no new native dependency, and the cards stay
  editable. Swap in icons by adding images to `addKpiCards`.
- **DOCX and PDF unchanged** apart from the shared palette. Both already render
  from the same model and pass their tests; replacing the DOCX writer with the
  `docx` package was outside this change.

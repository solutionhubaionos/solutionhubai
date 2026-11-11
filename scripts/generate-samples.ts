/**
 * Builds the sample PDF, DOCX and PPTX from the seeded fixture library through
 * the real pipeline and renderers. No database or provider is needed: the
 * fixture provider follows the same stage prompts and the fixture chunks have
 * the search_chunks shape.
 *
 *   bun scripts/generate-samples.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { buildDocument } from "../src/lib/documents/build";
import { renderDocx } from "../src/lib/documents/render/docx";
import { renderPdf } from "../src/lib/documents/render/pdf";
import { renderPptx } from "../src/lib/documents/render/pptx";
import type { DocumentModel } from "../src/lib/documents/types";
import {
  CHUNKS,
  createMockFetch,
  createMockSupabase,
  deckHistory,
  draftFor,
} from "../tests/documents/fixtures";

const provider = {
  apiKey: "sample",
  baseUrl: "https://mock.local",
  fetchImpl: createMockFetch(),
};

async function main() {
  mkdirSync("samples", { recursive: true });
  const queries: string[] = [];

  const proposal = await buildDocument({
    draft: draftFor({
      mode: "proposal",
      type: "docx",
      title: "Zurich Insurance — Claims transformation proposal",
      client: "Zurich Insurance",
      industry: "insurance",
    }),
    history: deckHistory(),
    client: createMockSupabase(CHUNKS, queries),
    provider,
    now: new Date("2026-11-11T00:00:00Z"),
  });

  const pdfModel: DocumentModel = { ...proposal.model, format: "pdf" };
  const pdf = await renderPdf(pdfModel);
  const docx = renderDocx(proposal.model);

  const deck = await buildDocument({
    draft: draftFor({
      mode: "pitch",
      type: "pptx",
      title: "Zurich Insurance — Claims transformation",
      client: "Zurich Insurance",
      industry: "insurance",
    }),
    history: deckHistory(),
    client: createMockSupabase(CHUNKS, []),
    provider,
    now: new Date("2026-11-11T00:00:00Z"),
  });
  const pptx = renderPptx(deck.model);

  writeFileSync("samples/zurich-claims-proposal.pdf", pdf.bytes);
  writeFileSync("samples/zurich-claims-proposal.docx", docx.bytes);
  writeFileSync("samples/zurich-claims-pitch-deck.pptx", pptx.bytes);

  for (const [label, built] of [
    ["proposal", proposal],
    ["deck", deck],
  ] as const) {
    console.log(
      `\n${label}: ${built.model.sections.length} sections, ${built.model.sources.length} sources`,
    );
    for (const section of built.model.sections) {
      console.log(
        `  ${section.flagged ? "[!]" : "   "} ${section.title} — ${section.blocks.length} blocks`,
      );
    }
    if (built.model.openItems.length > 0) {
      console.log("  Open items:");
      for (const item of built.model.openItems) console.log(`   - ${item}`);
    }
  }

  console.log(
    `\nwrote pdf=${pdf.bytes.byteLength}B/${pdf.pages}pp docx=${docx.bytes.byteLength}B pptx=${pptx.bytes.byteLength}B/${pptx.pages} slides`,
  );
}

await main();

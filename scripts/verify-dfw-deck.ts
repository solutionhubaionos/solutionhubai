/**
 * Rebuilds the DFW data-maturity deck through the real pipeline (provider +
 * library, signed in as a library user) and reports every slide's layout and
 * title, then writes the PowerPoint and runs the structural checks.
 *
 *   bun scripts/verify-dfw-deck.ts
 *
 * This is the benchmark that shows the difference from the baseline deck: a
 * staged maturity journey and/or roadmap instead of five generic text cards,
 * with no placeholder ever reaching a slide.
 */
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { unzipSync } from "fflate";
import { buildDocument } from "../src/lib/documents/build";
import { visibleStrings } from "../src/lib/documents/deck/writer";
import { hasPlaceholders } from "../src/lib/documents/deck/text-guards";
import { assertDeckTraceable } from "../src/lib/documents/render/deck";
import { renderPptx } from "../src/lib/documents/render/pptx";
import type { DocumentDraft } from "../src/lib/documents/types";

const apiKey = process.env["TOKENFACTORY_API_KEY"] as string;
const baseUrl = (process.env["TOKENFACTORY_API_BASE"] ?? "").replace(/\/+$/, "");
const url = process.env["SUPABASE_URL"] ?? process.env["VITE_SUPABASE_URL"] ?? "";
const publishable =
  process.env["SUPABASE_PUBLISHABLE_KEY"] ?? process.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ?? "";
const email = process.env["LIBRARY_USER_EMAIL"] as string;
const password = process.env["LIBRARY_USER_PASSWORD"] as string;
if (!apiKey || !baseUrl || !url || !publishable || !email || !password) {
  console.error("Provider and library credentials must be configured in .env");
  process.exit(1);
}

const REQUEST =
  "Draft a pitch deck for Dallas Fort Worth International Airport on a data maturity and pipeline programme: where their operational data stands today, the stages to reach predictive operations, the target architecture, a phased roadmap and the expected business outcomes. Keep it executive-ready.";

const provider = { apiKey, baseUrl };

async function main(): Promise<void> {
  const client = createClient(url, publishable, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed: ${error.message}`);

  const draft: DocumentDraft = {
    type: "pptx",
    mode: "pitch",
    title: "DFW Airport — data maturity and pipeline pitch",
    subtitle: "From fragmented operational data to predictive airport operations",
    audience: "Executive committee",
    industry: "aviation",
    industrySlug: "aviation",
    client: "Dallas Fort Worth International Airport",
    sector: null,
    outline: [],
    prompt: REQUEST,
  };

  const history = [
    { role: "user" as const, content: REQUEST },
    {
      role: "assistant" as const,
      content:
        "The airport's operational data sits across separate systems, so decisions depend on manual reconciliation. A staged maturity programme moves from shared definitions to an integrated flow and then to predictive decisions.",
    },
  ];

  const built = await buildDocument({ draft, history, client, provider });
  const deck = built.model.deck;
  if (!deck) {
    console.error("build produced no deck");
    process.exit(1);
  }

  console.log("\nSlides:");
  deck.slides.forEach((slide, index) => {
    console.log(
      `${String(index + 1).padStart(2)}  ${slide.content.layout.padEnd(24)} ${slide.tier.padEnd(10)} ${slide.actionTitle}`,
    );
  });

  const failures: string[] = [];
  const placeholders = deck.slides.flatMap((slide) => [
    slide.actionTitle,
    ...visibleStrings(slide.content),
    slide.sourceNote ?? "",
    slide.notes,
  ]);
  if (placeholders.some(hasPlaceholders)) failures.push("a placeholder reached a slide");
  try {
    assertDeckTraceable(deck);
  } catch (traceError) {
    failures.push(String(traceError));
  }

  const layouts = deck.slides.map((slide) => slide.content.layout);
  if (layouts.length < 6) failures.push(`only ${layouts.length} slides`);
  if (new Set(layouts).size < 3) failures.push(`only ${new Set(layouts).size} distinct layouts`);
  for (let index = 2; index < layouts.length; index += 1) {
    if (new Set(layouts.slice(index - 2, index + 1)).size === 1) {
      failures.push(`layout \"${layouts[index]}\" runs three slides deep`);
    }
  }

  const { bytes, pages } = await renderPptx(built.model);
  writeFileSync("samples/deck-review/dfw-data-maturity.pptx", bytes);
  writeFileSync("samples/deck-review/dfw-data-maturity.model.json", JSON.stringify(built.model, null, 2));
  const parts = unzipSync(bytes);
  const slideCount = Object.keys(parts).filter((name) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(name),
  ).length;
  if (slideCount !== pages) failures.push(`package has ${slideCount} slides, renderer says ${pages}`);

  console.log(`\n${pages} pages · ${deck.slides.length} slides · ${deck.entities.length} entities`);
  console.log(`Layouts: ${[...new Set(layouts)].join(", ")}`);
  console.log(`Open items: ${built.model.openItems.length}`);
  for (const item of built.model.openItems) console.log(`  - ${item}`);

  console.log("\nAssertions:");
  for (const failure of failures) console.log(`  FAIL ${failure}`);
  if (failures.length === 0) console.log("  all hard assertions passed");
  process.exitCode = failures.length > 0 ? 1 : 0;
}

await main();

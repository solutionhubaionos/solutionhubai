/**
 * Re-runs the IndiGo x InterGlobe Hotels x BlueDart proposal through the real
 * pipeline (provider + library, signed in as a library user) and reports, per
 * slide, the layout, word count, bullet count, kinds and takeaway, then the
 * acceptance assertions for the descriptive-deck work.
 *
 *   bun scripts/verify-descriptive-deck.ts
 */
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { unzipSync } from "fflate";
import { buildDocument } from "../src/lib/documents/build";
import { buildExportBrief, type ExportHistoryMessage } from "../src/lib/documents/brief";
import { planOutline } from "../src/lib/documents/outline";
import { embedQuery } from "../src/lib/rag/embeddings";
import { searchLibraryChunks, type RetrievedChunk } from "../src/lib/rag/search";
import { renderPptx } from "../src/lib/documents/render/pptx";
import { thinSlides } from "../src/lib/documents/slides";
import { blockText } from "../src/lib/documents/validate";
import type { Block, DocumentDraft } from "../src/lib/documents/types";

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
  "Draft a proposal for a three-party partnership between IndiGo Airlines, InterGlobe Hotels and BlueDart that packages flights, hotel stays and last-mile delivery. Cover every party, how the collaboration would work, the commercial logic, risks and shortcomings, and the next steps.";
const PARTIES = ["IndiGo", "InterGlobe", "BlueDart"];
const provider = { apiKey, baseUrl };

const logs: { event: string; meta: Record<string, unknown> }[] = [];
const log = (event: string, meta: Record<string, unknown>) => {
  logs.push({ event, meta });
  if (event === "llm call") console.log(`  llm ${String(meta["label"] ?? "")}`);
};

async function main(): Promise<void> {
  const client = createClient(url, publishable, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed: ${error.message}`);

  const embed = (query: string) => embedQuery(query, provider);
  const seed = (
    await Promise.all(
      PARTIES.map((party) => searchLibraryChunks(client, party, {}, 2, embed).catch(() => [])),
    )
  ).flat() as RetrievedChunk[];

  const sources = seed.slice(0, 4).map((chunk) => ({
    title: chunk.title,
    contentId: chunk.contentId,
    chunkId: chunk.chunkId,
  }));
  const history: ExportHistoryMessage[] = [
    { role: "user", content: REQUEST },
    {
      role: "assistant",
      content:
        "**How the three fit together.** IndiGo owns the passenger and the booking moment, InterGlobe Hotels owns the room inventory in the cities those passengers fly to, and BlueDart owns the last-mile parcel leg. The interesting design is that none of them has to hand over its own inventory or pricing authority: the partnership sells a bundle, and each partner fulfils its own leg under its own terms [1].\n\n- The commercial model that survives all three P&Ls is a packaging fee on the bundle plus an attach share with the partner who owns the inventory [2].\n- The main shortcoming is operational coupling: a delayed flight breaks the stay and the parcel leg together, and peak inventory is not guaranteed [3].\n- A pilot should prove one route pair and one city before any joint entity is discussed [4].",
    },
    {
      role: "user",
      content:
        "Turn that into a client-ready proposal deck: every party, how the collaboration works, the commercial logic, risks and shortcomings, and next steps. Make it descriptive, not a wall of tables.",
    },
  ];

  const draft: DocumentDraft = {
    type: "pptx",
    mode: "proposal",
    title: "IndiGo x InterGlobe Hotels x BlueDart — proposal",
    subtitle: "Flights, stays and last-mile delivery in one packaged journey",
    audience: "COO",
    industry: "travel",
    industrySlug: null,
    client: "IndiGo",
    sector: null,
    outline: [],
    prompt: REQUEST,
  };

  const brief = await buildExportBrief(draft, history, { ...provider, client, log });
  const planned = await planOutline(brief, draft, { ...provider, log });
  const outlinePlan = planned.plans.map((plan) => ({
    title: plan.title,
    layout: plan.layout ?? "bullets",
    ...(plan.section ? { section: plan.section } : {}),
    ...(plan.kind ? { kind: plan.kind } : {}),
  }));
  const draftWithPlan: DocumentDraft = {
    ...draft,
    outline: outlinePlan.map((plan) => plan.title),
    outlinePlan,
  };

  console.log("\nPlan:");
  for (const plan of outlinePlan) console.log(`  · ${plan.title} [${plan.layout}]`);

  const built = await buildDocument({
    draft: draftWithPlan,
    history,
    client,
    provider,
    log,
  }).catch((error: unknown) => {
    for (const entry of logs.filter((item) => /fail/i.test(item.event))) {
      console.error(entry.event, JSON.stringify(entry.meta).slice(0, 400));
    }
    throw error;
  });
  const sections = built.model.sections;

  console.log("\nSlides:");
  const table = sections.map((section, index) => {
    const text = section.blocks.map(blockText).join(" ");
    const words = text.split(/\s+/).filter(Boolean).length;
    const bullets = section.blocks
      .filter((block): block is Extract<Block, { type: "bullet_list" }> => block.type === "bullet_list")
      .flatMap((block) => block.items);
    const kinds = [...new Set(bullets.map((item) => item.kind ?? "evidence"))].join("/");
    console.log(
      `${String(index + 1).padStart(2)}  ${(section.layout ?? "?").padEnd(11)} ${section.kind.padEnd(15)} ` +
        `words=${String(words).padStart(3)} bullets=${bullets.length} kinds=${kinds || "-"} ` +
        `takeaway=${section.takeaway ? "yes" : "no"}  ${section.title}`,
    );
    return { section, text, words, bullets };
  });

  const failures: string[] = [];
  const warnings: string[] = [];
  const check = (name: string, ok: boolean, detail: string) => {
    if (!ok) failures.push(`${name}: ${detail}`);
  };

  // Every brief party on the parties slide.
  const partySlide = sections.find((section) => section.kind === "parties");
  if (!partySlide) failures.push("parties slide: missing");
  else {
    const text = JSON.stringify(partySlide.blocks).toLowerCase();
    for (const party of PARTIES) {
      if (!text.includes(party.toLowerCase()))
        failures.push(`parties slide: ${party} is absent`);
    }
  }

  // No figure repeated across slides.
  const figurePattern =
    /[£$€₹]\s?\d[\d,.]*\s?(?:bn|m|k)?|\b\d[\d,.]*\s?(?:%|bn|m|k|x)\b|(?:\d+[–-]\d+\s?%)/gi;
  const owners = new Map<string, string[]>();
  for (const { section, text } of table) {
    for (const match of text.matchAll(figurePattern)) {
      const figure = match[0].replace(/\s+/g, " ").toLowerCase();
      const list = owners.get(figure) ?? [];
      list.push(section.title);
      owners.set(figure, list);
    }
  }
  for (const [figure, titles] of owners) {
    if (new Set(titles).size > 1) failures.push(`figure "${figure}" repeats on: ${titles.join(" | ")}`);
  }

  // Next steps: 3-5 recommendation bullets.
  const nextSlide = sections.find(
    (section) => section.kind === "next_steps" || /next steps|the ask/i.test(section.title),
  );
  if (!nextSlide) failures.push("next steps slide: missing");
  else {
    const recommendations = nextSlide.blocks
      .filter((block) => block.type === "bullet_list" || block.type === "numbered_list")
      .flatMap((block) => block.items)
      .filter((item) => item.kind === "recommendation");
    check(
      "next steps recommendations",
      recommendations.length >= 3 && recommendations.length <= 5,
      `${recommendations.length} recommendation bullets`,
    );
  }

  // Risks slide exists.
  check(
    "risks slide",
    sections.some(
      (section) => section.kind === "shortcomings" || /risks?|shortcom/i.test(section.title),
    ),
    "no risks/shortcomings slide",
  );

  // Unsupported claims: the verifier records every one it removed as a Review
  // open item. A claim that carries a number/date is a failure; a purely
  // narrative claim is a warning (the verifier did its job by removing it).
  const reviewItems = built.model.openItems.filter((item) => item.startsWith("Review:"));
  const numericReviews = reviewItems.filter((item) =>
    /\d/.test(item.replace(/ on slide \S+\.?$/, "")),
  );
  check("no unsupported numbers", numericReviews.length === 0, numericReviews.join(" | "));
  for (const item of reviewItems.filter((entry) => !numericReviews.includes(entry))) {
    warnings.push(`verifier removed an unsupported claim: ${item}`);
  }

  // Gate, table density, thin slides.
  check("gate not blocked", !built.gate.blocked, built.gate.message || "blocked");
  let run = 0;
  let maxRun = 0;
  for (const section of sections) {
    if (section.layout === "table") {
      run += 1;
      maxRun = Math.max(maxRun, run);
    } else run = 0;
  }
  if (maxRun > 2) warnings.push(`table run: ${maxRun} consecutive table slides`);
  for (const entry of thinSlides(sections)) {
    warnings.push(`thin slide "${entry.title}": ${entry.reasons.join(", ")}`);
  }

  // Enrichment budget.
  const calls = logs.filter((entry) => entry.event === "llm call");
  const enrichment = calls.filter((entry) =>
    String(entry.meta["label"] ?? "").includes("enrichment"),
  );
  check("at most one enrichment call", enrichment.length <= 1, `${enrichment.length} enrichment calls`);
  console.log(
    `\nLLM calls: ${calls.length} (enrichment ${enrichment.length}) · gate ${built.gate.blocked ? "BLOCKED" : "open"}`,
  );

  const { bytes, pages } = await renderPptx(built.model);
  writeFileSync("samples/deck-review/indigo-bluedart.pptx", bytes);
  writeFileSync(
    "samples/deck-review/indigo-bluedart.model.json",
    JSON.stringify(built.model, null, 2),
  );
  const parts = unzipSync(bytes);
  const slideCount = Object.keys(parts).filter((name) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(name),
  ).length;
  check("pptx re-opens", slideCount > 0, "no slides in package");

  console.log(`\nRendered ${pages} pages. Written samples/deck-review/indigo-bluedart.pptx`);
  console.log(`Open items: ${built.model.openItems.length}`);
  for (const item of built.model.openItems) console.log(`  - ${item}`);

  console.log("\nAssertions:");
  for (const failure of failures) console.log(`  FAIL ${failure}`);
  for (const warning of warnings) console.log(`  warn ${warning}`);
  if (failures.length === 0) console.log("  all hard assertions passed");
  process.exitCode = failures.length > 0 ? 1 : 0;
}

await main();

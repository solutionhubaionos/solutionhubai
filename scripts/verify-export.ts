/**
 * End-to-end verification of the export pipeline against the real provider and
 * the real library (signed in as a library user, so RLS still applies).
 *
 *   bun scripts/verify-export.ts [runs]
 *
 * Two proposal runs and one pitch run, mirroring the UI exactly: brief from the
 * conversation, planned slide plan on the confirm screen, then build that plan
 * verbatim. Each run renders PPTX, DOCX and PDF from the same model.
 *
 * The assertions are the acceptance criteria, not a fixed slide mix: the plan is
 * the contract, every slide is non-empty, the requested pointers and
 * shortcomings tables exist with rows, charts are sourced or labelled, the call
 * count stays at five (plus at most one repair), and the build finishes in 90s.
 */
import { createClient } from "@supabase/supabase-js";
import { unzipSync } from "fflate";
import { buildDocument } from "../src/lib/documents/build";
import { buildExportBrief, type ExportHistoryMessage } from "../src/lib/documents/brief";
import { planOutline } from "../src/lib/documents/outline";
import { searchLibraryChunks, type RetrievedChunk } from "../src/lib/rag/search";
import { embedQuery } from "../src/lib/rag/embeddings";
import { renderPptx } from "../src/lib/documents/render/pptx";
import { renderDocx } from "../src/lib/documents/render/docx";
import { renderPdf } from "../src/lib/documents/render/pdf";
import type { Block, DocumentDraft, DocumentMode, DocumentType } from "../src/lib/documents/types";

const apiKey = process.env["TOKENFACTORY_API_KEY"];
const baseUrl = (process.env["TOKENFACTORY_API_BASE"] ?? "").replace(/\/+$/, "");
const url = process.env["SUPABASE_URL"] ?? process.env["VITE_SUPABASE_URL"] ?? "";
const publishable =
  process.env["SUPABASE_PUBLISHABLE_KEY"] ?? process.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ?? "";
const email = process.env["LIBRARY_USER_EMAIL"];
const password = process.env["LIBRARY_USER_PASSWORD"];

if (!apiKey || !baseUrl || !url || !publishable || !email || !password) {
  console.error("Provider and library credentials must be configured in .env");
  process.exit(1);
}

const PROPOSAL_REQUEST =
  "Draft a proposal for a three-party vacation package between IndiGo Airlines, InterGlobe Hotels and Movin. Include a separate collaboration pointers table and a separate shortcomings table, with numbers, tables and graphs, and an assumed footfall.";
const PITCH_REQUEST =
  "Build a pitch deck for the same three-party vacation package between IndiGo Airlines, InterGlobe Hotels and Movin, with numbers and tables.";

const EXPECTED_ENTITIES = ["indigo", "interglobe", "movin"];
const BANNED = ["BluChip", "EV", "60+", "30+", "15-25%"];
const RUNS = Math.max(1, Number.parseInt(process.argv[2] ?? "3", 10));
const MAX_LLM_CALLS = 5;
const TARGET_MS = 90_000;

type Scenario = {
  label: string;
  mode: DocumentMode;
  type: DocumentType;
  request: string;
  expectTables: boolean;
};

const SCENARIOS: Scenario[] = [
  {
    label: "proposal / docx",
    mode: "proposal",
    type: "docx",
    request: PROPOSAL_REQUEST,
    expectTables: true,
  },
  {
    label: "proposal / pdf",
    mode: "proposal",
    type: "pdf",
    request: PROPOSAL_REQUEST,
    expectTables: true,
  },
  {
    label: "pitch / pptx",
    mode: "pitch",
    type: "pptx",
    request: PITCH_REQUEST,
    expectTables: false,
  },
];

const provider = { apiKey: apiKey as string, baseUrl };

type LogEntry = { event: string; meta: Record<string, unknown> };

function makeClient() {
  return createClient(url, publishable, { auth: { persistSession: false } });
}

async function scenarioHistory(
  chunks: RetrievedChunk[],
  request: string,
): Promise<ExportHistoryMessage[]> {
  const sources = chunks.slice(0, 4).map((chunk) => ({
    title: chunk.title,
    contentId: chunk.contentId,
    chunkId: chunk.chunkId,
  }));
  return [
    { role: "user", content: request },
    {
      role: "assistant",
      content:
        "IndiGo, InterGlobe Hotels and Movin all have material in the library; the evidence covers crew operations, procurement and logistics [1][2][3].",
      sources,
    },
    {
      role: "user",
      content:
        "Cover all three parties, with a separate pointers table and a separate shortcomings table.",
    },
  ];
}

type SlideReport = { title: string; layout: string; blocks: string[]; passages: number };

type RunReport = {
  run: number;
  label: string;
  buildMs: number;
  totalMs: number;
  title: string;
  parties: string[];
  slides: SlideReport[];
  outlineMatches: boolean;
  llmCalls: number;
  repairs: number;
  completionTokens: number;
  reasoningTokens: number;
  placeholders: number;
  bannedFound: string[];
  pptxSlides: number;
  docxParts: number;
  pdfPages: number;
  openItems: string[];
  failures: string[];
  logs: LogEntry[];
};

function check(name: string, ok: boolean, detail: string, failures: string[]): void {
  if (!ok) failures.push(`${name}: ${detail}`);
}

function tableRows(section: { blocks: Block[] }): number {
  return section.blocks
    .filter((block): block is Extract<Block, { type: "table" }> => block.type === "table")
    .reduce((total, block) => total + block.rows.length, 0);
}

async function runOnce(
  run: number,
  scenario: Scenario,
  client: ReturnType<typeof createClient>,
): Promise<RunReport> {
  const started = Date.now();
  const logs: LogEntry[] = [];
  const failures: string[] = [];
  // Echo each model call as it happens: a stalled export must be visible in the
  // log, not discovered after the run finishes.
  const log = (event: string, meta: Record<string, unknown>) => {
    logs.push({ event, meta });
    if (event === "llm call" || event === "llm call failed") {
      console.log(`+${((Date.now() - started) / 1000).toFixed(0)}s ${formatCall({ event, meta })}`);
    }
  };

  const embed = (query: string) => embedQuery(query, { apiKey: apiKey as string, baseUrl });
  let seedChunks: RetrievedChunk[] = [];
  try {
    const batches = await Promise.all(
      ["IndiGo Airlines", "InterGlobe Hotels", "Movin"].map((entity) =>
        searchLibraryChunks(client, entity, {}, 2, embed).catch(() => []),
      ),
    );
    seedChunks = batches.flat().slice(0, 4);
  } catch {
    seedChunks = [];
  }
  const history = await scenarioHistory(seedChunks, scenario.request);

  const draft: DocumentDraft = {
    type: scenario.type,
    mode: scenario.mode,
    title:
      scenario.mode === "proposal"
        ? "IndiGo x InterGlobe Hotels x Movin — proposal"
        : "IndiGo x InterGlobe Hotels x Movin — pitch deck",
    subtitle: "Vacation packages built from the Solution Hub library",
    audience: "COO",
    industry: "travel",
    industrySlug: null,
    client: "IndiGo",
    sector: null,
    outline: [],
    prompt: scenario.request,
  };

  // Confirm screen: brief + planned slide plan. What the card shows is what the
  // builder must generate, verbatim.
  const brief = await buildExportBrief(draft, history, { ...provider, client, log });
  const planned = await planOutline(brief, draft, { ...provider, log });
  const outlinePlan = planned.plans.map((plan) => ({
    title: plan.title,
    layout: plan.layout ?? "bullets",
    ...(plan.section ? { section: plan.section } : {}),
  }));
  const outline = outlinePlan.map((plan) => plan.title);
  const draftWithPlan: DocumentDraft = { ...draft, outline, outlinePlan };

  console.log(
    `planning done in ${((Date.now() - started) / 1000).toFixed(1)}s: ${outline.length} slides`,
  );
  for (const plan of outlinePlan) console.log(`  · ${plan.title} [${plan.layout}]`);

  const buildStarted = Date.now();
  const built = await buildDocument({
    draft: draftWithPlan,
    history,
    client,
    provider,
    log,
  });
  const buildMs = Date.now() - buildStarted;

  const sectionTitles = built.model.sections.map((section) => section.title);
  const outlineMatches = JSON.stringify(sectionTitles) === JSON.stringify(outline);

  const callLogs = logs.filter((entry) => entry.event === "llm call");
  const repairs = callLogs.filter((entry) =>
    String(entry.meta["label"] ?? "")
      .toLowerCase()
      .includes("repair"),
  ).length;
  const completionTokens = callLogs.reduce(
    (sum, entry) => sum + Number(entry.meta["completion_tokens"] ?? 0),
    0,
  );
  const reasoningTokens = callLogs.reduce(
    (sum, entry) => sum + Number(entry.meta["reasoning_tokens"] ?? 0),
    0,
  );

  const documentText = JSON.stringify(built.model.sections);
  const placeholders = (documentText.match(/\[To be confirmed\]/gi) ?? []).length;
  const bannedFound = BANNED.filter((value) => documentText.includes(value));

  // Render every format from the same model: the model is shared, the three
  // writers are what the user can actually download.
  const pptx = renderPptx(built.model);
  const pptxParts = unzipSync(pptx.bytes);
  const pptxSlides = Object.keys(pptxParts).filter((name) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(name),
  ).length;
  const docx = renderDocx(built.model);
  const docxParts = Object.keys(unzipSync(docx.bytes)).length;
  const pdf = await renderPdf(built.model);
  const pdfHeader = new TextDecoder().decode(pdf.bytes.slice(0, 5));

  // Entities actually searched, from the pipeline's own union log.
  const entityEntry = logs.find((entry) => entry.event === "export entities union");
  const parties = Array.isArray(entityEntry?.meta["entities"])
    ? (entityEntry?.meta["entities"] as string[])
    : [];
  const partiesText = parties.join(" | ").toLowerCase();

  check(
    "plan is the contract",
    outlineMatches,
    `${outline.length} planned vs ${sectionTitles.length} built`,
    failures,
  );
  check(
    "slide count 8-12",
    built.model.sections.length >= 8 && built.model.sections.length <= 12,
    `${built.model.sections.length} slides`,
    failures,
  );
  check("gate not blocked", !built.gate.blocked, built.gate.message || "blocked", failures);
  check(
    "every slide has content",
    built.model.sections.every((section) =>
      section.blocks.some((block) => block.type !== "heading"),
    ),
    built.model.sections
      .filter((section) => !section.blocks.some((block) => block.type !== "heading"))
      .map((section) => section.title)
      .join(", "),
    failures,
  );
  check("no placeholders", placeholders === 0, `${placeholders} placeholders`, failures);
  check("no banned strings", bannedFound.length === 0, bannedFound.join(", "), failures);
  check(
    "all three parties in evidence",
    EXPECTED_ENTITIES.every((name) => partiesText.includes(name)),
    parties.join(" | ") || "no entity log",
    failures,
  );
  check(
    "five LLM calls plus at most one repair",
    callLogs.length <= MAX_LLM_CALLS + 1 && repairs <= 1,
    `${callLogs.length} calls, ${repairs} repairs`,
    failures,
  );
  check("build under 90s", buildMs < TARGET_MS, `${(buildMs / 1000).toFixed(1)}s`, failures);
  check("pptx re-opens", pptxSlides > 0, `${pptxSlides} slides`, failures);
  check("docx re-opens", docxParts > 0, `${docxParts} parts`, failures);
  check("pdf non-blank", pdfHeader === "%PDF-" && pdf.pages > 0, `${pdf.pages} pages`, failures);

  if (scenario.expectTables) {
    const pointers = built.model.sections.find(
      (section) => section.kind === "pointers" || /pointer/i.test(section.title),
    );
    const shortcomings = built.model.sections.find(
      (section) => section.kind === "shortcomings" || /shortcom|risks?/i.test(section.title),
    );
    check(
      "separate pointers table",
      Boolean(pointers && tableRows(pointers) > 0),
      pointers ? `${tableRows(pointers)} rows` : "no pointers slide",
      failures,
    );
    check(
      "separate shortcomings table",
      Boolean(shortcomings && tableRows(shortcomings) > 0),
      shortcomings ? `${tableRows(shortcomings)} rows` : "no shortcomings slide",
      failures,
    );
  }

  // Charts must be sourced (with refs) or explicitly illustrative.
  for (const section of built.model.sections) {
    for (const block of section.blocks) {
      if (block.type !== "chart") continue;
      if (block.chart.basis === "assumption") {
        check("assumption chart labelled", block.illustrative === true, section.title, failures);
      } else {
        check("sourced chart has refs", block.sources.length > 0, section.title, failures);
      }
    }
  }

  return {
    run,
    label: scenario.label,
    buildMs,
    totalMs: Date.now() - started,
    title: built.model.cover.title,
    parties,
    slides: built.model.sections.map((section) => ({
      title: section.title,
      layout: section.layout ?? "-",
      blocks: section.blocks.map((block) => block.type),
      passages: built.gate.sections.find((entry) => entry.id === section.id)?.passages ?? 0,
    })),
    outlineMatches,
    llmCalls: callLogs.length,
    repairs,
    completionTokens,
    reasoningTokens,
    placeholders,
    bannedFound,
    pptxSlides,
    docxParts,
    pdfPages: pdf.pages,
    openItems: built.model.openItems,
    failures,
    logs,
  };
}

function formatCall(entry: LogEntry): string {
  const meta = entry.meta;
  return [
    `[llm] ${String(meta["type"]).padEnd(13)}`,
    `label=${String(meta["label"] ?? "-").padEnd(22)}`,
    `thinking=${meta["thinking"]}`,
    `max_tokens=${meta["max_tokens"]}`,
    `finish=${meta["finish_reason"] ?? "-"}`,
    `reasoning=${meta["reasoning_tokens"] ?? "-"}`,
    `completion=${meta["completion_tokens"] ?? "-"}`,
    `chars=${meta["content_chars"]}`,
    `ms=${meta["duration_ms"]}`,
    `attempt=${meta["attempt"]}`,
  ].join(" ");
}

async function main(): Promise<void> {
  const client = makeClient();
  const signIn = await client.auth.signInWithPassword({
    email: email as string,
    password: password as string,
  });
  if (signIn.error) {
    console.error(`sign-in failed: ${signIn.error.message}`);
    process.exit(1);
  }

  const reports: RunReport[] = [];
  const count = Math.min(RUNS, SCENARIOS.length);
  for (let run = 1; run <= count; run += 1) {
    const scenario = SCENARIOS[run - 1] as Scenario;
    console.log(`\n=== RUN ${run}/${count} — ${scenario.label} ===`);
    const report = await runOnce(run, scenario, client);
    reports.push(report);
    console.log(`title: ${report.title}`);
    console.log(`parties: ${report.parties.join(" | ")}`);
    console.log(
      `build: ${(report.buildMs / 1000).toFixed(1)}s; total: ${(report.totalMs / 1000).toFixed(1)}s`,
    );
    console.log(
      `llm calls: ${report.llmCalls} (repairs: ${report.repairs}); tokens: completion=${report.completionTokens}, reasoning=${report.reasoningTokens}`,
    );
    console.log("slides:");
    for (const slide of report.slides) {
      console.log(
        `  - ${slide.title} · ${slide.layout} · [${slide.blocks.join(", ")}] · passages=${slide.passages}`,
      );
    }
    console.log(
      `placeholders: ${report.placeholders}; banned: ${report.bannedFound.join(", ") || "none"}`,
    );
    console.log(
      `pptx slides: ${report.pptxSlides}; docx parts: ${report.docxParts}; pdf pages: ${report.pdfPages}`,
    );
    console.log(`open items: ${report.openItems.length}`);
    if (report.failures.length > 0) {
      console.log(`FAILURES: ${report.failures.join("; ")}`);
    } else {
      console.log("all assertions passed");
    }
    console.log("\nper-call log:");
    for (const entry of report.logs) {
      if (entry.event === "llm call" || entry.event === "llm call failed") {
        console.log(formatCall(entry));
      }
    }
    for (const entry of report.logs) {
      if (
        entry.event === "deck parse failed" ||
        entry.event === "deck verification skipped" ||
        entry.event === "deck verified" ||
        entry.event === "missing slide regeneration failed"
      ) {
        console.log(`[diag] ${entry.event} ${JSON.stringify(entry.meta).slice(0, 400)}`);
      }
    }
  }

  const failed = reports.filter((report) => report.failures.length > 0);
  console.log(`\n=== SUMMARY: ${reports.length - failed.length}/${reports.length} runs passed ===`);
  if (failed.length > 0) {
    for (const report of failed) console.log(`run ${report.run}: ${report.failures.join("; ")}`);
    process.exitCode = 1;
  }
}

await main();

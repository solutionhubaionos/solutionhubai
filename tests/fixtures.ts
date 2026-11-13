/**
 * Fixtures for the document pipeline tests. The chunks have the same shape as
 * search_chunks rows, and the mock provider follows the real stage prompts, so
 * these tests exercise brief -> outline -> retrieval -> generation -> validation
 * without a database or network.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../src/integrations/supabase/types";
import type { ExportHistoryMessage } from "../src/lib/documents/brief";
import type { DocumentDraft } from "../src/lib/documents/types";
import type { RetrievedChunk } from "../src/lib/rag/search";

const BASE = {
  vectorRank: 1,
  textRank: 1,
  score: 0.031,
};

const BASE_CHUNKS: RetrievedChunk[] = [
  {
    ...BASE,
    chunkId: "chunk-z1",
    contentId: "doc-z",
    content:
      "Zurich Insurance reduced claims assessment time from 14 days to 6 days across 12 markets after deploying an AI triage workflow. The programme covered 2,400 assessors and cut manual rework by 38%.",
    page: 3,
    slide: null,
    heading: "Claims transformation",
    title: "Zurich claims transformation",
    fileName: "zurich-claims.pdf",
    filePath: "library/zurich-claims.pdf",
    industry: "insurance",
    customerName: "Zurich Insurance",
  },
  {
    ...BASE,
    chunkId: "chunk-z2",
    contentId: "doc-z",
    content:
      "Straight-through processing rose to 61% of personal lines claims within two quarters. The client attributed the gain to automated document checks and a single assessment queue.",
    page: 5,
    slide: null,
    heading: "Outcomes",
    title: "Zurich claims transformation",
    fileName: "zurich-claims.pdf",
    filePath: "library/zurich-claims.pdf",
    industry: "insurance",
    customerName: "Zurich Insurance",
  },
  {
    ...BASE,
    chunkId: "chunk-z3",
    contentId: "doc-z2",
    content:
      "A six-week diagnostic interviewed 34 claims handlers and reviewed 1,200 sample files. It found that 42% of assessment time went to re-keying data between three systems.",
    page: 2,
    slide: null,
    heading: "Diagnostic",
    title: "Insurance operating model review",
    fileName: "insurance-operating-model.pdf",
    filePath: "library/insurance-operating-model.pdf",
    industry: "insurance",
    customerName: "Zurich Insurance",
  },
  {
    ...BASE,
    chunkId: "chunk-z4",
    contentId: "doc-z2",
    content:
      "The recommended operating model moved document intake to a shared service and introduced a weekly quality review. It was designed to protect regulatory traceability in every market.",
    page: 7,
    slide: null,
    heading: "Recommended model",
    title: "Insurance operating model review",
    fileName: "insurance-operating-model.pdf",
    filePath: "library/insurance-operating-model.pdf",
    industry: "insurance",
    customerName: "Zurich Insurance",
  },
  {
    ...BASE,
    chunkId: "chunk-z5",
    contentId: "doc-z3",
    content:
      "Phase one runs for eight weeks and covers intake, triage and the assessor dashboard. Phase two adds fraud signals and supplier integration over the following ten weeks.",
    slide: 6,
    page: null,
    heading: "Delivery plan",
    title: "Claims programme roadmap",
    fileName: "claims-roadmap.pptx",
    filePath: "library/claims-roadmap.pptx",
    industry: "insurance",
    customerName: "Zurich Insurance",
  },
  {
    ...BASE,
    chunkId: "chunk-z6",
    contentId: "doc-z3",
    content:
      "Governance uses a fortnightly steering group chaired by the client operations director. A named delivery lead owns the plan, risks and dependencies.",
    slide: 9,
    page: null,
    heading: "Governance",
    title: "Claims programme roadmap",
    fileName: "claims-roadmap.pptx",
    filePath: "library/claims-roadmap.pptx",
    industry: "insurance",
    customerName: "Zurich Insurance",
  },
  {
    ...BASE,
    chunkId: "chunk-i1",
    contentId: "doc-i",
    content:
      "InterGlobe Aviation consolidated crew rosters from four planning tools into one control tower. Roster publication moved from 48 hours to 9 hours before departure.",
    page: 4,
    slide: null,
    heading: "Crew operations",
    title: "InterGlobe crew operations",
    fileName: "interglobe-crew.pdf",
    filePath: "library/interglobe-crew.pdf",
    industry: "aviation",
    customerName: "InterGlobe Aviation",
  },
  {
    ...BASE,
    chunkId: "chunk-i2",
    contentId: "doc-i",
    content:
      "Absence cover improved by 23% because planners could see availability across bases in one view. The change affected 1,800 crew members.",
    page: 6,
    slide: null,
    heading: "Outcomes",
    title: "InterGlobe crew operations",
    fileName: "interglobe-crew.pdf",
    filePath: "library/interglobe-crew.pdf",
    industry: "aviation",
    customerName: "InterGlobe Aviation",
  },
  {
    ...BASE,
    chunkId: "chunk-i3",
    contentId: "doc-i2",
    content:
      "The integration layer connected the crew platform to the flight schedule every 90 seconds. A replay queue protects rosters when the upstream feed fails.",
    slide: 5,
    page: null,
    heading: "Architecture",
    title: "Aviation integration blueprint",
    fileName: "aviation-integration.pptx",
    filePath: "library/aviation-integration.pptx",
    industry: "aviation",
    customerName: "InterGlobe Aviation",
  },
  {
    ...BASE,
    chunkId: "chunk-i4",
    contentId: "doc-i2",
    content:
      "A four-week pilot covered two bases and 240 crew. It reduced manual roster edits by 31% and produced a reusable integration pattern for the remaining bases.",
    slide: 8,
    page: null,
    heading: "Pilot",
    title: "Aviation integration blueprint",
    fileName: "aviation-integration.pptx",
    filePath: "library/aviation-integration.pptx",
    industry: "aviation",
    customerName: "InterGlobe Aviation",
  },
  {
    ...BASE,
    chunkId: "chunk-i5",
    contentId: "doc-i3",
    content:
      "The rollout sequence starts with the two largest bases, then adds regional bases at four-week intervals. Training is delivered as a two-hour workshop for planners.",
    page: 11,
    slide: null,
    heading: "Rollout",
    title: "Aviation rollout playbook",
    fileName: "aviation-rollout.pdf",
    filePath: "library/aviation-rollout.pdf",
    industry: "aviation",
    customerName: "InterGlobe Aviation",
  },
  {
    ...BASE,
    chunkId: "chunk-r1",
    contentId: "doc-r",
    content:
      "A retail client cut stock-out incidents by 27% after introducing daily demand signals into store replenishment. The programme covered 340 stores.",
    page: 3,
    slide: null,
    heading: "Replenishment",
    title: "Retail replenishment programme",
    fileName: "retail-replenishment.pdf",
    filePath: "library/retail-replenishment.pdf",
    industry: "retail",
    customerName: "Northwind Retail",
  },
  {
    ...BASE,
    chunkId: "chunk-r2",
    contentId: "doc-r",
    content:
      "Forecast accuracy improved by 12 percentage points over six months. Store managers received a short daily exception list instead of a full planning pack.",
    page: 8,
    slide: null,
    heading: "Outcomes",
    title: "Retail replenishment programme",
    fileName: "retail-replenishment.pdf",
    filePath: "library/retail-replenishment.pdf",
    industry: "retail",
    customerName: "Northwind Retail",
  },
  {
    ...BASE,
    chunkId: "chunk-r3",
    contentId: "doc-r2",
    content:
      "The change team ran 18 store trials before rollout. Each trial compared a control store with a test store for four weeks.",
    page: 5,
    slide: null,
    heading: "Method",
    title: "Retail trial playbook",
    fileName: "retail-trial-playbook.pdf",
    filePath: "library/retail-trial-playbook.pdf",
    industry: "retail",
    customerName: "Northwind Retail",
  },
  {
    ...BASE,
    chunkId: "chunk-r4",
    contentId: "doc-r2",
    content:
      "A weekly trading review owns the benefit tracking. The client finance team signs off realised savings every quarter.",
    page: 9,
    slide: null,
    heading: "Governance",
    title: "Retail trial playbook",
    fileName: "retail-trial-playbook.pdf",
    filePath: "library/retail-trial-playbook.pdf",
    industry: "retail",
    customerName: "Northwind Retail",
  },
  // The document the first retrieval missed: it exists with customer "Zurich
  // Airport" and a file name that never says "Zurich" as a customer.
  {
    ...BASE,
    chunkId: "chunk-za1",
    contentId: "doc-zhr",
    content:
      "Zurich Airport's AI-on-OS programme connects flight, passenger and retail data into one operating layer. The airport reports a single view of turnarounds across 3 terminals and 41 gates.",
    slide: 4,
    page: null,
    heading: "Operating layer",
    title: "250317_ZRH_Airport_AIonOS_v1.0",
    fileName: "250317_ZRH_Airport_AIonOS_v1.0.pptx",
    filePath: "library/250317_ZRH_Airport_AIonOS_v1.0.pptx",
    industry: "airports",
    customerName: "Zurich Airport",
  },
  {
    ...BASE,
    chunkId: "chunk-za2",
    contentId: "doc-zhr",
    content:
      "The data exchange treats airlines, hotels and ground handlers as data contributors. Each partner keeps ownership of its feed while the airport publishes shared operational events.",
    slide: 7,
    page: null,
    heading: "Data exchange",
    title: "250317_ZRH_Airport_AIonOS_v1.0",
    fileName: "250317_ZRH_Airport_AIonOS_v1.0.pptx",
    filePath: "library/250317_ZRH_Airport_AIonOS_v1.0.pptx",
    industry: "airports",
    customerName: "Zurich Airport",
  },
  {
    ...BASE,
    chunkId: "chunk-za3",
    contentId: "doc-zhr",
    content:
      "Turnaround visibility improved by 18% in the pilot and 250 airport staff moved to the new console. The programme is being extended to retail and hotel partners in 2027.",
    slide: 11,
    page: null,
    heading: "Outcomes",
    title: "250317_ZRH_Airport_AIonOS_v1.0",
    fileName: "250317_ZRH_Airport_AIonOS_v1.0.pptx",
    filePath: "library/250317_ZRH_Airport_AIonOS_v1.0.pptx",
    industry: "airports",
    customerName: "Zurich Airport",
  },
  // The hotel-procurement deck the first answer did find; kept alongside Zurich
  // so the multi-entity assertion has both families to retrieve.
  {
    ...BASE,
    chunkId: "chunk-ih1",
    contentId: "doc-igl-hotel",
    content:
      "InterGlobe Hotels moved hotel procurement into one marketplace covering 46 properties. Suppliers publish rates and availability once, and property teams buy from the same catalogue.",
    slide: 3,
    page: null,
    heading: "Procurement marketplace",
    title: "InterGlobe Hotels — hotel procurement marketplace",
    fileName: "interglobe-hotel-procurement.pptx",
    filePath: "library/interglobe-hotel-procurement.pptx",
    industry: "hospitality",
    customerName: "InterGlobe Hotels",
  },
  {
    ...BASE,
    chunkId: "chunk-ih2",
    contentId: "doc-igl-hotel",
    content:
      "Supplier onboarding fell from 21 days to 5 days after the marketplace replaced email-based rate collection. The programme covered 380 suppliers in the first year.",
    slide: 6,
    page: null,
    heading: "Supplier onboarding",
    title: "InterGlobe Hotels — hotel procurement marketplace",
    fileName: "interglobe-hotel-procurement.pptx",
    filePath: "library/interglobe-hotel-procurement.pptx",
    industry: "hospitality",
    customerName: "InterGlobe Hotels",
  },
  {
    ...BASE,
    chunkId: "chunk-ih3",
    contentId: "doc-igl-hotel",
    content:
      "Procurement savings reached 9% on room rates across the portfolio. A shared booking feed lets hotel partners contribute availability to the InterGlobe travel app.",
    slide: 9,
    page: null,
    heading: "Outcomes",
    title: "InterGlobe Hotels — hotel procurement marketplace",
    fileName: "interglobe-hotel-procurement.pptx",
    filePath: "library/interglobe-hotel-procurement.pptx",
    industry: "hospitality",
    customerName: "InterGlobe Hotels",
  },
];

/**
 * Real passages are longer than the title-only threshold; make every fixture
 * chunk carry enough prose to be usable evidence, with a unique final line so
 * bullets stay distinct across sections.
 */
export const CHUNKS: RetrievedChunk[] = BASE_CHUNKS.map((chunk, index) => ({
  ...chunk,
  content: `${chunk.content} The engagement was reviewed with the client operations lead in case ${index + 1}.`,
}));

/** Additional generated cases so dedupe across nine sections has room. */
const GENERATED: RetrievedChunk[] = Array.from({ length: 44 }, (_, index) => {
  const industries = ["insurance", "aviation", "retail"];
  const customers = ["Zurich Insurance", "InterGlobe Aviation", "Northwind Retail"];
  const industry = industries[index % 3] ?? "insurance";
  const customer = customers[index % 3] ?? "Zurich Insurance";
  const percentage = 11 + index;
  const markets = 2 + (index % 9);
  const weeks = 4 + (index % 8);
  return {
    ...BASE,
    chunkId: `chunk-g${index}`,
    contentId: `doc-g${index}`,
    content: `Programme ${index + 1} improved processing throughput by ${percentage}% across ${markets} markets after a workflow redesign. The rollout covered ${120 + index * 13} staff and was delivered in ${weeks} weeks. The client operations lead signed off market ${index + 1} after a two-week review.`,
    page: 2 + (index % 9),
    slide: null,
    heading: `Case ${index + 1}`,
    title: `Library case study ${index + 1}`,
    fileName: `case-study-${index + 1}.pdf`,
    filePath: `library/case-study-${index + 1}.pdf`,
    industry,
    customerName: customer,
  };
});

CHUNKS.push(...GENERATED);

export function deckHistory(
  client = "Zurich Insurance",
  industry = "insurance",
): ExportHistoryMessage[] {
  return [
    {
      role: "user",
      content: `Build a pitch deck for ${client}, a ${industry} company. Their problem is slow manual claims handling and rising cost per claim. They care about cycle time and straight-through processing.`,
    },
    {
      role: "assistant",
      content: `Comparable work exists: claims assessment time fell from 14 days to 6 days across 12 markets [1].`,
      sources: [
        {
          title: "Zurich claims transformation",
          contentId: "doc-z",
          chunkId: "chunk-z1",
        },
      ],
    },
    {
      role: "user",
      content: "Include the 6-day result as proof and exclude pricing from this deck.",
    },
  ];
}

export function draftFor(
  input: {
    mode?: DocumentDraft["mode"];
    type?: DocumentDraft["type"];
    title?: string;
    client?: string;
    industry?: string;
  } = {},
): DocumentDraft {
  const mode = input.mode ?? "pitch";
  const type = input.type ?? "pptx";
  const client = input.client ?? "Zurich Insurance";
  const industry = input.industry ?? "insurance";
  return {
    type,
    mode,
    title: input.title ?? `${client} — ${type === "pptx" ? "pitch deck" : "proposal"}`,
    subtitle: `A ${type === "pptx" ? "pitch deck" : "proposal"} built from the Solution Hub library`,
    audience: "COO",
    industry,
    industrySlug: industry,
    client,
    sector: null,
    // The confirmed outline the user agreed to on the confirm screen. It is the
    // only section plan the builder may use.
    outline: [
      "Manual claiming is capping growth",
      "One intake queue changes the economics",
      "What you receive",
      "Comparable work, measured",
      "The commercial shape",
      "Our approach over the first eight weeks",
      "The decision we need",
    ],
    prompt: `Create a ${mode} for ${client}`,
  };
}

function hash(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) >>> 0;
  }
  return result;
}

type SearchRow = {
  chunk_id: string;
  content_id: string;
  content: string;
  page: number | null;
  slide: number | null;
  heading: string | null;
  title: string;
  file_name: string;
  file_path: string;
  industry: string;
  customer_name: string | null;
  vector_rank: number | null;
  text_rank: number | null;
  score: number;
};

function toRow(chunk: RetrievedChunk): SearchRow {
  return {
    chunk_id: chunk.chunkId,
    content_id: chunk.contentId,
    content: chunk.content,
    page: chunk.page,
    slide: chunk.slide,
    heading: chunk.heading,
    title: chunk.title,
    file_name: chunk.fileName,
    file_path: chunk.filePath,
    industry: chunk.industry,
    customer_name: chunk.customerName,
    vector_rank: chunk.vectorRank,
    text_rank: chunk.textRank,
    score: chunk.score,
  };
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cheap stand-in for pg_trgm similarity(), enough to exercise resolution. */
function nameSimilarity(name: string, candidates: readonly string[]): number {
  const key = normalizeName(name);
  let best = 0;
  for (const candidate of candidates) {
    const other = normalizeName(candidate);
    if (!key || !other) continue;
    if (key === other) {
      best = 1;
      continue;
    }
    if (key.includes(other) || other.includes(key)) {
      best = Math.max(best, 0.9);
      continue;
    }
    const a = new Set(key.split(" "));
    const b = new Set(other.split(" "));
    const shared = [...a].filter((word) => b.has(word)).length;
    if (shared > 0) best = Math.max(best, 0.4 + (0.5 * shared) / Math.max(a.size, b.size));
  }
  return best;
}

export function createMockSupabase(
  chunks: readonly RetrievedChunk[],
  queries: string[],
  options: { fixedResult?: readonly RetrievedChunk[] } = {},
): SupabaseClient<Database> {
  const source = () => options.fixedResult ?? chunks;

  const tableQuery = (table: string) => {
    const filters: { ids?: string[]; inColumn?: string; terms?: string[] } = {};
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        if (column === "content_id" || column === "id") {
          filters.ids = [String(value)];
          filters.inColumn = column;
        }
        return builder;
      },
      in: (column: string, values: readonly unknown[]) => {
        filters.ids = values.map(String);
        filters.inColumn = column;
        return builder;
      },
      or: (expression: string) => {
        filters.terms = [...expression.matchAll(/%([^%]*)%/g)].map((match) => match[1] ?? "");
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: (value: { data: unknown[]; error: null }) => unknown) => {
        if (table === "content_items") {
          if (filters.inColumn === "id") {
            return resolve({
              data: (filters.ids ?? []).map((id) => ({
                id,
                content_type: "deck",
                created_at: "2026-01-01T00:00:00.000Z",
              })),
              error: null,
            });
          }
          const terms = filters.terms ?? [];
          const ids = [
            ...new Set(
              source()
                .filter(
                  (chunk) =>
                    terms.length === 0 ||
                    terms.some(
                      (term) =>
                        normalizeName(chunk.customerName ?? "").includes(normalizeName(term)) ||
                        normalizeName(chunk.title).includes(normalizeName(term)) ||
                        normalizeName(chunk.fileName).includes(normalizeName(term)),
                    ),
                )
                .map((chunk) => chunk.contentId),
            ),
          ];
          return resolve({ data: ids.map((id) => ({ id })), error: null });
        }

        const ids = filters.ids ?? [];
        const rows = source()
          .filter((chunk) => ids.includes(chunk.contentId))
          .map((chunk) => ({
            ...toRow(chunk),
            id: chunk.chunkId,
            chunk_index: 0,
            content_items: {
              title: chunk.title,
              file_name: chunk.fileName,
              file_path: chunk.filePath,
              industry: chunk.industry,
              customer_name: chunk.customerName,
            },
          }));
        return resolve({ data: rows, error: null });
      },
    };
    return builder;
  };

  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "match_customer_entities") {
        const candidates = (args["p_candidates"] as string[] | undefined) ?? [];
        const threshold = Number(args["p_threshold"] ?? 0.4);
        const names = [
          ...new Set(
            source()
              .map((chunk) => chunk.customerName)
              .filter(Boolean) as string[],
          ),
        ];
        const rows = names
          .map((canonical) => ({
            canonical,
            matched_name: canonical,
            score: nameSimilarity(canonical, candidates),
            spellings: [canonical],
          }))
          .filter((row) => row.score >= threshold)
          .sort((a, b) => b.score - a.score)
          .slice(0, Number(args["p_limit"] ?? 3));
        return { data: rows, error: null };
      }

      const query = String(args["query_text"] ?? "");
      queries.push(query);
      const customer = typeof args["filter_customer"] === "string" ? args["filter_customer"] : null;
      const industry = typeof args["filter_industry"] === "string" ? args["filter_industry"] : null;
      // A scoped search returns only that scope's rows: if the spelling does not
      // exist, the result is empty, exactly like the real database function.
      const pool = source().filter(
        (chunk) =>
          (!customer || chunk.customerName === customer) &&
          (!industry || chunk.industry === industry),
      );
      const offset = hash(query) % Math.max(pool.length, 1);
      const rotated = [...pool.slice(offset), ...pool.slice(0, offset)];
      return { data: rotated.slice(0, 12).map(toRow), error: null };
    },
    from: tableQuery,
  };
  return client as unknown as SupabaseClient<Database>;
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function briefFrom(user: string): Record<string, unknown> {
  const interglobe = user.includes("InterGlobe");
  const client = interglobe ? "InterGlobe Aviation" : "Zurich Insurance";
  const industry = interglobe ? "aviation" : "insurance";
  return {
    title: interglobe
      ? "InterGlobe x IndiGo — pitch deck"
      : "Zurich Insurance — claims transformation",
    subject: interglobe
      ? "InterGlobe x IndiGo partnership"
      : "Zurich Insurance claims transformation",
    partiesInvolved: interglobe
      ? ["Adani Airports", "IndiGo", "InterGlobe Hotels"]
      : ["Zurich Insurance"],
    keyTopics: interglobe
      ? ["crew operations", "Fly++ SPV", "JV versus tech partner"]
      : ["claims assessment", "straight-through processing"],
    keyEntities: interglobe
      ? ["Adani Airports", "IndiGo", "InterGlobe Hotels", "Zurich Airport", "Fly++ SPV"]
      : ["Zurich Insurance", "claims transformation"],
    client,
    industry,
    sector: industry,
    audience: "COO",
    problem: interglobe
      ? "Crew rosters are split across four planning tools, which slows publication and obscures availability."
      : "Claims assessment is manual and slow, which raises cost per claim and hurts customer experience.",
    goals: ["Reduce cycle time", "Improve straight-through processing"],
    constraints: ["No pricing in this document"],
    budget: null,
    timeline: null,
    tone: "professional, confident, concise",
    include: ["proof with measured outcomes"],
    exclude: ["pricing"],
    decisions: [],
    citedDocuments: [
      { title: interglobe ? "InterGlobe crew operations" : "Zurich claims transformation" },
    ],
    openItems: ["Budget range"],
  };
}

function outlineFrom(user: string): Record<string, unknown> {
  const interglobe = user.includes("InterGlobe");
  const client = interglobe ? "InterGlobe Aviation" : "Zurich Insurance";
  const industry = interglobe ? "aviation" : "insurance";
  const pitch = /Mode: pitch/.test(user);
  const kinds = pitch
    ? ["problem", "solution", "why_us", "proof", "how_it_works", "results", "timeline", "ask"]
    : [
        "executive_summary",
        "problem",
        "solution",
        "approach",
        "proof",
        "timeline",
        "deliverables",
        "assumptions",
        "pricing",
        "next_steps",
      ];
  const titles: Record<string, string> = {
    executive_summary: `Executive summary for ${client}`,
    problem: `${client}: the current process is the constraint`,
    solution: `A faster path from intake to decision`,
    approach: `How the work runs over the first twelve weeks`,
    proof: `Comparable ${industry} work with measured outcomes`,
    timeline: `A phased path to first value`,
    deliverables: `What the ${client} team receives`,
    assumptions: `What must be true for this to land`,
    pricing: `Commercial approach under review`,
    next_steps: `The decision needed next`,
    why_us: `Why this team fits ${client}`,
    how_it_works: `How it fits the existing stack`,
    results: `Results the library can substantiate`,
    ask: `Approve a four-week pilot`,
  };
  const focus: Record<string, string> = {
    problem: "Establish the current constraint.",
    solution: "Describe the proposed change.",
    proof: "Show comparable outcomes.",
    results: "Show measured results.",
    timeline: "Show phases and durations.",
    ask: "State the decision requested.",
  };
  return {
    sections: kinds.map((kind) => ({
      kind,
      title: titles[kind],
      goal: focus[kind] ?? `Cover ${kind} for ${client}.`,
      query: `${client} ${industry} ${kind} outcomes evidence`,
    })),
  };
}

function sectionFrom(user: string): Record<string, unknown> {
  const kind = /Section kind: (\w+)/.exec(user)?.[1] ?? "solution";
  // The prompt header shares a newline with [S1], so start at the first label.
  const firstLabel = user.search(/\n?\[S1\]/);
  const passageText = firstLabel >= 0 ? user.slice(firstLabel).replace(/^\n/, "") : "";
  const passageBlocks = passageText
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => /^\[S\d+\]/.test(block));

  const first = passageBlocks[0] ?? "";
  const firstLines = first.split("\n");
  const firstContent = firstLines.slice(1).join(" ").trim();
  const secondContent = (passageBlocks[1] ?? "").split("\n").slice(1).join(" ").trim();

  const paragraph = `${firstContent.slice(0, 700)}${firstContent.length > 0 ? "" : "No evidence."}`;
  const sentences = firstContent
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 25);
  const bullets = sentences.slice(0, 3);
  if (bullets.length < 2) {
    // Keep the fallback inside the same passage so every bullet is supported by S1.
    bullets.push(firstContent.slice(0, 160));
  }
  void secondContent;

  const blocks: Record<string, unknown>[] = [
    { type: "paragraph", text: paragraph, sources: ["S1"] },
    { type: "bullet_list", items: bullets.map((text) => ({ text })), sources: ["S1"] },
  ];

  if (kind === "proof" || kind === "results") {
    const match = /(\d[\d,]*(?:\.\d+)?)\s*(%|days?|weeks?|months?|x)/i.exec(firstContent);
    const weeks = /(\d+)\s*weeks?/i.exec(firstContent);
    if (match) {
      blocks.push({
        type: "metrics",
        items: [
          {
            label: "Reported outcome",
            value: match[1],
            unit: match[2],
            context: "Stated in the cited passage",
            source: "S1",
          },
        ],
        sources: ["S1"],
      });
    }
    if (match && weeks) {
      blocks.push({
        type: "table",
        caption: "Reported measures",
        headers: ["Measure", "Reported result"],
        rows: [
          ["Improvement", `${match[1]} ${match[2]}`],
          ["Delivery", `${weeks[1]} weeks`],
        ],
        sources: ["S1"],
      });
    }
  }

  return {
    blocks,
    speakerNotes: `Explain the evidence on this slide, then pause for the client's reaction. Source: ${firstLines[0]?.slice(0, 90) ?? ""}.`,
    openItems: [],
  };
}

type DeckPlan = { title: string; layout?: string; section?: string };

/**
 * Deck-shaped response for the one-call pipeline: one slide per plan entry,
 * with the title, layout and refs the real model is asked for. Content is
 * copied from the numbered passages in the prompt, so the normaliser and the
 * sourcing checks run against real passage text.
 */
function deckFrom(user: string): Record<string, unknown> {
  const planMatch =
    /Plan \(contract; same titles and order\):\n(\[[\s\S]*?\])\n\nExport brief/.exec(user);
  let plans: DeckPlan[] = [];
  if (planMatch?.[1]) {
    try {
      const parsed: unknown = JSON.parse(planMatch[1]);
      if (Array.isArray(parsed)) plans = parsed as DeckPlan[];
    } catch {
      plans = [];
    }
  }

  const passagesStart = user.indexOf("Passages (the only sourced facts you may use):");
  const assumptionsStart = user.indexOf("Assumptions model", passagesStart);
  const passageText =
    passagesStart >= 0
      ? user.slice(passagesStart, assumptionsStart > 0 ? assumptionsStart : undefined)
      : "";
  const passages = passageText
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => /^\[\d+\]/.test(block))
    .map((block, index) => {
      const [header, ...rest] = block.split("\n");
      return { ref: index + 1, header: header ?? "", content: rest.join(" ").trim() };
    });
  const fallback = passages[0]?.content ?? "The library has no passage for this slide.";
  const table = (content: string, ref: number): Record<string, unknown> => {
    const sentences = content
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 20)
      .slice(0, 3);
    const rows = (sentences.length > 0 ? sentences : [content.slice(0, 160)]).map(
      (sentence, index) => [`Point ${index + 1}`, sentence, `[${ref}]`],
    );
    return { headers: ["Point", "Detail", "Evidence"], rows };
  };

  const slides = plans.map((plan, index) => {
    const passage = passages[index % Math.max(1, passages.length)];
    const content = passage?.content || fallback;
    const ref = passage?.ref ?? 1;
    const layout = plan.layout ?? "bullets";
    const sentences = content
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 20);
    const numeric = /(\d[\d,]*(?:\.\d+)?)\s*(%|days?|weeks?|months?|x)/i.exec(content);

    const slide: Record<string, unknown> = {
      title: plan.title,
      section: plan.section,
      layout,
      notes: `Talking points for "${plan.title}", drawn from the cited passage.`,
      refs: [ref],
    };

    if (layout === "chart" && numeric) {
      slide["chart"] = {
        type: "bar",
        title: plan.title,
        unit: numeric[2],
        categories: ["Reported"],
        series: [{ name: "Reported value", values: [Number(numeric[1]?.replace(/,/g, ""))] }],
        basis: "sourced",
      };
    }
    if (layout === "table" || layout === "raci" || layout === "comparison") {
      slide["table"] = table(content, ref);
    }
    if (layout === "chart" && !slide["chart"]) slide["table"] = table(content, ref);
    if (layout !== "text" && layout !== "summary" && layout !== "bullets") {
      const points = sentences.slice(0, 2).map((sentence) => sentence.slice(0, 110));
      if (points.length > 0) slide["bullets"] = points;
    }
    if (layout === "flow") {
      slide["flow"] = [
        { label: plan.title, detail: sentences[0]?.slice(0, 90) ?? content.slice(0, 90) },
        { label: "Hand-off", detail: sentences[1]?.slice(0, 90) ?? "Documented in the passage." },
      ];
    }
    if (layout === "timeline") {
      slide["timeline"] = [
        {
          phase: "Phase 1",
          when: "First",
          items: [sentences[0]?.slice(0, 80) ?? content.slice(0, 80)],
        },
      ];
    }
    if (layout === "text" || layout === "summary" || layout === "bullets") {
      slide["text"] = content.slice(0, 260);
      slide["bullets"] = sentences.slice(0, 3).map((sentence) => sentence.slice(0, 110));
      slide["table"] = table(content, ref);
    }
    if (
      !slide["text"] &&
      !slide["bullets"] &&
      !slide["table"] &&
      !slide["chart"] &&
      !slide["flow"] &&
      !slide["timeline"]
    ) {
      slide["text"] = content.slice(0, 240);
    }
    return slide;
  });

  return { slides };
}

export function createMockFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    if (url.endsWith("/embeddings")) {
      return json({
        data: [{ embedding: Array.from({ length: 1536 }, () => 0.001), index: 0 }],
        usage: { prompt_tokens: 1 },
      });
    }

    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: { role: string; content: string }[];
    };
    const messages = body.messages ?? [];
    const system = messages[0]?.content ?? "";
    const user = messages[messages.length - 1]?.content ?? "";

    let content: unknown;
    if (system.includes("extract a document brief")) content = briefFrom(user);
    else if (system.includes("You plan a client-ready sales document")) content = outlineFrom(user);
    else if (system.includes("You write a client-ready sales deck")) content = deckFrom(user);
    else if (system.includes("grounding auditor")) content = { unsupported: [] };
    else content = sectionFrom(user);

    return json({
      choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }],
    });
  }) as typeof fetch;
}

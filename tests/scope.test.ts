/**
 * Conversation scope: what the user picked follows the conversation into
 * retrieval, into the answer prompt and into exports — and a document is only
 * ever built from an explicit request.
 *
 * The retrieval case mirrors the reported failure: with Zurich Airport selected,
 * "what did we propose?" must reach Zurich passages only, and a question about
 * an organisation outside the scope must still be answered.
 */
import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../src/integrations/supabase/types";
import {
  EMPTY_SCOPE,
  contextFromScope,
  mergeScopeWithContext,
  normalizeScope,
  outsideScopeEntities,
  outsideScopeNote,
  scopeIndustryLabels,
  scopePillLabels,
  scopePromptLine,
  scopeRetrievalScopes,
  type ConversationScope,
} from "../src/lib/chat/conversationScope";
import { EMPTY_CONTEXT } from "../src/lib/chat/scope";
import { readConversationScope } from "../src/lib/chat/scope.functions";
import { searchLibraryChunksForEntities } from "../src/lib/rag/search";
import { applyScopeToBrief, fallbackBrief } from "../src/lib/documents/brief";
import { buildDraft, detectExportIntent, SHOW_EXPORT_CONFIRM } from "../src/lib/documents/intent";
import type { ExportBrief } from "../src/lib/documents/types";
import { CHUNKS, createMockSupabase } from "./fixtures";

const INDUSTRY_NAMES = {
  airlines: "Airlines",
  airports: "Airports",
  hospitality: "Hospitality",
  aviation: "Aviation",
};

const TWO_PARTY_SCOPE: ConversationScope = {
  industries: ["airports", "aviation"],
  companies: [
    { id: null, canonicalName: "Zurich Airport", industry: "airports" },
    { id: null, canonicalName: "InterGlobe Aviation", industry: "aviation" },
  ],
  updatedAt: null,
};

const THREE_PARTY_SCOPE: ConversationScope = {
  industries: ["airlines", "airports", "hospitality"],
  companies: [
    { id: null, canonicalName: "IndiGo Airlines", industry: "airlines" },
    { id: null, canonicalName: "Adani Airports", industry: "airports" },
    { id: null, canonicalName: "InterGlobe Hotels", industry: "hospitality" },
  ],
  updatedAt: null,
};

function embed(): Promise<number[]> {
  return Promise.resolve(Array.from({ length: 1536 }, () => 0.001));
}

function scopeClient(scope: unknown): SupabaseClient<Database> {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { scope }, error: null }),
        }),
      }),
    }),
  } as unknown as SupabaseClient<Database>;
}

describe("conversation scope model", () => {
  test("a conversation without a scope stays unscoped and unchanged", () => {
    expect(normalizeScope(null)).toEqual(EMPTY_SCOPE);
    expect(normalizeScope({})).toEqual(EMPTY_SCOPE);
    expect(scopeRetrievalScopes(EMPTY_SCOPE)).toEqual([]);
    expect(scopePromptLine(EMPTY_SCOPE)).toBe("");
    expect(scopePillLabels(EMPTY_SCOPE)).toEqual([]);
  });

  test("scope normalisation trims, de-duplicates and tolerates old shapes", () => {
    const scope = normalizeScope({
      industries: ["airlines", " Airlines ", ""],
      companies: [
        {
          id: "00000000-0000-0000-0000-000000000001",
          canonicalName: " IndiGo ",
          industry: "airlines",
        },
        { canonicalName: "IndiGo" },
        "not-a-company",
      ],
      updatedAt: "2026-11-13T00:00:00.000Z",
    });
    expect(scope.industries).toEqual(["airlines"]);
    expect(scope.companies).toHaveLength(1);
    expect(scope.companies[0]?.canonicalName).toBe("IndiGo");
    expect(scope.updatedAt).toBe("2026-11-13T00:00:00.000Z");
  });

  test("selected companies keep their own industry; whole sectors stay whole", () => {
    // Zurich pairs with its industry, InterGlobe Aviation with aviation, and the
    // industry-only filter is not duplicated.
    expect(scopeRetrievalScopes(TWO_PARTY_SCOPE)).toEqual([
      { industry: "airports", customer: "Zurich Airport" },
      { industry: "aviation", customer: "InterGlobe Aviation" },
    ]);
    // An industry with no company picked means the whole industry.
    expect(
      scopeRetrievalScopes({
        industries: ["airports", "retail"],
        companies: [{ id: null, canonicalName: "Zurich Airport", industry: "airports" }],
        updatedAt: null,
      }),
    ).toEqual([{ industry: "airports", customer: "Zurich Airport" }, { industry: "retail" }]);
  });

  test("the prompt line names industries and companies and explains resolution", () => {
    const line = scopePromptLine(THREE_PARTY_SCOPE, INDUSTRY_NAMES);
    expect(line).toContain("Airlines, Airports, Hospitality");
    expect(line).toContain("IndiGo Airlines");
    expect(line).toContain("Resolve unnamed references");
    expect(scopePillLabels(THREE_PARTY_SCOPE, INDUSTRY_NAMES)).toEqual([
      "Airlines",
      "Airports",
      "Hospitality",
      "IndiGo Airlines",
      "Adani Airports",
      "InterGlobe Hotels",
    ]);
    expect(scopeIndustryLabels(THREE_PARTY_SCOPE, INDUSTRY_NAMES)).toEqual([
      "Airlines",
      "Airports",
      "Hospitality",
    ]);
  });

  test("context and scope merge into one selection", () => {
    const context = contextFromScope(TWO_PARTY_SCOPE, { personas: ["COO"] });
    expect(context.industries).toEqual(["airports", "aviation"]);
    expect(context.clients).toEqual(["Zurich Airport", "InterGlobe Aviation"]);
    expect(context.personas).toEqual(["COO"]);

    const merged = mergeScopeWithContext(
      { ...EMPTY_SCOPE, industries: ["airports"] },
      { ...EMPTY_CONTEXT, industries: ["aviation"], clients: ["Zurich Airport"] },
      "2026-11-13T00:00:00.000Z",
    );
    expect(merged.industries).toEqual(["airports", "aviation"]);
    expect(merged.companies.map((company) => company.canonicalName)).toEqual(["Zurich Airport"]);
    expect(merged.updatedAt).toBe("2026-11-13T00:00:00.000Z");
  });

  test("an organisation outside the scope is named, not blocked", () => {
    const outside = outsideScopeEntities(["Zurich Airport", "InterGlobe Hotels"], TWO_PARTY_SCOPE);
    expect(outside).toEqual(["InterGlobe Hotels"]);
    // A shorter spelling of a scoped company is still in scope.
    expect(outsideScopeEntities(["Zurich"], TWO_PARTY_SCOPE)).toEqual([]);
    expect(outsideScopeNote(outside)).toContain("isn't in your selected scope");
    expect(outsideScopeNote([])).toBe("");
  });

  test("the server loads the stored scope on every turn, not once", async () => {
    const client = scopeClient({
      industries: TWO_PARTY_SCOPE.industries,
      companies: TWO_PARTY_SCOPE.companies,
      updatedAt: "2026-11-13T00:00:00.000Z",
    });
    for (let turn = 0; turn < 12; turn += 1) {
      const loaded = await readConversationScope(client, "8a1c1f34-0000-4000-8000-000000000000");
      expect(loaded.companies.map((company) => company.canonicalName)).toEqual([
        "Zurich Airport",
        "InterGlobe Aviation",
      ]);
      expect(loaded.industries).toEqual(["airports", "aviation"]);
    }
    // An unreadable row degrades to unscoped instead of failing the turn.
    const broken = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: { message: "boom" } }),
          }),
        }),
      }),
    } as unknown as SupabaseClient<Database>;
    expect(await readConversationScope(broken, "8a1c1f34-0000-4000-8000-000000000000")).toEqual(
      EMPTY_SCOPE,
    );
  });
});

describe("scoped retrieval", () => {
  test("a question that names no company returns only scoped documents", async () => {
    const client = createMockSupabase(CHUNKS, []);
    const chunks = await searchLibraryChunksForEntities(
      client,
      "what did we propose?",
      [],
      scopeRetrievalScopes(TWO_PARTY_SCOPE),
      8,
      embed,
    );
    const contentIds = new Set(chunks.map((chunk) => chunk.contentId));
    expect(contentIds.size).toBeGreaterThan(0);
    // Every passage belongs to a selected company, whatever its content id.
    for (const chunk of chunks) {
      expect(["Zurich Airport", "InterGlobe Aviation"]).toContain(chunk.customerName ?? "");
    }
    // doc-zhr is Zurich Airport; both selected companies get slots (per-company quota).
    expect(contentIds.has("doc-zhr")).toBe(true);
    expect(chunks.some((chunk) => chunk.customerName === "Zurich Airport")).toBe(true);
    expect(chunks.some((chunk) => chunk.customerName === "InterGlobe Aviation")).toBe(true);
    // The unscoped families are out: retail, hotels and the insurance decks.
    expect(contentIds.has("doc-r")).toBe(false);
    expect(contentIds.has("doc-igl-hotel")).toBe(false);
    expect(contentIds.has("doc-z")).toBe(false);
  });

  test("an entity outside the scope is still retrievable in the same turn", async () => {
    const client = createMockSupabase(CHUNKS, []);
    const chunks = await searchLibraryChunksForEntities(
      client,
      "What about Zurich airport and Interglobe hotels?",
      [{ canonical: "InterGlobe Hotels", spellings: ["InterGlobe Hotels"] }],
      scopeRetrievalScopes(TWO_PARTY_SCOPE),
      8,
      embed,
    );
    const contentIds = new Set(chunks.map((chunk) => chunk.contentId));
    // Scoped Zurich and out-of-scope InterGlobe Hotels both come back.
    expect(contentIds.has("doc-zhr")).toBe(true);
    expect(contentIds.has("doc-igl-hotel")).toBe(true);
  });
});

describe("exports use the whole scope", () => {
  test("a three-company, three-sector scope produces three parties and three sectors", () => {
    const draft = buildDraft({
      prompt: "Create a pitch deck for this partnership",
      type: "pptx",
      context: contextFromScope(THREE_PARTY_SCOPE),
      industryNames: INDUSTRY_NAMES,
    });
    const brief = fallbackBrief(draft, [], [], THREE_PARTY_SCOPE, INDUSTRY_NAMES);
    expect(brief.partiesInvolved).toEqual(
      expect.arrayContaining(["IndiGo Airlines", "Adani Airports", "InterGlobe Hotels"]),
    );
    expect(brief.partiesInvolved).toHaveLength(3);
    expect(brief.sectors).toEqual(["Airlines", "Airports", "Hospitality"]);
    // The evidence queries follow the same sectors.
    expect(brief.keyTopics).toEqual(
      expect.arrayContaining(["Airlines", "Airports", "Hospitality"]),
    );
  });

  test("the scope wins over a brief that kept only the first party", () => {
    const draft = buildDraft({
      prompt: "Create a pitch deck",
      type: "pptx",
      context: contextFromScope(TWO_PARTY_SCOPE),
      industryNames: INDUSTRY_NAMES,
    });
    const narrow: ExportBrief = {
      documentTitle: "IndiGo Airlines — pitch deck",
      request: "create a pitch deck",
      partiesInvolved: ["IndiGo Airlines"],
      sectors: [],
      keyTopics: [],
      keyEntities: ["IndiGo Airlines"],
      mode: "pitch",
      client: "IndiGo Airlines",
      industry: "Airlines",
      sector: "Airlines",
      audience: null,
      problem: null,
      goals: [],
      constraints: [],
      budget: null,
      timeline: null,
      tone: "professional",
      include: [],
      exclude: [],
      decisions: [],
      citedDocuments: [],
      chatFigures: [],
      openItems: [],
    };
    const scoped = applyScopeToBrief(narrow, THREE_PARTY_SCOPE, INDUSTRY_NAMES);
    expect(scoped.partiesInvolved).toEqual(
      expect.arrayContaining(["IndiGo Airlines", "Adani Airports", "InterGlobe Hotels"]),
    );
    expect(scoped.sectors).toEqual(["Airlines", "Airports", "Hospitality"]);
    // An unscoped conversation keeps the brief exactly as generated.
    expect(applyScopeToBrief(narrow, EMPTY_SCOPE, INDUSTRY_NAMES)).toEqual(narrow);
  });

  test("the draft itself is unscoped-safe (backward compatible)", () => {
    const draft = buildDraft({
      prompt: "Create a pitch deck",
      type: "pptx",
      context: EMPTY_CONTEXT,
      industryNames: INDUSTRY_NAMES,
    });
    const brief = fallbackBrief(draft, [], [], EMPTY_SCOPE, INDUSTRY_NAMES);
    expect(brief.sectors).toEqual([]);
    expect(brief.partiesInvolved).toEqual([]);
  });
});

describe("detectExportIntent", () => {
  test("explicit requests are recognised with the right format", () => {
    expect(detectExportIntent("create a pitch deck for this collaboration")).toEqual({
      type: "pptx",
      mode: "pitch",
    });
    expect(detectExportIntent("generate a proposal pdf")).toEqual({
      type: "pdf",
      mode: "proposal",
    });
    expect(detectExportIntent("make slides")).toEqual({ type: "pptx", mode: "pitch" });
    expect(detectExportIntent("build a proposal deck for Adani")).toEqual({
      type: "pptx",
      mode: "proposal",
    });
    expect(detectExportIntent("turn this into a word doc")).toEqual({
      type: "docx",
      mode: "proposal",
    });
    expect(detectExportIntent("Put together a capabilities deck for IndiGo")).toEqual({
      type: "pptx",
      mode: "pitch",
    });
  });

  test("questions and summaries never start a document", () => {
    expect(detectExportIntent("what points were in the Zurich proposal deck?")).toBeNull();
    expect(detectExportIntent("summarize the pitch")).toBeNull();
    expect(detectExportIntent("Which deck should we send?")).toBeNull();
    expect(detectExportIntent("Tell me about the deck")).toBeNull();
    expect(detectExportIntent("The proposal deck was strong.")).toBeNull();
    expect(detectExportIntent("create")).toBeNull();
    expect(detectExportIntent("pitch deck")).toBeNull();
  });

  test("a bare follow-up only counts when the previous turn asked for a document", () => {
    expect(
      detectExportIntent("export it", [
        { role: "user", content: "please create a proposal document" },
        { role: "assistant", content: "Here is the plan." },
      ]),
    ).toEqual({ type: "docx", mode: "proposal" });
    expect(
      detectExportIntent("export it", [{ role: "user", content: "what did we propose?" }]),
    ).toBeNull();
  });

  test("a document starts on the explicit request without an outline card", () => {
    expect(SHOW_EXPORT_CONFIRM).toBe(false);
  });
});

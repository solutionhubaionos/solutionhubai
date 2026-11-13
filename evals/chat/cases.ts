/**
 * Answer-quality eval for the chat pipeline: no database, no provider calls.
 *
 * Retrieval is fixtures, entity resolution is a local stand-in for the pg_trgm
 * function, and the completion endpoint is mocked. The assertions are about
 * structure and strings, so the set does not pin exact model wording.
 */
import {
  buildContext,
  buildMessages,
  finalizeAnswer,
  generateAnswer,
  type ChatMessage,
} from "../../src/lib/chat/answer";
import { parseCitationMarkers } from "../../src/lib/chat/citations";
import { needsRewrite, rewriteQuery } from "../../src/lib/chat/rewrite";
import { isTitleOnlyChunk } from "../../src/lib/rag/chunk-quality";
import {
  entityCandidates,
  isComparativeQuestion,
  normalizeEntityKey,
  pickEntityMatch,
  type EntityMatchRow,
} from "../../src/lib/rag/entities";
import { selectRelevantChunks } from "../../src/lib/rag/relevance";
import {
  HISTORY_ADANI,
  HOTEL_RETRIEVAL,
  KNOWN_CUSTOMERS,
  TITLE_ONLY_RETRIEVAL,
  ZURICH_RETRIEVAL,
} from "./fixtures";

export type Check = { name: string; passed: boolean; detail?: string };

export type EvalCaseResult = {
  id: string;
  title: string;
  checks: Check[];
  passed: boolean;
};

const API = { apiKey: "test-key", baseUrl: "https://gateway.test/v1" };

function check(name: string, passed: boolean, detail?: string): Check {
  return { name, passed, ...(detail ? { detail } : {}) };
}

function result(id: string, title: string, checks: Check[]): EvalCaseResult {
  return { id, title, checks, passed: checks.every((entry) => entry.passed) };
}

/** Deterministic stand-in for the mocked completion endpoint. */
function mockCompletion(
  respond: (
    messages: ChatMessage[],
    call: number,
    maxTokens: number,
  ) => { content: string; finishReason: string },
) {
  const calls: { messages: ChatMessage[]; maxTokens: number }[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages: ChatMessage[];
      max_tokens: number;
    };
    calls.push({ messages: body.messages, maxTokens: body.max_tokens });
    const reply = respond(body.messages, calls.length, body.max_tokens);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: reply.content }, finish_reason: reply.finishReason }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Bigram Dice coefficient: a rough local stand-in for pg_trgm similarity(). */
export function fakeSimilarity(left: string, right: string): number {
  const grams = (value: string) => {
    const text = ` ${value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()} `;
    const out = new Set<string>();
    for (let index = 0; index < text.length - 1; index += 1) {
      out.add(text.slice(index, index + 2));
    }
    return out;
  };
  const a = grams(left);
  const b = grams(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

const CANONICAL: Record<string, string> = { "InterGlode Hotels": "InterGlobe Hotels" };
const ALIASES: Record<string, string[]> = { "InterGlobe Hotels": ["InterGlode Hotels"] };

type LookupRow = EntityMatchRow & { spellings: string[] };

/** Mirrors match_customer_entities(): best known spelling plus all variants. */
export function fakeEntityLookup(
  query: string,
  known: readonly string[] = KNOWN_CUSTOMERS,
): { candidates: string[]; rows: LookupRow[]; best: LookupRow | null } {
  const candidates = entityCandidates(query);
  const rows: LookupRow[] = known.map((name) => {
    const canonical = CANONICAL[name] ?? name;
    const spellings = [...new Set([name, canonical, ...(ALIASES[canonical] ?? [])])];
    return {
      canonical,
      matched_name: name,
      spellings,
      score: Math.max(0, ...candidates.map((candidate) => fakeSimilarity(name, candidate))),
    };
  });
  rows.sort((a, b) => b.score - a.score);
  return { candidates, rows, best: rows.find((row) => row.score >= 0.4) ?? null };
}

function citedNumbersAreValid(answer: string, citations: readonly number[]): boolean {
  return parseCitationMarkers(answer).every((marker) =>
    marker.numbers.every((number) => citations.includes(number)),
  );
}

async function zurichCase(): Promise<EvalCaseResult> {
  const question = "What kind of data maturity plan was proposed to Zurich Airport";
  const entity = fakeEntityLookup(question);
  const entityKeys = (entity.best?.spellings ?? []).map(normalizeEntityKey);
  const chunks = selectRelevantChunks(ZURICH_RETRIEVAL, {
    entityKeys,
    comparative: isComparativeQuestion(question),
  });
  const context = buildContext(chunks);
  const { fetchImpl } = mockCompletion(() => ({
    content:
      "The plan uses a four-level data maturity model, run over three horizons [1]. A joint data office chaired by the CIO owns it [2].",
    finishReason: "stop",
  }));
  const generation = await generateAnswer(buildMessages(question, context), { ...API, fetchImpl });
  const final = finalizeAnswer(generation.answer, context);
  const citationNumbers = final.sources.map((source) => source.citation);

  return result("zurich_maturity", "Zurich maturity question stays on Zurich documents", [
    check(
      "the best entity match is Zurich Airport",
      entity.best?.canonical === "Zurich Airport",
      `got ${entity.best?.canonical ?? "none"} at ${entity.best?.score.toFixed(2) ?? "n/a"}`,
    ),
    check(
      "no Adani passage survives relevance filtering",
      chunks.every((chunk) => !chunk.customerName || chunk.customerName === "Zurich Airport"),
      chunks.map((chunk) => chunk.customerName).join(", "),
    ),
    check(
      "the answer mentions the maturity levels or horizons",
      /maturity|horizon/i.test(final.answer),
      final.answer,
    ),
    check(
      "sources are Zurich documents only",
      final.sources.length > 0 &&
        final.sources.every((source) => source.customerName === "Zurich Airport"),
    ),
    check(
      "no Adani source is returned",
      !final.sources.some((source) => /adani/i.test(source.customerName ?? "")),
    ),
    check(
      "every marker points at a returned source",
      citedNumbersAreValid(final.answer, citationNumbers),
    ),
  ]);
}

async function followUpCase(): Promise<EvalCaseResult> {
  const question = "and for Zurich?";
  const rewrite = await rewriteQuery(question, HISTORY_ADANI, {
    ...API,
    fetchImpl: mockCompletion(() => ({
      content: "What was proposed to Zurich Airport?",
      finishReason: "stop",
    })).fetchImpl,
  });

  const standalone = "What was proposed to Adani airports?";
  const retrieval = /zurich/i.test(rewrite.query) ? ZURICH_RETRIEVAL : [];
  const entity = fakeEntityLookup(rewrite.query);
  const chunks = selectRelevantChunks(retrieval, {
    entityKeys: (entity.best?.spellings ?? []).map(normalizeEntityKey),
  });

  return result("follow_up_zurich", "A follow-up is rewritten before retrieval", [
    check("the follow-up is detected as dependent", needsRewrite(question, HISTORY_ADANI)),
    check("a standalone question is not rewritten", !needsRewrite(standalone, HISTORY_ADANI)),
    check("no history means no rewrite", !needsRewrite(standalone, [])),
    check(
      "the rewrite is standalone",
      rewrite.rewritten && /zurich/i.test(rewrite.query),
      rewrite.query,
    ),
    check(
      "the rewritten query retrieves Zurich documents",
      chunks.length > 0 &&
        chunks.every((chunk) => !chunk.customerName || chunk.customerName === "Zurich Airport"),
    ),
  ]);
}

async function interglobeCase(): Promise<EvalCaseResult> {
  const questions = ["Interglobe hotels", "Interglode hotels", "InterGlobe"];
  const checks: Check[] = [];

  for (const question of questions) {
    const lookup = fakeEntityLookup(question);
    const entityKeys = (lookup.best?.spellings ?? []).map(normalizeEntityKey);
    const chunks = selectRelevantChunks(HOTEL_RETRIEVAL, { entityKeys });

    checks.push(
      check(
        `"${question}" resolves to InterGlobe Hotels`,
        lookup.best?.canonical === "InterGlobe Hotels",
        `got ${lookup.best?.canonical ?? "none"} at ${lookup.best?.score.toFixed(2) ?? "n/a"}`,
      ),
      check(
        `"${question}" retrieves the hotel procurement deck`,
        chunks.length > 0 && /hotel procurement/i.test(chunks[0]?.fileName ?? ""),
        chunks[0]?.fileName ?? "no chunk",
      ),
      check(
        `"${question}" returns no other customer's passage`,
        chunks.every(
          (chunk) =>
            !chunk.customerName || entityKeys.includes(normalizeEntityKey(chunk.customerName)),
        ),
        chunks.map((chunk) => chunk.customerName ?? "industry-wide").join(", "),
      ),
    );
  }

  checks.push(
    check(
      "the typo and the correct spelling share a comparison key family",
      normalizeEntityKey("InterGlode Hotels") !== normalizeEntityKey("InterGlobe Hotels") &&
        pickEntityMatch(fakeEntityLookup("InterGlode hotels").rows)?.canonical ===
          "InterGlobe Hotels",
    ),
    check(
      "the entity matcher keeps the old spelling as an accepted variant",
      (fakeEntityLookup("InterGlode hotels").best?.spellings ?? [])
        .map(normalizeEntityKey)
        .includes(normalizeEntityKey("Interglode Hotels")),
    ),
  );

  return result("interglobe_variants", "Typos and partial names reach the same deck", checks);
}

async function titleOnlyCase(): Promise<EvalCaseResult> {
  const chunks = selectRelevantChunks(TITLE_ONLY_RETRIEVAL);
  const context = buildContext(chunks);
  const final = finalizeAnswer(
    "The deck covers the programme structure, but the detailed scope isn't available, only the title and section structure [1].",
    context,
  );

  return result("title_only_evidence", "Title-only evidence yields a one-line gap", [
    check(
      "the only passage is a title-only divider",
      chunks.length === 1 && isTitleOnlyChunk(chunks[0] as never),
    ),
    check("the context labels it as title-only", /title-only slide/.test(context.text)),
    check(
      "the answer states the gap in one short sentence",
      /only the title and section structure/.test(final.answer),
    ),
    check(
      "no apology or self-correction",
      !/(i'm sorry|i apologi|sorry|my earlier|i was wrong|previous answer|to correct myself)/i.test(
        final.answer,
      ),
      final.answer,
    ),
    check("the answer is not a multi-paragraph apology", final.answer.split(/\n{2,}/).length === 1),
  ]);
}

async function citationCase(): Promise<EvalCaseResult> {
  const entity = fakeEntityLookup("What was proposed to Zurich Airport");
  const context = buildContext(
    selectRelevantChunks(ZURICH_RETRIEVAL, {
      entityKeys: (entity.best?.spellings ?? []).map(normalizeEntityKey),
    }),
  );
  const raw =
    "The passages show Zurich proposed a four-level maturity model [1]. It also covered governance [2][4]. According to passage [7], nothing else applies.";
  const final = finalizeAnswer(raw, context);
  const citationNumbers = final.sources.map((source) => source.citation);

  return result("citation_integrity", "Markers are validated and sources are cited only", [
    check(
      "meta narration is detected for logging",
      final.metaPhrases.some((phrase) => /passages/i.test(phrase)) &&
        final.metaPhrases.some((phrase) => /according to passage/i.test(phrase)),
      final.metaPhrases.join(", "),
    ),
    check(
      "markers outside the source map are dropped",
      final.invalidMarkers.includes(4) && final.invalidMarkers.includes(7),
      final.invalidMarkers.join(", "),
    ),
    check(
      "every remaining marker exists in the sources",
      citedNumbersAreValid(final.answer, citationNumbers) && !/\[(?:4|7)\]/.test(final.answer),
      final.answer,
    ),
    check(
      "sources contain only cited entries",
      final.sources.length === 2 &&
        final.sources.every((source) => citationNumbers.includes(source.citation)),
      `${final.sources.length} sources`,
    ),
    check(
      "adjacent markers stay adjacent",
      /\[1\]/.test(final.answer) && /\[2\]/.test(final.answer),
    ),
  ]);
}

async function truncationCase(): Promise<EvalCaseResult> {
  const logs: { event: string; meta: Record<string, unknown> }[] = [];
  const log = (event: string, meta: Record<string, unknown>) => logs.push({ event, meta });

  const continuation = mockCompletion((_messages, call) =>
    call === 1
      ? { content: "So the specific proposed offerings,", finishReason: "length" }
      : { content: "start with the marketplace pilot [1].", finishReason: "stop" },
  );
  const answer = await generateAnswer([{ role: "user", content: "What was proposed?" }], {
    ...API,
    maxTokens: 40,
    fetchImpl: continuation.fetchImpl,
    log,
  });

  const forced = mockCompletion(() => ({
    content: "So the specific proposed offerings,",
    finishReason: "length",
  }));
  const truncated = await generateAnswer([{ role: "user", content: "What was proposed?" }], {
    ...API,
    maxTokens: 40,
    maxContinuations: 0,
    fetchImpl: forced.fetchImpl,
    log,
  });

  const finishReasons = logs
    .filter((entry) => entry.event === "completion")
    .map((entry) => entry.meta["finishReason"]);

  return result("truncation", "A `length` stop is continued and logged", [
    check(
      "finish_reason is logged for every completion",
      finishReasons.length >= 3 && finishReasons.includes("length"),
      finishReasons.join(", "),
    ),
    check(
      "a continuation is issued once",
      answer.continuations === 1 && continuation.calls.length === 2,
    ),
    check(
      "the continued answer is not cut mid-word",
      answer.answer === "So the specific proposed offerings, start with the marketplace pilot [1].",
      answer.answer,
    ),
    check(
      "the warning path fires when continuations are exhausted",
      truncated.finishReason === "length" &&
        logs.some((entry) => entry.event === "answer truncated"),
    ),
  ]);
}

export async function runChatEval(): Promise<EvalCaseResult[]> {
  return [
    await zurichCase(),
    await followUpCase(),
    await interglobeCase(),
    await titleOnlyCase(),
    await citationCase(),
    await truncationCase(),
  ];
}

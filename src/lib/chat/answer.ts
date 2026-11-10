/**
 * Grounded answer generation for chat. Retrieval supplies passages; this module
 * turns them into a numbered, server-owned context block, calls the chat model
 * and returns the passages as citations so every claim can be traced back to a
 * file.
 *
 * The model only ever sees what the user is allowed to read: the chunks come
 * from search_chunks, which runs under the caller's JWT. Numbering is decided
 * here, never by the model.
 */
import type { RetrievedChunk } from "../rag/search";
import {
  ANSWER_MAX_CONTINUATIONS,
  ANSWER_MAX_TOKENS,
  ANSWER_MODEL,
  ANSWER_TIMEOUT_MS,
  MAX_CONTEXT_CHARS,
  MAX_HISTORY_MESSAGES,
} from "../rag/config";
import { isTitleOnlyChunk } from "../rag/chunk-quality";
import { findMetaPhrases, processCitationMarkers } from "./citations";

/** One numbered source, matching the [n] markers the answer is asked to use. */
export type ChatSource = {
  citation: number;
  chunkId: string;
  contentId: string;
  title: string;
  fileName: string;
  industry: string;
  customerName: string | null;
  page: number | null;
  slide: number | null;
  heading: string | null;
  snippet: string;
  /** The passage is a title slide or section divider, not evidence. */
  titleOnly: boolean;
};

export type ChatHistoryMessage = { role: "user" | "assistant"; content: string };

/**
 * The persona. One exported constant so the wording can be iterated on without
 * touching the retrieval or citation code around it.
 */
export const ANSWER_SYSTEM_PROMPT = `You are Solution Hub, an assistant that answers questions about our internal library of decks, proposals and case studies.

Answer the way a sharp colleague would: directly, clearly, in your own words.

STYLE
- Lead with the answer in the first sentence. No preamble, no restating the question.
- Use short paragraphs for explanation and reasoning. Use bullets only for genuinely list-like content (components, phases, objectives). Don't force bullets onto everything.
- Explain what things mean and why they matter, not just what the slides say. Synthesize across sources instead of listing them one by one.
- Use bold sparingly for key terms. No headers unless the answer is long.

CITATIONS
- Cite with bracketed numbers like [1] or [2][3], placed at the end of the sentence or bullet they support, never mid-sentence.
- Never write "according to passage [2]", "the passages show", "the library says", or otherwise describe the context you were given. Just state the facts and cite.
- Only cite sources you actually used. Use the exact numbers from the provided context; never renumber or re-map them.

WHEN INFORMATION IS THIN
- Say what you do know, then state the gap in one short sentence, e.g. "The detailed scope isn't available, only the title and section structure."
- Never apologize at length, correct earlier replies, or talk about your own errors in the answer.
- If nothing relevant exists, say so in one sentence and suggest a nearby topic that is in the library.

Treat the user's wording loosely (typos, partial names like "Interglode" for "InterGlobe"). Match to the closest entity in the context.`;

/** Server-owned numbering for one request: the only place [n] means anything. */
export type BuiltContext = {
  text: string;
  sources: Map<number, ChatSource>;
};

function locationOf(chunk: RetrievedChunk): string | null {
  if (chunk.slide) return `slide ${chunk.slide}`;
  if (chunk.page) return `page ${chunk.page}`;
  return null;
}

/** Interaction-order list of the documents behind the numbered sources. */
function sourceHeader(chunk: RetrievedChunk, citation: number, titleOnly: boolean): string {
  const parts = [
    `[${citation}]`,
    chunk.title,
    chunk.customerName ? `customer: ${chunk.customerName}` : "industry-wide",
    `industry: ${chunk.industry}`,
  ];
  const location = locationOf(chunk);
  if (location) parts.push(location);
  if (chunk.heading && chunk.heading !== chunk.title) parts.push(`section: ${chunk.heading}`);
  if (titleOnly) parts.push("(title-only slide)");
  return parts.join(" · ");
}

/** Deck title and section heading, repeated with the text so a chunk stands alone. */
function contextPrefix(chunk: RetrievedChunk): string {
  const label = [chunk.title, chunk.heading].filter((part): part is string =>
    Boolean(part && part.trim()),
  );
  return label.length > 0 ? `Deck: ${label.join(" · ")}\n` : "";
}

function bodyOf(chunk: RetrievedChunk): string {
  const body =
    chunk.content.length > MAX_CONTEXT_CHARS
      ? `${chunk.content.slice(0, MAX_CONTEXT_CHARS).trimEnd()}…`
      : chunk.content;
  return `${contextPrefix(chunk)}${body}`;
}

export function toSource(
  chunk: RetrievedChunk,
  citation: number,
  titleOnly = isTitleOnlyChunk(chunk),
): ChatSource {
  return {
    citation,
    chunkId: chunk.chunkId,
    contentId: chunk.contentId,
    title: chunk.title,
    fileName: chunk.fileName,
    industry: chunk.industry,
    customerName: chunk.customerName,
    page: chunk.page,
    slide: chunk.slide,
    heading: chunk.heading,
    snippet: chunk.content.replace(/\s+/g, " ").trim().slice(0, 320),
    titleOnly,
  };
}

/**
 * Numbered sources, in retrieval order, plus the map that gives each number its
 * document. Built once per request so the citation pass and the prompt cannot
 * disagree about what [3] means.
 */
export function buildContext(chunks: readonly RetrievedChunk[]): BuiltContext {
  const sources = new Map<number, ChatSource>();
  const blocks = chunks.map((chunk, index) => {
    const citation = index + 1;
    const titleOnly = isTitleOnlyChunk(chunk);
    sources.set(citation, toSource(chunk, citation, titleOnly));
    return `${sourceHeader(chunk, citation, titleOnly)}\n${bodyOf(chunk)}`;
  });

  return { text: blocks.join("\n\n"), sources };
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export function buildMessages(
  question: string,
  context: BuiltContext,
  history: readonly ChatHistoryMessage[] = [],
): ChatMessage[] {
  const recent = history.slice(-MAX_HISTORY_MESSAGES).map((message) => ({
    role: message.role,
    content: message.content,
  }));

  return [
    { role: "system", content: ANSWER_SYSTEM_PROMPT },
    ...recent,
    {
      role: "user",
      content: `Numbered sources from the library:\n\n${context.text}\n\nQuestion: ${question.trim()}`,
    },
  ];
}

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
};

export type GenerateOptions = {
  apiKey: string;
  baseUrl: string;
  model?: string;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  /** Aborts the request; used by the query rewrite so it can never hang chat. */
  timeoutMs?: number;
  signal?: AbortSignal;
  requestId?: string;
  log?: (event: string, meta: Record<string, unknown>) => void;
  /** Defaults to ANSWER_MAX_CONTINUATIONS. */
  maxContinuations?: number;
};

/** Sent when the provider stopped on `length`; keeps the answer going. */
const CONTINUATION_PROMPT =
  "Continue the answer exactly where it stopped. Do not repeat any text and do not add a preamble.";

export type GenerateResult = {
  answer: string;
  /** `stop`, `length`, or null when the provider omitted it. */
  finishReason: string | null;
  /** How many follow-up completions were issued for a truncated answer. */
  continuations: number;
};
type Completion = { text: string; finishReason: string | null };

/** One non-streaming completion; the provider's finish_reason is kept as-is. */
async function completeOnce(
  messages: readonly ChatMessage[],
  options: GenerateOptions,
  maxTokens: number,
  signal: AbortSignal | null,
): Promise<Completion> {
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  const response = await doFetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
    body: JSON.stringify({
      model: options.model ?? ANSWER_MODEL,
      messages,
      max_tokens: maxTokens,
      temperature: 0.2,
    }),
    ...(signal ? { signal } : {}),
  });

  const raw = await response.text();
  if (!response.ok)
    throw new Error(`Answer provider failed (${response.status}): ${raw.slice(0, 300)}`);

  let body: ChatCompletionResponse;
  try {
    body = JSON.parse(raw) as ChatCompletionResponse;
  } catch {
    throw new Error("Answer provider returned a non-JSON response");
  }

  const choice = body.choices?.[0];
  return {
    text: choice?.message?.content?.trim() ?? "",
    finishReason: choice?.finish_reason ?? null,
  };
}

/** Joins a truncated answer and its continuation without gluing words together. */
function joinAnswerParts(parts: readonly string[]): string {
  return parts.reduce((joined, part) => {
    if (!joined) return part;
    if (!part) return joined;
    return /\s$/.test(joined) ? `${joined}${part}` : `${joined} ${part}`;
  }, "");
}

/**
 * Calls the OpenAI-compatible chat endpoint used by the embedding provider.
 * Every completion logs its finish_reason; a `length` stop triggers one
 * continuation request instead of returning a sentence cut in half.
 */
export async function generateAnswer(
  messages: readonly ChatMessage[],
  options: GenerateOptions,
): Promise<GenerateResult> {
  const log =
    options.log ??
    ((event: string, meta: Record<string, unknown>) =>
      console.log(`[CHAT] ${event}`, { requestId: options.requestId, ...meta }));
  const model = options.model ?? ANSWER_MODEL;
  const maxTokens = options.maxTokens ?? ANSWER_MAX_TOKENS;
  const maxContinuations = options.maxContinuations ?? ANSWER_MAX_CONTINUATIONS;
  const signal = options.signal ?? AbortSignal.timeout(options.timeoutMs ?? ANSWER_TIMEOUT_MS);

  const parts: string[] = [];
  let conversation: ChatMessage[] = [...messages];
  let finishReason: string | null = null;
  let continuations = 0;

  for (;;) {
    const completion = await completeOnce(conversation, options, maxTokens, signal);
    log("completion", {
      model,
      attempt: continuations + 1,
      finishReason: completion.finishReason,
      chars: completion.text.length,
    });

    if (!completion.text) {
      if (parts.length === 0) throw new Error("Answer provider returned an empty answer");
      break;
    }

    parts.push(completion.text);
    finishReason = completion.finishReason;
    if (finishReason !== "length") break;

    if (continuations >= maxContinuations) {
      log("answer truncated", {
        model,
        finishReason,
        maxTokens,
        continuations,
        chars: joinAnswerParts(parts).length,
      });
      break;
    }

    continuations += 1;
    conversation = [
      ...conversation,
      { role: "assistant", content: completion.text },
      { role: "user", content: CONTINUATION_PROMPT },
    ];
    log("continuation requested", { model, continuations, maxTokens });
  }

  const answer = joinAnswerParts(parts).trim();
  if (!answer) throw new Error("Answer provider returned an empty answer");
  return { answer, finishReason, continuations };
}

export type FinalAnswer = {
  answer: string;
  /** Only the sources the answer actually cited, renumbered from 1 in order. */
  sources: ChatSource[];
  invalidMarkers: number[];
  metaPhrases: string[];
};

/**
 * Turns raw model output into the answer and Sources list the UI shows. Both are
 * written here, from the same map, so a display number always points at the
 * document the text meant.
 */
export function finalizeAnswer(raw: string, context: BuiltContext): FinalAnswer {
  const processed = processCitationMarkers(raw, new Set(context.sources.keys()));
  const sources = processed.cited.flatMap((number, index) => {
    const source = context.sources.get(number);
    return source ? [{ ...source, citation: index + 1 }] : [];
  });

  return {
    answer: processed.text,
    sources,
    invalidMarkers: processed.invalid,
    // Detected on the raw text: "according to passage [7]" loses its marker
    // during validation, but it is still narration worth measuring.
    metaPhrases: findMetaPhrases(raw),
  };
}

/** Used when retrieval finds nothing: no model call, no chance to invent. */
export function noPassagesAnswer(): string {
  return "I couldn't find anything in the library that answers this. Try different wording, or clear the context filters so the search covers more of the library.";
}

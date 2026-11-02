/**
 * Grounded answer generation for chat. Retrieval supplies passages; this module
 * turns them into a prompt, calls the chat model and returns the passages as
 * numbered citations so every claim can be traced back to a file.
 *
 * The model only ever sees what the user is allowed to read: the passages come
 * from search_chunks, which runs under the caller's JWT.
 */
import type { RetrievedChunk } from "../rag/search";
import { ANSWER_MAX_TOKENS, ANSWER_MODEL } from "../rag/config";

/** One numbered passage, matching the [n] markers the answer is asked to use. */
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
  snippet: string;
};

export type ChatHistoryMessage = { role: "user" | "assistant"; content: string };

/** Prompt budget per passage; the full chunk is still kept for the UI snippet. */
const MAX_CONTEXT_CHARS = 1400;
/** Turns of history sent to the model; older turns are already in the answer. */
const MAX_HISTORY_MESSAGES = 6;

export const SYSTEM_PROMPT = [
  "You are the sales enablement assistant for Solution Hub, an internal library of case studies, pitch decks, proposals and POC material.",
  "Answer using ONLY the numbered library passages in the user message. Do not use outside knowledge and do not invent customers, numbers or products.",
  "Cite every factual claim with the passage number in square brackets, like [1] or [2][3]. Put the citation at the end of the sentence it supports.",
  "If the passages do not answer the question, say so plainly in one sentence and name what is missing. Never guess.",
  "Be concise and commercial: lead with the answer, then the supporting detail. Plain prose or short bullet lists, no headings, no markdown tables.",
].join(" ");

function locationOf(chunk: RetrievedChunk): string {
  if (chunk.page) return `page ${chunk.page}`;
  if (chunk.slide) return `slide ${chunk.slide}`;
  if (chunk.heading) return chunk.heading;
  return "passage";
}

/** Numbered passages, in retrieval order, as the model sees them. */
export function buildContextBlocks(chunks: readonly RetrievedChunk[]): string {
  return chunks
    .map((chunk, index) => {
      const where = [
        `[${index + 1}]`,
        chunk.title,
        `(${chunk.fileName}, ${locationOf(chunk)})`,
        `industry: ${chunk.industry}`,
        chunk.customerName ? `customer: ${chunk.customerName}` : "industry-wide",
      ].join(" · ");
      const body =
        chunk.content.length > MAX_CONTEXT_CHARS
          ? `${chunk.content.slice(0, MAX_CONTEXT_CHARS).trimEnd()}…`
          : chunk.content;
      return `${where}\n${body}`;
    })
    .join("\n\n");
}

/** The same passages as UI citations, one per retrieved chunk. */
export function collectSources(chunks: readonly RetrievedChunk[]): ChatSource[] {
  return chunks.map((chunk, index) => ({
    citation: index + 1,
    chunkId: chunk.chunkId,
    contentId: chunk.contentId,
    title: chunk.title,
    fileName: chunk.fileName,
    industry: chunk.industry,
    customerName: chunk.customerName,
    page: chunk.page,
    slide: chunk.slide,
    snippet: chunk.content.replace(/\s+/g, " ").trim().slice(0, 320),
  }));
}

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export function buildMessages(
  question: string,
  chunks: readonly RetrievedChunk[],
  history: readonly ChatHistoryMessage[] = [],
): ChatMessage[] {
  const recent = history.slice(-MAX_HISTORY_MESSAGES).map((message) => ({
    role: message.role,
    content: message.content,
  }));

  return [
    { role: "system", content: SYSTEM_PROMPT },
    ...recent,
    {
      role: "user",
      content: `Library passages:\n\n${buildContextBlocks(chunks)}\n\nQuestion: ${question.trim()}`,
    },
  ];
}

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
};

export type GenerateOptions = {
  apiKey: string;
  baseUrl: string;
  model?: string;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
};

/**
 * Calls the OpenAI-compatible chat endpoint used by the embedding provider.
 * Returns the trimmed answer text; throws with a provider message on failure.
 */
export async function generateAnswer(
  messages: readonly ChatMessage[],
  options: GenerateOptions,
): Promise<{ answer: string }> {
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  const response = await doFetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
    body: JSON.stringify({
      model: options.model ?? ANSWER_MODEL,
      messages,
      max_tokens: options.maxTokens ?? ANSWER_MAX_TOKENS,
      temperature: 0.2,
    }),
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

  const answer = body.choices?.[0]?.message?.content?.trim() ?? "";
  if (!answer) throw new Error("Answer provider returned an empty answer");
  return { answer };
}

/** Used when retrieval finds nothing: no model call, no chance to invent. */
export function noPassagesAnswer(): string {
  return "I couldn't find anything in the library that answers this. Try different wording, or clear the context filters so the search covers more of the library.";
}

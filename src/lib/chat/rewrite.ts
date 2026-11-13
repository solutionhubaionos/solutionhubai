/**
 * Query rewriting for follow-up questions. A chat turn like "wht about Interglobe
 * hotels?" is not a search query on its own; retrieval needs the standalone
 * form, "What was proposed to InterGlobe Hotels?".
 *
 * The gate is deliberately conservative: a rewrite costs an extra model call,
 * so it only runs when the message cannot stand alone. Any failure, timeout or
 * empty completion falls back to the raw message and never blocks the chat.
 */
import {
  ANSWER_MODEL,
  QUERY_REWRITE_HISTORY_MESSAGES,
  QUERY_REWRITE_MAX_TOKENS,
  QUERY_REWRITE_TIMEOUT_MS,
} from "../rag/config";
import type { ChatHistoryMessage } from "./answer";
import { generateAnswer } from "./answer";

/** Standalone questions longer than this are never rewritten on a hunch. */
const SHORT_QUESTION_WORDS = 5;

/** Words that point at an earlier turn instead of naming the subject. */
const PRONOUN =
  /\b(it|its|it's|they|them|their|this|that|these|those|he|she|his|her|itself|themselves)\b/i;

/** "and for Zurich?", "what about hotels?", "also ...", a trailing ellipsis. */
const DEPENDENT_START =
  /^\s*(?:and|also|plus|then|same|what about|how about|what else|anything else|ok(?:ay)?(?:,)?\s+so)\b/i;
const ELLIPSIS = /(?:\.\.\.|…)\s*$|^\s*(?:\.\.\.|…)/;

const REWRITE_INSTRUCTIONS = [
  "Rewrite the user's latest message as one standalone search query for an internal library of decks, proposals and case studies.",
  'Use the conversation only to resolve references: pronouns, ellipsis, and phrases like "and for X" or "what about X".',
  "Keep the user's own wording and entities; fix only obvious typos in customer names.",
  "Return the query and nothing else: no quotes, no explanation, no list.",
].join(" ");

export type RewriteReason = "no-history" | "standalone" | "rewritten" | "fallback";

export type RewriteResult = {
  /** The query retrieval should embed. Always non-empty. */
  query: string;
  /** The message exactly as the user typed it. */
  original: string;
  rewritten: boolean;
  reason: RewriteReason;
};

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * True when the latest message leans on the conversation. No history, or a
 * self-contained question, means no rewrite and no extra model call.
 */
export function needsRewrite(question: string, history: readonly ChatHistoryMessage[]): boolean {
  const trimmed = question.trim();
  if (!trimmed || history.length === 0) return false;
  if (DEPENDENT_START.test(trimmed) || ELLIPSIS.test(trimmed)) return true;
  if (PRONOUN.test(trimmed)) return true;
  return wordCount(trimmed) <= SHORT_QUESTION_WORDS;
}

/** The rewrite prompt: recent turns, then the message to make standalone. */
export function buildRewritePrompt(
  question: string,
  history: readonly ChatHistoryMessage[],
): string {
  const turns = history
    .slice(-QUERY_REWRITE_HISTORY_MESSAGES)
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`)
    .join("\n");

  return [
    REWRITE_INSTRUCTIONS,
    "",
    turns ? `Conversation so far:\n${turns}` : "No previous conversation.",
    "",
    `Latest message: ${question.trim()}`,
    "Standalone query:",
  ].join("\n");
}

/** Keeps one line, drops quotes and any "Query:" prefix the model adds. */
export function sanitizeRewrite(raw: string, fallback: string): string {
  const line =
    raw
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? "";
  const cleaned = line
    .replace(/^(?:standalone\s+)?(?:search\s+)?query\s*:\s*/i, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length < 2) return fallback;
  return cleaned.slice(0, 300);
}

export type RewriteOptions = {
  apiKey: string;
  baseUrl: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: (event: string, meta: Record<string, unknown>) => void;
};

/**
 * One small, fast completion that turns the latest message into a standalone
 * query. Every failure path returns the raw message with `reason: "fallback"`.
 */
export async function rewriteQuery(
  question: string,
  history: readonly ChatHistoryMessage[],
  options: RewriteOptions,
): Promise<RewriteResult> {
  const original = question.trim();
  if (!needsRewrite(original, history)) {
    return {
      query: original,
      original,
      rewritten: false,
      reason: history.length === 0 ? "no-history" : "standalone",
    };
  }

  try {
    const { answer } = await generateAnswer(
      [{ role: "user", content: buildRewritePrompt(original, history) }],
      {
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        model: options.model ?? ANSWER_MODEL,
        maxTokens: QUERY_REWRITE_MAX_TOKENS,
        timeoutMs: options.timeoutMs ?? QUERY_REWRITE_TIMEOUT_MS,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      },
    );
    const query = sanitizeRewrite(answer, original);
    options.log?.("query rewrite", { original, query, rewritten: query !== original });
    return { query, original, rewritten: query !== original, reason: "rewritten" };
  } catch (error) {
    options.log?.("query rewrite failed", {
      original,
      error: error instanceof Error ? error.message : String(error),
    });
    return { query: original, original, rewritten: false, reason: "fallback" };
  }
}

/**
 * One OpenAI-compatible completion helper for the document pipeline. Briefing,
 * outlining, section writing and verification all need the same request shape,
 * the same token/thinking budget and the same tolerant JSON reader.
 *
 * The provider reasons by default and reasoning tokens count against
 * max_tokens, so a retry with identical parameters after a "length" finish is
 * guaranteed to fail again. Every retry therefore changes the request:
 * max_tokens doubles (up to the ceiling) and the final attempt forces thinking
 * off, so the call still returns visible content.
 */
import { llmLimiter } from "./concurrency";
import {
  llmCallTimeoutMs,
  maxTokensCeiling,
  THINKING_FLOOR_TOKENS,
  withMaxTokens,
  type LlmBudget,
  type LlmCallType,
} from "./llm-budget";

export type CompletionMessage = { role: "system" | "user" | "assistant"; content: string };

export type ProviderOptions = {
  apiKey: string;
  baseUrl: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Total attempts including the first. Defaults to 3 (DOC_LLM_ATTEMPTS). */
  attempts?: number;
  /** Injected by tests so backoff does not sleep for real. */
  sleepImpl?: (ms: number) => Promise<void>;
  log?: (event: string, meta: Record<string, unknown>) => void;
};

/**
 * Why a call produced no usable result. Zod/JSON failures are schema_invalid,
 * never provider_error; a truncated completion is token_limit, not a network
 * problem.
 */
export type CompletionFailure =
  "provider_error" | "token_limit" | "timeout" | "schema_invalid" | "no_passages";

export class CompletionError extends Error {
  readonly reason: CompletionFailure;

  constructor(reason: CompletionFailure, message: string) {
    super(message);
    this.name = "CompletionError";
    this.reason = reason;
  }
}

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { message?: string } | string;
};

type RawCompletion = {
  content: string;
  finishReason: string | null;
  reasoningTokens: number | null;
  completionTokens: number | null;
  promptTokens: number | null;
  contentChars: number;
  durationMs: number;
};

export type CompletionOutcome = RawCompletion & {
  type: LlmCallType;
  thinking: boolean;
  maxTokens: number;
  attempts: number;
};

const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash";

/** Per-call wall clock cap; overridable with DOC_LLM_CALL_TIMEOUT_MS. */
export const DOC_PROVIDER_TIMEOUT_MS = 120_000;
export const DOC_PROVIDER_ATTEMPTS = 3;

/** Maps any failure to the one reason the gate and logs report. */
export function failureReasonOf(error: unknown): CompletionFailure {
  if (error instanceof CompletionError) return error.reason;
  // Zod errors are objects with `issues`; their message can mention anything.
  if (typeof error === "object" && error !== null && "issues" in error) return "schema_invalid";
  const message = error instanceof Error ? error.message : String(error);
  if (/timed? ?out|timeout|ETIMEDOUT|aborted due to timeout/i.test(message)) return "timeout";
  if (
    /document provider failed|answer provider failed|empty completion|non-JSON response|network|fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up|rate limit/i.test(
      message,
    )
  ) {
    return "provider_error";
  }
  if (/json|schema|zod|invalid|parse|expected|unrecognized_keys|too_big|too_small/i.test(message)) {
    return "schema_invalid";
  }
  return "provider_error";
}

/** Failures worth another request; client errors and aborts are not. */
export function isRetryableProviderError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const reason = failureReasonOf(error);
  if (reason === "timeout") return true;
  if (reason === "token_limit") return true;
  if (/abort|cancelled|canceled/i.test(message)) return false;
  if (/empty completion|no JSON value/i.test(message)) return true;
  if (/failed \((?:429|5\d\d)\)/.test(message)) return true;
  return /fetch failed|network|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up|terminated/i.test(message);
}

async function requestCompletion(
  messages: readonly CompletionMessage[],
  options: ProviderOptions,
  budget: LlmBudget,
  temperature: number,
): Promise<RawCompletion> {
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const signal =
    options.signal ??
    AbortSignal.timeout(options.timeoutMs ?? budget.timeoutMs ?? llmCallTimeoutMs());
  const started = Date.now();

  const response = await doFetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
    body: JSON.stringify({
      model: options.model ?? DEFAULT_MODEL,
      messages,
      max_tokens: budget.maxTokens,
      temperature,
      ...budget.extraBody,
    }),
    signal,
  });

  const raw = await response.text();
  if (!response.ok) {
    if (response.status === 400 && /max_tokens|context length|too (?:large|long)/i.test(raw)) {
      throw new CompletionError(
        "token_limit",
        `provider rejected max_tokens=${budget.maxTokens}: ${raw.slice(0, 200)}`,
      );
    }
    throw new CompletionError(
      "provider_error",
      `Document provider failed (${response.status}): ${raw.slice(0, 300)}`,
    );
  }

  let body: ChatCompletionResponse;
  try {
    body = JSON.parse(raw) as ChatCompletionResponse;
  } catch {
    throw new CompletionError("provider_error", "Document provider returned a non-JSON response");
  }

  const choice = body.choices?.[0];
  const content = choice?.message?.content ?? "";
  return {
    content,
    finishReason: choice?.finish_reason ?? null,
    reasoningTokens: body.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    completionTokens: body.usage?.completion_tokens ?? null,
    promptTokens: body.usage?.prompt_tokens ?? null,
    contentChars: content.length,
    durationMs: Math.max(0, Date.now() - started),
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Jitter stops parallel sections from retrying in lockstep. */
function backoffMs(attempt: number): number {
  return 300 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
}

/**
 * Runs one budgeted completion, retrying only with different parameters.
 * Logs exactly one line per attempt with the fields the budget audit needs.
 */
export async function completeWithBudget(
  messages: readonly CompletionMessage[],
  options: ProviderOptions,
  budget: LlmBudget,
  temperature: number,
  meta: { label?: string } = {},
): Promise<CompletionOutcome> {
  const totalAttempts = Math.max(1, options.attempts ?? budget.attempts ?? DOC_PROVIDER_ATTEMPTS);
  const ceiling = maxTokensCeiling();
  const sleep = options.sleepImpl ?? defaultSleep;
  const limit = llmLimiter();

  let maxTokens = budget.maxTokens;
  let thinking = budget.thinking;
  let attempt = 0;
  let lastError: unknown = new CompletionError("provider_error", "completion was never attempted");

  while (attempt < totalAttempts) {
    attempt += 1;
    const isLast = attempt === totalAttempts;
    // The last attempt must return content, so reasoning is forced off there.
    const attemptThinking = isLast && totalAttempts > 1 ? false : thinking;
    const attemptBudget = withMaxTokens(budget, maxTokens, attemptThinking);

    let outcome: RawCompletion;
    try {
      outcome = await limit(() => requestCompletion(messages, options, attemptBudget, temperature));
    } catch (error) {
      lastError = error;
      const reason = failureReasonOf(error);
      options.log?.("llm call failed", {
        type: budget.type,
        label: meta.label,
        thinking: attemptBudget.thinking ? "on" : "off",
        max_tokens: attemptBudget.maxTokens,
        finish_reason: null,
        reasoning_tokens: null,
        completion_tokens: null,
        content_chars: 0,
        duration_ms: 0,
        attempt,
        reason,
        error: String(error).slice(0, 240),
      });
      const retry = attempt < totalAttempts && isRetryableProviderError(error);
      if (!retry) break;
      if (reason === "token_limit") {
        // The provider itself rejected this size; step down rather than up.
        const next = Math.max(1_000, Math.floor(attemptBudget.maxTokens / 2));
        options.log?.("provider max_tokens ceiling", {
          rejected: attemptBudget.maxTokens,
          next,
        });
        maxTokens = next;
      }
      await sleep(backoffMs(attempt));
      continue;
    }

    options.log?.("llm call", {
      type: budget.type,
      label: meta.label,
      thinking: attemptBudget.thinking ? "on" : "off",
      max_tokens: attemptBudget.maxTokens,
      finish_reason: outcome.finishReason,
      reasoning_tokens: outcome.reasoningTokens,
      completion_tokens: outcome.completionTokens,
      content_chars: outcome.contentChars,
      duration_ms: outcome.durationMs,
      attempt,
    });

    const truncated = outcome.finishReason === "length";
    const empty = outcome.contentChars === 0;
    if (!truncated && !empty) {
      return {
        ...outcome,
        type: budget.type,
        thinking: attemptBudget.thinking,
        maxTokens: attemptBudget.maxTokens,
        attempts: attempt,
      };
    }

    lastError = new CompletionError(
      truncated ? "token_limit" : "provider_error",
      truncated
        ? `completion stopped at the token limit after ${attemptBudget.maxTokens} tokens (${outcome.contentChars} chars); partial output is not usable`
        : "Document provider returned an empty completion",
    );

    // Never repeat a request that hit the limit: double the budget, and drop
    // reasoning if the ceiling is already reached so the next try differs.
    const doubled = Math.min(Math.max(attemptBudget.maxTokens, 1) * 2, ceiling);
    if (doubled === attemptBudget.maxTokens) {
      // Nothing left to change (ceiling reached with reasoning already off):
      // another identical request would fail the same way.
      if (!attemptBudget.thinking) break;
      thinking = false;
    }
    maxTokens = doubled;

    if (attempt >= totalAttempts) break;
    await sleep(backoffMs(attempt));
  }

  throw lastError instanceof Error
    ? lastError
    : new CompletionError("provider_error", String(lastError));
}

/**
 * Legacy helper kept for tests and simple callers: one text completion with the
 * given size and no reasoning. DOC stages use completeWithBudget instead.
 */
export async function completeText(
  messages: readonly CompletionMessage[],
  options: ProviderOptions,
  maxTokens: number,
  temperature: number,
): Promise<string> {
  const budget: LlmBudget = {
    type: "SECTION",
    thinking: false,
    maxTokens: Math.max(1, Math.trunc(maxTokens)),
    extraBody: { chat_template_kwargs: { thinking: false } },
    timeoutMs: options.timeoutMs ?? DOC_PROVIDER_TIMEOUT_MS,
    attempts: options.attempts ?? DOC_PROVIDER_ATTEMPTS,
  };
  const outcome = await completeWithBudget(messages, options, budget, temperature);
  return outcome.content;
}

/** Reads the outermost JSON value, tolerating fences and stray prose. */
export function parseJsonValue(raw: string): unknown {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/, "");
  const objectStart = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  const useArray = arrayStart !== -1 && (objectStart === -1 || arrayStart < objectStart);
  const start = useArray ? arrayStart : objectStart;
  const end = useArray ? text.lastIndexOf("]") : text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("completion contained no JSON value");
  return JSON.parse(text.slice(start, end + 1));
}

export async function completeJson(
  messages: readonly CompletionMessage[],
  options: ProviderOptions,
  maxTokens: number,
  temperature: number,
): Promise<unknown> {
  const text = await completeText(messages, options, maxTokens, temperature);
  try {
    return parseJsonValue(text);
  } catch (error) {
    throw new CompletionError(
      "schema_invalid",
      `completion did not contain valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export { THINKING_FLOOR_TOKENS };

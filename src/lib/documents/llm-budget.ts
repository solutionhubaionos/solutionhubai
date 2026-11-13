/**
 * Per-call token and thinking budgets for the document pipeline (and the chat
 * query rewrite, which shares the same provider quirk).
 *
 * The provider turns reasoning ON by default and reasoning tokens COUNT AGAINST
 * max_tokens, so a small budget returns an empty completion with finish_reason
 * "length". Two levers fix that: `chat_template_kwargs.thinking = false` (the
 * only switch this provider honours) and a max_tokens large enough to cover
 * reasoning plus the answer.
 *
 * Everything is env-overridable per call type:
 *   DOC_THINKING_<TYPE>=on|off
 *   DOC_MAX_TOKENS_<TYPE>=<int>
 *   DOC_MAX_TOKENS_CEILING=<int>        (default 32000)
 *   DOC_LLM_CALL_TIMEOUT_MS=<int>       (default 120000)
 *   DOC_LLM_ATTEMPTS=<int>              (default 3)
 */

export type LlmCallType = "QUERY_REWRITE" | "BRIEF" | "OUTLINE" | "SECTION" | "DECK" | "VERIFY";

export type LlmBudget = {
  type: LlmCallType;
  thinking: boolean;
  maxTokens: number;
  /** Extra body fields for the OpenAI-compatible request. */
  extraBody: Record<string, unknown>;
  timeoutMs: number;
  /** Total attempts including the first. */
  attempts: number;
};

/** Reasoning plus a useful answer never fits below this when thinking is on. */
export const THINKING_FLOOR_TOKENS = 4_000;
export const DEFAULT_MAX_TOKENS_CEILING = 32_000;
export const DEFAULT_LLM_TIMEOUT_MS = 120_000;
export const DEFAULT_LLM_ATTEMPTS = 3;
export const DEFAULT_LLM_CONCURRENCY = 3;
export const DEFAULT_SEARCH_CONCURRENCY = 3;

/**
 * Calibrated 2026-11-12 against the live provider (scripts/calibrate-llm-budget.ts):
 * ~2x the largest observed (reasoning + output) completion, floored at 4000
 * while thinking is on. Largest observed: brief 6400, outline 3022, section
 * 5724 completion tokens. An end-to-end export then showed outline reasoning
 * alone exceeding 7000, so OUTLINE keeps the SECTION-sized margin; a later
 * section spent all 12000 tokens on reasoning and retried, so SECTION is 16000.
 * VERIFY is sized like SECTION: it reads the same passages plus the section's
 * claims. Changes here must be mirrored in .env.example.
 */
const DEFAULTS: Record<LlmCallType, { thinking: boolean; maxTokens: number }> = {
  QUERY_REWRITE: { thinking: false, maxTokens: 1_000 },
  BRIEF: { thinking: true, maxTokens: 13_000 },
  OUTLINE: { thinking: true, maxTokens: 12_000 },
  SECTION: { thinking: true, maxTokens: 16_000 },
  /** One call for the whole deck, JSON only; reasoning off by default. */
  DECK: { thinking: false, maxTokens: 16_000 },
  VERIFY: { thinking: false, maxTokens: 4_000 },
};

function envValue(name: string): string | undefined {
  const raw = typeof process !== "undefined" ? process.env[name] : undefined;
  const value = raw?.trim();
  return value ? value : undefined;
}

/** Reads an integer env var, ignoring values that are not positive numbers. */
export function envInt(name: string, fallback: number): number {
  const raw = envValue(name);
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

/** on/true/1 enable; off/false/0 disable; anything else keeps the default. */
export function envFlag(name: string, fallback: boolean): boolean {
  const raw = envValue(name)?.toLowerCase();
  if (!raw) return fallback;
  if (["on", "true", "1", "yes"].includes(raw)) return true;
  if (["off", "false", "0", "no"].includes(raw)) return false;
  return fallback;
}

export function maxTokensCeiling(): number {
  return Math.max(1_000, envInt("DOC_MAX_TOKENS_CEILING", DEFAULT_MAX_TOKENS_CEILING));
}

export function llmCallTimeoutMs(): number {
  return envInt("DOC_LLM_CALL_TIMEOUT_MS", DEFAULT_LLM_TIMEOUT_MS);
}

/** The one body field this provider honours to disable reasoning. */
export function thinkingExtraBody(thinking: boolean): Record<string, unknown> {
  return thinking ? {} : { chat_template_kwargs: { thinking: false } };
}

function buildBudget(type: LlmCallType, thinking: boolean, requestedMaxTokens: number): LlmBudget {
  const ceiling = maxTokensCeiling();
  const floor = thinking ? THINKING_FLOOR_TOKENS : 1;
  const maxTokens = Math.min(Math.max(Math.trunc(requestedMaxTokens), floor), ceiling);
  return {
    type,
    thinking,
    maxTokens,
    extraBody: thinkingExtraBody(thinking),
    timeoutMs: llmCallTimeoutMs(),
    attempts: envInt("DOC_LLM_ATTEMPTS", DEFAULT_LLM_ATTEMPTS),
  };
}

/** Budget for one call type, from env with the documented defaults. */
export function llmBudget(type: LlmCallType): LlmBudget {
  const fallback = DEFAULTS[type];
  const thinking = envFlag(`DOC_THINKING_${type}`, fallback.thinking);
  const sizedForThinking = type === "DECK" && thinking ? 24_000 : fallback.maxTokens;
  const requested = envInt(`DOC_MAX_TOKENS_${type}`, sizedForThinking);
  return buildBudget(type, thinking, requested);
}

/** Same call type, different size/thinking; floors and clamps apply again. */
export function withMaxTokens(
  budget: LlmBudget,
  maxTokens: number,
  thinking: boolean = budget.thinking,
): LlmBudget {
  return buildBudget(budget.type, thinking, maxTokens);
}

/** Defaults, for docs and the calibration script. */
export function llmBudgetDefaults(): typeof DEFAULTS {
  return { ...DEFAULTS };
}

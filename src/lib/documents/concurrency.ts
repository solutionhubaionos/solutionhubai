/**
 * Small shared limiters. Before this, one export fired every section's LLM call
 * and every hybrid search at once; the database answered 5 of ~28 parallel
 * search statements with "canceling statement due to statement timeout".
 *
 * Two independent pools:
 *   DOC_LLM_CONCURRENCY   (default 3) model calls
 *   DOC_SEARCH_CONCURRENCY (default 3) hybrid searches
 */
import { DEFAULT_LLM_CONCURRENCY, DEFAULT_SEARCH_CONCURRENCY, envInt } from "./llm-budget";

export type Limiter = <T>(run: () => Promise<T>) => Promise<T>;

export function createLimiter(limit: number): Limiter {
  const max = Math.max(1, Math.trunc(limit));
  let active = 0;
  const waiting: (() => void)[] = [];

  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      const next = waiting.shift();
      if (next) next();
    }
  };
}

let llmPool: Limiter | null = null;
let llmPoolSize = 0;
let searchPool: Limiter | null = null;
let searchPoolSize = 0;

/** One process-wide pool, so parallel sections share the same cap. */
export function llmLimiter(): Limiter {
  const size = envInt("DOC_LLM_CONCURRENCY", DEFAULT_LLM_CONCURRENCY);
  if (!llmPool || size !== llmPoolSize) {
    llmPool = createLimiter(size);
    llmPoolSize = size;
  }
  return llmPool;
}

export function searchLimiter(): Limiter {
  const size = envInt("DOC_SEARCH_CONCURRENCY", DEFAULT_SEARCH_CONCURRENCY);
  if (!searchPool || size !== searchPoolSize) {
    searchPool = createLimiter(size);
    searchPoolSize = size;
  }
  return searchPool;
}

/** Tests only: drop the pools so an env change takes effect. */
export function resetLimiters(): void {
  llmPool = null;
  searchPool = null;
  llmPoolSize = 0;
  searchPoolSize = 0;
}

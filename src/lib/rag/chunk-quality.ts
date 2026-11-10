/**
 * Passage quality heuristics. Title slides and section dividers embed as if they
 * were evidence, so retrieval and the prompt both need to know which chunks
 * carry no content. Kept pure and dependency-free so the eval can exercise it.
 */
import { TITLE_ONLY_MAX_TOKENS } from "./config";

/** A list number, bullet, page marker or shape name: not a word of content. */
const NOISE_TOKEN = /^(?:\d+[a-z]?[.)]?|[-–—•·*|]+|s\d+|p\d+)$/i;

/** Words (and numbers) in a passage, ignoring bullets, slide numbers and punctuation. */
export function meaningfulTokens(text: string): string[] {
  return text
    .split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}\p{N}%$]+|[^\p{L}\p{N}%$]+$/gu, ""))
    .filter((token) => token.length > 0 && /[\p{L}\p{N}]/u.test(token) && !NOISE_TOKEN.test(token));
}

export function meaningfulTokenCount(text: string): number {
  return meaningfulTokens(text).length;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export type ChunkQualityInput = {
  content: string;
  heading: string | null;
  title: string;
};

/**
 * True when a passage cannot answer anything on its own: an empty or very short
 * chunk, a chunk that only repeats the deck title/heading, or a numbered section
 * divider such as "2A. Hospitality Marketplace and Tools Case-Studies".
 */
export function isTitleOnlyChunk(chunk: ChunkQualityInput): boolean {
  const body = chunk.content.replace(/\s+/g, " ").trim();
  if (!body) return true;

  const tokens = meaningfulTokenCount(body);
  if (tokens <= TITLE_ONLY_MAX_TOKENS) return true;

  const normalizedBody = normalize(body);
  if (normalizedBody.length === 0) return true;
  if (normalizedBody === normalize(chunk.title)) return true;
  if (chunk.heading && normalizedBody === normalize(chunk.heading)) return true;

  // A divider is short, numbered and has no sentence punctuation of its own.
  if (tokens <= TITLE_ONLY_MAX_TOKENS * 2 && /^\d+[a-z]?[.)]\s/i.test(body)) {
    if (!/[.!?](\s|$)/.test(body)) return true;
  }

  return false;
}

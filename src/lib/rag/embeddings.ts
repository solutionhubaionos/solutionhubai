/**
 * Embedding client shared by ingestion (Bun worker) and query retrieval
 * (Cloudflare Worker). No Node built-ins here on purpose: the Worker imports
 * this module while the ingestion worker imports it too.
 */
import {
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  EMBEDDING_USD_PER_TOKEN,
} from "./config";

export type EmbedOptions = {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  model?: string;
  dimensions?: number;
  batchSize?: number;
};

export type EmbeddingResult = {
  embeddings: number[][];
  promptTokens: number | null;
  costUsd: number | null;
  /** True when cost was derived from the token count instead of provider usage. */
  costEstimated: boolean;
};

type EmbeddingResponse = {
  data?: Array<{ embedding?: number[]; index?: number }>;
  usage?: { prompt_tokens?: number; cost?: number };
  error?: { message?: string } | string;
};

/** Embeds texts in provider-sized batches, preserving input order. */
export async function embedTexts(
  texts: readonly string[],
  options: EmbedOptions,
): Promise<EmbeddingResult> {
  const embeddings: number[][] = [];
  let promptTokens = 0;
  let costUsd = 0;
  let sawUsage = false;
  let sawCost = false;

  const batchSize = Math.max(1, Math.min(options.batchSize ?? EMBEDDING_BATCH_SIZE, 100));
  const dimensions = options.dimensions ?? EMBEDDING_DIMENSIONS;
  const model = options.model ?? EMBEDDING_MODEL;
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize);
    const response = await doFetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify({ model, input: batch, dimensions }),
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Embedding provider failed (${response.status}): ${providerMessage(raw)}`);
    }

    let body: EmbeddingResponse;
    try {
      body = JSON.parse(raw) as EmbeddingResponse;
    } catch {
      throw new Error("Embedding provider returned a non-JSON response");
    }

    const data = body.data;
    if (!Array.isArray(data) || data.length !== batch.length) {
      throw new Error(
        `Embedding provider returned ${Array.isArray(data) ? data.length : 0} vectors for ${batch.length} inputs`,
      );
    }

    // Providers may reorder; index is authoritative when present.
    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const entry of ordered) {
      const vector = entry.embedding;
      if (!Array.isArray(vector) || vector.length !== dimensions) {
        throw new Error(
          `Embedding dimension mismatch: expected ${dimensions}, received ${vector?.length ?? 0}`,
        );
      }
      embeddings.push(vector);
    }

    if (body.usage) {
      sawUsage = true;
      promptTokens += body.usage.prompt_tokens ?? 0;
      if (typeof body.usage.cost === "number") {
        sawCost = true;
        costUsd += body.usage.cost;
      }
    }
  }

  // Batched responses omit cost, so fall back to the observed per-token price.
  const costEstimated = sawUsage && !sawCost;
  if (costEstimated) costUsd = promptTokens * EMBEDDING_USD_PER_TOKEN;

  return {
    embeddings,
    promptTokens: sawUsage ? promptTokens : null,
    costUsd: sawUsage ? costUsd : null,
    costEstimated,
  };
}

/** Embeds one query string; retrieval always sends exactly one input. */
export async function embedQuery(
  text: string,
  options: Omit<EmbedOptions, "batchSize">,
): Promise<number[]> {
  const query = text.trim();
  if (!query) throw new Error("Cannot embed an empty query");
  const { embeddings } = await embedTexts([query], options);
  const vector = embeddings[0];
  if (!vector) throw new Error("Embedding provider returned no vector for the query");
  return vector;
}

/** Keeps provider text in logs useful without dumping a whole response body. */
function providerMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as EmbeddingResponse;
    const message = typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? "");
    if (message) return message.slice(0, 300);
  } catch {
    // fall through to the raw body
  }
  return raw.slice(0, 300);
}

/**
 * One OpenAI-compatible completion helper for the document pipeline. Briefing,
 * outlining and section writing all need the same request shape and the same
 * tolerant JSON reader, so the provider details stay in one file.
 */
export type CompletionMessage = { role: "system" | "user" | "assistant"; content: string };

export type ProviderOptions = {
  apiKey: string;
  baseUrl: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
};

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
  error?: { message?: string } | string;
};

export const DOC_PROVIDER_TIMEOUT_MS = 75_000;

export async function completeText(
  messages: readonly CompletionMessage[],
  options: ProviderOptions,
  maxTokens: number,
  temperature: number,
): Promise<string> {
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const signal =
    options.signal ?? AbortSignal.timeout(options.timeoutMs ?? DOC_PROVIDER_TIMEOUT_MS);

  const response = await doFetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
    body: JSON.stringify({
      model: options.model ?? "deepseek/deepseek-v4.1-flash",
      messages,
      max_tokens: maxTokens,
      temperature,
    }),
    signal,
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Document provider failed (${response.status}): ${raw.slice(0, 300)}`);
  }

  let body: ChatCompletionResponse;
  try {
    body = JSON.parse(raw) as ChatCompletionResponse;
  } catch {
    throw new Error("Document provider returned a non-JSON response");
  }

  const content = body.choices?.[0]?.message?.content ?? "";
  if (!content.trim()) throw new Error("Document provider returned an empty completion");
  return content;
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
  return parseJsonValue(await completeText(messages, options, maxTokens, temperature));
}

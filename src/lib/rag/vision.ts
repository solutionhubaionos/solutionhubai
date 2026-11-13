/**
 * Vision pass for pictures that carry content but no text (a chart exported as
 * a PNG, an image-only slide, a scanned page). No Node built-ins: the same file
 * works from the Bun worker and any fetch-capable runtime.
 *
 * This is optional. With no vision model configured the caller must skip it —
 * a description is never invented from the picture's filename or alt text.
 */

export type VisionOptions = {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
};

/**
 * Asks for a retrieval-ready transcription, not an opinion. Values are marked
 * approximate because a model reading pixels cannot be authoritative; chunks
 * built from this carry `approximate: true` in their metadata.
 */
export const VISION_PROMPT = [
  "Transcribe this slide picture so it can be searched later.",
  "State the title if there is one.",
  "If it shows a chart: name the axes and series, then list the values you can read, marking each as approximate.",
  "If it shows a table: transcribe it as pipe-separated rows with the header first.",
  "If it shows a diagram: list the boxes and the connections between them.",
  "Use only what is visible. Never invent numbers, names or labels, and do not comment on the design.",
].join(" ");

type ChatResponse = {
  choices?: Array<{
    message?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
  error?: { message?: string } | string;
};

/** One image in, one plain-text description out. Throws on any provider problem. */
export async function describeImage(
  image: Uint8Array,
  mimeType: string,
  options: VisionOptions,
): Promise<string> {
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const response = await doFetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
    body: JSON.stringify({
      model: options.model,
      max_tokens: options.maxTokens ?? 500,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: VISION_PROMPT },
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${base64(image)}` },
            },
          ],
        },
      ],
    }),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Vision provider failed (${response.status}): ${providerMessage(raw)}`);
  }

  let body: ChatResponse;
  try {
    body = JSON.parse(raw) as ChatResponse;
  } catch {
    throw new Error("Vision provider returned a non-JSON response");
  }

  const choice = body.choices?.[0];
  const text = (choice?.message?.content ?? "").trim();
  if (!text) {
    // Reasoning models can spend the budget and return nothing usable.
    const reason = choice?.message?.reasoning_content?.trim();
    throw new Error(
      `Vision provider returned no text (finish_reason: ${choice?.finish_reason ?? "none"}` +
        `${reason ? ", reasoning only" : ""})`,
    );
  }
  return text.slice(0, 2_000);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return btoa(binary);
}

function providerMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as ChatResponse;
    const message = typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? "");
    if (message) return message.slice(0, 300);
  } catch {
    // fall through to the raw body
  }
  return raw.slice(0, 300);
}

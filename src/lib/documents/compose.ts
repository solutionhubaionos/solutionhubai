/**
 * Turns a confirmed draft plus retrieved library passages into the outline the
 * renderers consume. The model writes the prose; the passages are the only
 * facts it is allowed to use, and an unusable response falls back to a
 * passage-derived outline so a demo never dies on a bad completion.
 */
import { ANSWER_MODEL } from "../rag/config";
import type { RetrievedChunk } from "../rag/search";
import type { DocumentDraft, DocumentOutline, DocumentOutlineSection } from "./types";

export const COMPOSE_MAX_TOKENS = 1600;
const MAX_PASSAGE_CHARS = 1200;

export const COMPOSE_SYSTEM_PROMPT = [
  "You are a senior consultant turning an internal sales library into a client-ready document.",
  "Use ONLY the numbered library passages. Do not invent customers, numbers, products or claims.",
  "Write in British English, commercially and concretely: lead with the point, then the evidence.",
  'Return JSON only, no markdown fences: {"title": string, "subtitle": string, "sections": [{"heading": string, "bullets": string[]}]}.',
  "Follow the requested section count and headings closely. Each bullet is one sentence.",
].join(" ");

/** Numbered passages, exactly as the model sees them. */
export function passagesBlock(passages: readonly RetrievedChunk[]): string {
  return passages
    .map((chunk, index) => {
      const where = chunk.page
        ? `page ${chunk.page}`
        : chunk.slide
          ? `slide ${chunk.slide}`
          : (chunk.heading ?? "passage");
      const body = chunk.content.replace(/\s+/g, " ").slice(0, MAX_PASSAGE_CHARS);
      const customer = chunk.customerName ? ` · customer: ${chunk.customerName}` : "";
      return `[${index + 1}] ${chunk.title} (${chunk.fileName}, ${where}) · industry: ${chunk.industry}${customer}\n${body}`;
    })
    .join("\n\n");
}

export type ComposeHistoryTurn = { role: "user" | "assistant"; content: string };

export function composeUserPrompt(
  draft: DocumentDraft,
  passages: readonly RetrievedChunk[],
  history: readonly ComposeHistoryTurn[] = [],
): string {
  const context = [
    draft.client ? `Client: ${draft.client}` : null,
    draft.industry ? `Industry: ${draft.industry}` : null,
    draft.sector ? `Sector: ${draft.sector}` : null,
    draft.audience ? `Audience: ${draft.audience}` : null,
  ].filter(Boolean);

  const library =
    passages.length > 0
      ? passagesBlock(passages)
      : "No passages were retrieved. Keep the outline generic and do not state facts about clients.";

  const conversation = history
    .map(
      (turn) =>
        `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content.replace(/\s+/g, " ").slice(0, 600)}`,
    )
    .join("\n");

  const lines = [
    `Document request: ${draft.prompt}`,
    `Format: ${draft.type}`,
    `Title to use: ${draft.title}`,
    `Subtitle to use: ${draft.subtitle}`,
    context.length > 0 ? context.join(" · ") : "No additional context selected.",
    `Section headings to cover: ${draft.outline.join(" | ")}`,
  ];
  if (conversation) lines.push("", "Conversation so far:", conversation);
  lines.push("", "Library passages:", library);
  return lines.join("\n");
}

/** Reads the model's JSON, tolerating fences and stray prose around it. */
export function parseOutline(raw: string, draft: DocumentDraft): DocumentOutline {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("composed outline contained no JSON object");

  const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
  if (typeof parsed !== "object" || parsed === null) throw new Error("outline is not an object");
  const record = parsed as Record<string, unknown>;

  const rawSections = Array.isArray(record["sections"]) ? record["sections"] : [];
  const sections = rawSections.flatMap<DocumentOutlineSection>((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const item = entry as Record<string, unknown>;
    const heading = typeof item["heading"] === "string" ? item["heading"].trim() : "";
    const bullets = Array.isArray(item["bullets"])
      ? item["bullets"]
          .filter((bullet): bullet is string => typeof bullet === "string")
          .map((bullet) => bullet.trim())
          .filter(Boolean)
      : [];
    if (!heading || bullets.length === 0) return [];
    return [{ heading, bullets }];
  });

  if (sections.length === 0) throw new Error("outline contained no usable sections");

  const title =
    typeof record["title"] === "string" && record["title"].trim()
      ? record["title"].trim()
      : draft.title;
  const subtitle =
    typeof record["subtitle"] === "string" ? record["subtitle"].trim() : draft.subtitle;
  return { title, subtitle, sections };
}

function firstSentence(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const stop = collapsed.indexOf(". ");
  const sentence = stop > 40 ? collapsed.slice(0, stop + 1) : collapsed;
  return sentence.length > 200 ? `${sentence.slice(0, 197).trimEnd()}…` : sentence;
}

/** Deterministic outline used when the provider is unavailable or returns junk. */
export function fallbackOutline(
  draft: DocumentDraft,
  passages: readonly RetrievedChunk[],
): DocumentOutline {
  const snippets = passages.map((chunk) => firstSentence(chunk.content)).filter(Boolean);
  const perSection = Math.max(
    1,
    Math.min(3, Math.floor(snippets.length / Math.max(1, draft.outline.length)) || 1),
  );

  const sections = draft.outline.map((heading, index) => {
    const start = index * perSection;
    const bullets = snippets.slice(start, start + perSection);
    return {
      heading,
      bullets:
        bullets.length > 0
          ? bullets
          : [
              `${heading}: no matching library passage yet — add supporting content before sending.`,
            ],
    };
  });

  return { title: draft.title, subtitle: draft.subtitle, sections };
}

export type ComposeOptions = {
  apiKey: string;
  baseUrl: string;
  model?: string;
  fetchImpl?: typeof fetch;
  /** Recent chat turns, so the document reflects the current conversation. */
  history?: readonly ComposeHistoryTurn[];
};

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string } | string;
};

export async function composeDocument(
  draft: DocumentDraft,
  passages: readonly RetrievedChunk[],
  options: ComposeOptions,
): Promise<{ outline: DocumentOutline }> {
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  const response = await doFetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
    body: JSON.stringify({
      model: options.model ?? ANSWER_MODEL,
      messages: [
        { role: "system", content: COMPOSE_SYSTEM_PROMPT },
        {
          role: "user",
          content: composeUserPrompt(draft, passages, options.history ?? []),
        },
      ],
      max_tokens: COMPOSE_MAX_TOKENS,
      temperature: 0.4,
    }),
  });

  const raw = await response.text();
  if (!response.ok)
    throw new Error(`Document provider failed (${response.status}): ${raw.slice(0, 300)}`);

  let body: ChatCompletionResponse;
  try {
    body = JSON.parse(raw) as ChatCompletionResponse;
  } catch {
    throw new Error("Document provider returned a non-JSON response");
  }

  const content = body.choices?.[0]?.message?.content ?? "";
  if (!content.trim()) throw new Error("Document provider returned an empty completion");
  return { outline: parseOutline(content, draft) };
}

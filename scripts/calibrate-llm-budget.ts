/**
 * Real measurement of the provider's token behaviour for the three document
 * calls that used to fail: brief, outline and section.
 *
 *   bun scripts/calibrate-llm-budget.ts
 *
 * It builds the *production* prompts (same builders the pipeline uses), fills
 * them with real retrieved passages for the IndiGo x InterGlobe Hotels x Movin
 * scenario, and calls the provider at 4000/8000/16000 tokens with thinking on
 * plus once with thinking off. Nothing is written; the table and the
 * recommended env values are printed.
 *
 * Keys are read from the environment only and never printed.
 */
import { createClient } from "@supabase/supabase-js";
import {
  llmBudget,
  maxTokensCeiling,
  THINKING_FLOOR_TOKENS,
} from "../src/lib/documents/llm-budget";
import {
  buildExportBrief,
  briefUserPrompt,
  BRIEF_SYSTEM,
  transcriptOf,
  type ExportHistoryMessage,
} from "../src/lib/documents/brief";
import {
  planOutline,
  outlineUserPrompt,
  OUTLINE_SYSTEM,
  plansFromOutline,
  type SectionPlan,
} from "../src/lib/documents/outline";
import { sectionUserPrompt, SECTION_SYSTEM } from "../src/lib/documents/generate";
import { parseJsonValue } from "../src/lib/documents/provider";
import { searchLibraryChunks, type RetrievedChunk } from "../src/lib/rag/search";
import { embedQuery } from "../src/lib/rag/embeddings";
import type { DocumentDraft } from "../src/lib/documents/types";

const apiKey = process.env["TOKENFACTORY_API_KEY"];
const baseUrl = (process.env["TOKENFACTORY_API_BASE"] ?? "").replace(/\/+$/, "");
const model = "deepseek/deepseek-v4.1-flash";

if (!apiKey || !baseUrl) {
  console.error("TOKENFACTORY_API_KEY and TOKENFACTORY_API_BASE must be set.");
  process.exit(1);
}

const REQUEST =
  "Vacation packages with IndiGo flights, Movin luggage logistics and InterGlobe stays plus partners.";

const HISTORY: ExportHistoryMessage[] = [
  { role: "user", content: `Build a pitch deck: ${REQUEST}` },
  {
    role: "assistant",
    content:
      "The library has IndiGo crew and integration work, InterGlobe Hotels procurement, and Movin logistics material [1][2][3].",
  },
  {
    role: "user",
    content: "Use numbers, tables and an assumed footfall. Cover all three parties.",
  },
];

const DRAFT: DocumentDraft = {
  type: "pptx",
  mode: "pitch",
  title: "IndiGo x InterGlobe Hotels x Movin — pitch deck",
  subtitle: "Vacation packages",
  audience: "COO",
  industry: "travel",
  industrySlug: null,
  client: "IndiGo",
  sector: null,
  outline: [],
  prompt: REQUEST,
};

type CallResult = {
  thinking: boolean;
  maxTokens: number;
  status: number;
  finishReason: string | null;
  reasoningTokens: number | null;
  completionTokens: number | null;
  contentChars: number;
  durationMs: number;
  jsonValid: boolean;
  note: string;
};

/** One raw call so the table shows the provider's own finish reason. */
async function rawCall(
  messages: { role: "system" | "user"; content: string }[],
  maxTokens: number,
  thinking: boolean,
  temperature: number,
): Promise<CallResult> {
  const started = Date.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      ...(thinking ? {} : { chat_template_kwargs: { thinking: false } }),
    }),
  });
  const raw = await response.text();
  const durationMs = Date.now() - started;
  if (!response.ok) {
    return {
      thinking,
      maxTokens,
      status: response.status,
      finishReason: null,
      reasoningTokens: null,
      completionTokens: null,
      contentChars: 0,
      durationMs,
      jsonValid: false,
      note: raw.slice(0, 160).replace(/\s+/g, " "),
    };
  }
  const body = JSON.parse(raw) as {
    choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
    usage?: {
      completion_tokens?: number;
      completion_tokens_details?: { reasoning_tokens?: number };
    };
  };
  const content = body.choices?.[0]?.message?.content ?? "";
  let jsonValid = false;
  try {
    parseJsonValue(content);
    jsonValid = true;
  } catch {
    jsonValid = false;
  }
  return {
    thinking,
    maxTokens,
    status: response.status,
    finishReason: body.choices?.[0]?.finish_reason ?? null,
    reasoningTokens: body.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    completionTokens: body.usage?.completion_tokens ?? null,
    contentChars: content.length,
    durationMs,
    jsonValid,
    note: "",
  };
}

function row(label: string, result: CallResult): string {
  return [
    label.padEnd(11),
    (result.thinking ? "on" : "off").padEnd(6),
    String(result.maxTokens).padStart(6),
    String(result.status).padStart(4),
    String(result.finishReason ?? "-").padEnd(8),
    String(result.reasoningTokens ?? "-").padStart(8),
    String(result.completionTokens ?? "-").padStart(9),
    String(result.contentChars).padStart(8),
    String(result.durationMs).padStart(7),
    result.jsonValid ? "y" : "n",
    result.note,
  ].join(" | ");
}

function headerLine(): string {
  return [
    "call".padEnd(11),
    "think".padEnd(6),
    "tokens",
    "code",
    "finish".padEnd(8),
    "reasn".padStart(8),
    "compl".padStart(9),
    "chars".padStart(8),
    "ms".padStart(7),
    "json",
  ].join(" | ");
}

/** Real passages for the scenario: hybrid search under the library user's JWT. */
async function scenarioChunks(): Promise<RetrievedChunk[]> {
  const url = process.env["SUPABASE_URL"] ?? process.env["VITE_SUPABASE_URL"] ?? "";
  const key =
    process.env["SUPABASE_PUBLISHABLE_KEY"] ?? process.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ?? "";
  const email = process.env["LIBRARY_USER_EMAIL"];
  const password = process.env["LIBRARY_USER_PASSWORD"];
  if (!url || !key || !email || !password) return [];

  const client = createClient(url, key, { auth: { persistSession: false } });
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) {
    console.log(`[calibrate] sign-in failed: ${signIn.error.message}`);
    return [];
  }

  const embed = (query: string) => embedQuery(query, { apiKey: apiKey as string, baseUrl });
  const seen = new Map<string, RetrievedChunk>();
  for (const query of [
    "IndiGo Airlines crew operations integration",
    "InterGlobe Hotels procurement marketplace",
    "Movin logistics luggage",
  ]) {
    try {
      const found = await searchLibraryChunks(client, query, {}, 4, embed);
      for (const chunk of found) {
        if (!seen.has(chunk.chunkId)) seen.set(chunk.chunkId, chunk);
      }
    } catch (error) {
      console.log(`[calibrate] search failed for "${query}": ${String(error).slice(0, 140)}`);
    }
  }
  return [...seen.values()].slice(0, 6);
}

async function main(): Promise<void> {
  const chunks = await scenarioChunks();
  console.log(`[calibrate] passages: ${chunks.length}`);
  for (const chunk of chunks) {
    console.log(`  - ${chunk.customerName ?? "industry-wide"} · ${chunk.title}`);
  }

  const provider = { apiKey: apiKey as string, baseUrl };
  const brief = await buildExportBrief(DRAFT, HISTORY, {
    ...provider,
    log: (event, meta) => {
      if (event !== "llm call") console.log(`[calibrate] brief ${event}`, meta);
    },
  });
  const planned = await planOutline(brief, DRAFT, provider);
  const plans = plansFromOutline({ ...DRAFT, outline: planned.plans.map((p) => p.title) }, brief);
  const plan: SectionPlan = plans.find((candidate) => candidate.kind === "proof") ??
    plans[0] ?? {
      id: "proof",
      kind: "proof",
      title: "Proof",
      goal: "Show evidence.",
      query: "IndiGo proof",
      minChars: 70,
      wantsNumbers: true,
    };

  console.log(`[calibrate] brief title: ${brief.documentTitle}`);
  console.log(`[calibrate] parties: ${(brief.partiesInvolved ?? []).join(" | ") || "none"}`);

  const prompts: { label: string; messages: { role: "system" | "user"; content: string }[] }[] = [
    {
      label: "BRIEF",
      messages: [
        { role: "system", content: BRIEF_SYSTEM },
        { role: "user", content: briefUserPrompt(DRAFT, HISTORY, transcriptOf(HISTORY)) },
      ],
    },
    {
      label: "OUTLINE",
      messages: [
        { role: "system", content: OUTLINE_SYSTEM },
        { role: "user", content: outlineUserPrompt(brief, DRAFT) },
      ],
    },
    {
      label: "SECTION",
      messages: [
        { role: "system", content: SECTION_SYSTEM },
        { role: "user", content: sectionUserPrompt(plan, brief, chunks, []) },
      ],
    },
  ];

  console.log(`\n${headerLine()}`);
  const results: Record<string, CallResult[]> = {};
  for (const prompt of prompts) {
    results[prompt.label] = [];
    const temperature = prompt.label === "SECTION" ? 0.25 : prompt.label === "OUTLINE" ? 0.2 : 0.1;
    for (const maxTokens of [4000, 8000, 16000]) {
      const result = await rawCall(prompt.messages, maxTokens, true, temperature);
      results[prompt.label]?.push(result);
      console.log(row(prompt.label, result));
    }
    const off = await rawCall(prompt.messages, 4000, false, temperature);
    results[prompt.label]?.push(off);
    console.log(row(`${prompt.label} OFF`, off));
  }

  console.log("\nRecommended defaults (~2x the largest observed reasoning + output):");
  for (const [label, rows] of Object.entries(results)) {
    const largest = Math.max(
      0,
      ...rows
        .filter((entry) => entry.thinking && entry.status === 200)
        .map((entry) => entry.completionTokens ?? 0),
    );
    // completion_tokens already includes reasoning tokens.
    const value = Math.min(
      maxTokensCeiling(),
      Math.max(THINKING_FLOOR_TOKENS, Math.ceil((largest * 2) / 1000) * 1000),
    );
    const budget = llmBudget(label as "BRIEF" | "OUTLINE" | "SECTION");
    console.log(
      `${label.padEnd(8)} observed max ${String(largest).padStart(6)} -> DOC_MAX_TOKENS_${label}=${value}` +
        ` (thinking ${budget.thinking ? "on" : "off"}; default ${budget.maxTokens})`,
    );
  }

  const rejected = Object.values(results)
    .flat()
    .some((entry) => entry.status === 400 && /max_tokens|context length/i.test(entry.note));
  console.log(
    `\nCeiling check: ${rejected ? "provider rejected a large max_tokens (400)" : "no 400 at 16000 tokens"}; DOC_MAX_TOKENS_CEILING=${maxTokensCeiling()}`,
  );
}

await main();

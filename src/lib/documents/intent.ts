/**
 * Turns a chat message plus the composer's context into a document draft.
 * Pure: no model, no database, so the confirmation card can be shown instantly
 * and the rules can be tested without a browser or a provider.
 *
 * Detection is deliberately conservative — a build verb *and* a format word —
 * so a question about a deck never turns into a generated file.
 */
import { PERSONAS, type ChatContext } from "../chat/scope";
import {
  DOCUMENT_FORMATS,
  type DocumentDraft,
  type DocumentMode,
  type DocumentType,
} from "./types";

const CREATE_VERB =
  /\b(create|generate|make|build|draft|prepare|produce|write|assemble|put together)\b/i;

/** Explicit formats first, so "a pdf deck" resolves to PDF, not PowerPoint. */
const FORMAT_HINTS: { type: DocumentType; pattern: RegExp }[] = [
  {
    type: "pdf",
    pattern:
      /\bpdf\b|\bone[- ]?pager\b|\bdata ?sheet\b|\bleave[- ]?behind\b|\bflyer\b|\bbrochure\b/i,
  },
  {
    type: "pptx",
    pattern:
      /\bpptx?\b|\bpowerpoint\b|\bpitch deck\b|\bdeck\b|\bslides?\b|\bpresentation\b|\bcapabilities deck\b/i,
  },
  {
    type: "docx",
    pattern: /\bdocx?\b|\bword\b|\bproposal\b|\bmemo\b|\bbrief\b|\bwrite[- ]?up\b|\breport\b/i,
  },
];

export function detectDocumentType(text: string): DocumentType | null {
  if (!CREATE_VERB.test(text)) return null;
  for (const hint of FORMAT_HINTS) {
    if (hint.pattern.test(text)) return hint.type;
  }
  return null;
}

/**
 * No outline card between an explicit request and generation. The composer's
 * hint only prefills text, so a document still starts solely from a user
 * request; the deck planner owns the storyline instead of a preview outline.
 */
export const SHOW_EXPORT_CONFIRM = false;

/**
 * A document is only ever built when the user asks for one in so many words.
 * Naming a deck in a question ("what points were in the Zurich proposal deck?")
 * is not a request; a request needs an imperative verb *and* a target format.
 */
export type ExportIntent = { type: DocumentType; mode: DocumentMode };

/** Imperatives that can start a build request, including phrasal forms. */
const REQUEST_VERB =
  /\b(create|make|generate|build|prepare|draft|put together|export|give me|turn (?:this|that|it) into|turn (?:this|that|it) in to)\b/i;

/** Verbs that make a request explicit even when it ends with a question mark. */
const LEADING_VERB =
  /^\s*(?:please\s+|could you\s+|can you\s+|would you\s+|i(?:'d| would)\s+like (?:you to\s+)?)?(create|make|generate|build|prepare|draft|put together|export|give me)\b/i;

/** Question and summary openings: asking *about* a deck is not asking for one. */
const QUESTION_FORM =
  /^\s*(?:what|which|how|why|who|when|where|explain|summari[sz]e|summary|tell me|describe|list|show me|is|are|was|were|does|do|did|could you tell|remind me)\b/i;

/** "what points were in it" style questions, whatever the opening word. */
const SUMMARY_FORM = /\b(summary|summari[sz]e|overview|recap|highlights|key points|takeaways)\b/i;

const FORMAT_NOUN = /\b(deck|ppt|pptx|powerpoint|slides?|pitch|proposal|pdf|document|docx|word)\b/i;
/** "turn this into one", "export it": the target lived in the previous turn. */
const ANAPHOR = /\b(this|that|it|these|those|them)\b/i;

/** deck/ppt/slides/pitch -> pptx; pdf -> pdf; proposal/document/word -> docx. */
function formatOf(text: string): ExportIntent {
  const deckish = /\b(deck|ppt|pptx|powerpoint|slides?|pitch)\b/i.test(text);
  const proposalish = /\bproposal\b/i.test(text);
  if (/\bpdf\b/i.test(text)) return { type: "pdf", mode: "proposal" };
  if (proposalish && deckish) return { type: "pptx", mode: "proposal" };
  if (/\b(docx|word(?:\s+doc(?:ument)?)?|document)\b/i.test(text)) {
    return { type: "docx", mode: "proposal" };
  }
  if (deckish) return { type: "pptx", mode: "pitch" };
  if (proposalish) return { type: "docx", mode: "proposal" };
  return { type: "docx", mode: "proposal" };
}

/**
 * Deterministic export-intent detection: imperative/request verb plus a target
 * noun in the same message. No model call, so it cannot drift between turns.
 */
export function detectExportIntent(
  message: string,
  history: readonly { role: "user" | "assistant"; content: string }[] = [],
): ExportIntent | null {
  const text = message.trim();
  if (text.length < 2) return null;

  // A question about a document is never a request for one.
  if (QUESTION_FORM.test(text) || SUMMARY_FORM.test(text)) return null;
  if (/\?\s*$/.test(text) && !LEADING_VERB.test(text)) return null;
  if (!REQUEST_VERB.test(text)) return null;

  if (FORMAT_NOUN.test(text)) return formatOf(text);

  // Anaphoric continuation: "turn this into a deck" already names the floor;
  // "export it" is only a request when the previous user turn asked for a
  // document, so a bare "do it" can never start a generation.
  if (ANAPHOR.test(text)) {
    const previous = [...history].reverse().find((entry) => entry.role === "user");
    if (previous && REQUEST_VERB.test(previous.content) && FORMAT_NOUN.test(previous.content)) {
      return formatOf(previous.content);
    }
  }
  return null;
}

type Subject = { industry: string | null; sector: string | null; audience: string | null };

/** The outline the user agrees to; the model may refine it during generation. */
export function outlineFor(type: DocumentType, subject: Subject): string[] {
  const industry = subject.industry ?? "the market";
  switch (type) {
    case "pptx":
      return [
        `Why ${industry} needs this now`,
        "Our point of view",
        "What we deliver",
        "Proof points from the library",
        subject.audience ? `Value to the ${subject.audience}` : "Commercial value",
        "How an engagement starts",
        "Next steps",
      ];
    case "pdf":
      return [
        "Executive summary",
        `The ${industry} challenge`,
        "Our approach",
        "Outcomes delivered",
        "Next steps",
      ];
    default:
      return [
        "Purpose",
        "Context",
        "Recommended approach",
        "Evidence from the library",
        "Risks and mitigations",
        "Next steps",
      ];
  }
}

export function buildDraft(input: {
  prompt: string;
  type: DocumentType;
  context: ChatContext;
  industryNames?: Record<string, string>;
}): DocumentDraft {
  const names = input.industryNames ?? {};
  const industrySlug = input.context.industries[0] ?? null;
  const industry = industrySlug ? (names[industrySlug] ?? industrySlug) : null;
  const client = input.context.clients[0] ?? null;
  const sector = input.context.sectors[0] ?? null;
  // An explicit "aimed at the CIO" beats an empty persona pill, but a picked
  // persona always wins.
  const spoken =
    PERSONAS.find((persona) => input.prompt.toLowerCase().includes(persona.toLowerCase())) ?? null;
  const audience = input.context.personas[0] ?? spoken;

  const { noun, label } = DOCUMENT_FORMATS[input.type];
  const subject = client ?? industry ?? sector ?? "Solution Hub";
  const title = client
    ? `${client} — ${noun}`
    : industry
      ? `${industry} ${noun}`
      : `${subject} ${noun}`;

  const qualifiers = [
    audience ? `for ${audience}` : null,
    sector && sector !== subject ? sector : null,
  ].filter((value): value is string => Boolean(value));
  const subtitle =
    qualifiers.length > 0
      ? `${label} · ${qualifiers.join(" · ")}`
      : `${label} built from the Solution Hub library`;

  return {
    type: input.type,
    mode: input.type === "pptx" ? "pitch" : "proposal",
    title,
    subtitle,
    audience,
    industry,
    industrySlug,
    client,
    sector,
    outline: outlineFor(input.type, { industry, sector, audience }),
    prompt: input.prompt.slice(0, 500),
  };
}

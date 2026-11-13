/**
 * Turns a chat message plus the composer's context into a document draft.
 * Pure: no model, no database, so the confirmation card can be shown instantly
 * and the rules can be tested without a browser or a provider.
 *
 * Detection is deliberately conservative — a build verb *and* a format word —
 * so a question about a deck never turns into a generated file.
 */
import { PERSONAS, type ChatContext } from "../chat/scope";
import { DOCUMENT_FORMATS, type DocumentDraft, type DocumentType } from "./types";

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

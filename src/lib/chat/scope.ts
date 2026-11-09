/**
 * Chat context: the filters and hints a user can attach to a question before
 * retrieval runs. Kept pure so the query-shaping rules can be tested without a
 * browser or a database.
 *
 * Retrieval's database function takes one industry and one customer, so a
 * filter is only applied when exactly one value is picked; with several picks
 * the names join the search text instead of silently narrowing to the first.
 */

export type ChatContext = {
  clients: string[];
  personas: string[];
  industries: string[];
  sectors: string[];
  website: string;
};

export const EMPTY_CONTEXT: ChatContext = {
  clients: [],
  personas: [],
  industries: [],
  sectors: [],
  website: "",
};

export const PERSONAS = [
  "CIO / CTO",
  "VP Engineering",
  "Head of Operations",
  "Procurement",
  "Business unit lead",
] as const;

export const SECTORS = [
  "Payments",
  "Lending",
  "Wealth & asset management",
  "Insurance claims",
  "Supply chain",
  "Customer service",
  "Field operations",
  "Data & AI",
] as const;

/** A scope the retrieval function understands: at most one industry/customer. */
export type RetrievalFilter = { industry?: string; customer?: string };

/** Upper bound on scoped searches for one question; keeps latency predictable. */
export const MAX_RETRIEVAL_SCOPES = 8;

/**
 * Splits the picked context into the single-value filters retrieval can apply
 * and the free-text hints that are appended to the search query.
 */
export function retrievalInputs(context: ChatContext): {
  filter: RetrievalFilter;
  hints: string[];
} {
  const filter: RetrievalFilter = {};
  const hints: string[] = [];

  if (context.industries.length === 1) {
    const [industry] = context.industries;
    if (industry) filter.industry = industry;
  } else {
    hints.push(...context.industries);
  }

  if (context.clients.length === 1) {
    const [client] = context.clients;
    if (client) filter.customer = client;
  } else {
    hints.push(...context.clients);
  }

  hints.push(...context.personas, ...context.sectors);
  const website = normaliseWebsite(context.website);
  if (website) hints.push(website);

  return { filter, hints };
}

/**
 * Every (industry, company) pair worth searching. The database function filters
 * by one industry and one company, so multi-select becomes several scoped
 * searches that are merged, instead of silently narrowing to the first pick.
 */
export function retrievalScopes(context: ChatContext): RetrievalFilter[] {
  const industries = [...new Set(context.industries.filter(Boolean))];
  const clients = [...new Set(context.clients.filter(Boolean))];

  if (industries.length === 0 && clients.length === 0) return [{}];
  if (clients.length === 0) {
    return industries.map((industry) => ({ industry })).slice(0, MAX_RETRIEVAL_SCOPES);
  }
  if (industries.length === 0) {
    return clients.map((customer) => ({ customer })).slice(0, MAX_RETRIEVAL_SCOPES);
  }

  const scopes: RetrievalFilter[] = [];
  for (const industry of industries) {
    for (const customer of clients) {
      scopes.push({ industry, customer });
      if (scopes.length >= MAX_RETRIEVAL_SCOPES) return scopes;
    }
  }
  return scopes;
}

/** The text actually embedded for retrieval: the question, then any hints. */
export function buildRetrievalQuery(question: string, context: ChatContext): string {
  const { hints } = retrievalInputs(context);
  const trimmed = question.trim();
  if (hints.length === 0) return trimmed;
  return `${trimmed}\nContext: ${hints.join(", ")}`;
}

/** Drops the scheme, trailing slash and leading www. so a paste stays short. */
export function normaliseWebsite(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";
  return trimmed
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

/** Quiet client-side check only — it never blocks sending a question. */
export function isValidWebsite(value: string): boolean {
  const normalised = normaliseWebsite(value);
  return /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+(\/[^\s]*)?$/.test(normalised);
}

export function contextSummary(
  context: ChatContext,
  industryNames: Record<string, string> = {},
): string[] {
  return [
    ...context.clients,
    ...context.personas,
    ...context.industries.map((slug) => industryNames[slug] ?? slug),
    ...context.sectors,
    normaliseWebsite(context.website),
  ].filter(Boolean);
}

export type ExampleCard = {
  kind: "deck" | "question";
  label: string;
  prompt: string;
};

/**
 * Four starting points: two deck requests and two questions. They follow the
 * live context so the examples stay relevant to what the user has selected.
 */
export function examplePrompts(
  context: ChatContext,
  names: { industries?: string[]; clients?: string[] } = {},
): ExampleCard[] {
  const industry = context.industries.length
    ? (names.industries?.[0] ?? context.industries[0])
    : undefined;
  const client = context.clients.length ? (names.clients?.[0] ?? context.clients[0]) : undefined;
  const audience = context.personas[0];

  const scopeLabel = [client, industry].filter(Boolean).join(" · ");
  const sector = context.sectors[0];

  return [
    {
      kind: "deck",
      label: scopeLabel ? `Pitch deck for ${scopeLabel}` : "Pitch deck from our best case studies",
      prompt: `Build a pitch deck${scopeLabel ? ` for ${scopeLabel}` : ""}${
        audience ? ` aimed at ${audience}` : ""
      } from our library content.`,
    },
    {
      kind: "deck",
      label: sector ? `Capabilities deck for ${sector}` : "Capabilities deck for a new client",
      prompt: `Build a capabilities deck${sector ? ` for ${sector} clients` : ""} using our library.`,
    },
    {
      kind: "question",
      label: industry
        ? `What have we delivered in ${industry}?`
        : "What have we delivered recently?",
      prompt: industry
        ? `What have we delivered in ${industry}? Summarise the outcomes with sources.`
        : "What have we delivered recently? Summarise the outcomes with sources.",
    },
    {
      kind: "question",
      label: client ? `What is the ${client} story?` : "Where do we have measurable impact?",
      prompt: client
        ? `What is the ${client} story? What problem did we solve and what changed?`
        : "Where do we have measurable impact? Summarise the proof points with sources.",
    },
  ];
}

/** First user line, trimmed to a sidebar-sized title. */
export function titleFromQuestion(question: string): string {
  const line = question.trim().replace(/\s+/g, " ");
  if (line.length <= 48) return line;
  return `${line.slice(0, 47).trimEnd()}…`;
}

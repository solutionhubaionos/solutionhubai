/**
 * The persistent scope of one conversation: the industries and companies the
 * user picked in the wizard. It lives with the conversation (server-side) and
 * is loaded on every turn, so retrieval and exports follow the same selection
 * after a reload, a new message or a later session of the same conversation.
 *
 * Pure functions only, so the rules can be tested without a browser or a
 * database. An industry selected with no companies picked means the whole
 * industry is in scope.
 */
import {
  EMPTY_CONTEXT,
  MAX_RETRIEVAL_SCOPES,
  type ChatContext,
  type RetrievalFilter,
} from "./scope";

export type ScopeCompany = {
  /** content/customer row id when known, else null. */
  id: string | null;
  canonicalName: string;
  /** Industry slug or name the company was picked under. */
  industry: string | null;
};

/**
 * The client being pitched. This is NOT an evidence scope: its name is never a
 * retrieval filter. It shapes how the deck looks and gives retrieval a topical
 * hint (industry, and what the client does from the scraped page).
 */
export type TargetLogo = {
  dataUrl: string;
  /** Logo opaque pixels are mostly light, so it sits on navy without a panel. */
  light: boolean;
  /** width / height, so a renderer keeps its proportions. */
  aspect: number;
};

export type TargetClient = {
  name: string;
  websiteUrl: string | null;
  /** The client's detected logo, extracted from its website. Never recoloured. */
  logo: TargetLogo | null;
  /** The client's own words about itself from its homepage, for grounding. */
  siteText: string | null;
  industry: string | null;
  /** External decks say "a leading European airport operator" by default. */
  anonymise: boolean;
  /** Opt-in: also use the library's own material about this client. */
  includePriorWork: boolean;
  notes: string;
};

export type ConversationScope = {
  /** Industry slugs as the wizard stores them (keys of the industries table). */
  industries: string[];
  /** Evidence companies (existing library customers), never the target client. */
  companies: ScopeCompany[];
  /** Index 0 is the primary target; more than one is a multi-party pitch. */
  targetClients: TargetClient[];
  /** ISO timestamp of the last edit; null for a conversation that never had one. */
  updatedAt: string | null;
};

export const EMPTY_SCOPE: ConversationScope = {
  industries: [],
  companies: [],
  targetClients: [],
  updatedAt: null,
};

export function isEmptyScope(scope: ConversationScope | null | undefined): boolean {
  return (
    !scope ||
    (scope.industries.length === 0 &&
      scope.companies.length === 0 &&
      (scope.targetClients ?? []).length === 0)
  );
}

/** Trimmed, de-duplicated (case-insensitive) string list. */
function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * Accepts whatever a client or an old row sends and returns a valid scope.
 * Unknown shapes collapse to an empty scope rather than throwing, so a chat is
 * never blocked by a malformed scope.
 */
/** Accepts whatever a client or an old row sends, or null when unusable. */
export function normalizeTargetClient(value: unknown): TargetClient | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const name = typeof record["name"] === "string" ? record["name"].trim() : "";
  if (!name) return null;
  const text = (key: string, limit: number) =>
    typeof record[key] === "string" ? (record[key] as string).trim().slice(0, limit) : null;
  const rawLogo = record["logo"];
  const logo =
    rawLogo && typeof rawLogo === "object"
      ? (() => {
          const entry = rawLogo as Record<string, unknown>;
          const dataUrl = typeof entry["dataUrl"] === "string" ? entry["dataUrl"] : "";
          if (!dataUrl.startsWith("data:image/")) return null;
          return {
            dataUrl,
            light: entry["light"] === true,
            aspect: typeof entry["aspect"] === "number" && entry["aspect"] > 0 ? entry["aspect"] : 3,
          };
        })()
      : null;
  return {
    name: name.slice(0, 120),
    websiteUrl: text("websiteUrl", 500),
    logo,
    siteText: text("siteText", 2000),
    industry: text("industry", 80),
    anonymise: record["anonymise"] !== false,
    includePriorWork: record["includePriorWork"] === true,
    notes: typeof record["notes"] === "string" ? record["notes"].slice(0, 1000) : "",
  };
}

/**
 * Stores the target client's website on the primary target. The URL is kept so
 * a later export can ground the deck on it and detect the client's logo.
 */
export function withPrimaryTargetWebsite(
  scope: ConversationScope,
  websiteUrl: string,
): ConversationScope {
  const [primary, ...rest] = scope.targetClients;
  if (!primary) return scope;
  return {
    ...scope,
    targetClients: [{ ...primary, websiteUrl }, ...rest],
  };
}

/** Stores the detected logo and homepage text on the primary target. */
export function withPrimaryTargetInfo(
  scope: ConversationScope,
  info: { logo?: TargetLogo | null; siteText?: string | null },
): ConversationScope {
  const [primary, ...rest] = scope.targetClients;
  if (!primary) return scope;
  return {
    ...scope,
    targetClients: [
      {
        ...primary,
        ...(info.logo !== undefined ? { logo: info.logo } : {}),
        ...(info.siteText !== undefined ? { siteText: info.siteText } : {}),
      },
      ...rest,
    ],
  };
}

/**
 * Puts the just-selected clients first, so the newest pick is the primary
 * target. Previously chosen clients that were not re-selected stay behind as
 * co-pitch parties. This is the fix for "a new client was ignored": generation
 * always reads index 0, and the new pick now lands there.
 */
export function reorderTargetClients(
  existing: readonly TargetClient[],
  selected: readonly TargetClient[],
): TargetClient[] {
  const selectedKeys = new Set(selected.map((client) => client.name.toLowerCase()));
  return [
    ...selected,
    ...existing.filter((client) => !selectedKeys.has(client.name.toLowerCase())),
  ].slice(0, 6);
}

/**
 * Sets the primary target's name from the composer input. Creates a target when
 * none exists yet, filing it under the first selected sector.
 */
export function withPrimaryTargetName(scope: ConversationScope, name: string): ConversationScope {
  const trimmed = name.trim().slice(0, 120);
  const [primary, ...rest] = scope.targetClients;
  if (primary) {
    if (!trimmed || trimmed === primary.name) return scope;
    return { ...scope, targetClients: [{ ...primary, name: trimmed }, ...rest] };
  }
  if (!trimmed) return scope;
  return {
    ...scope,
    targetClients: [
      {
        name: trimmed,
        websiteUrl: null,
        logo: null,
        siteText: null,
        industry: scope.industries[0] ?? null,
        anonymise: true,
        includePriorWork: false,
        notes: "",
      },
    ],
  };
}

export function normalizeTargetClients(value: unknown): TargetClient[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const clients: TargetClient[] = [];
  for (const entry of value) {
    const client = normalizeTargetClient(entry);
    const key = client?.name.toLowerCase();
    if (!client || !key || seen.has(key)) continue;
    seen.add(key);
    clients.push(client);
  }
  return clients.slice(0, 6);
}

export function normalizeScope(value: unknown): ConversationScope {
  if (!value || typeof value !== "object") return EMPTY_SCOPE;
  const record = value as Record<string, unknown>;
  const industries = Array.isArray(record["industries"])
    ? uniqueStrings(record["industries"].filter((item): item is string => typeof item === "string"))
    : [];
  const companies: ScopeCompany[] = [];
  const seen = new Set<string>();
  if (Array.isArray(record["companies"])) {
    for (const entry of record["companies"]) {
      if (!entry || typeof entry !== "object") continue;
      const company = entry as Record<string, unknown>;
      const name =
        typeof company["canonicalName"] === "string"
          ? company["canonicalName"].trim()
          : typeof company["name"] === "string"
            ? (company["name"] as string).trim()
            : "";
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      companies.push({
        id: typeof company["id"] === "string" ? company["id"] : null,
        canonicalName: name,
        industry: typeof company["industry"] === "string" ? company["industry"] : null,
      });
    }
  }
  const updatedAt = typeof record["updatedAt"] === "string" ? record["updatedAt"] : null;
  return {
    industries,
    companies,
    targetClients: normalizeTargetClients(record["targetClients"]),
    updatedAt,
  };
}

/** Company names in scope, in selection order. */
export function scopeCompanyNames(scope: ConversationScope): string[] {
  return scope.companies.map((company) => company.canonicalName);
}

/**
 * The wizard's `ChatContext` form of a scope, so drafts and example prompts can
 * be built from it without a second code path.
 */
export function contextFromScope(
  scope: ConversationScope,
  rest: Partial<ChatContext> = {},
): ChatContext {
  return {
    ...EMPTY_CONTEXT,
    ...rest,
    industries: uniqueStrings([...scope.industries, ...(rest.industries ?? [])]),
    clients: uniqueStrings([...scopeCompanyNames(scope), ...(rest.clients ?? [])]),
    targetClients: targetHints(scope),
    anonymise: (scope.targetClients ?? []).some((client) => client.anonymise),
  };
}

/** The target's topical hints only: never an evidence filter or a customer name. */
export function targetHints(scope: ConversationScope): ChatContext["targetClients"] {
  return (scope.targetClients ?? []).map((client) => ({
    name: client.name,
    industry: client.industry,
    websiteUrl: client.websiteUrl,
    description: null,
    includePriorWork: client.includePriorWork,
  }));
}

/** Union of a stored scope and the client's live context, used while editing. */
export function mergeScopeWithContext(
  scope: ConversationScope,
  context: ChatContext,
  updatedAt: string | null = scope.updatedAt,
): ConversationScope {
  const companies: ScopeCompany[] = [...scope.companies];
  const seen = new Set(companies.map((company) => company.canonicalName.toLowerCase()));
  for (const name of context.clients) {
    const key = name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    companies.push({ id: null, canonicalName: name.trim(), industry: null });
  }
  return {
    industries: uniqueStrings([...scope.industries, ...context.industries]),
    companies,
    targetClients: scope.targetClients ?? [],
    updatedAt,
  };
}

/**
 * One line for the prompt and the scope pill: industries (as labels) and the
 * company names. Empty for a conversation that never picked anything, which is
 * how unscoped conversations keep behaving exactly as before.
 */
export function scopePromptLine(
  scope: ConversationScope,
  industryNames: Record<string, string> = {},
): string {
  // A target client on its own still needs the prompt: it is the reason the
  // answer must be framed as evidence from other customers.
  if (isEmptyScope(scope) && (scope.targetClients ?? []).length === 0) return "";
  const industries = scope.industries.map((slug) => industryNames[slug] ?? slug);
  const companies = scopeCompanyNames(scope);
  const owning = companies.length > 0 ? companies.join(", ") : "";
  const lines: string[] = [];
  if (industries.length > 0 || owning) {
    lines.push(
      `Evidence scope: ${[industries.join(", "), owning].filter(Boolean).join(" · ")}. Do not search the library for the target client's name: these are the customers whose work supplies the evidence. Resolve unnamed references (e.g. "the proposal", "their data") within this scope.`,
    );
  }
  if ((scope.targetClients ?? []).length > 0) {
    lines.push(targetClientLine(scope));
  }
  return lines.join("\n");
}

/**
 * How the model is told about the pitch target. Spelling out that a new client
 * is normally absent from the library is what stops "the library has nothing on
 * Zurich" answers.
 */
export function targetClientLine(scope: ConversationScope): string {
  const targets = scope.targetClients ?? [];
  const names = targets.map((client) => client.name);
  if (names.length === 0) return "";
  const industries = [...new Set(targets.map((client) => client.industry).filter(Boolean))];
  return [
    `Pitch target: ${names.join(", ")}. We are pitching TO this client, so the library normally holds nothing ABOUT them; never say the library has nothing on ${names[0]}. Build the case from evidence about other customers${industries.length > 0 ? ` in ${industries.join(", ")}` : ""} and say which customers that evidence comes from.`,
    targets.some((client) => client.anonymise)
      ? "Refer to the evidence customers generically (for example 'a leading European airport operator') unless the user asks for names."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** True when at least one target asks for anonymised evidence customers. */
export function anonymiseCustomers(scope: ConversationScope | undefined): boolean {
  return Boolean(scope?.targetClients?.some((client) => client.anonymise));
}

/** Display labels for every sector in scope (industry slug -> name when known). */
export function scopeIndustryLabels(
  scope: ConversationScope | undefined,
  industryNames: Record<string, string> = {},
): string[] {
  if (!scope) return [];
  return uniqueStrings(scope.industries.map((slug) => industryNames[slug] ?? slug));
}

/** Labels for the pill row: industries first, then companies, de-duplicated. */
export function scopePillLabels(
  scope: ConversationScope,
  industryNames: Record<string, string> = {},
): string[] {
  return uniqueStrings([
    ...scope.industries.map((slug) => industryNames[slug] ?? slug),
    ...scopeCompanyNames(scope),
  ]);
}

/**
 * True when the conversation named an organisation the user did not select.
 * Retrieval still covers it (never block a question), and the answer says so.
 */
export function outsideScopeEntities(named: readonly string[], scope: ConversationScope): string[] {
  if (isEmptyScope(scope)) return [];
  const inScope = new Set(scopeCompanyNames(scope).map((name) => name.toLowerCase()));
  return uniqueStrings(
    named.filter((name) => {
      const key = name.toLowerCase();
      // A name that contains, or is contained by, a scoped company counts as
      // in scope ("IndiGo" vs "IndiGo Airlines").
      return ![...inScope].some((known) => known.includes(key) || key.includes(known));
    }),
  );
}

/** Appended to an answer that had to reach outside the scope. */
export function outsideScopeNote(names: readonly string[]): string {
  if (names.length === 0) return "";
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `_${list} isn't in your selected scope; added for this answer._`;
}

/**
 * Retrieval scopes for a conversation scope: one per selected company (its own
 * industry + customer filter), plus the whole remaining industries, so a
 * company's family of documents cannot crowd out a sector the user also picked.
 */
export function scopeRetrievalScopes(scope: ConversationScope): RetrievalFilter[] {
  const scopes: RetrievalFilter[] = [];
  const covered = new Set<string>();
  for (const company of scope.companies) {
    const industry = company.industry?.trim();
    scopes.push(
      industry
        ? { industry, customer: company.canonicalName }
        : { customer: company.canonicalName },
    );
    if (industry) covered.add(industry);
  }
  for (const industry of scope.industries) {
    if (covered.has(industry)) continue;
    scopes.push({ industry });
  }
  return scopes.slice(0, MAX_RETRIEVAL_SCOPES + 4);
}

/**
 * Party validation. A deck names companies, airports and institutions — not
 * concepts, capabilities or instructions that happened to appear in the brief.
 * The wizard selection and the evidence's own customer metadata are the strong
 * signals; free-form model strings are only accepted when they look like a
 * name and are corroborated by a passage.
 */
import type { RetrievedChunk } from "../../rag/search";
import type { ValidatedEntity } from "../../rag/entities";

const GENERIC = new Set([
  "platform",
  "platforms",
  "capability",
  "capabilities",
  "function",
  "functions",
  "service",
  "services",
  "solution",
  "solutions",
  "product",
  "products",
  "offering",
  "offerings",
  "portfolio",
  "market",
  "markets",
  "sector",
  "sectors",
  "industry",
  "industries",
  "model",
  "models",
  "partnership",
  "collaboration",
  "programme",
  "program",
  "opportunity",
  "proposition",
  "customer",
  "customers",
  "client",
  "clients",
  "data",
  "insight",
  "insights",
  "journey",
  "ecosystem",
  "network",
  "operations",
  "technology",
  "digital",
  "ai",
]);

const INSTRUCTION =
  /\b(?:create|build|make|write|draft|generate|prepare|include|add|remove|separate|produce|show|use|compare|explain|summarise|summarize|design|plan|propose|need|needs|want|wants|focus|highlight)\b/i;

/** A lower-case hyphenated phrase is a concept label, never a company. */
const CONCEPT_LIKE = /^[a-z][a-z0-9]*(?:[-/][a-z0-9]+)+$/;

function collapse(name: string): string {
  return name
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:."']+|[\s,;:."']+$/g, "")
    .trim();
}

export function normaliseEntityName(name: string): string {
  return collapse(name)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Accepts a party-shaped string. Wizard picks and evidence customer names are
 * trusted separately; this is the filter for model output.
 */
export function isValidPartyName(value: string): boolean {
  const name = collapse(value);
  if (name.length < 2 || name.length > 80) return false;
  const words = name.split(" ").filter(Boolean);
  if (words.length > 8) return false;
  if (/^\d/.test(name)) return false;
  if (CONCEPT_LIKE.test(name)) return false;
  if (INSTRUCTION.test(name)) return false;
  if (GENERIC.has(name.toLowerCase())) return false;
  if (words.every((word) => GENERIC.has(word.toLowerCase()))) return false;
  // A name has at least one capitalised token (Fly++ SPV, NK Proteins, IndiGo).
  return words.some((word) => /[A-Z]/.test(word)) || /^[A-Z0-9]/.test(name);
}

function addParty(list: string[], seen: Set<string>, value: string): void {
  const name = collapse(value);
  if (!isValidPartyName(name)) return;
  const key = normaliseEntityName(name);
  if (!key || seen.has(key)) return;
  seen.add(key);
  list.push(name);
}

/**
 * Wizard picks first, then the conversation/brief, then evidence metadata.
 *
 * When the entities table answered (`authoritative`), a string from the brief
 * or the conversation is only a *lookup* for a validated company or airport:
 * "Charts", "KPIs" and an invented "Adani Power" are dropped, and "Adani"
 * resolves to the canonical "Adani Airports". Without the table the older
 * name-shape filter applies, so a deck still builds before 0023 is applied.
 */
export function partyList(input: {
  wizardCompanies?: readonly string[];
  briefParties?: readonly string[];
  briefEntities?: readonly string[];
  conversationEntities?: readonly string[];
  evidenceNames?: readonly string[];
  /** Canonical rows from the entities table, when migration 0023 is applied. */
  validatedEntities?: readonly Pick<ValidatedEntity, "name" | "type">[];
  /** True when the entities table answered; validated names are the authority. */
  authoritative?: boolean;
  clientName?: string | null;
}): string[] {
  const parties: string[] = [];
  const seen = new Set<string>();
  const validated = input.validatedEntities ?? [];
  const concepts = new Set(
    validated
      .filter((entity) => entity.type === "concept")
      .map((entity) => normaliseEntityName(entity.name)),
  );
  const canonical = new Map<string, string>();
  for (const entity of validated) {
    if (entity.type === "concept") continue;
    const key = normaliseEntityName(entity.name);
    if (key) canonical.set(key, collapse(entity.name));
  }
  const authoritative = input.authoritative === true && canonical.size > 0;

  // A brief string is only a spelling of a validated party.
  const addKnown = (value: string) => {
    if (!authoritative) {
      addParty(parties, seen, value);
      return;
    }
    const key = normaliseEntityName(value);
    if (!key) return;
    const exact = canonical.get(key);
    if (exact) {
      addParty(parties, seen, exact);
      return;
    }
    const partial = [...canonical.entries()].find(
      ([candidate]) => candidate.length > 3 && (candidate.includes(key) || key.includes(candidate)),
    );
    if (partial) addParty(parties, seen, partial[1]);
  };

  // The wizard selection is the user's own choice; it is trusted as typed.
  for (const value of input.wizardCompanies ?? []) addParty(parties, seen, value);
  if (input.clientName) addKnown(input.clientName);
  for (const entity of validated) {
    if (entity.type !== "concept") addParty(parties, seen, entity.name);
  }
  for (const value of input.briefParties ?? []) addKnown(value);
  for (const value of input.conversationEntities ?? []) addKnown(value);
  for (const value of input.briefEntities ?? []) addKnown(value);
  // Evidence names are canonical customer names from the library.
  for (const value of input.evidenceNames ?? []) addKnown(value);
  return parties.filter((party) => !concepts.has(normaliseEntityName(party))).slice(0, 8);
}

/**
 * Keeps only the validated rows this document is actually about.
 *
 * `match_entities` is a trigram search, so asking about "Adani Airports" also
 * returns "Zurich Airport" and "Adani Power". A score cannot separate them: a
 * brief that lists the neighbour itself produces an exact match at 1.0. The
 * ground truth is the user's own words, so a row survives only when the request
 * names it (aliases included, which keeps a misspelt request working), the
 * wizard picked it, or it is the draft's client.
 */
export function groundedEntities<
  T extends { name: string; type: string; spellings?: readonly string[] },
>(input: {
  entities: readonly T[];
  requestText: string;
  wizardCompanies?: readonly string[];
  clientName?: string | null;
}): T[] {
  const request = normaliseEntityName(input.requestText);
  const mentioned = (value: string) => {
    const key = normaliseEntityName(value);
    return key.length >= 3 && request.includes(key);
  };
  const picks = (input.wizardCompanies ?? []).map(normaliseEntityName);
  const client = input.clientName ? normaliseEntityName(input.clientName) : "";
  return input.entities.filter((entity) => {
    const key = normaliseEntityName(entity.name);
    if (picks.includes(key) || (client !== "" && key === client)) return true;
    if (mentioned(entity.name)) return true;
    return (entity.spellings ?? []).some((spelling) => mentioned(spelling));
  });
}

/**
 * Which names retrieval may search. Once entity validation answered, only the
 * validated companies and airports drive searches: a company the brief invented
 * must not pull another customer's documents into the deck's evidence.
 */
export function retrievalEntityNames(input: {
  wizardCompanies?: readonly string[];
  clientName?: string | null;
  briefParties?: readonly string[];
  briefEntities?: readonly string[];
  conversationEntities?: readonly string[];
  validatedEntities?: readonly Pick<ValidatedEntity, "name" | "type">[];
  authoritative?: boolean;
}): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    const name = collapse(value);
    const key = normaliseEntityName(name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    names.push(name);
  };

  for (const value of input.wizardCompanies ?? []) push(value);
  if (input.clientName) push(input.clientName);
  if (input.authoritative === true && (input.validatedEntities ?? []).length > 0) {
    for (const entity of input.validatedEntities ?? []) {
      if (entity.type !== "concept") push(entity.name);
    }
  } else {
    for (const value of input.briefParties ?? []) push(value);
    for (const value of input.conversationEntities ?? []) push(value);
    for (const value of input.briefEntities ?? []) push(value);
    for (const entity of input.validatedEntities ?? []) {
      if (entity.type !== "concept") push(entity.name);
    }
  }
  return names.slice(0, 8);
}

/** The entity a passage belongs to, or null when it is generic evidence. */
export function entityForChunk(chunk: RetrievedChunk, parties: readonly string[]): string | null {
  const customer = normaliseEntityName(chunk.customerName ?? "");
  if (customer) {
    const exact = parties.find((party) => normaliseEntityName(party) === customer);
    if (exact) return exact;
    const partial = parties.find((party) => {
      const key = normaliseEntityName(party);
      return key.length > 3 && (customer.includes(key) || key.includes(customer));
    });
    if (partial) return partial;
  }
  const text = normaliseEntityName(`${chunk.title} ${chunk.heading ?? ""} ${chunk.content}`);
  const named = parties.find((party) => {
    const key = normaliseEntityName(party);
    return key.length > 3 && text.includes(key);
  });
  return named ?? null;
}

/** A short, client-facing description of what a party does in the evidence. */
export function roleForParty(party: string, chunks: readonly RetrievedChunk[]): string {
  const chunk = chunks[0];
  if (!chunk) return "Role and scope to agree together";
  const heading = chunk.heading?.replace(/\s+/g, " ").trim();
  if (heading && heading.length >= 4 && heading.length <= 60) return heading;
  const first = chunk.content
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)[0]
    ?.replace(
      /^[A-Z][A-Za-z0-9&.'’ -]{2,60}\s+(?:reduced|cut|moved|improved|consolidated|built|deployed|delivered)\b/,
      "Documented work",
    )
    .trim();
  return (first ?? "Role and scope to agree together").slice(0, 110);
}

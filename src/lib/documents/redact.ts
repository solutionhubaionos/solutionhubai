/**
 * Deterministic anonymisation of library customers for client-facing exports.
 * Prompt instructions are not a boundary: the model sees passages, titles and
 * file names, so names are removed before composition. The mapping back to the
 * real document stays in the trace/source audit only.
 */
import type { RetrievedChunk } from "../rag/search";

export type ReferenceName = {
  name: string;
  aliases?: readonly string[];
  industry?: string | null;
};

export type ReferenceDocument = {
  contentId: string;
  industry?: string | null;
  customerName?: string | null;
};

export type ReferenceRedactor = {
  /** Names replaced by neutral labels, for the author-facing lint pass. */
  entries: readonly { value: string; label: string }[];
  scrub: (text: string) => string;
  labelFor: (contentId: string, industry?: string | null) => string;
  scrubChunk: (chunk: RetrievedChunk) => RetrievedChunk;
};

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** A neutral descriptor that adds no region, size or claim of its own. */
export function neutralDescriptor(industry?: string | null): string {
  const value = (industry ?? "").toLowerCase().replace(/[_-]+/g, " ");
  if (/\bairlines?\b|\bairways?\b|\baviation\b/.test(value)) return "peer airline";
  if (/\bairports?\b/.test(value)) return "peer airport";
  if (/\bhotels?\b|\bhospitality\b/.test(value)) return "peer hotel group";
  if (/\bbanks?\b|\bbanking\b|\bfinancial\b/.test(value)) return "peer bank";
  if (/\btelco\b|\btelecom\b|\btelecommunications\b/.test(value)) return "peer telecoms operator";
  if (/\binsurance\b|\binsurer\b/.test(value)) return "peer insurer";
  if (/\bretail\b|\bcommerce\b/.test(value)) return "peer retailer";
  return "peer company";
}

function suffix(index: number): string {
  const base = LETTERS[index % LETTERS.length] ?? "A";
  return index < LETTERS.length ? base : `${base}${Math.floor(index / LETTERS.length)}`;
}

function comparable(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function patternTokens(value: string): string[] {
  return value
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
}

/** A name needs three alphanumerics to be distinctive enough to match safely. */
function distinctive(value: string): boolean {
  return (
    patternTokens(value)
      .join("")
      .replace(/[^A-Za-z0-9]/g, "").length >= 3
  );
}

/**
 * Separators are split before escaping: escaping first turns "booking.com" into
 * `booking\[[\s._-]+com`, whose lone `]` is a syntax error under the `u` flag.
 */
function patternFor(value: string): RegExp {
  const escaped = patternTokens(value).map(escapeLiteral).join("[\\s._-]+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?:(['’])s)?(?![\\p{L}\\p{N}])`, "giu");
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = comparable(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value.trim());
  }
  return out;
}

export function createReferenceRedactor(input: {
  references: readonly ReferenceName[];
  documents?: readonly ReferenceDocument[];
  /** Never anonymise the client the deck is addressed to. */
  targets?: readonly string[];
}): ReferenceRedactor {
  const targetKeys = new Set((input.targets ?? []).map(comparable).filter(Boolean));
  const isTarget = (value: string) => targetKeys.has(comparable(value));

  const references = input.references.filter((entry) => entry.name.trim() && !isTarget(entry.name));

  const byDescriptor = new Map<string, number>();
  const nameLabels = new Map<string, string>();
  const entries: { value: string; label: string }[] = [];
  const sortedNames = [...references].sort((a, b) => a.name.localeCompare(b.name));

  for (const reference of sortedNames) {
    const descriptor = neutralDescriptor(reference.industry);
    const index = byDescriptor.get(descriptor) ?? 0;
    byDescriptor.set(descriptor, index + 1);
    const label = `${descriptor} ${suffix(index)}`;
    for (const value of unique([reference.name, ...(reference.aliases ?? [])])) {
      if (isTarget(value)) continue;
      nameLabels.set(comparable(value), label);
      entries.push({ value, label });
    }
  }

  const documentLabels = new Map<string, string>();
  const documentCounts = new Map<string, number>();
  const documents = [...(input.documents ?? [])].sort((a, b) =>
    a.contentId.localeCompare(b.contentId),
  );
  for (const document of documents) {
    if (documentLabels.has(document.contentId)) continue;
    const descriptor = neutralDescriptor(document.industry);
    const index = documentCounts.get(descriptor) ?? 0;
    documentCounts.set(descriptor, index + 1);
    documentLabels.set(document.contentId, `${descriptor} ${suffix(index)}`);
  }

  const labelFor = (contentId: string, industry?: string | null): string => {
    const existing = documentLabels.get(contentId);
    if (existing) return existing;
    const created = `${neutralDescriptor(industry)} ${suffix(documentLabels.size)}`;
    documentLabels.set(contentId, created);
    return created;
  };

  // Longest first, so "Riyadh Air Cargo" wins over "Riyadh Air". Patterns are
  // built here once: a malformed name falls back to a literal instead of
  // throwing mid-export, and repeated chunks reuse the compiled patterns.
  type Rule = { value: string; label: string; pattern: RegExp | null };
  const rules: Rule[] = [...entries]
    .sort((a, b) => b.value.length - a.value.length)
    .flatMap((entry): Rule[] => {
      if (!distinctive(entry.value)) return [];
      const label = nameLabels.get(comparable(entry.value)) ?? entry.label;
      try {
        return [{ value: entry.value, label, pattern: patternFor(entry.value) }];
      } catch {
        try {
          return [
            { value: entry.value, label, pattern: new RegExp(escapeLiteral(entry.value), "giu") },
          ];
        } catch {
          return [{ value: entry.value, label, pattern: null }];
        }
      }
    });
  const scrub = (text: string): string => {
    let value = text;
    for (const rule of rules) {
      if (!rule.pattern) {
        value = value.split(rule.value).join(rule.label);
        continue;
      }
      value = value.replace(rule.pattern, (match, possessive: string | undefined) => {
        return possessive ? `${rule.label}’s` : rule.label;
      });
    }
    return value;
  };

  const scrubChunk = (chunk: RetrievedChunk): RetrievedChunk => {
    const label = labelFor(chunk.contentId, chunk.industry);
    return {
      ...chunk,
      title: `Prior engagement with ${label}`,
      heading: chunk.heading ? scrub(chunk.heading) : null,
      content: scrub(chunk.content),
      fileName: "",
      filePath: "",
      customerName: label,
      industry: neutralDescriptor(chunk.industry),
    };
  };

  return {
    entries: rules.map(({ value, label }) => ({ value, label })),
    scrub,
    labelFor,
    scrubChunk,
  };
}

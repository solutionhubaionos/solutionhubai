/**
 * VERIFY pass. Section generation runs with thinking on, which can drift: a
 * confident sentence can still contain a claim the passages never made. This
 * pass asks the model, once per section, to list claims that the cited passages
 * do not support, then removes the offending blocks in code.
 *
 * It is deliberately non-fatal. If the verifier fails, the deterministic
 * number/quote checks in validate.ts are still in force and the section ships.
 */
import { z } from "zod";
import type { Block, DocumentSection } from "./types";
import { blockText } from "./validate";
import { completeWithBudget, type ProviderOptions } from "./provider";
import { llmBudget } from "./llm-budget";

const MAX_PASSAGE_CHARS = 1_400;

const verifySchema = z.object({
  unsupported: z
    .array(
      z.object({
        claim: z
          .string()
          .trim()
          .min(3)
          .transform((value) => value.slice(0, 400)),
        // Advisory text: shorten it, never reject the whole verification.
        reason: z
          .string()
          .trim()
          .transform((value) => value.slice(0, 200))
          .optional(),
      }),
    )
    .max(20)
    .default([]),
});

const VERIFY_SYSTEM = [
  "You are a grounding auditor for a sales document.",
  "You receive the claims of one section and the numbered passages the section cites.",
  "List every claim that is not supported by those passages, word for word from the claims list.",
  "Treat as unsupported: outside knowledge, reputational claims, figures, counts, percentages, dates and prices the passages do not state, and any description of a company the passages do not make.",
  "Do not rewrite the section. Do not list a claim that the passages do support.",
  'Return JSON only: {"unsupported":[{"claim":"...","reason":"..."}]}. Use an empty list when everything is supported.',
].join(" ");

export type VerifyResult = {
  section: DocumentSection;
  unsupported: string[];
  warnings: string[];
};

function sourceIdsOf(block: Block): string[] {
  switch (block.type) {
    case "heading":
      return [];
    case "quote":
      return [block.source];
    case "metrics":
      return [...new Set([...block.sources, ...block.items.flatMap((item) => [item.source])])];
    case "timeline":
      return [...new Set([...block.sources, ...block.items.flatMap((item) => item.sources)])];
    default:
      return block.sources;
  }
}

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Unsupported claim strings that match a block's text, to remove it. */
function blocksForClaims(section: DocumentSection, claims: readonly string[]): Set<number> {
  const offenderBlocks = new Set<number>();
  for (const claim of claims) {
    const needle = normalise(claim);
    if (needle.length < 12) continue;
    section.blocks.forEach((block, index) => {
      if (block.type === "heading") return;
      if (normalise(blockText(block)).includes(needle)) offenderBlocks.add(index);
    });
  }
  return offenderBlocks;
}

/**
 * One budgeted VERIFY call. Errors propagate to the caller, which treats them
 * as "verification skipped" rather than a section failure.
 */
export async function verifySectionClaims(
  section: DocumentSection,
  chunksById: ReadonlyMap<string, string>,
  options: ProviderOptions,
  log: (event: string, meta: Record<string, unknown>) => void,
): Promise<VerifyResult> {
  if (section.flagged) return { section, unsupported: [], warnings: [] };
  const content = section.blocks.filter((block) => block.type !== "heading");
  if (content.length === 0) return { section, unsupported: [], warnings: [] };

  const passageIds = [...new Set(section.blocks.flatMap(sourceIdsOf))];
  const passages = passageIds
    .map((id) => {
      const text = chunksById.get(id);
      if (!text) return null;
      return `[${id}] ${text.replace(/\s+/g, " ").slice(0, MAX_PASSAGE_CHARS)}`;
    })
    .filter((value): value is string => value !== null);

  const claims = content.map((block, index) => `${index + 1}. ${blockText(block)}`).join("\n");

  const outcome = await completeWithBudget(
    [
      { role: "system", content: VERIFY_SYSTEM },
      {
        role: "user",
        content: [
          `Section: ${section.title}`,
          "",
          "Claims:",
          claims,
          "",
          "Cited passages:",
          passages.join("\n\n"),
          "",
          "Return JSON only.",
        ].join("\n"),
      },
    ],
    options,
    llmBudget("VERIFY"),
    0,
    { label: `${section.id}:verify` },
  );

  const parsed = verifySchema.parse(JSON.parse(extractJson(outcome.content)));
  const claimsFound = parsed.unsupported.map((entry) => entry.claim);
  if (claimsFound.length === 0) {
    return { section, unsupported: [], warnings: [] };
  }

  const indexes = blocksForClaims(section, claimsFound);
  const warnings: string[] = [];
  const kept = section.blocks.filter((block, index) => !indexes.has(index));
  const keptContent = kept.filter((block) => block.type !== "heading");
  const removed = section.blocks.length - kept.length;

  for (const claim of claimsFound.slice(0, 5)) {
    warnings.push(`VERIFY: unsupported claim flagged — "${claim.slice(0, 120)}"`);
  }

  log("section verified", {
    section: section.id,
    unsupported: claimsFound.length,
    removed,
  });

  // Removing every block would leave a hollow section; flag it instead so the
  // gate and the reader both see that verification failed.
  if (keptContent.length === 0) {
    return {
      section: { ...section, warnings: [...section.warnings, ...warnings] },
      unsupported: claimsFound,
      warnings,
    };
  }

  return {
    section: { ...section, blocks: kept, warnings: [...section.warnings, ...warnings] },
    unsupported: claimsFound,
    warnings,
  };
}

/** Tolerates a fenced or chatty verifier response. */
function extractJson(raw: string): string {
  const text = raw.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return '{"unsupported":[]}';
  return text.slice(start, end + 1);
}

// Lenient by design: the verifier only ever adds advisory value, so a verbose
// or slightly malformed response is filtered, never allowed to reject the whole
// audit. Rejecting it silently disabled verification (a >40-item list failed
// zod and the deck shipped unverified).
const deckVerifySchema = z.object({
  unsupported: z
    .array(z.unknown())
    .catch([])
    .transform((entries) =>
      entries
        .map((entry) => {
          const record =
            entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
          const slide = record["slide"];
          const claim = typeof record["claim"] === "string" ? record["claim"].trim() : "";
          const reason =
            typeof record["reason"] === "string" ? record["reason"].trim().slice(0, 200) : "";
          return {
            slide: typeof slide === "number" || typeof slide === "string" ? slide : 1,
            claim: claim.slice(0, 400),
            ...(reason ? { reason } : {}),
          };
        })
        .filter((entry) => entry.claim.length >= 3)
        .slice(0, 40),
    )
    .default([]),
});

const DECK_VERIFY_SYSTEM = [
  "You are a grounding auditor for a sales deck.",
  "You receive each slide's claims and the numbered passages it cites. Lines may start with a kind label: [evidence], [implication], [recommendation] or [takeaway].",
  "Check [evidence] and unlabelled claims fully against that slide's cited passages, word for word from the slide.",
  "For [implication] claims, list only one that introduces a number, count, percentage, date, named entity or claim about a company that the passages do not support.",
  "[recommendation] items are our proposal, not sourced claims: do not judge their sourcing, but list one when it states a figure, count, percentage or date the passages do not contain.",
  "Treat as unsupported: outside knowledge, reputational claims, figures, counts, percentages, dates and prices the passages do not state, and any description of a company the passages do not make.",
  "Quote claims without the kind label. Do not rewrite the deck. Do not list a claim the passages support.",
  "A row or line that states a proposed role, a next step or a recommended action is our proposal, not a factual claim: judge it only for invented figures, as above.",
  "List at most twelve claims, the most serious first. Omit nitpicks and anything already marked illustrative.",
  'Return JSON only: {"unsupported":[{"slide":1,"claim":"...","reason":"..."}]}. Use an empty list when everything is supported.',
].join(" ");

export type DeckVerifyResult = {
  sections: DocumentSection[];
  unsupported: { slide: string; claim: string }[];
  warnings: string[];
};

/** Removes a claim where the block can lose it cleanly; flags otherwise. */
function removeClaim(section: DocumentSection, claim: string): DocumentSection {
  const needle = normalise(claim);
  if (needle.length < 12) return { ...section, flagged: true };
  const warnings = [
    ...section.warnings,
    `VERIFY: unsupported claim flagged — "${claim.slice(0, 120)}"`,
  ];
  const trimmed: Block[] = [];
  for (const block of section.blocks) {
    if (block.type === "heading") {
      trimmed.push(block);
      continue;
    }
    if (!normalise(blockText(block)).includes(needle)) {
      trimmed.push(block);
      continue;
    }
    if (block.type === "bullet_list" || block.type === "numbered_list") {
      const items = block.items.filter((item) => !normalise(item.text).includes(needle));
      if (items.length > 0) trimmed.push({ ...block, items });
      continue;
    }
    if (block.type === "table") {
      const rows = block.rows.filter((row) => !normalise(row.join(" ")).includes(needle));
      if (rows.length > 0) trimmed.push({ ...block, rows });
      continue;
    }
    if (block.type !== "paragraph" && block.type !== "callout") {
      trimmed.push(block);
      continue;
    }
    // A paragraph that is the only content stays, but the slide is flagged.
  }
  const hasContent = trimmed.some((block) => block.type !== "heading");
  return {
    ...section,
    blocks: hasContent ? trimmed : section.blocks,
    flagged: true,
    warnings,
  };
}

/** Slide copy with kind labels, so the verifier knows what it may challenge. */
function labelledContent(section: DocumentSection): string {
  const lines: string[] = [];
  for (const block of section.blocks) {
    if (block.type === "heading") continue;
    if (block.type === "bullet_list" || block.type === "numbered_list") {
      for (const item of block.items) {
        lines.push(`${item.kind ? `[${item.kind}] ` : ""}${item.text}`);
      }
      continue;
    }
    lines.push(blockText(block));
  }
  if (section.takeaway) lines.push(`[takeaway] ${section.takeaway}`);
  return lines.join("\n").slice(0, 1_600);
}

function cleanClaimLabel(claim: string): string {
  return claim.replace(/^\[(evidence|implication|recommendation|takeaway)\]\s*/i, "").trim();
}

/** The kind of the bullet a claim quotes, when it quotes one. */
function itemKindFor(section: DocumentSection, claim: string): string | null {
  const needle = normalise(claim);
  if (needle.length < 8) return null;
  for (const block of section.blocks) {
    if (block.type !== "bullet_list" && block.type !== "numbered_list") continue;
    for (const item of block.items) {
      if (normalise(item.text).includes(needle)) return item.kind ?? "evidence";
    }
  }
  return null;
}

/**
 * One VERIFY call for the whole deck, thinking off and 4000 output tokens.
 * Non-fatal: a failed verifier leaves the deterministic checks in charge.
 */
export async function verifyDeckClaims(
  sections: readonly DocumentSection[],
  chunks: readonly { chunkId: string; content: string }[],
  options: ProviderOptions,
  log: (event: string, meta: Record<string, unknown>) => void,
): Promise<DeckVerifyResult> {
  const usable = sections.filter((section) =>
    section.blocks.some((block) => block.type !== "heading"),
  );
  if (usable.length === 0) return { sections: [...sections], unsupported: [], warnings: [] };

  const indexByChunk = new Map(chunks.map((chunk, index) => [chunk.chunkId, index + 1]));
  const slideText = usable
    .map((section, index) => {
      const refs = [...new Set(section.blocks.flatMap(sourceIdsOf))]
        .map((id) => indexByChunk.get(id))
        .filter((value): value is number => value !== undefined);
      const content = labelledContent(section);
      return `${index + 1}. ${section.title}\nrefs: [${refs.join(", ")}]\n${content}`;
    })
    .join("\n\n");
  const passages = chunks
    .map((chunk, index) => `[${index + 1}] ${chunk.content.replace(/\s+/g, " ").slice(0, 1_200)}`)
    .join("\n\n");

  let parsed: z.infer<typeof deckVerifySchema>;
  try {
    const outcome = await completeWithBudget(
      [
        { role: "system", content: DECK_VERIFY_SYSTEM },
        {
          role: "user",
          content: ["Slides:", slideText, "", "Passages:", passages, "", "Return JSON only."].join(
            "\n",
          ),
        },
      ],
      options,
      llmBudget("VERIFY"),
      0,
      { label: "export verify" },
    );
    parsed = deckVerifySchema.parse(JSON.parse(extractJson(outcome.content)));
  } catch (error) {
    log("deck verification skipped", { error: String(error).slice(0, 240) });
    return {
      sections: [...sections],
      unsupported: [],
      warnings: ["Deck verification was skipped; deterministic checks still applied."],
    };
  }

  const unsupported = parsed.unsupported.map((entry) => ({
    slide: String(entry.slide),
    claim: cleanClaimLabel(entry.claim),
  }));
  if (unsupported.length === 0) {
    return { sections: [...sections], unsupported: [], warnings: [] };
  }

  const chunkText = new Map(chunks.map((chunk) => [chunk.chunkId, chunk.content]));
  const passageTextFor = (section: DocumentSection): string =>
    [...new Set(section.blocks.flatMap(sourceIdsOf))]
      .map((id) => chunkText.get(id) ?? "")
      .join(" ")
      .toLowerCase();
  const newEntityIn = (section: DocumentSection, claim: string): boolean => {
    const passage = passageTextFor(section);
    // Capitalised tokens after the first word: company and product names.
    return claim
      .split(/\s+/)
      .slice(1)
      .filter((word) => /^[A-Z][A-Za-z&.-]{2,}/.test(word))
      .some((word) => !passage.includes(word.toLowerCase().replace(/[.,;:)]+$/, "")));
  };

  const result = [...sections];
  const reported: typeof unsupported = [];
  for (const entry of parsed.unsupported) {
    const index =
      typeof entry.slide === "number"
        ? entry.slide - 1
        : result.findIndex((section) => section.title === entry.slide);
    const target = result[index];
    if (!target) continue;
    const claim = cleanClaimLabel(entry.claim);
    // Honest absence is not an unsupported claim; it is what the parties slide
    // must say when the library has nothing for a party.
    if (/no library evidence found/i.test(claim)) continue;
    const kind = itemKindFor(target, claim);
    // An implication may connect and weigh cited facts. Only a new figure or a
    // new named entity makes it unsupported; tone or a different framing does not.
    if (kind === "implication" && !/\d/.test(claim) && !newEntityIn(target, claim)) continue;
    // A recommendation is our proposal: it is only removed when it carries a
    // figure the passages cannot support, never for lacking a citation.
    if (kind === "recommendation" && !/\d/.test(claim)) continue;
    result[index] = removeClaim(target, claim);
    reported.push({ slide: String(entry.slide), claim });
  }

  const warnings = reported
    .slice(0, 8)
    .map((entry) => `VERIFY flagged "${entry.claim.slice(0, 100)}" on slide ${entry.slide}.`);
  log("deck verified", { unsupported: reported.length, slides: usable.length });
  return { sections: result, unsupported: reported, warnings };
}

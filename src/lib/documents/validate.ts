/**
 * Post-generation validator. The prompt asks for grounded, specific, consistent
 * output; this module checks it. Errors trigger one retry with the complaints
 * fed back to the model; if the retry still fails, offending blocks are removed
 * and the section is marked rather than shipped with invented numbers.
 */
import type { Block, DocumentModel, DocumentSection, ExportBrief, SourceRecord } from "./types";
import type { SectionPlan } from "./outline";
import { citedChunkIds } from "./generate";
export type SectionValidation = {
  errors: string[];
  warnings: string[];
  /** Figures asserted in chat but absent from the library. */
  conflicts: string[];
};

/**
 * Reader-facing copy states what is there, never what the library lacks. A
 * client-ready document does not tell the client which data we failed to find;
 * the recommendation carries the gap instead, and the gap is an open item.
 */
const MISSING_DATA_PHRASES: readonly RegExp[] = [
  /\[to be confirmed\]/i,
  /\bno library evidence\b/i,
  /\bcould not find\b/i,
  /\bcouldn['\u2019]t find\b/i,
  /\bno (?:data|information|evidence|passages|sources?)\b/i,
  /\bnot (?:present|available|found) in the library\b/i,
  /\bnothing (?:was )?(?:found|available)\b/i,
  /\bwe (?:were unable|did not find|have no)\b/i,
  /\bmissing evidence\b/i,
];

export function statesMissingData(text: string): boolean {
  return MISSING_DATA_PHRASES.some((pattern) => pattern.test(text));
}

const BANNED = [
  /\blorem ipsum\b/i,
  /\bplaceholder text\b/i,
  /\bTODO\b/,
  /\bTBD\b/,
  /\bas an AI\b/i,
  /\binsert .* here\b/i,
  /\bclick here\b/i,
  ...MISSING_DATA_PHRASES,
];

const NUMBER_PATTERN =
  /(?:[£$€]\s?\d[\d,]*(?:\.\d+)?\s?(?:bn|m|k)?|\b\d[\d,]*(?:\.\d+)?\s?(?:%|percent|days?|weeks?|months?|years?|hours?|minutes?|x|times|bn|fte|countries|markets|sites|clients|customers|projects|users)(?![a-z])|\b\d{1,3}(?:,\d{3})+\b|\b\d{4,}\b|\b\d+\.\d+\b)/gi;

function numericCore(value: string): string {
  const match = value.match(/\d[\d,]*(?:\.\d+)?/);
  return (match?.[0] ?? "").replace(/,/g, "").replace(/^0+(?=\d)/, "");
}

/** Every numeric token in a value, used for metrics where any digit is a claim. */
export function allNumbersInText(text: string): string[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)]
    .map((match) => numericCore(match[0]))
    .filter((value) => value.length > 0);
}

export function numbersInText(text: string): string[] {
  return [...text.matchAll(NUMBER_PATTERN)]
    .map((match) => match[0])
    .filter((value) => {
      const core = numericCore(value);
      if (!core) return false;
      // A bare small integer (1-12) is usually structure, not a claim.
      const numeric = Number(core);
      const hasUnit = /[£$€%a-z]/i.test(value.replace(/^\d[\d,.]*/, ""));
      return hasUnit || numeric >= 100 || value.includes(".");
    });
}

function normalisedNumbers(text: string): Set<string> {
  const values = [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((match) => numericCore(match[0]));
  return new Set(values.filter(Boolean));
}

/** Numbers stated anywhere in the block's cited passages plus the item's own. */
function metricNumbers(
  cited: readonly string[],
  itemSource: string,
  chunksById: ReadonlyMap<string, string>,
): Set<string> {
  const numbers = new Set<string>();
  for (const id of new Set([...cited, itemSource])) {
    for (const value of normalisedNumbers(chunksById.get(id) ?? "")) numbers.add(value);
  }
  return numbers;
}

export function blockText(block: Block): string {
  switch (block.type) {
    case "heading":
      return block.text;
    case "paragraph":
    case "callout":
      return block.text;
    case "bullet_list":
    case "numbered_list":
      return block.items.map((item) => item.text).join("\n");
    case "table":
      return [block.caption ?? "", ...block.headers, ...block.rows.flat()].join("\n");
    case "metrics":
      return block.items
        .map((item) => [item.label, item.value, item.unit ?? "", item.context ?? ""].join(" "))
        .join("\n");
    case "quote":
      return `${block.text} ${block.attribution}`;
    case "timeline":
      return block.items.map((item) => `${item.label} ${item.timeframe} ${item.detail}`).join("\n");
    case "comparison":
      return [
        block.title ?? "",
        ...block.criteria,
        ...block.options.flatMap((option) => [option.name, ...option.values]),
      ].join("\n");
    case "chart":
      return [
        block.chart.title,
        ...block.chart.categories,
        ...block.chart.series.flatMap((series) => [series.name, ...series.values.map(String)]),
      ].join("\n");
    case "kpis":
      return block.items
        .map((item) => [item.label, item.value, item.note ?? ""].join(" "))
        .join("\n");
    case "flow":
      return block.steps.map((step) => [step.label, step.detail ?? ""].join(" ")).join("\n");
  }
}

/** Text that is actually content, excluding subsections headings. */
function contentText(blocks: readonly Block[]): string {
  return blocks
    .filter((block) => block.type !== "heading")
    .map(blockText)
    .join("\n")
    .trim();
}

function sectionTextLength(blocks: readonly Block[]): number {
  return contentText(blocks).replace(/\s+/g, " ").length;
}

function citeSet(block: Block): string[] {
  return citedChunkIds(block);
}

function unsupportedIn(
  text: string,
  cited: readonly string[],
  chunksById: ReadonlyMap<string, string>,
): string[] {
  const sourceNumbers = new Set<string>();
  for (const id of cited) {
    const content = chunksById.get(id);
    if (!content) continue;
    for (const value of normalisedNumbers(content)) sourceNumbers.add(value);
  }
  return numbersInText(text).filter((value) => {
    const core = numericCore(value);
    return core.length > 0 && !sourceNumbers.has(core);
  });
}

export function validateSection(
  plan: SectionPlan,
  section: DocumentSection,
  chunksById: ReadonlyMap<string, string>,
  brief: ExportBrief,
  minCharsOverride?: number,
): SectionValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const conflicts: string[] = [];

  const content = section.blocks.filter((block) => block.type !== "heading");
  if (content.length === 0) errors.push("the section has no content blocks");
  const chars = sectionTextLength(section.blocks);
  const minChars = minCharsOverride ?? plan.minChars;
  if (chars > 0 && chars < minChars) {
    errors.push(`the section is too thin (${chars} characters; needs at least ${minChars})`);
  }

  const text = contentText(section.blocks);
  if (BANNED.some((pattern) => pattern.test(text))) {
    errors.push("the section contains placeholder or meta text");
  }
  if (/\[[a-z ]{3,30}\]/i.test(text)) {
    warnings.push("the section contains an unexplained bracketed note");
  }

  const headings = new Set<string>();
  for (const block of section.blocks) {
    if (block.type === "heading") {
      const key = block.text.toLowerCase();
      if (headings.has(key)) errors.push(`duplicate subheading "${block.text}"`);
      headings.add(key);
    }
  }

  const seenBullets = new Set<string>();
  for (const [index, block] of section.blocks.entries()) {
    const cited = citeSet(block);
    for (const id of cited) {
      if (!chunksById.has(id))
        errors.push(`block ${index + 1} cites a chunk that was not supplied`);
    }

    if (block.type === "table") {
      if (block.headers.some((header) => header.trim().length === 0)) {
        errors.push("a table has an empty header cell");
      }
      if (
        new Set(block.headers.map((header) => header.toLowerCase())).size !== block.headers.length
      ) {
        errors.push("a table has duplicate column headers");
      }
      if (block.rows.some((row) => row.length !== block.headers.length)) {
        errors.push("a table row does not match its column count");
      }
      if (block.rows.some((row) => row.every((cell) => cell.trim().length === 0))) {
        errors.push("a table has an entirely empty row");
      }
    }

    if (block.type === "metrics") {
      for (const item of block.items) {
        if (!chunksById.has(item.source)) {
          errors.push(`metric "${item.label}" has no valid source`);
          continue;
        }
        // A metrics block cites several passages; a figure in any of them is
        // grounded. Checking only the item's own source rejected valid figures
        // and cost whole sections.
        const sourceNumbers = metricNumbers(cited, item.source, chunksById);
        for (const core of allNumbersInText(item.value)) {
          if (!sourceNumbers.has(core)) {
            errors.push(
              `metric "${item.label}" states ${item.value}, which is not in its cited passages`,
            );
          }
        }
      }
    }

    if (block.type === "quote") {
      if (!chunksById.has(block.source)) {
        errors.push("a quote has no valid source");
      } else {
        const source = (chunksById.get(block.source) ?? "").replace(/\s+/g, " ").toLowerCase();
        const quote = block.text.replace(/\s+/g, " ").toLowerCase();
        const probe = quote.slice(0, 40);
        if (probe.length >= 20 && !source.includes(probe)) {
          errors.push("a quote is not verbatim from its cited passage");
        }
      }
    }

    if (block.type === "comparison") {
      if (block.options.some((option) => option.values.length !== block.criteria.length)) {
        errors.push("a comparison does not match its criteria count");
      }
    }

    if (block.type === "bullet_list" || block.type === "numbered_list") {
      for (const item of block.items) {
        const key = item.text.toLowerCase().replace(/\s+/g, " ").trim();
        if (seenBullets.has(key)) errors.push(`duplicate bullet "${item.text.slice(0, 60)}"`);
        seenBullets.add(key);
      }
    }

    if (block.type !== "heading" && block.type !== "quote") {
      const unsupported = unsupportedIn(blockText(block), cited, chunksById);
      if (unsupported.length > 0) {
        const chatNumbers = new Set(brief.chatFigures.map(numericCore));
        for (const value of unsupported) {
          const conflict = chatNumbers.has(numericCore(value));
          if (conflict) conflicts.push(value);
          errors.push(
            `“${value}” is not present in the cited passages${conflict ? " (it appears in the chat; prefer the source or remove it)" : ""}`,
          );
        }
      }
    }
  }

  return { errors: [...new Set(errors)], warnings, conflicts: [...new Set(conflicts)] };
}

function validBlock(
  block: Block,
  chunksById: ReadonlyMap<string, string>,
  brief: ExportBrief,
  plan: SectionPlan,
): boolean {
  if (block.type === "heading") return true;
  if (block.type === "quote") {
    const source = chunksById.get(block.source);
    if (!source) return false;
    return source
      .replace(/\s+/g, " ")
      .toLowerCase()
      .includes(block.text.slice(0, 40).toLowerCase());
  }
  const cited = citeSet(block);
  if (block.type === "metrics") {
    return block.items.every(
      (item) =>
        chunksById.has(item.source) &&
        allNumbersInText(item.value).every((value) =>
          metricNumbers(cited, item.source, chunksById).has(value),
        ),
    );
  }
  if (cited.length === 0 || cited.some((id) => !chunksById.has(id))) return false;
  if (block.type === "table") {
    return (
      block.headers.length >= 2 &&
      block.rows.every((row) => row.length === block.headers.length) &&
      block.rows.every((row) => row.some((cell) => cell.trim().length > 0))
    );
  }
  if (block.type === "comparison") {
    return block.options.every((option) => option.values.length === block.criteria.length);
  }
  // Copy that announces a gap in the library is removed rather than shipped.
  if (statesMissingData(blockText(block))) return false;
  const unsupported = unsupportedIn(blockText(block), cited, chunksById);
  if (unsupported.length > 0) {
    void brief;
    void plan;
    return false;
  }
  return true;
}

/** Removes only the blocks the validator proved unsupported. Never rewrites text. */
export function sanitizeSection(
  plan: SectionPlan,
  section: DocumentSection,
  chunksById: ReadonlyMap<string, string>,
  brief: ExportBrief,
): { section: DocumentSection; removed: number } {
  const kept: Block[] = [];
  for (const block of section.blocks) {
    if (validBlock(block, chunksById, brief, plan)) {
      kept.push(block);
    } else if (block.type === "metrics") {
      const items = block.items.filter(
        (item) =>
          chunksById.has(item.source) &&
          allNumbersInText(item.value).every((value) =>
            metricNumbers(citeSet(block), item.source, chunksById).has(value),
          ),
      );
      if (items.length > 0) kept.push({ type: "metrics", items, sources: block.sources });
    }
  }

  // A trailing heading with nothing after it is noise.
  while (kept.length > 0 && kept[kept.length - 1]?.type === "heading") kept.pop();

  const content = kept.filter((block) => block.type !== "heading");
  if (content.length === 0) {
    // Nothing survived grounding, so the section is left out of the document
    // rather than filled with a note about the library's gaps. The caller sees
    // the flag and can list it as an open item for the team.
    return {
      section: {
        ...section,
        blocks: [],
        flagged: true,
        warnings: [...section.warnings, `No grounded copy for "${plan.title}"; section omitted.`],
      },
      removed: section.blocks.length,
    };
  }

  return {
    section: {
      ...section,
      blocks: kept,
      warnings: section.warnings,
    },
    removed: section.blocks.length - kept.length,
  };
}

/** Document-level checks: uniqueness, empty sections, dangling sources. */
export function validateModel(
  model: DocumentModel,
  chunksById: ReadonlyMap<string, string>,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const titles = new Set<string>();
  const bullets = new Map<string, string>();

  for (const section of model.sections) {
    const title = section.title.toLowerCase().replace(/\s+/g, " ").trim();
    if (!title) errors.push("a section has no title");
    if (titles.has(title)) errors.push(`duplicate section heading "${section.title}"`);
    titles.add(title);

    if (section.blocks.length === 0) errors.push(`section "${section.title}" is empty`);
    const content = section.blocks.filter((block) => block.type !== "heading");
    if (content.length === 0) errors.push(`section "${section.title}" has no content blocks`);
    if (!section.flagged && sectionTextLength(section.blocks) < 70) {
      errors.push(`section "${section.title}" is too short to be substantive`);
    }

    for (const block of section.blocks) {
      for (const id of citeSet(block)) {
        if (!chunksById.has(id)) errors.push(`section "${section.title}" cites an unknown chunk`);
      }
      if (block.type === "bullet_list" || block.type === "numbered_list") {
        for (const item of block.items) {
          const key = item.text.toLowerCase().replace(/\s+/g, " ").trim();
          const owner = bullets.get(key);
          if (owner) {
            errors.push(
              `duplicate point in "${owner}" and "${section.title}": "${item.text.slice(0, 60)}"`,
            );
          } else {
            bullets.set(key, section.title);
          }
        }
      }
    }
  }

  const sourceIds = new Set(model.sources.map((source) => source.chunkId));
  for (const id of chunksById.keys()) {
    if (
      !sourceIds.has(id) &&
      [...model.sections].some((section) => sectionSourceIdsOf(section).includes(id))
    ) {
      warnings.push(`source list is missing chunk ${id}`);
    }
  }

  if (model.sections.length < (model.mode === "proposal" ? 6 : 6)) {
    errors.push(`the document has only ${model.sections.length} sections`);
  }

  return { errors: [...new Set(errors)], warnings };
}

function sectionSourceIdsOf(section: DocumentSection): string[] {
  return [...new Set([...section.blocks.flatMap(citedChunkIds), ...(section.evidenceIds ?? [])])];
}

export function sourceRecords(
  sections: readonly DocumentSection[],
  chunksById: ReadonlyMap<string, string>,
  chunkMeta: ReadonlyMap<string, SourceRecord>,
): SourceRecord[] {
  void chunksById;
  const ordered: SourceRecord[] = [];
  const seen = new Set<string>();
  for (const section of sections) {
    for (const id of sectionSourceIdsOf(section)) {
      if (seen.has(id)) continue;
      const record = chunkMeta.get(id);
      if (!record) continue;
      seen.add(id);
      ordered.push(record);
    }
  }
  return ordered;
}

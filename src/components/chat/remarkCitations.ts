/**
 * Remark plugin that turns [n] / [2][3] text into links to the Sources list.
 * It runs on the parsed markdown tree, so a marker inside a table cell, list
 * item or heading is handled the same way and the surrounding markdown still
 * renders normally.
 *
 * Markers the server never issued are left as plain text. Code and links are
 * skipped so a citation cannot break either.
 */
import type { PhrasingContent, Root } from "mdast";

type Options = { known: ReadonlySet<number>; anchorPrefix: string };

const MARKER = /\[\s*(\d+(?:\s*[,;]\s*\d+)*)\s*\]/g;

type ParentNode = {
  type: string;
  children?: unknown[];
};

function splitText(value: string, options: Options): PhrasingContent[] {
  const nodes: PhrasingContent[] = [];
  let cursor = 0;

  for (const match of value.matchAll(MARKER)) {
    const start = match.index ?? 0;
    if (start > cursor) nodes.push({ type: "text", value: value.slice(cursor, start) });
    cursor = start + match[0].length;

    const numbers = [
      ...new Set((match[1] ?? "").split(/[,;]/).map((part) => Number.parseInt(part.trim(), 10))),
    ].filter((number) => options.known.has(number));

    if (numbers.length === 0) {
      nodes.push({ type: "text", value: match[0] });
      continue;
    }

    for (const number of numbers) {
      nodes.push({
        type: "link",
        url: `#source-${options.anchorPrefix}-${number}`,
        children: [{ type: "text", value: `[${number}]` }],
        data: {
          hProperties: {
            className: ["citation-chip"],
            "aria-label": `Source ${number}`,
          },
        },
      });
    }
  }

  if (cursor < value.length) nodes.push({ type: "text", value: value.slice(cursor) });
  return nodes;
}

function walk(node: ParentNode, options: Options): void {
  if (!Array.isArray(node.children)) return;
  // A link inside a link is invalid HTML; let citation-looking text there be.
  if (node.type === "link") return;

  const next: unknown[] = [];
  for (const child of node.children) {
    if (!child || typeof child !== "object") {
      next.push(child);
      continue;
    }
    const entry = child as { type?: string; value?: string };
    if (entry.type === "text" && typeof entry.value === "string") {
      next.push(...splitText(entry.value, options));
      continue;
    }
    walk(child as ParentNode, options);
    next.push(child);
  }
  node.children = next;
}

export function remarkCitations(options: Options) {
  return (tree: Root) => {
    walk(tree as unknown as ParentNode, options);
  };
}

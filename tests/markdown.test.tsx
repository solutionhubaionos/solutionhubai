import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownAnswer } from "../src/components/chat/MarkdownAnswer";
import type { ChatSource } from "../src/lib/chat/answer";

const source: ChatSource = {
  citation: 1,
  chunkId: "chunk-1",
  contentId: "doc-1",
  title: "Zurich claims transformation",
  fileName: "zurich-claims.pdf",
  industry: "insurance",
  customerName: "Zurich Insurance",
  page: 3,
  slide: null,
  heading: "Outcomes",
  snippet: "Claims time fell.",
  titleOnly: false,
};

function render(text: string, sources: ChatSource[] = [source]) {
  return renderToStaticMarkup(
    <MarkdownAnswer text={text} sources={sources} anchorPrefix="message-1" />,
  );
}

describe("assistant markdown", () => {
  test("renders GFM tables with a scroll container", () => {
    const html = render("| Metric | Value |\n| --- | --- |\n| Cycle time | 6 days [1] |");
    expect(html).toContain("<table");
    expect(html).toContain("<thead");
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("Cycle time");
  });

  test("renders headings, lists and emphasis", () => {
    const html = render("## What changes\n\n- **Faster** intake [1]\n- One queue");
    expect(html).toContain("<h2");
    expect(html).toContain("<ul");
    expect(html).toContain("Faster</strong>");
  });

  test("turns known markers into superscript source links", () => {
    const html = render("Cycle time fell to 6 days [1].");
    expect(html).toContain("<sup");
    expect(html).toContain('href="#source-message-1-1"');
    expect(html).toContain("citation-chip");
  });

  test("leaves unknown markers as plain text", () => {
    const html = render("A claim [7].");
    expect(html).not.toContain('href="#source-message-1-7"');
    expect(html).toContain("[7]");
  });

  test("sanitises embedded HTML", () => {
    const html = render('<script>alert("x")</script>\n\nSafe text.');
    expect(html).not.toContain("<script>");
    expect(html).toContain("Safe text.");
  });
});

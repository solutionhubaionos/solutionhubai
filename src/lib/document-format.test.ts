import { describe, expect, it } from "vitest";
import { documentFormat } from "./document-format";
describe("inline documents", () => {
  it("opens PDF even when uploaded with generic MIME", () => expect(documentFormat("Proposal.PDF", "application/octet-stream")).toBe("pdf"));
  it("opens modern Word documents", () => expect(documentFormat("Case study.docx")).toBe("docx"));
  it("opens modern PowerPoint decks", () => expect(documentFormat("Deck.pptx")).toBe("pptx"));
  it("does not misrepresent unsupported legacy Office formats", () => {
    expect(documentFormat("Legacy.doc")).toBe("unsupported");
    expect(documentFormat("Legacy.ppt")).toBe("unsupported");
  });
});
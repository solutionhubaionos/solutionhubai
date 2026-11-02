import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDocument: vi.fn(),
  getPage: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock("pdfjs-dist", () => ({ getDocument: mocks.getDocument, GlobalWorkerOptions: {} }));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "/test-worker.js" }));
import { PdfPreview } from "./PdfPreview";

describe("PDF page navigation", () => {
  it("parses the file once when moving between pages", async () => {
    mocks.getPage.mockResolvedValue({ getViewport: () => ({ width: 600, height: 800 }), render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }) });
    mocks.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 2, getPage: mocks.getPage }), destroy: mocks.destroy });
    const blob = { arrayBuffer: async () => new ArrayBuffer(8) } as Blob;
    const view = render(<PdfPreview blob={blob} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled());
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Next page" })); });
    await waitFor(() => expect(mocks.getPage).toHaveBeenCalledWith(2));
    expect(mocks.getDocument).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });
});
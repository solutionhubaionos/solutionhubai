import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/button";
import type { ContentItem } from "@/lib/content";

const mocks = vi.hoisted(() => ({ download: vi.fn(), log: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { storage: { from: () => ({ download: mocks.download }) } } }));
vi.mock("@/lib/activity", () => ({ logActivity: mocks.log }));
import { FilePreviewDialog } from "./FilePreviewDialog";

const item: ContentItem = { id: "file-1", title: "Proposal", file_name: "proposal.pdf", file_path: "private/proposal.pdf", industry: "airlines", content_type: "proposal", customer_name: null, solution: null, description: null, file_size: 100, mime_type: "application/pdf", uploaded_by: "owner", uploader_email: null, created_at: "2026-10-22T00:00:00Z" };
describe("default file viewing", () => {
  it("opens the private viewer and logs an open when the file title is clicked", async () => {
    mocks.download.mockResolvedValue({ error: new Error("test download unavailable") });
    const view = render(<FilePreviewDialog item={item} trigger={<Button>{item.title}</Button>} />);
    expect(mocks.download).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Proposal" }));
    await waitFor(() => expect(mocks.download).toHaveBeenCalledWith("private/proposal.pdf"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(mocks.log).toHaveBeenCalledWith({ event_type: "file_open", content_id: "file-1", industry: "airlines" });
    view.unmount();
  });
});
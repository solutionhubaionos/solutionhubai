import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ContentItem } from "@/lib/content";

const mocks = vi.hoisted(() => ({ download: vi.fn(), log: vi.fn(), move: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { storage: { from: () => ({ download: mocks.download }) } },
}));
vi.mock("@/lib/activity", () => ({ logActivity: mocks.log }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@tanstack/react-router", () => ({ useRouteContext: () => ({ user: { id: "member" } }) }));
vi.mock("@/lib/industries", () => ({
  useIndustries: () => ({ industries: [] }),
  contentTypeLabel: () => "Proposal",
}));
vi.mock("@/lib/roles", () => ({ useRole: () => ({ role: "member", isAdmin: false }) }));
vi.mock("@/components/MoveCopyDialog", () => ({
  MoveCopyDialog: () => <button onClick={mocks.move}>Move or copy</button>,
}));
vi.mock("@/components/EditContentDialog", () => ({ EditContentDialog: () => null }));
import { ContentCard } from "./ContentCard";

const item: ContentItem = {
  id: "file-1",
  title: "Proposal",
  file_name: "proposal.pdf",
  file_path: "private/proposal.pdf",
  industry: "airlines",
  content_type: "proposal",
  customer_name: null,
  solution: null,
  description: "Customer proposal",
  file_size: 100,
  mime_type: "application/pdf",
  uploaded_by: "owner",
  uploader_email: null,
  created_at: "2026-10-22T00:00:00Z",
};

describe("file tile viewing", () => {
  it("opens the private viewer through the tile control without opening it for separate actions", async () => {
    mocks.download.mockResolvedValue({ error: new Error("test download unavailable") });
    const view = render(<ContentCard item={item} />);
    fireEvent.click(screen.getByRole("button", { name: "Move or copy" }));
    expect(mocks.move).toHaveBeenCalledOnce();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Proposal" }));
    await waitFor(() => expect(mocks.download).toHaveBeenCalledWith("private/proposal.pdf"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(mocks.log).toHaveBeenCalledWith({
      event_type: "file_open",
      content_id: "file-1",
      industry: "airlines",
    });
    view.unmount();
  });
});

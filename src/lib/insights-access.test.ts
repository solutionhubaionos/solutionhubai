import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc } }));
import { Route } from "@/routes/_authenticated/insights";

async function enterInsights() {
  const beforeLoad = Route.options.beforeLoad;
  if (typeof beforeLoad !== "function") throw new Error("Missing Insights access check");
  // Exercise the actual route guard without a router or network connection.
  return beforeLoad({ context: { queryClient: new QueryClient() } } as Parameters<typeof beforeLoad>[0]);
}

describe("Insights access", () => {
  it("redirects members to the library before loading Insights", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    await expect(enterInsights()).rejects.toMatchObject({ options: { to: "/library" } });
    expect(rpc).toHaveBeenCalledWith("is_content_admin");
  });
  it("allows verified admins to enter Insights", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    await expect(enterInsights()).resolves.toBeUndefined();
  });
});
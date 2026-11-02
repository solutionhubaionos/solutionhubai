import { createFileRoute, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { AppHeader } from "@/components/AppHeader";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (!data.user) throw redirect({ to: "/auth" });
    return { user: data.user };
  },
  component: AuthenticatedLayout,
});

/**
 * Chat owns its own full-height shell (rail, top bar, pinned composer), so the
 * shared header would double up. Every other route keeps it.
 */
function AuthenticatedLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  if (pathname === "/chat") return <Outlet />;
  return (
    <div className="min-h-screen">
      <AppHeader />
      <Outlet />
    </div>
  );
}

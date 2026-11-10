import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { roleFromRows } from "./permissions";

export function useRole() {
  const { user } = useRouteContext({ from: "/_authenticated" });
  const query = useQuery({
    queryKey: ["role", user.id],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id);
      if (error) throw error;
      return roleFromRows(data);
    },
  });
  return { role: query.data ?? "member", isAdmin: query.data === "admin" };
}

import { queryOptions } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";

export type ContentItem = Tables<"content_items">;

export const contentQuery = (industry?: string) =>
  queryOptions({
    queryKey: ["content", industry ?? "all"],
    staleTime: 30_000,
    queryFn: async () => {
      let q = supabase.from("content_items").select("*").order("created_at", { ascending: false });
      if (industry) q = q.eq("industry", industry);
      const { data, error } = await q;
      if (error) throw error;
      return data;
    },
  });

export function matches(item: ContentItem, term: string) {
  const t = term.trim().toLowerCase();
  if (!t) return true;
  return [item.title, item.customer_name, item.solution, item.description, item.file_name].some(
    (v) => v?.toLowerCase().includes(t),
  );
}

export function formatSize(bytes?: number | null) {
  if (!bytes) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0,
    n = bytes;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

export type DateSort = "newest" | "oldest";
export function sortByDate<T extends { created_at: string }>(list: T[], sort: DateSort) {
  return [...list].sort((a, b) =>
    sort === "newest"
      ? b.created_at.localeCompare(a.created_at)
      : a.created_at.localeCompare(b.created_at),
  );
}

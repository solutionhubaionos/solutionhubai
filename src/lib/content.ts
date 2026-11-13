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

/** Saved customers plus names that only exist on older uploads, de-duplicated and sorted. */
export function mergeCustomerNames(
  saved: readonly string[],
  uploaded: readonly (string | null)[],
): string[] {
  return [...new Set([...saved, ...uploaded.filter((name): name is string => Boolean(name))])].sort(
    (a, b) => a.localeCompare(b),
  );
}

/** Removes the library row first, then its stored file; a storage failure is reported, not thrown. */
export async function deleteContent(item: Pick<ContentItem, "id" | "file_path">) {
  const { error } = await supabase
    .from("content_items")
    .delete()
    .eq("id", item.id)
    .select("id")
    .single();
  if (error) throw error;
  const { error: storageError } = await supabase.storage.from("content").remove([item.file_path]);
  return { storageError };
}

export type DateSort = "newest" | "oldest";
export function sortByDate<T extends { created_at: string }>(list: T[], sort: DateSort) {
  return [...list].sort((a, b) =>
    sort === "newest"
      ? b.created_at.localeCompare(a.created_at)
      : a.created_at.localeCompare(b.created_at),
  );
}

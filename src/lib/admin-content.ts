import { queryOptions } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { matches, type ContentItem } from "./content";

export async function checkAdminAccess() {
  const { data, error } = await supabase.rpc("is_content_admin");
  if (error) throw error;
  return data === true;
}

export const adminAccessQuery = queryOptions({
  queryKey: ["admin-access"],
  staleTime: 0,
  queryFn: checkAdminAccess,
});

export const adminContentQuery = queryOptions({
  queryKey: ["content", "admin"],
  queryFn: async () => {
    if (!(await checkAdminAccess())) throw new Error("Administrator access required.");
    const items: ContentItem[] = [];
    for (let start = 0; ; start += 1000) {
      const { data, error } = await supabase
        .from("content_items")
        .select("*")
        .order("created_at", { ascending: false })
        .order("id")
        .range(start, start + 999);
      if (error) throw error;
      items.push(...data);
      if (data.length < 1000) return items;
    }
  },
});

export type AdminFilters = {
  q?: string | undefined;
  industry?: string | undefined;
  customer?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  sort?: "newest" | "oldest" | "largest" | "smallest" | undefined;
};

export function filterAdminFiles(items: ContentItem[], filters: AdminFilters) {
  return items
    .filter((item) => {
      const day = item.created_at.slice(0, 10);
      return (
        matches(item, filters.q ?? "") &&
        (!filters.industry || item.industry === filters.industry) &&
        (!filters.customer ||
          (filters.customer === "__industry_wide__"
            ? !item.customer_name
            : item.customer_name === filters.customer)) &&
        (!filters.from || day >= filters.from) &&
        (!filters.to || day <= filters.to)
      );
    })
    .sort((a, b) => {
      if (filters.sort === "largest")
        return (b.file_size ?? -1) - (a.file_size ?? -1) || a.id.localeCompare(b.id);
      if (filters.sort === "smallest")
        return (
          (a.file_size ?? Number.MAX_SAFE_INTEGER) - (b.file_size ?? Number.MAX_SAFE_INTEGER) ||
          a.id.localeCompare(b.id)
        );
      return filters.sort === "oldest"
        ? a.created_at.localeCompare(b.created_at)
        : b.created_at.localeCompare(a.created_at);
    });
}

export function storageSummary(items: ContentItem[]) {
  const unique = new Map<string, ContentItem>();
  for (const item of items) if (!unique.has(item.file_path)) unique.set(item.file_path, item);
  let bytes = 0,
    unknown = 0;
  for (const item of unique.values()) {
    if (item.file_size == null) unknown++;
    else bytes += item.file_size;
  }
  return { bytes, unknown, files: unique.size };
}

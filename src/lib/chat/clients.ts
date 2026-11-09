/**
 * Companies per sector, for the guided intake picker. The library keeps saved
 * customers in `customers`, but older file uploads may only carry a name on
 * `content_items.customer_name`, so both sources are merged — the same rule the
 * industry pages use for their customer counts.
 */
import { queryOptions, useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type ClientsByIndustry = Record<string, string[]>;

/** Groups and de-duplicates company names by industry slug, sorted per sector. */
export function groupClientsByIndustry(
  customers: readonly { name: string; industry: string }[],
  content: readonly { customer_name: string | null; industry: string }[],
): ClientsByIndustry {
  const grouped = new Map<string, Set<string>>();

  const add = (industry: string, name: string | null) => {
    const slug = industry.trim();
    const value = (name ?? "").trim();
    if (!slug || !value) return;
    const names = grouped.get(slug) ?? new Set<string>();
    names.add(value);
    grouped.set(slug, names);
  };

  for (const row of customers) add(row.industry, row.name);
  for (const row of content) add(row.industry, row.customer_name);

  return Object.fromEntries(
    [...grouped.entries()].map(([slug, names]) => [
      slug,
      [...names].sort((a, b) => a.localeCompare(b)),
    ]),
  );
}

export const industryClientsQuery = queryOptions({
  queryKey: ["chat-industry-clients"],
  staleTime: 60_000,
  queryFn: async (): Promise<ClientsByIndustry> => {
    const [customers, content] = await Promise.all([
      supabase.from("customers").select("name, industry"),
      supabase.from("content_items").select("customer_name, industry"),
    ]);
    if (customers.error) throw customers.error;
    if (content.error) throw content.error;
    return groupClientsByIndustry(customers.data, content.data);
  },
});

export function useIndustryClients() {
  const query = useQuery(industryClientsQuery);
  return { clientsByIndustry: query.data ?? {}, isLoading: query.isLoading };
}

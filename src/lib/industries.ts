import { queryOptions, useQuery } from "@tanstack/react-query";
import airlines from "@/assets/airlines.webp";
import airports from "@/assets/airports.webp";
import bfsi from "@/assets/bfsi.webp";
import hospitality from "@/assets/hospitality.webp";
import logistics from "@/assets/logistics.webp";
import manufacturing from "@/assets/manufacturing.webp";
import retail from "@/assets/retail.webp";
import telecom from "@/assets/telecom.webp";
import healthcare from "@/assets/healthcare-life-sciences.webp";
import energy from "@/assets/energy.webp";
import automotive from "@/assets/automotive.webp";
import hero from "@/assets/hero.webp";
import { supabase } from "@/integrations/supabase/client";

export type Industry = { slug: string; name: string; tagline: string; image: string };

const BUILTIN_IMAGES: Record<string, string> = {
  airlines, airports, bfsi, hospitality, logistics, manufacturing, retail, telecom,
  "healthcare-and-life-sciences": healthcare,
  energy,
  automotive,
};

export const industriesQuery = queryOptions({
  queryKey: ["industries"],
  staleTime: 5 * 60_000,
  queryFn: async (): Promise<Industry[]> => {
    const { data, error } = await supabase.from("industries").select("slug,name,tagline,image_url");
    if (error) throw error;
    return data
      .map((r) => ({
        slug: r.slug,
        name: r.name,
        tagline: r.tagline ?? "",
        image: BUILTIN_IMAGES[r.slug] ?? r.image_url ?? hero,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

export function useIndustries() {
  const q = useQuery(industriesQuery);
  return { industries: q.data ?? [], isLoading: q.isLoading };
}

export function slugify(name: string) {
  return name.trim().toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

export const CONTENT_TYPES = [
  { value: "case_study", label: "Case study" },
  { value: "pitch_deck", label: "Pitch deck" },
  { value: "poc_video", label: "POC video" },
  { value: "proposal", label: "Proposal" },
  { value: "other", label: "Other" },
] as const;

export const contentTypeLabel = (v: string) =>
  CONTENT_TYPES.find((c) => c.value === v)?.label ?? "Other";

export const ACCEPTED_FILES =
  ".ppt,.pptx,.doc,.docx,.xls,.xlsx,.pdf,.csv,image/*,video/*";

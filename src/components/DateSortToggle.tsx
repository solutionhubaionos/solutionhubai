import { ArrowDownWideNarrow, ArrowUpNarrowWide } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DateSort } from "@/lib/content";

export function DateSortToggle({ value, onChange }: { value: DateSort; onChange: (v: DateSort) => void }) {
  const newest = value === "newest";
  return (
    <Button variant="outline" size="sm" onClick={() => onChange(newest ? "oldest" : "newest")} aria-label="Sort by date">
      {newest ? <ArrowDownWideNarrow /> : <ArrowUpNarrowWide />} {newest ? "Newest first" : "Oldest first"}
    </Button>
  );
}

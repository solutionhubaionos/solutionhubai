import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ProgressiveList<T>({
  items,
  renderItem,
  className,
  batchSize = 12,
}: {
  items: T[];
  renderItem: (item: T) => ReactNode;
  className?: string;
  batchSize?: number;
}) {
  const [limit, setLimit] = useState(batchSize);
  const shown = Math.min(limit, items.length);
  return (
    <>
      <div className={className}>{items.slice(0, shown).map(renderItem)}</div>
      {shown < items.length && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          <span className="text-xs text-muted-foreground">
            {shown} of {items.length}
          </span>
          <Button variant="outline" onClick={() => setLimit((n) => n + batchSize)}>
            <ChevronDown />
            Show more
          </Button>
        </div>
      )}
    </>
  );
}

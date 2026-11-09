import { useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FOCUS } from "./theme";

/**
 * Multi-select grid used by the guided intake. Each option is a bordered tile
 * that keeps its selection visible with a primary border and check, so several
 * sectors or companies can be picked before confirming with Done.
 */
export function SelectionCard({
  title,
  options,
  emptyLabel,
  doneLabel = "Done",
  skipLabel = "Skip",
  onDone,
  onSkip,
}: {
  title: string;
  options: { value: string; label: string }[];
  emptyLabel?: string;
  doneLabel?: string;
  skipLabel?: string;
  onDone: (selected: string[]) => void;
  onSkip: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const toggle = (value: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  // Preserve the menu's order rather than the click order.
  const chosen = options
    .filter((option) => selected.has(option.value))
    .map((option) => option.value);

  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-card">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </p>
        <span className="shrink-0 text-[11px] text-muted-foreground">{selected.size} selected</span>
      </div>

      {options.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          {emptyLabel ?? "Nothing to pick here."}
        </p>
      ) : (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {options.map((option) => {
            const active = selected.has(option.value);
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() => toggle(option.value)}
                className={`${FOCUS} flex min-h-11 items-center justify-between gap-2 rounded-xl border-2 px-3 py-2 text-left text-sm transition-colors duration-150 ${
                  active
                    ? "border-primary bg-primary/10 font-medium text-primary"
                    : "border-border bg-card text-foreground hover:border-primary/40 hover:bg-secondary"
                }`}
              >
                <span className="min-w-0 truncate">{option.label}</span>
                {active && <Check size={15} className="shrink-0 text-primary" />}
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-4 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onSkip}
          className={`${FOCUS} rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground`}
        >
          {skipLabel}
        </button>
        <Button size="sm" onClick={() => onDone(chosen)} disabled={selected.size === 0}>
          {doneLabel}
        </Button>
      </div>
    </div>
  );
}

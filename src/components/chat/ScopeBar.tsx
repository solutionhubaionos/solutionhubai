import { useState } from "react";
import { Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FOCUS, chipCls, columnCls, eyebrowCls } from "./theme";
import { ChipGroup } from "./SelectionCard";

/**
 * The one-line scope row at the top of the chat: what retrieval and exports are
 * scoped to. Edit reopens the same compact chip selector; saving writes the new
 * scope to the conversation and it applies from the next turn.
 */
export function ScopeBar({
  labels,
  sectors,
  companies,
  industryOptions,
  companyOptions,
  onSave,
}: {
  labels: string[];
  sectors: string[];
  companies: string[];
  industryOptions: { value: string; label: string }[];
  companyOptions: { value: string; label: string }[];
  /** Resolves display labels to the stored slug/name pairs. */
  onSave: (next: { industries: string[]; companies: string[] }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [pickedSectors, setPickedSectors] = useState<Set<string>>(() => new Set(sectors));
  const [pickedCompanies, setPickedCompanies] = useState<Set<string>>(() => new Set(companies));

  const openEditor = () => {
    setPickedSectors(new Set(sectors));
    setPickedCompanies(new Set(companies));
    setEditing(true);
  };

  const toggle = (set: Set<string>, value: string) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  if (editing) {
    return (
      <div className={`${columnCls} pt-2`}>
        <div className="space-y-2 rounded-xl border border-border bg-card px-3 py-2">
          <ChipGroup
            label="Sectors"
            options={industryOptions}
            selected={pickedSectors}
            onToggle={(value) => setPickedSectors((previous) => toggle(previous, value))}
          />
          <ChipGroup
            label="Companies"
            options={companyOptions}
            selected={pickedCompanies}
            onToggle={(value) => setPickedCompanies((previous) => toggle(previous, value))}
          />
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <Button
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={() => {
                onSave({
                  industries: industryOptions
                    .filter((option) => pickedSectors.has(option.value))
                    .map((option) => option.value),
                  companies: companyOptions
                    .filter((option) => pickedCompanies.has(option.value))
                    .map((option) => option.value),
                });
                setEditing(false);
              }}
            >
              Done
            </Button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className={`${FOCUS} rounded-md px-1.5 py-0.5 text-xs font-medium text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground`}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (labels.length === 0) return null;

  return (
    <div className={`${columnCls} flex flex-wrap items-center gap-1.5 pt-2`}>
      <span className={eyebrowCls}>Scope</span>
      {labels.map((label) => (
        <span key={label} className={`${chipCls} pointer-events-none`}>
          {label}
        </span>
      ))}
      <button
        type="button"
        onClick={openEditor}
        aria-label="Edit the selected scope"
        className={`${chipCls} border-dashed text-muted-foreground hover:text-foreground`}
      >
        <Pencil size={11} aria-hidden /> Edit
      </button>
      <button
        type="button"
        onClick={() => onSave({ industries: [], companies: [] })}
        aria-label="Clear the selected scope"
        className={`${FOCUS} grid h-7 w-7 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground`}
      >
        <X size={12} />
      </button>
    </div>
  );
}

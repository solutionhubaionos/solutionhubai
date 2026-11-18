import { useState } from "react";
import { Check, Plus, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FOCUS, chipCls, chipLargeCls, chipSelectedCls } from "./theme";

/**
 * One selectable chip. Deliberately the same surface as the premade prompt
 * chips (border, radius, background, text size, hover) with the accent colour
 * reserved for the selected state, so the wizard reads as part of the chat and
 * not as a separate form.
 */
export function ChipButton({
  label,
  active,
  onToggle,
  large = false,
}: {
  label: string;
  active: boolean;
  onToggle: () => void;
  /** The wizard's own options read a size up from the small scope pills. */
  large?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onToggle}
      className={`${chipCls} ${large ? chipLargeCls : ""} ${active ? chipSelectedCls : ""}`}
    >
      <span className={large ? "max-w-[220px] truncate" : "max-w-[180px] truncate"}>{label}</span>
      {active && <Check size={large ? 13 : 11} className="shrink-0 text-primary" aria-hidden />}
    </button>
  );
}

/** Wrapped chip group: one or two rows on desktop and mobile. */
export function ChipGroup({
  options,
  selected,
  onToggle,
  label,
  large = false,
}: {
  options: { value: string; label: string }[];
  selected: ReadonlySet<string>;
  onToggle: (value: string) => void;
  label?: string;
  large?: boolean;
}) {
  if (options.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {label && (
        <span className="mr-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      )}
      {options.map((option) => (
        <ChipButton
          key={option.value}
          label={option.label}
          active={selected.has(option.value)}
          onToggle={() => onToggle(option.value)}
          large={large}
        />
      ))}
    </div>
  );
}

/**
 * The guided intake step, rebuilt as a compact inline block: one short prompt
 * line, wrapped chips, a small Done button and a quiet Skip link. No card, no
 * shadow, no grid — at most one or two rows per step.
 */
export function SelectionCard({
  title,
  options,
  emptyLabel,
  doneLabel = "Done",
  skipLabel = "Skip",
  large = false,
  initial,
  freeTextLabel,
  freeTextPlaceholder,
  freeTextAction = "Use",
  onDone,
  onSkip,
  onUndo,
}: {
  /** Omitted when the prompt above the card already asks the question. */
  title?: string;
  options: { value: string; label: string }[];
  emptyLabel?: string;
  doneLabel?: string;
  skipLabel?: string;
  /** One size up for the opening options, matching their weight as the first choice. */
  large?: boolean;
  /** Pre-selected values, used when the selector is reopened to edit scope. */
  initial?: readonly string[];
  /** Adds a free-text field: a name that is not in the list is a valid answer. */
  freeTextLabel?: string;
  freeTextPlaceholder?: string;
  freeTextAction?: string;
  onDone: (selected: string[]) => void;
  onSkip?: () => void;
  /** Returns to the previous step; shown only when there is a step to undo. */
  onUndo?: () => void;
}) {
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(initial ?? []));
  const [typed, setTyped] = useState("");
  const [custom, setCustom] = useState<string[]>([]);

  const toggle = (value: string) => {
    setChosen((previous) => {
      const next = new Set(previous);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  /** Enter adds the typed name; clicking the action does the same. */
  const addCustom = () => {
    const value = typed.trim().replace(/\s+/g, " ");
    if (!value) return;
    const exists =
      custom.some((entry) => entry.toLowerCase() === value.toLowerCase()) ||
      options.some(
        (option) => option.label.toLowerCase() === value.toLowerCase() && chosen.has(option.value),
      );
    if (!exists) setCustom((previous) => [...previous, value].slice(0, 12));
    setTyped("");
  };

  // Preserve the menu's order rather than the click order; typed names follow.
  // A half-typed value counts too, so Done never silently drops what was typed.
  const typedValue = typed.trim().replace(/\s+/g, " ");
  const values = [
    ...options.filter((option) => chosen.has(option.value)).map((option) => option.value),
    ...custom,
    ...(typedValue && !custom.some((entry) => entry.toLowerCase() === typedValue.toLowerCase())
      ? [typedValue]
      : []),
  ];
  const count = values.length;

  return (
    <div className="space-y-2">
      {(title || count > 0) && (
        <p className="text-xs font-medium text-foreground">
          {title}
          {count > 0 && (
            <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
              {count} selected
            </span>
          )}
        </p>
      )}

      {options.length === 0 && !freeTextLabel ? (
        <p className="text-xs text-muted-foreground">{emptyLabel ?? "Nothing to pick here."}</p>
      ) : (
        <ChipGroup options={options} selected={chosen} onToggle={toggle} large={large} />
      )}

      {freeTextLabel && (
        <div className="space-y-1.5">
          {custom.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {custom.map((name) => (
                <span
                  key={name}
                  className={`${chipCls} ${chipSelectedCls} ${large ? chipLargeCls : ""}`}
                >
                  {name}
                  <button
                    type="button"
                    onClick={() =>
                      setCustom((previous) => previous.filter((entry) => entry !== name))
                    }
                    aria-label={`Remove ${name}`}
                    className="grid h-4 w-4 place-items-center rounded-full"
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                addCustom();
              }}
              placeholder={freeTextPlaceholder ?? freeTextLabel}
              aria-label={freeTextLabel}
              className={`${FOCUS} min-w-[180px] flex-1 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary`}
            />
            <button
              type="button"
              onClick={addCustom}
              disabled={typed.trim().length === 0}
              className={`${chipCls} disabled:opacity-50`}
            >
              <Plus size={11} aria-hidden /> {freeTextAction}
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          className="h-7 px-3 text-xs"
          onClick={() => onDone(values)}
          disabled={count === 0}
        >
          {doneLabel}
        </Button>
        {onSkip && (
          <button
            type="button"
            onClick={onSkip}
            className={`${FOCUS} rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground`}
          >
            {skipLabel}
          </button>
        )}
        {onUndo && (
          <button
            type="button"
            onClick={onUndo}
            className={`${FOCUS} inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground`}
          >
            <Undo2 size={11} aria-hidden /> Undo
          </button>
        )}
      </div>
    </div>
  );
}

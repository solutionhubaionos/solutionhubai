import { Sparkles, X } from "lucide-react";
import { FOCUS, chipCls } from "./theme";

/** Prefill-only starters: none of these starts a generation. */
export const EXPORT_HINTS = [
  { label: "Pitch deck", prompt: "Create a pitch deck for this." },
  { label: "Proposal", prompt: "Generate a proposal document for this." },
  { label: "PDF", prompt: "Create a PDF one-pager for this." },
] as const;

/**
 * One slim hint above the composer. It only writes text into the composer, so a
 * document is still built solely from an explicit request; the dismissal is
 * remembered per user by the page.
 */
export function ExportHint({
  onPrefill,
  onDismiss,
}: {
  onPrefill: (prompt: string) => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="note"
      className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card/60 px-2.5 py-1.5 text-[11px] text-muted-foreground"
    >
      <Sparkles size={12} className="shrink-0 text-primary" aria-hidden />
      <p className="min-w-0 flex-1">
        Need a deck, proposal or PDF? Just ask, e.g. &ldquo;Create a pitch deck for this&rdquo;.
      </p>
      {EXPORT_HINTS.map((hint) => (
        <button
          key={hint.label}
          type="button"
          onClick={() => onPrefill(hint.prompt)}
          className={chipCls}
        >
          {hint.label}
        </button>
      ))}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss the document hint"
        className={`${FOCUS} grid h-6 w-6 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground`}
      >
        <X size={12} />
      </button>
    </div>
  );
}

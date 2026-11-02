/**
 * The confirmation card. A draft is never generated until the user presses
 * Generate, and the card states that plainly; once the file exists it becomes
 * the download.
 */
import {
  AlertTriangle,
  Download,
  File,
  FileText,
  Loader2,
  Presentation,
  Sparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { downloadDocument } from "@/lib/documents/download";
import { DOCUMENT_FORMATS, formatBytes, type DocumentDraftState } from "@/lib/documents/types";
import { FOCUS } from "./theme";

const ICONS = { pdf: File, docx: FileText, pptx: Presentation } as const;

function Chip({ children }: { children: string }) {
  return (
    <span className="rounded-full border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground">
      {children}
    </span>
  );
}

export function DocumentCard({
  state,
  onGenerate,
  onCancel,
}: {
  state: DocumentDraftState;
  onGenerate: () => void;
  onCancel: () => void;
}) {
  const { draft, status, file } = state;
  const format = DOCUMENT_FORMATS[draft.type];
  const Icon = ICONS[draft.type];
  const context = [draft.client, draft.industry, draft.sector, draft.audience].filter(
    (value): value is string => Boolean(value),
  );

  const heading =
    status === "ready"
      ? "Document ready"
      : status === "generating"
        ? "Building document"
        : status === "cancelled"
          ? "Cancelled"
          : status === "error"
            ? "Generation failed"
            : "Ready to build";

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex items-start gap-3 border-b border-border bg-secondary/40 px-4 py-3">
        <span
          aria-hidden
          className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"
        >
          <Icon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {heading}
          </p>
          <h3 className="truncate font-display text-sm font-semibold text-foreground">
            {draft.title}
          </h3>
          <p className="truncate text-xs text-muted-foreground">{draft.subtitle}</p>
        </div>
        <span className="shrink-0 rounded-full border border-border bg-card px-2 py-0.5 text-[11px] font-medium text-foreground">
          {format.label}
        </span>
      </div>

      {context.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 pt-3">
          {context.map((value) => (
            <Chip key={value}>{value}</Chip>
          ))}
        </div>
      )}

      <div className="px-4 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Outline
        </p>
        <ol className="mt-1.5 space-y-1">
          {draft.outline.map((heading, index) => (
            <li key={heading} className="flex gap-2 text-xs text-muted-foreground">
              <span className="w-4 shrink-0 text-right tabular-nums text-muted-foreground/70">
                {index + 1}.
              </span>
              <span className="min-w-0 truncate">{heading}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
        {status === "proposed" && (
          <>
            <Button size="sm" onClick={onGenerate}>
              <Sparkles /> Generate {format.label}
            </Button>
            <Button size="sm" variant="ghost" onClick={onCancel}>
              <X /> Cancel
            </Button>
            <span className="text-[11px] text-muted-foreground">
              Nothing is generated until you confirm.
            </span>
          </>
        )}

        {status === "generating" && (
          <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 size={14} className="animate-spin" /> Composing from your library…
          </span>
        )}

        {status === "ready" && file && (
          <>
            <Button size="sm" onClick={() => downloadDocument(file)}>
              <Download /> Download
            </Button>
            <span className="text-[11px] text-muted-foreground">
              {file.fileName} · {formatBytes(file.bytes)} · {file.pages}{" "}
              {draft.type === "pptx" ? "slides" : "pages"}
              {typeof state.sourceCount === "number"
                ? ` · built from ${state.sourceCount} passage${state.sourceCount === 1 ? "" : "s"}`
                : ""}
            </span>
          </>
        )}

        {status === "cancelled" && (
          <>
            <span className="text-xs italic text-muted-foreground">Nothing was generated.</span>
            <button
              type="button"
              onClick={onGenerate}
              className={`${FOCUS} rounded-lg px-2 py-1 text-xs font-medium text-primary underline underline-offset-4`}
            >
              Build it after all
            </button>
          </>
        )}

        {status === "error" && (
          <>
            <span
              role="alert"
              className="inline-flex items-center gap-1.5 text-xs text-destructive"
            >
              <AlertTriangle size={13} />
              {state.error ?? "Could not build that document."}
            </span>
            <Button size="sm" variant="outline" onClick={onGenerate}>
              Try again
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

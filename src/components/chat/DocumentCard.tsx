/**
 * The confirmation card. A draft is never generated until the user presses
 * Generate, and the card states that plainly. Mode (proposal or pitch deck) is
 * chosen here, and the finished card exposes the source audit per section.
 */
import {
  AlertTriangle,
  Download,
  Eye,
  File,
  FileText,
  Loader2,
  Presentation,
  Sparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DocumentPreviewDialog } from "./DocumentPreviewDialog";
import { downloadDocument } from "@/lib/documents/download";
import {
  DOCUMENT_FORMATS,
  formatBytes,
  type DocumentDraftState,
  type DocumentMode,
} from "@/lib/documents/types";
import { FOCUS } from "./theme";

const ICONS = { pdf: File, docx: FileText, pptx: Presentation } as const;

function Chip({ children }: { children: string }) {
  return (
    <span className="rounded-full border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground">
      {children}
    </span>
  );
}

const MODES: { id: DocumentMode; label: string; hint: string }[] = [
  { id: "proposal", label: "Proposal", hint: "Narrative document with evidence and next steps" },
  { id: "pitch", label: "Pitch deck", hint: "8-9 takeaway slides with speaker notes" },
];

export function DocumentCard({
  state,
  onGenerate,
  onCancel,
  onModeChange,
}: {
  state: DocumentDraftState;
  onGenerate: () => void;
  onCancel: () => void;
  onModeChange: (mode: DocumentMode) => void;
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

  const openItems = state.openItems ?? [];
  const warnings = state.warnings ?? [];

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

      {status === "proposed" && (
        <div className="px-4 pt-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Format
          </p>
          <div
            role="radiogroup"
            aria-label="Document mode"
            className="mt-1.5 grid grid-cols-2 gap-2"
          >
            {MODES.map((mode) => {
              const active = draft.mode === mode.id;
              return (
                <button
                  key={mode.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => onModeChange(mode.id)}
                  className={`${FOCUS} rounded-xl border px-3 py-2 text-left transition-colors ${
                    active
                      ? "border-primary bg-primary/5"
                      : "border-border bg-card hover:bg-secondary/60"
                  }`}
                >
                  <span className="block text-xs font-semibold text-foreground">{mode.label}</span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                    {mode.hint}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="px-4 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Outline
        </p>
        <ol className="mt-1.5 space-y-1">
          {draft.outline.map((outlineHeading, index) => (
            <li key={outlineHeading} className="flex gap-2 text-xs text-muted-foreground">
              <span className="w-4 shrink-0 text-right tabular-nums text-muted-foreground/70">
                {index + 1}.
              </span>
              <span className="min-w-0 truncate">{outlineHeading}</span>
            </li>
          ))}
        </ol>
        <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
          The final structure is generated from this conversation and the library, so headings may
          be tailored. Nothing is generated until you confirm.
        </p>
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
              Every claim is checked against the cited passages.
            </span>
          </>
        )}

        {status === "generating" && (
          <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 size={14} className="animate-spin" /> Briefing, retrieving and composing…
          </span>
        )}

        {status === "ready" && file && (
          <>
            <Button size="sm" onClick={() => downloadDocument(file)}>
              <Download /> Download
            </Button>
            <DocumentPreviewDialog
              file={file}
              type={draft.type}
              trigger={
                <Button size="sm" variant="outline">
                  <Eye /> View
                </Button>
              }
            />
            <span className="text-[11px] text-muted-foreground">
              {file.fileName} · {formatBytes(file.bytes)} · {file.pages}{" "}
              {draft.type === "pptx" ? "slides" : "pages"}
              {typeof state.sourceCount === "number"
                ? ` · ${state.sourceCount} source${state.sourceCount === 1 ? "" : "s"}`
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

      {status === "ready" && openItems.length > 0 && (
        <div className="border-t border-border bg-amber-50/60 px-4 py-3">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-amber-700">
            <AlertTriangle size={12} /> Open items to confirm before sending
          </p>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[11px] leading-snug text-amber-900">
            {openItems.slice(0, 8).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {status === "ready" && warnings.length > 0 && (
        <details className="border-t border-border px-4 py-2.5 text-[11px] text-muted-foreground">
          <summary className="cursor-pointer font-medium">
            Generation notes ({warnings.length})
          </summary>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
            {warnings.slice(0, 8).map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </details>
      )}

      {status === "ready" && state.trace && (
        <details className="border-t border-border px-4 py-2.5 text-[11px] text-muted-foreground">
          <summary className="cursor-pointer font-medium">
            Source audit — {state.trace.sections.length} sections, {state.trace.usedChunkIds.length}{" "}
            passages
          </summary>
          <div className="mt-2 space-y-2">
            {state.trace.brief.client || state.trace.brief.industry ? (
              <p>
                Brief: {state.trace.brief.client ?? "client not stated"} ·{" "}
                {state.trace.brief.industry ?? "industry not stated"}
              </p>
            ) : null}
            <ul className="space-y-1.5">
              {state.trace.sections.map((section) => (
                <li
                  key={section.id}
                  className="rounded-lg border border-border bg-secondary/30 p-2"
                >
                  <p className="font-medium text-foreground">{section.title}</p>
                  <p className="mt-0.5">
                    {section.chunkIds.length} passage{section.chunkIds.length === 1 ? "" : "s"}
                    {section.weak ? " · marked for completion" : ""}
                  </p>
                  <p className="mt-0.5 font-mono text-[10px] leading-snug break-words">
                    query: {section.query}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </details>
      )}
    </div>
  );
}

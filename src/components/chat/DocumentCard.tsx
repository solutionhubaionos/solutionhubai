/**
 * The confirmation card. A draft is never generated until the user presses
 * Generate, and the card states that plainly. Mode (proposal or pitch deck) is
 * chosen here, and the finished card exposes the source audit per section.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  Download,
  Eye,
  File,
  FileText,
  Loader2,
  Presentation,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ChipButton } from "./SelectionCard";
import { DocumentPreviewDialog } from "./DocumentPreviewDialog";
import { downloadDocument } from "@/lib/documents/download";
import { useIndustries } from "@/lib/industries";
import { useIndustryClients } from "@/lib/chat/clients";
import { supabase } from "@/integrations/supabase/client";
import {
  DOCUMENT_FORMATS,
  formatBytes,
  type DocumentDraftState,
  type DocumentMode,
} from "@/lib/documents/types";
import { FOCUS, eyebrowCls } from "./theme";

const ICONS = { pdf: File, docx: FileText, pptx: Presentation } as const;

function Chip({ children }: { children: string }) {
  return (
    <span className="rounded-full border border-border bg-card px-2 py-0.5 text-xs text-muted-foreground">
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
  const { user } = useRouteContext({ from: "/_authenticated" });
  const { industries } = useIndustries();
  const { clientsByIndustry } = useIndustryClients();
  const qc = useQueryClient();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [savedIndustry, setSavedIndustry] = useState("");
  /** Saving always names a sector first, then the industry inside it. */
  const [saveStep, setSaveStep] = useState<"sector" | "industry">("sector");
  const [saveSector, setSaveSector] = useState("");
  const [saveCustomer, setSaveCustomer] = useState("");
  const sectorName =
    industries.find((industry) => industry.slug === saveSector)?.name ?? saveSector;
  const sectorClients = saveSector ? (clientsByIndustry[saveSector] ?? []) : [];

  /** The dialog opens on the full sector list, with the draft's sector pre-picked. */
  function openSaveDialog() {
    setSaveSector(draft.industrySlug ?? "");
    setSaveCustomer(draft.client?.trim() ?? "");
    setSaveStep("sector");
    setUploadOpen(true);
  }
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

  /**
   * Saving is explicit. The file only ever exists in memory, so it reaches the
   * library solely from this confirmation: the sector and industry picked in the
   * dialog decide where it lands, and the chosen customer becomes the company
   * (industry-wide when none is picked). Same rows an upload from that industry
   * page writes, so the ingestion worker indexes it without a special path.
   */
  async function saveToLibrary() {
    if (!file || !saveSector || !user) return;
    setUploading(true);
    const customerName = saveCustomer.trim();
    const binary = globalThis.atob(file.base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    // Create the client folder in the chosen sector first. A name that already
    // exists (23505) is simply reused; any other failure is non-fatal, because
    // the document still lands with its customer_name.
    if (customerName) {
      const { error: folderError } = await supabase
        .from("customers")
        .insert({ industry: saveSector, name: customerName, created_by: user.id });
      if (!folderError || folderError.code === "23505") {
        void qc.invalidateQueries({ queryKey: ["chat-industry-clients"] });
      }
    }
    const safeName = file.fileName.replace(/[^\w.-]+/g, "_");
    const path = `${user.id}/${saveSector}/${crypto.randomUUID()}-${safeName}`;
    const uploaded = await supabase.storage
      .from("content")
      .upload(path, new Blob([bytes], { type: file.mimeType }), { contentType: file.mimeType });
    const failure = uploaded.error
      ? uploaded.error
      : (
          await supabase.from("content_items").insert({
            industry: saveSector,
            customer_name: customerName || null,
            title: draft.title,
            description: draft.subtitle || null,
            content_type: draft.type === "pptx" ? "pitch_deck" : "proposal",
            file_path: path,
            file_name: file.fileName,
            mime_type: file.mimeType,
            file_size: file.bytes,
            uploaded_by: user.id,
            uploader_email: user.email ?? null,
          })
        ).error;

    // A row without its bytes would be an unopenable library entry, so the
    // object is removed again when the metadata write is the part that failed.
    if (failure) {
      if (!uploaded.error) await supabase.storage.from("content").remove([path]);
      toast.error(failure.message || "Could not save this document to the library.");
      setUploading(false);
      return;
    }

    const label = customerName ? `${sectorName} · ${customerName}` : sectorName;
    setSavedIndustry(label);
    qc.invalidateQueries({ queryKey: ["content"] });
    toast.success(`Saved to ${label}`);
    setUploading(false);
    setUploadOpen(false);
  }

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
          <p className={eyebrowCls}>{heading}</p>
          <h3 className="truncate font-display text-sm font-semibold text-foreground">
            {draft.title}
          </h3>
          <p className="truncate text-xs text-muted-foreground">{draft.subtitle}</p>
        </div>
        <span className="shrink-0 rounded-full border border-border bg-card px-2 py-0.5 text-xs font-medium text-foreground">
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
          <p className={eyebrowCls}>Format</p>
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
                  <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                    {mode.hint}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {status === "proposed" && (
        <div className="px-4 py-3">
          <p className="text-xs leading-snug text-muted-foreground">
            The structure is built from this conversation and the library. Nothing is generated
            until you confirm.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
        {status === "proposed" && (
          <>
            <Button size="sm" onClick={onGenerate}>
              <Sparkles /> Generate {format.label}
            </Button>
            <Button size="sm" variant="ghost" onClick={onCancel}>
              <X /> Cancel
            </Button>
            <span className="text-xs text-muted-foreground">
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
                  <Eye /> Open
                </Button>
              }
            />
            {savedIndustry ? (
              <span className="inline-flex items-center gap-1 text-xs text-primary">
                <Check size={13} /> In library · {savedIndustry}
              </span>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={openSaveDialog}
                disabled={!user}
                title="Save this document to the library"
              >
                <Upload /> Save to library
              </Button>
            )}
            <span className="text-xs text-muted-foreground">
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
        <div className="border-t border-border bg-accent/10 px-4 py-3">
          <p className={`flex items-center gap-1.5 ${eyebrowCls}`}>
            <AlertTriangle size={12} className="shrink-0 text-accent-foreground" /> Open items to
            confirm before sending
          </p>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-xs leading-snug text-foreground">
            {openItems.slice(0, 8).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {status === "ready" && warnings.length > 0 && (
        <details className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
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

      {status === "ready" && file && (
        <Dialog
          open={uploadOpen}
          onOpenChange={(open) => {
            if (!uploading) setUploadOpen(open);
          }}
        >
          <DialogContent className="max-w-md" aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>Save to the library</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              Pick the sector, then the specific industry it belongs in.{" "}
              <span className="font-medium text-foreground">{file.fileName}</span> appears in the
              library like any other upload, and the ingestion worker extracts and embeds it in the
              background so later answers can cite it. Nothing is uploaded until you confirm.
            </p>

            {saveStep === "sector" ? (
              <div className="space-y-2">
                <p className={eyebrowCls}>1 · Sector</p>
                {industries.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No sectors are available yet.</p>
                ) : (
                  <div className="flex max-h-56 flex-wrap gap-1.5 overflow-y-auto">
                    {industries.map((industry) => (
                      <ChipButton
                        key={industry.slug}
                        label={industry.name}
                        active={industry.slug === saveSector}
                        onToggle={() => {
                          setSaveSector(industry.slug);
                          // A team's own draft keeps its customer; another
                          // sector starts as industry-wide content.
                          setSaveCustomer(
                            industry.slug === draft.industrySlug
                              ? (draft.client?.trim() ?? "")
                              : "",
                          );
                          setSaveStep("industry");
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className={eyebrowCls}>2 · Industry in {sectorName}</p>
                  <button
                    type="button"
                    onClick={() => setSaveStep("sector")}
                    className={`${FOCUS} rounded-md px-1.5 py-0.5 text-xs font-medium text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground`}
                  >
                    Change sector
                  </button>
                </div>
                <div className="flex max-h-56 flex-wrap gap-1.5 overflow-y-auto">
                  <ChipButton
                    label="Industry-wide"
                    active={saveCustomer.trim().length === 0}
                    onToggle={() => setSaveCustomer("")}
                  />
                  {sectorClients.map((name) => (
                    <ChipButton
                      key={name}
                      label={name}
                      active={saveCustomer.trim().toLowerCase() === name.trim().toLowerCase()}
                      onToggle={() => setSaveCustomer(name)}
                    />
                  ))}
                </div>
                <div className="space-y-1 pt-1">
                  <Label htmlFor="save-client" className="text-xs">
                    Client folder
                  </Label>
                  <Input
                    id="save-client"
                    maxLength={80}
                    value={saveCustomer}
                    onChange={(event) => setSaveCustomer(event.target.value)}
                    autoComplete="off"
                    name="save-client"
                    placeholder="Type a client to create its folder, e.g. Air India"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {saveCustomer.trim()
                    ? `Saves under ${sectorName} · ${saveCustomer.trim()}; if that client folder does not exist yet it is created.`
                    : `Pick a customer above, type a new one to create its folder, or leave empty to save as industry-wide content.`}
                </p>
              </div>
            )}

            <DialogFooter className="gap-2">
              <Button variant="ghost" onClick={() => setUploadOpen(false)} disabled={uploading}>
                Cancel
              </Button>
              <Button onClick={saveToLibrary} disabled={uploading || !saveSector}>
                {uploading ? <Loader2 className="animate-spin" /> : <Upload />}
                {uploading
                  ? "Uploading…"
                  : saveSector
                    ? `Upload to ${sectorName}${saveCustomer.trim() ? ` · ${saveCustomer.trim()}` : ""}`
                    : "Choose a sector"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {status === "ready" && state.trace && (
        <details className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
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
                  <p className="mt-0.5 font-mono text-[11px] leading-snug break-words">
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

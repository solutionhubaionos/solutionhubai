import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Download, Eye, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { type ContentItem } from "@/lib/content";
import { documentFormat } from "@/lib/document-format";
import { logActivity } from "@/lib/activity";
const PdfPreview = lazy(() =>
  import("@/components/PdfPreview").then((module) => ({ default: module.PdfPreview })),
);

export function FilePreviewDialog({ item, trigger }: { item: ContentItem; trigger?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next)
          void logActivity({
            event_type: "file_open",
            content_id: item.id,
            industry: item.industry,
          });
      }}
    >
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline">
            <Eye /> Open
          </Button>
        )}
      </DialogTrigger>
      <DialogContent
        className="flex h-[90dvh] w-[96vw] max-w-6xl flex-col gap-3 overflow-hidden p-4"
        aria-describedby={undefined}
      >
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle className="truncate">{item.title}</DialogTitle>
        </DialogHeader>
        {open && <FilePreview item={item} />}
      </DialogContent>
    </Dialog>
  );
}

function FilePreview({ item }: { item: ContentItem }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [url, setUrl] = useState("");
  const [blob, setBlob] = useState<Blob | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [frameReady, setFrameReady] = useState(false);
  const format = documentFormat(item.file_name, item.mime_type ?? "");

  useEffect(() => {
    let active = true;
    let objectUrl = "";
    void (async () => {
      try {
        const result = await supabase.storage.from("content").download(item.file_path);
        if (result.error) throw result.error;
        if (!active) return;
        const file =
          format === "pdf" ? new Blob([result.data], { type: "application/pdf" }) : result.data;
        objectUrl = URL.createObjectURL(file);
        setUrl(objectUrl);
        setBlob(file);
        if (format !== "docx" && format !== "pptx") setLoading(false);
      } catch {
        if (active) {
          setError("Could not open this file. Try again.");
          setLoading(false);
        }
      }
    })();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [item.file_path, format]);

  useEffect(() => {
    if (!blob || !frameReady || (format !== "docx" && format !== "pptx")) return;
    let active = true;
    void (async () => {
      try {
        const iframe = frame.current;
        const doc = iframe?.contentDocument;
        if (!iframe || !doc) throw new Error("Viewer unavailable");
        const host = doc.createElement("div");
        doc.body.replaceChildren(host);
        if (format === "docx") {
          const { renderAsync } = await import("docx-preview");
          if (!active) return;
          await renderAsync(blob, host, undefined, { breakPages: true, useBase64URL: true });
        } else {
          const { init } = await import("pptx-preview");
          if (!active) return;
          const width = Math.max(280, iframe.clientWidth - 20);
          const viewer = init(host, { width, height: (width * 9) / 16 });
          await viewer.preview(await blob.arrayBuffer());
        }
        if (active) setLoading(false);
      } catch {
        if (active) {
          setError("This document could not be displayed. You can download the original.");
          setLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [blob, format, frameReady]);

  return (
    <>
      <div className="flex shrink-0 items-center justify-between gap-3">
        <p className="truncate text-sm text-muted-foreground">{item.file_name}</p>
        <Button size="sm" variant="outline" disabled={!url} asChild>
          <a href={url || undefined} download={item.file_name}>
            <Download /> Download
          </a>
        </Button>
      </div>
      <div className="relative min-h-0 flex-1 overflow-auto rounded-md border bg-muted">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            Opening…
          </div>
        )}
        {error ? (
          <p role="alert" className="p-8 text-center text-destructive">
            {error}
          </p>
        ) : (
          <>
            {format === "pdf" && blob && (
              <Suspense
                fallback={
                  <Loader2 aria-label="Loading PDF viewer" className="m-8 h-5 w-5 animate-spin" />
                }
              >
                <PdfPreview blob={blob} />
              </Suspense>
            )}
            {(format === "docx" || format === "pptx") && (
              <iframe
                ref={frame}
                onLoad={() => setFrameReady(true)}
                title={item.file_name}
                sandbox="allow-same-origin"
                referrerPolicy="no-referrer"
                srcDoc={
                  "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data: blob:; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'\"></head><body></body></html>"
                }
                className="h-full w-full border-0"
              />
            )}
            {format === "image" && url && (
              <img src={url} alt={item.title} className="h-full w-full object-contain" />
            )}
            {format === "video" && url && <video src={url} controls className="h-full w-full" />}
            {format === "unsupported" && !loading && (
              <p className="p-8 text-center text-muted-foreground">
                {/\.(doc|ppt)$/i.test(item.file_name)
                  ? "This older Office format cannot be displayed here. Upload a PDF, DOCX or PPTX version to view it inline."
                  : "Preview is unavailable for this file type. Download the original to open it."}
              </p>
            )}
          </>
        )}
      </div>
    </>
  );
}

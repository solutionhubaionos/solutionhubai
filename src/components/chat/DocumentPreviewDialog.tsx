/**
 * In-app viewer for a document the assistant generated in this conversation.
 * The base64 payload is turned into a local blob on open, then rendered with
 * the same engines as library previews: PDF.js for PDF, docx-preview and
 * pptx-preview inside a script-disabled frame for Office files.
 *
 * Nothing is uploaded or written to Storage — the blob lives in this tab.
 */
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
import { downloadDocument } from "@/lib/documents/download";
import { formatBytes, type DocumentType, type GeneratedDocument } from "@/lib/documents/types";

const PdfPreview = lazy(() =>
  import("@/components/PdfPreview").then((module) => ({ default: module.PdfPreview })),
);

const FRAME_SRC =
  "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data: blob:; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'\"></head><body></body></html>";

function decodeDocument(file: GeneratedDocument): Blob {
  const binary = globalThis.atob(file.base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: file.mimeType });
}

export function DocumentPreviewDialog({
  file,
  type,
  trigger,
}: {
  file: GeneratedDocument;
  type: DocumentType;
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline">
            <Eye /> View
          </Button>
        )}
      </DialogTrigger>
      <DialogContent
        className="flex h-[90dvh] w-[96vw] max-w-6xl flex-col gap-3 overflow-hidden p-4"
        aria-describedby={undefined}
      >
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle className="truncate">{file.fileName}</DialogTitle>
        </DialogHeader>
        {open && <DocumentPreview file={file} type={type} />}
      </DialogContent>
    </Dialog>
  );
}

function DocumentPreview({ file, type }: { file: GeneratedDocument; type: DocumentType }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [loading, setLoading] = useState(type !== "pdf");
  const [error, setError] = useState("");
  const [frameReady, setFrameReady] = useState(false);

  useEffect(() => {
    setBlob(decodeDocument(file));
  }, [file]);

  useEffect(() => {
    if (!blob || !frameReady || (type !== "docx" && type !== "pptx")) return;
    let active = true;
    void (async () => {
      try {
        const iframe = frame.current;
        const doc = iframe?.contentDocument;
        if (!iframe || !doc) throw new Error("Viewer unavailable");
        const host = doc.createElement("div");
        doc.body.replaceChildren(host);
        if (type === "docx") {
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
          setError("This document could not be displayed. You can still download it.");
          setLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [blob, type, frameReady]);

  return (
    <>
      <div className="flex shrink-0 items-center justify-between gap-3">
        <p className="truncate text-sm text-muted-foreground">
          {formatBytes(file.bytes)} · {file.pages} {type === "pptx" ? "slides" : "pages"}
        </p>
        <Button size="sm" variant="outline" onClick={() => downloadDocument(file)}>
          <Download /> Download
        </Button>
      </div>
      <div className="relative min-h-0 flex-1 overflow-auto rounded-md border bg-muted">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" /> Opening…
          </div>
        )}
        {error ? (
          <p role="alert" className="p-8 text-center text-destructive">
            {error}
          </p>
        ) : (
          <>
            {type === "pdf" && blob && (
              <Suspense
                fallback={
                  <Loader2 aria-label="Loading PDF viewer" className="m-8 h-5 w-5 animate-spin" />
                }
              >
                <PdfPreview blob={blob} />
              </Suspense>
            )}
            {(type === "docx" || type === "pptx") && (
              <iframe
                ref={frame}
                onLoad={() => setFrameReady(true)}
                title={file.fileName}
                sandbox="allow-same-origin"
                referrerPolicy="no-referrer"
                srcDoc={FRAME_SRC}
                className="h-full w-full border-0"
              />
            )}
          </>
        )}
      </div>
    </>
  );
}

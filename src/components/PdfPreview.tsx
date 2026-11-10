import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PDFDocumentProxy } from "pdfjs-dist";

export function PdfPreview({ blob }: { blob: Blob }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  useEffect(() => {
    let active = true;
    let destroy: (() => void) | undefined;
    setBusy(true);
    setError("");
    setDocument(null);
    setPage(1);
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) });
        destroy = () => {
          void task.destroy();
        };
        const pdf = await task.promise;
        if (!active) return;
        setPages(pdf.numPages);
        setDocument(pdf);
      } catch {
        if (active) {
          setError("Could not display this PDF. Download the original to open it.");
          setBusy(false);
        }
      }
    })();
    return () => {
      active = false;
      destroy?.();
    };
  }, [blob]);
  useEffect(() => {
    if (!document) return;
    let active = true;
    let cancel: (() => void) | undefined;
    setBusy(true);
    setError("");
    void (async () => {
      try {
        const sheet = await document.getPage(page);
        const target = canvas.current;
        if (!active || !target) return;
        const viewport = sheet.getViewport({ scale: 1.5 });
        target.width = viewport.width;
        target.height = viewport.height;
        const render = sheet.render({ canvas: target, viewport });
        cancel = () => render.cancel();
        await render.promise;
        if (active) setBusy(false);
      } catch {
        if (active) {
          setError("Could not display this PDF page.");
          setBusy(false);
        }
      }
    })();
    return () => {
      active = false;
      cancel?.();
    };
  }, [document, page]);
  return (
    <div className="flex min-h-full flex-col items-center gap-4 p-3">
      <div className="sticky top-0 z-10 flex items-center gap-3 rounded-md border bg-background p-2">
        <Button
          size="icon"
          variant="ghost"
          disabled={busy || page <= 1}
          aria-label="Previous page"
          onClick={() => setPage((p) => p - 1)}
        >
          <ChevronLeft />
        </Button>
        <span className="text-sm">
          Page {page} of {pages || "…"}
        </span>
        <Button
          size="icon"
          variant="ghost"
          disabled={busy || page >= pages}
          aria-label="Next page"
          onClick={() => setPage((p) => p + 1)}
        >
          <ChevronRight />
        </Button>
      </div>
      {busy && <Loader2 className="h-5 w-5 animate-spin" aria-label="Rendering PDF" />}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <canvas
        ref={canvas}
        aria-label={`PDF page ${page}`}
        className="h-auto max-w-full shadow-sm"
      />
    </div>
  );
}

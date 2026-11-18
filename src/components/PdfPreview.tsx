import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PDFDocumentProxy } from "pdfjs-dist";

/**
 * PDF.js page viewer. The page is drawn on an explicit white background: a PDF
 * page carries no background of its own, so a transparent canvas shows whatever
 * sits behind it — which reads as a blank dark rectangle in dark browser themes
 * and in forced-dark modes. White paper is what the document actually means.
 *
 * The canvas is also owned here rather than by PDF.js: given a `canvas`, PDF.js
 * builds its own 2D context with `alpha: false`, and an opaque canvas starts out
 * black. Any interruption after that point — a worker that never answers, a
 * cancelled page, a render that never begins — paints nothing and leaves a solid
 * black page on screen. Papering the canvas white first and handing PDF.js that
 * same context means the page is white from its first pixel.
 */
function paperCanvas(
  target: HTMLCanvasElement,
  width: number,
  height: number,
): CanvasRenderingContext2D | null {
  target.width = Math.floor(width);
  target.height = Math.floor(height);
  const context = target.getContext("2d", { alpha: false });
  if (!context) return null;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, target.width, target.height);
  return context;
}

export function PdfPreview({ blob }: { blob: Blob }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [objectUrl, setObjectUrl] = useState("");
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
          setError("Could not display this PDF here. Open it in a new tab to read it.");
          setBusy(false);
        }
      }
    })();
    return () => {
      active = false;
      destroy?.();
    };
  }, [blob]);

  // A native-viewer fallback, so a PDF is never unreachable when the in-app
  // renderer cannot draw it. The URL is revoked with the blob.
  useEffect(() => {
    const url = URL.createObjectURL(blob);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
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
        const context = paperCanvas(target, viewport.width, viewport.height);
        if (!context) throw new Error("The PDF canvas is unavailable in this browser.");
        // `canvas: null` tells PDF.js to use the supplied context as-is instead
        // of building its own opaque one.
        const render = sheet.render({
          canvas: null,
          canvasContext: context,
          viewport,
          background: "#ffffff",
        });
        cancel = () => render.cancel();
        await render.promise;
        if (active) setBusy(false);
      } catch {
        if (active) {
          setError("Could not display this PDF page. Open it in a new tab to read it.");
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
        {objectUrl && (
          <Button size="sm" variant="ghost" asChild>
            <a href={objectUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink /> New tab
            </a>
          </Button>
        )}
      </div>
      {busy && !error && <Loader2 className="h-5 w-5 animate-spin" aria-label="Rendering PDF" />}
      {error && (
        <div className="flex flex-col items-center gap-3 text-center">
          <p role="alert" className="max-w-sm text-sm text-destructive">
            {error}
          </p>
          {objectUrl && (
            <Button size="sm" variant="outline" asChild>
              <a href={objectUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink /> Open the PDF in a new tab
              </a>
            </Button>
          )}
        </div>
      )}
      <canvas
        ref={canvas}
        aria-label={`PDF page ${page}`}
        aria-hidden={error.length > 0}
        className={`h-auto max-w-full bg-white shadow-sm ${error ? "hidden" : ""}`}
      />
    </div>
  );
}

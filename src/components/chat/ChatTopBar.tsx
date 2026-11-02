import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Download, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FOCUS } from "./theme";

/**
 * Route header. The breadcrumb and title sit quietly on the left; the two file
 * actions stay flush to the far right. The hairline only appears once the
 * transcript has scrolled underneath it.
 */
export function ChatTopBar({
  scrolled,
  onOpenNav,
  onDownload,
  canDownload,
  uploadTrigger,
}: {
  scrolled: boolean;
  onOpenNav: () => void;
  onDownload: () => void;
  canDownload: boolean;
  uploadTrigger: ReactNode;
}) {
  return (
    <header
      className={`relative z-30 shrink-0 border-b bg-background transition-colors duration-200 ${
        scrolled ? "border-border" : "border-transparent"
      }`}
    >
      <div className="flex h-14 w-full items-center gap-3 px-4 sm:px-6">
        <button
          type="button"
          onClick={onOpenNav}
          aria-label="Open navigation"
          className={`${FOCUS} -ml-1 grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-border bg-card text-muted-foreground transition-colors hover:bg-secondary lg:hidden`}
        >
          <Menu size={16} />
        </button>

        <div className="min-w-0 flex-1">
          <nav
            aria-label="Breadcrumb"
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            <Link
              to="/library"
              className={`${FOCUS} rounded transition-colors hover:text-foreground`}
            >
              Library
            </Link>
            <ChevronRight size={12} className="shrink-0 text-muted-foreground/60" />
            <span className="font-medium text-foreground">AI Search</span>
          </nav>
          <h1 className="mt-0.5 truncate font-display text-sm font-semibold text-foreground sm:text-base">
            Ask across your knowledge base
          </h1>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            onClick={onDownload}
            disabled={!canDownload}
            title={
              canDownload ? "Download this conversation" : "Start a conversation to download it"
            }
            aria-label="Download conversation"
            className="h-9 px-3.5"
          >
            <Download className="text-muted-foreground" />
            <span className="hidden sm:inline">Download</span>
          </Button>
          {uploadTrigger}
        </div>
      </div>
    </header>
  );
}

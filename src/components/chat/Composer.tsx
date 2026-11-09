import { useEffect, useRef, type ReactNode } from "react";
import { ArrowUp, File, FileSpreadsheet, FileText, Plus, Presentation } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FOCUS } from "./theme";

const TOOLS = [
  { id: "ppt", label: "Pitch deck (PowerPoint)", icon: Presentation },
  { id: "pdf", label: "PDF one-pager", icon: File },
  { id: "doc", label: "Word document", icon: FileText },
  { id: "sheet", label: "Spreadsheet maker", icon: FileSpreadsheet },
] as const;

/**
 * The composer card: context row on top, a textarea that grows with the draft,
 * and a footer with the generator menu and the send button. Enter sends;
 * Shift+Enter adds a line.
 */
export function Composer({
  value,
  onChange,
  onSend,
  isTyping,
  focusSignal,
  contextBar,
  onCreateTool,
  disabled = false,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  onSend: () => void;
  isTyping: boolean;
  /** Bumped by the page to hand focus back after New chat or an example pick. */
  focusSignal: number;
  contextBar: ReactNode;
  onCreateTool: (toolId: string) => void;
  /** Locked while the guided scope picker is waiting for a choice. */
  disabled?: boolean;
  placeholder?: string;
}) {
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // Height follows the content up to a cap, then the field scrolls.
  useEffect(() => {
    const element = areaRef.current;
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [value]);

  useEffect(() => {
    if (focusSignal === 0) return;
    areaRef.current?.focus();
  }, [focusSignal]);

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-card">
      {contextBar}
      <div className="px-3 pt-3">
        <textarea
          ref={areaRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            if (event.nativeEvent.isComposing) return;
            event.preventDefault();
            onSend();
          }}
          rows={1}
          disabled={disabled}
          aria-label="Ask the library a question"
          placeholder={placeholder ?? "Ask anything across your library…"}
          className={`${FOCUS} block max-h-[200px] w-full resize-none bg-transparent text-sm leading-relaxed text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60`}
        />
      </div>
      <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 pt-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-label="Create with AI"
              title="Create with AI"
              className={`${FOCUS} grid h-8 w-8 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50`}
            >
              <Plus size={16} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel>Create from the library</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {TOOLS.map((tool) => (
              <DropdownMenuItem key={tool.id} onSelect={() => onCreateTool(tool.id)}>
                <tool.icon /> {tool.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex items-center gap-3">
          <span className="hidden text-[11px] text-muted-foreground sm:inline">
            Enter to send · Shift+Enter for a new line
          </span>
          <Button
            size="icon"
            onClick={onSend}
            disabled={disabled || isTyping || value.trim().length === 0}
            aria-label="Send question"
            className="h-9 w-9 rounded-xl"
          >
            <ArrowUp />
          </Button>
        </div>
      </div>
    </div>
  );
}

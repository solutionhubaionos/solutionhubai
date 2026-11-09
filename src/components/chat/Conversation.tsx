import { useEffect, useRef, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, MessageSquare, Plus, Presentation, Sparkles } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { FilePreviewDialog } from "@/components/FilePreviewDialog";
import type { ContentItem } from "@/lib/content";
import type { ChatSource } from "@/lib/chat/answer";
import type { ExampleCard } from "@/lib/chat/scope";
import { FOCUS } from "./theme";
import { DocumentCard } from "./DocumentCard";
import type { ChatMessageView } from "./types";

/** Transcript. Owns its scroll anchor so new messages always land in view. */
export function Conversation({
  messages,
  isTyping,
  onNewChat,
  exampleCards,
  onExampleSelect,
  onGenerateDocument,
  onCancelDocument,
  intake,
}: {
  messages: ChatMessageView[];
  isTyping: boolean;
  onNewChat: () => void;
  exampleCards: ExampleCard[];
  onExampleSelect: (prompt: string) => void;
  onGenerateDocument: (messageId: string) => void;
  onCancelDocument: (messageId: string) => void;
  /** The guided sector/company picker, shown under the latest prompt. */
  intake?: ReactNode;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isTyping]);

  if (messages.length === 0) {
    return <EmptyState exampleCards={exampleCards} onExampleSelect={onExampleSelect} />;
  }

  const opening =
    messages.find((message) => message.role === "user")?.content ?? "New conversation";
  const hasUserMessage = messages.some((message) => message.role === "user");

  return (
    <section aria-label="Conversation" className="flex flex-col gap-4">
      {hasUserMessage && (
        <div className="flex items-center gap-3 px-1">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <MessageSquare size={14} className="shrink-0 text-muted-foreground" />
            <h2 className="truncate font-display text-sm font-semibold text-foreground">
              {opening}
            </h2>
            <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">
              {messages.length} {messages.length === 1 ? "message" : "messages"}
            </span>
          </div>
          <button
            onClick={onNewChat}
            className={`${FOCUS} inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary lg:hidden`}
          >
            <Plus size={13} />
            New chat
          </button>
        </div>
      )}

      <div
        role="log"
        aria-live="polite"
        aria-label="Conversation transcript"
        className="flex flex-col gap-5"
      >
        {messages.map((message) => (
          <Bubble
            key={message.id}
            message={message}
            onGenerateDocument={onGenerateDocument}
            onCancelDocument={onCancelDocument}
          />
        ))}
        {intake}
        {isTyping && <ThinkingRow />}
        <div ref={endRef} />
      </div>

      {!hasUserMessage && exampleCards.length > 0 && (
        <ExampleGrid exampleCards={exampleCards} onExampleSelect={onExampleSelect} />
      )}
    </section>
  );
}

/** The kind decides the icon and the word shown with it. */
const CARD_KINDS = {
  deck: { icon: Presentation, label: "Deck" },
  question: { icon: MessageSquare, label: "Question" },
} as const;

function EmptyState({
  exampleCards,
  onExampleSelect,
}: {
  exampleCards: ExampleCard[];
  onExampleSelect: (prompt: string) => void;
}) {
  return (
    <section className="flex min-h-0 flex-1 flex-col items-center justify-center px-1 py-4 text-center">
      <span className="mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-card sm:mb-5 sm:h-16 sm:w-16">
        <Sparkles size={26} />
      </span>

      <h1 className="text-balance font-display text-2xl font-bold text-foreground sm:text-3xl">
        How can I help today?
      </h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        Answers come from the files in your library, with the source passage cited under every
        reply.
      </p>

      {exampleCards.length > 0 && (
        <div className="mt-5 sm:mt-6">
          <ExampleGrid exampleCards={exampleCards} onExampleSelect={onExampleSelect} />
        </div>
      )}
    </section>
  );
}

/** The four starter cards, also shown under the greeting on a fresh chat. */
function ExampleGrid({
  exampleCards,
  onExampleSelect,
}: {
  exampleCards: ExampleCard[];
  onExampleSelect: (prompt: string) => void;
}) {
  return (
    <div className="w-full text-left">
      <p className="mb-2.5 text-center text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Try an example
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-2.5 lg:grid-cols-4">
        {exampleCards.map((card) => {
          const { icon: Icon, label } = CARD_KINDS[card.kind];
          return (
            <button
              key={card.prompt}
              onClick={() => onExampleSelect(card.prompt)}
              className={`${FOCUS} flex min-h-[76px] flex-col justify-between rounded-2xl border border-border bg-secondary/50 p-2.5 text-left transition-all duration-150 hover:-translate-y-px hover:bg-secondary`}
            >
              <span className="line-clamp-3 text-xs font-medium text-foreground">{card.label}</span>
              <span className="mt-2 flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="grid h-6 w-6 place-items-center rounded-lg bg-card text-primary shadow-sm"
                >
                  <Icon size={13} />
                </span>
                <span className="text-[11px] text-muted-foreground">{label}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Bubble({
  message,
  onGenerateDocument,
  onCancelDocument,
}: {
  message: ChatMessageView;
  onGenerateDocument: (messageId: string) => void;
  onCancelDocument: (messageId: string) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-foreground">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <span
        aria-hidden
        className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary"
      >
        <Sparkles size={15} />
      </span>
      <div className="min-w-0 max-w-[85%] space-y-3">
        {message.content.trim().length > 0 && (
          <div
            className={`rounded-2xl rounded-bl-md border border-border px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
              message.notice
                ? "bg-background italic text-muted-foreground"
                : "bg-card text-foreground"
            }`}
          >
            {message.content}
          </div>
        )}
        {message.document && (
          <DocumentCard
            state={message.document}
            onGenerate={() => onGenerateDocument(message.id)}
            onCancel={() => onCancelDocument(message.id)}
          />
        )}
        {message.sources && message.sources.length > 0 && <SourceList sources={message.sources} />}
      </div>
    </div>
  );
}

/** Cited passages, one chip per retrieved passage, each opening the real file. */
function SourceList({ sources }: { sources: ChatSource[] }) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Sources
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {sources.map((source) => (
          <li key={source.chunkId}>
            <SourceChip source={source} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The chip needs the full content row to open the shared preview dialog, so it
 * loads that row on demand. Until it arrives the chip is plain, non-interactive
 * text — never a control that does nothing.
 */
function SourceChip({ source }: { source: ChatSource }) {
  const { data: item } = useQuery({
    queryKey: ["content-item", source.contentId],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<ContentItem | null> => {
      const { data, error } = await supabase
        .from("content_items")
        .select("*")
        .eq("id", source.contentId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const where = source.page ? ` · p.${source.page}` : source.slide ? ` · s.${source.slide}` : "";
  const label = (
    <>
      <span className="font-semibold text-primary">[{source.citation}]</span>
      <FileText size={12} className="shrink-0 text-muted-foreground" />
      <span className="max-w-[220px] truncate">{source.title}</span>
      <span className="shrink-0 text-muted-foreground">{where}</span>
    </>
  );
  const className =
    "inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-foreground";

  if (!item) {
    return <span className={className}>{label}</span>;
  }

  return (
    <FilePreviewDialog
      item={item}
      trigger={
        <button
          type="button"
          className={`${FOCUS} ${className} transition-colors hover:bg-secondary`}
          title={`${source.fileName}${where}`}
        >
          {label}
        </button>
      }
    />
  );
}

/**
 * The assistant's pending turn: a message-shaped placeholder that says what is
 * happening, so a slow answer reads as work in progress rather than silence.
 * The composer also disables sending while this is on screen.
 */
function ThinkingRow() {
  return (
    <div className="flex gap-3" role="status" aria-live="polite">
      <span
        aria-hidden
        className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary"
      >
        <Sparkles size={15} />
      </span>
      <div className="inline-flex items-center gap-1.5 rounded-2xl rounded-bl-md border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
        <span>Thinking</span>
        <span className="flex items-center" aria-hidden>
          {[0, 160, 320].map((delay) => (
            <span
              key={delay}
              className="mx-0.5 h-1.5 w-1.5 animate-bounce rounded-full bg-primary motion-reduce:animate-none"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </span>
        <span className="sr-only">AI Search is forming an answer</span>
      </div>
    </div>
  );
}

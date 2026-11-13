import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Sparkles, UploadCloud, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { UploadDialog } from "@/components/UploadDialog";
import { useIndustries } from "@/lib/industries";
import { useIndustryClients } from "@/lib/chat/clients";
import { askLibrary, type AskLibraryResult } from "@/lib/chat/chat.functions";
import {
  DOCUMENT_SUGGESTION,
  INTAKE_GREETING,
  INITIAL_INTAKE,
  READY_QUESTION,
  SECTOR_QUESTION,
  SUGGESTION_MIN_ANSWERS,
  capabilityOptions,
  clientQuestion,
  clientsDone,
  documentTypesForCapabilities,
  isPickingScope,
  optionsDone,
  sectorsDone,
  type IntakeState,
} from "@/lib/chat/intake";
import {
  EMPTY_CONTEXT,
  contextSummary,
  examplePrompts,
  titleFromQuestion,
  type ChatContext,
} from "@/lib/chat/scope";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { ChatTopBar } from "@/components/chat/ChatTopBar";
import { Composer } from "@/components/chat/Composer";
import { ContextToolbar } from "@/components/chat/ContextToolbar";
import { Conversation } from "@/components/chat/Conversation";
import { SelectionCard } from "@/components/chat/SelectionCard";
import type { ChatMessageView } from "@/components/chat/types";
import { downloadDocument } from "@/lib/documents/download";
import { generateDocument } from "@/lib/documents/documents.functions";
import { buildDraft, detectDocumentType } from "@/lib/documents/intent";
import {
  DOCUMENT_FORMATS,
  type DocumentDraft,
  type DocumentDraftState,
  type DocumentType,
} from "@/lib/documents/types";

export const Route = createFileRoute("/_authenticated/chat")({
  head: () => ({
    meta: [
      { title: "AI Search — Solution Hub" },
      { name: "description", content: "Ask questions across the sales enablement library." },
      { property: "og:title", content: "AI Search — Solution Hub" },
      { property: "og:description", content: "Ask questions across the sales enablement library." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ChatPage,
});

/** The sidebar's two widths: the resting icon rail and the expanded overlay. */
const RAIL_WIDTH = 64;
const FULL_WIDTH = 280;
/** Turns of history sent with each question; older turns stay in the transcript. */
const HISTORY_TURNS = 6;
/** Exports read the whole conversation, not just the recent chat turns. */
const DOCUMENT_HISTORY_TURNS = 40;

type ChatThread = {
  id: string;
  title: string;
  messages: ChatMessageView[];
  intake: IntakeState;
  /** Tools picked on the opening card, e.g. a deck or a proposal. */
  capabilities: string[];
  dismissedSuggestion?: boolean;
};

/** A fresh chat opens with the assistant's greeting already in the transcript. */
function greetingThread(): ChatThread {
  return {
    id: crypto.randomUUID(),
    title: "New conversation",
    messages: [{ id: crypto.randomUUID(), role: "assistant", content: INTAKE_GREETING }],
    intake: INITIAL_INTAKE,
    capabilities: [],
  };
}

/** Only keyboard focus holds the sidebar open — a click shouldn't pin it. */
function isKeyboardFocus(element: Element) {
  try {
    return element.matches(":focus-visible");
  } catch {
    return false;
  }
}

function ChatPage() {
  const { industries } = useIndustries();
  const { clientsByIndustry } = useIndustryClients();

  const [context, setContext] = useState<ChatContext>(EMPTY_CONTEXT);
  const [threads, setThreads] = useState<ChatThread[]>(() => [greetingThread()]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [focusSignal, setFocusSignal] = useState(0);
  const [scrolled, setScrolled] = useState(false);

  const [drawerOpen, setDrawerOpen] = useState(false);
  // Sidebar shell: rests as a rail and expands as an overlay on hover, keyboard
  // focus-within, an open popover inside it, or a coarse-pointer tap.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [tapped, setTapped] = useState(false);
  const [coarse, setCoarse] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  // Whether hover can expand the rail at all: a coarse pointer never fires it.
  useEffect(() => {
    const query = window.matchMedia("(hover: none) and (pointer: coarse)");
    const sync = () => setCoarse(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  // After a coarse tap opens the rail, a tap anywhere else closes it again.
  useEffect(() => {
    if (!coarse || !tapped) return;
    const onDown = (event: MouseEvent) => {
      if (!sidebarRef.current?.contains(event.target as Node)) setTapped(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [coarse, tapped]);

  const setContextValue = useCallback(
    <K extends keyof ChatContext>(key: K, next: ChatContext[K]) => {
      setContext((previous) => ({ ...previous, [key]: next }));
    },
    [],
  );

  const industryNames = useMemo(
    () => industries.map((industry) => ({ slug: industry.slug, name: industry.name })),
    [industries],
  );

  const industryNameBySlug = useMemo(
    () => Object.fromEntries(industryNames.map((industry) => [industry.slug, industry.name])),
    [industryNames],
  );

  const allClients = useMemo(
    () => [...new Set(Object.values(clientsByIndustry).flat())].sort((a, b) => a.localeCompare(b)),
    [clientsByIndustry],
  );

  const summary = useMemo(
    () => contextSummary(context, industryNameBySlug),
    [context, industryNameBySlug],
  );

  const cards = useMemo(
    () =>
      examplePrompts(context, {
        industries: industryNames
          .filter((i) => context.industries.includes(i.slug))
          .map((i) => i.name),
        clients: context.clients,
      }),
    [context, industryNames],
  );

  const activeThread = threads.find((thread) => thread.id === activeId) ?? threads[0] ?? null;
  const messages = activeThread?.messages ?? [];
  const intake = activeThread?.intake ?? INITIAL_INTAKE;
  const picking = isPickingScope(intake);

  const appendMessage = useCallback((threadId: string, message: ChatMessageView) => {
    setThreads((previous) =>
      previous.map((thread) =>
        thread.id === threadId ? { ...thread, messages: [...thread.messages, message] } : thread,
      ),
    );
  }, []);

  /** Patches one document card in place; the transcript is the only state. */
  const updateDocument = useCallback((messageId: string, patch: Partial<DocumentDraftState>) => {
    setThreads((previous) =>
      previous.map((thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.id === messageId && message.document
            ? { ...message, document: { ...message.document, ...patch } }
            : message,
        ),
      })),
    );
  }, []);

  const documentGeneration = useMutation({
    mutationFn: (payload: {
      messageId: string;
      draft: DocumentDraft;
      history: { role: "user" | "assistant"; content: string }[];
    }) => generateDocument({ data: { draft: payload.draft, history: payload.history } }),
    onSuccess: (result, payload) => {
      if (!result.ok) {
        updateDocument(payload.messageId, { status: "error", error: result.error });
        return;
      }
      updateDocument(payload.messageId, {
        status: "ready",
        file: result.file,
        sourceCount: result.sourceCount,
        openItems: result.openItems,
        warnings: result.warnings,
        trace: result.trace,
      });
      downloadDocument(result.file);
    },
    onError: (_error, payload) => {
      updateDocument(payload.messageId, {
        status: "error",
        error: "Document generation failed. Please try again.",
      });
    },
  });

  const generateForMessage = useCallback(
    (messageId: string) => {
      const target = activeThread?.messages.find((message) => message.id === messageId);
      if (!target?.document || target.document.status === "generating") return;
      const history = (activeThread?.messages ?? [])
        .filter(
          (message) => !message.notice && !message.document && message.content.trim().length > 0,
        )
        .slice(-DOCUMENT_HISTORY_TURNS)
        .map((message) => ({
          role: message.role,
          content: message.content,
          ...(message.sources && message.sources.length > 0
            ? {
                sources: message.sources.map((source) => ({
                  title: source.title,
                  contentId: source.contentId,
                  chunkId: source.chunkId,
                })),
              }
            : {}),
        }));
      updateDocument(messageId, { status: "generating", error: null });
      documentGeneration.mutate({ messageId, draft: target.document.draft, history });
    },
    [activeThread, documentGeneration, updateDocument],
  );

  const cancelDocument = useCallback(
    (messageId: string) => updateDocument(messageId, { status: "cancelled" }),
    [updateDocument],
  );

  /** Proposal / pitch deck is chosen on the card, before anything is built. */
  const changeDocumentMode = useCallback((messageId: string, mode: "proposal" | "pitch") => {
    setThreads((previous) =>
      previous.map((thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.id === messageId && message.document
            ? {
                ...message,
                document: {
                  ...message.document,
                  draft: { ...message.document.draft, mode },
                },
              }
            : message,
        ),
      })),
    );
  }, []);

  /** Starts a draft from the "+" menu or the suggestion using current context. */
  const startDocument = useCallback(
    (type: DocumentType) => {
      if (!activeThread) return;
      const threadId = activeThread.id;
      const draft = buildDraft({
        prompt: `Create a ${DOCUMENT_FORMATS[type].noun}`,
        type,
        context,
        industryNames: industryNameBySlug,
      });
      if (!activeThread.messages.some((message) => message.role === "user")) {
        setThreads((previous) =>
          previous.map((thread): ChatThread =>
            thread.id === threadId
              ? { ...thread, title: `${DOCUMENT_FORMATS[type].label} request` }
              : thread,
          ),
        );
      }
      appendMessage(threadId, {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
        document: { draft, status: "proposed" },
      });
    },
    [activeThread, appendMessage, context, industryNameBySlug],
  );

  /**
   * The final turn of the intake: the ready prompt, plus a confirmable draft for
   * every document tool picked on the opening card. Nothing is generated until
   * the user presses Generate on a card.
   */
  const completeIntake = useCallback(
    (nextContext: ChatContext, capabilities: readonly string[]): ChatMessageView[] => {
      const messages: ChatMessageView[] = [
        { id: crypto.randomUUID(), role: "assistant", content: READY_QUESTION },
      ];
      for (const type of documentTypesForCapabilities(capabilities)) {
        messages.push({
          id: crypto.randomUUID(),
          role: "assistant",
          content: "",
          document: {
            draft: buildDraft({
              prompt: `Create a ${DOCUMENT_FORMATS[type].noun}`,
              type,
              context: nextContext,
              industryNames: industryNameBySlug,
            }),
            status: "proposed",
          },
        });
      }
      return messages;
    },
    [industryNameBySlug],
  );

  /** Opening card Done: remember the tools, then ask which sectors to cover. */
  const finishOptions = useCallback(
    (selected: string[]) => {
      const thread = activeThread;
      if (!thread || thread.intake.stage !== "options") return;

      setThreads((previous) =>
        previous.map((item): ChatThread =>
          item.id === thread.id
            ? {
                ...item,
                capabilities: selected,
                intake: optionsDone(),
                messages: [
                  ...item.messages,
                  { id: crypto.randomUUID(), role: "assistant", content: SECTOR_QUESTION },
                ],
              }
            : item,
        ),
      );
    },
    [activeThread],
  );

  /** Sector Done: remember the picks, then walk through each sector's companies. */
  const finishSectors = useCallback(
    (selected: string[]) => {
      const thread = activeThread;
      if (!thread || thread.intake.stage !== "sectors") return;

      const nextContext: ChatContext = { ...context, industries: selected, clients: [] };
      setContext(nextContext);
      const next = sectorsDone(selected);
      const firstName =
        next.stage === "clients" ? (industryNameBySlug[next.current] ?? next.current) : "";
      const followUp: ChatMessageView[] =
        next.stage === "clients"
          ? [{ id: crypto.randomUUID(), role: "assistant", content: clientQuestion(firstName) }]
          : completeIntake(nextContext, thread.capabilities);

      setThreads((previous) =>
        previous.map((item): ChatThread =>
          item.id === thread.id
            ? { ...item, intake: next, messages: [...item.messages, ...followUp] }
            : item,
        ),
      );
    },
    [activeThread, completeIntake, context, industryNameBySlug],
  );

  /** Company Done: add the picks and advance to the next selected sector. */
  const finishClients = useCallback(
    (selected: string[]) => {
      const thread = activeThread;
      if (!thread || thread.intake.stage !== "clients") return;

      const nextContext: ChatContext =
        selected.length > 0
          ? { ...context, clients: [...new Set([...context.clients, ...selected])] }
          : context;
      if (selected.length > 0) setContext(nextContext);

      const next = clientsDone(thread.intake.queue);
      const nextName =
        next.stage === "clients" ? (industryNameBySlug[next.current] ?? next.current) : "";
      const followUp: ChatMessageView[] =
        next.stage === "clients"
          ? [{ id: crypto.randomUUID(), role: "assistant", content: clientQuestion(nextName) }]
          : completeIntake(nextContext, thread.capabilities);

      setThreads((previous) =>
        previous.map((item): ChatThread =>
          item.id === thread.id
            ? { ...item, intake: next, messages: [...item.messages, ...followUp] }
            : item,
        ),
      );
    },
    [activeThread, completeIntake, context, industryNameBySlug],
  );

  const industryOptions = useMemo(
    () => industries.map((industry) => ({ value: industry.slug, label: industry.name })),
    [industries],
  );

  const clientOptions = useMemo(
    () =>
      intake.stage === "clients"
        ? (clientsByIndustry[intake.current] ?? []).map((name) => ({ value: name, label: name }))
        : [],
    [clientsByIndustry, intake],
  );

  const picker = (() => {
    if (intake.stage === "options") {
      return (
        <SelectionCard
          key="intake-options"
          title="What would you like to do?"
          options={capabilityOptions}
          skipLabel="Skip"
          onDone={finishOptions}
          onSkip={() => finishOptions([])}
        />
      );
    }
    if (intake.stage === "sectors") {
      return (
        <SelectionCard
          key="intake-sectors"
          title="Sectors & industries"
          options={industryOptions}
          onDone={finishSectors}
          onSkip={() => finishSectors([])}
        />
      );
    }
    if (intake.stage === "clients") {
      const currentName = industryNameBySlug[intake.current] ?? intake.current;
      return (
        <SelectionCard
          key={`intake-clients-${intake.current}`}
          title={`${currentName} companies`}
          options={clientOptions}
          emptyLabel={`No companies are listed under ${currentName} yet. You can still continue.`}
          skipLabel={`Skip ${currentName}`}
          onDone={finishClients}
          onSkip={() => finishClients([])}
        />
      );
    }
    return null;
  })();

  const ask = useMutation({
    mutationFn: (payload: {
      threadId: string;
      question: string;
      history: { role: "user" | "assistant"; content: string }[];
    }) => askLibrary({ data: { question: payload.question, context, history: payload.history } }),
    onSuccess: (result: AskLibraryResult, payload) => {
      if (!result.ok) {
        appendMessage(payload.threadId, {
          id: crypto.randomUUID(),
          role: "assistant",
          notice: true,
          content: result.error,
        });
        return;
      }
      appendMessage(payload.threadId, {
        id: crypto.randomUUID(),
        role: "assistant",
        content: result.answer,
        sources: result.sources,
        notice: !result.grounded,
      });
    },
    onError: (_error, payload) => {
      appendMessage(payload.threadId, {
        id: crypto.randomUUID(),
        role: "assistant",
        notice: true,
        content: "AI Search is unavailable right now. Please try again in a moment.",
      });
    },
  });

  const send = useCallback(() => {
    const question = input.trim();
    if (!question || ask.isPending || !activeThread) return;
    if (isPickingScope(activeThread.intake)) return;

    const threadId = activeThread.id;

    // The first typed line names the conversation in the sidebar.
    if (!activeThread.messages.some((message) => message.role === "user")) {
      setThreads((previous) =>
        previous.map((thread): ChatThread =>
          thread.id === threadId ? { ...thread, title: titleFromQuestion(question) } : thread,
        ),
      );
    }

    const history = activeThread.messages
      .filter((message) => !message.notice && !message.document)
      .slice(-HISTORY_TURNS)
      .map((message) => ({ role: message.role, content: message.content }));

    appendMessage(threadId, { id: crypto.randomUUID(), role: "user", content: question });
    setInput("");

    // "Create a pitch deck" becomes a draft to confirm, never an instant file.
    const documentType = detectDocumentType(question);
    if (documentType) {
      appendMessage(threadId, {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
        document: {
          draft: buildDraft({
            prompt: question,
            type: documentType,
            context,
            industryNames: industryNameBySlug,
          }),
          status: "proposed",
        },
      });
      return;
    }

    ask.mutate({ threadId, question, history });
  }, [activeThread, appendMessage, ask, context, industryNameBySlug, input]);

  const newChat = useCallback(() => {
    const pristine =
      activeThread !== null &&
      !activeThread.messages.some((message) => message.role === "user" || message.document);
    if (!pristine) {
      const thread = greetingThread();
      setThreads((previous) => [thread, ...previous]);
      setActiveId(thread.id);
      setContext(EMPTY_CONTEXT);
    }
    setInput("");
    setFocusSignal((signal) => signal + 1);
  }, [activeThread]);

  // An example card drops its prompt into the composer for editing — never sends.
  const useExample = useCallback((prompt: string) => {
    setInput(prompt);
    setFocusSignal((signal) => signal + 1);
  }, []);

  // The "+" menu opens a draft the user has to confirm, exactly like a typed
  // request; the sheet maker is the one tool still unconnected.
  const onCreateTool = useCallback(
    (toolId: string) => {
      if (toolId === "ppt") return startDocument("pptx");
      if (toolId === "doc") return startDocument("docx");
      if (toolId === "pdf") return startDocument("pdf");
      toast("Spreadsheet maker isn’t connected yet", {
        description: "Decks, PDFs and Word documents can be created from this menu.",
      });
    },
    [startDocument],
  );

  const downloadTranscript = useCallback(() => {
    if (!activeThread || activeThread.messages.length === 0) return;
    const body = activeThread.messages
      .map((message) => `${message.role === "user" ? "You" : "AI Search"}: ${message.content}`)
      .join("\n\n");
    const url = URL.createObjectURL(new Blob([body], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${activeThread.title.replace(/[^\w -]+/g, "").trim() || "ai-search-chat"}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  }, [activeThread]);

  const groundedAnswers = messages.filter(
    (message) => message.role === "assistant" && (message.sources?.length ?? 0) > 0,
  ).length;
  const showSuggestion =
    activeThread !== null &&
    intake.stage === "complete" &&
    !activeThread.dismissedSuggestion &&
    groundedAnswers >= SUGGESTION_MIN_ANSWERS &&
    !ask.isPending;

  const dismissSuggestion = useCallback(() => {
    if (!activeThread) return;
    const threadId = activeThread.id;
    setThreads((previous) =>
      previous.map((thread): ChatThread =>
        thread.id === threadId ? { ...thread, dismissedSuggestion: true } : thread,
      ),
    );
  }, [activeThread]);

  const expanded = hovered || focused || overlayOpen || tapped;

  const sidebar = (options: {
    expanded: boolean;
    onNavigate?: () => void;
    showCloseButton?: boolean;
  }) => (
    <ChatSidebar
      expanded={options.expanded}
      chats={threads
        .filter((thread) =>
          thread.messages.some((message) => message.role === "user" || message.document),
        )
        .map((thread) => ({ id: thread.id, title: thread.title }))}
      activeChatId={activeThread?.id ?? null}
      onSelectChat={setActiveId}
      onNewChat={newChat}
      onOverlayOpenChange={setOverlayOpen}
      {...(options.onNavigate ? { onNavigate: options.onNavigate } : {})}
      {...(options.showCloseButton ? { showCloseButton: true } : {})}
    />
  );

  return (
    <div className="relative flex h-dvh overflow-hidden bg-background">
      {/* Desktop offset: a constant rail width. Expansion is an overlay, so the
          content never moves while the sidebar animates. */}
      <div aria-hidden className="hidden shrink-0 lg:block" style={{ width: RAIL_WIDTH }} />

      {/* ---------- sidebar (lg and up) ---------- */}
      <aside
        ref={sidebarRef}
        aria-label="Navigation"
        onMouseEnter={() => {
          if (!coarse) setHovered(true);
        }}
        onMouseLeave={() => {
          if (!coarse) setHovered(false);
        }}
        onFocusCapture={(event) => {
          if (isKeyboardFocus(event.target as Element)) setFocused(true);
        }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
        }}
        onClick={() => {
          if (coarse && !expanded) setTapped(true);
        }}
        className="absolute inset-y-0 left-0 z-30 hidden flex-col overflow-hidden border-r border-border bg-sidebar transition-[width] duration-200 ease-out motion-reduce:transition-none lg:flex"
        style={{ width: expanded ? FULL_WIDTH : RAIL_WIDTH }}
      >
        {sidebar({ expanded })}
      </aside>

      {/* ---------- slide-over drawer (below lg) ---------- */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-ink/40 backdrop-blur-sm"
            onClick={() => setDrawerOpen(false)}
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-border bg-sidebar"
          >
            {sidebar({
              expanded: true,
              onNavigate: () => setDrawerOpen(false),
              showCloseButton: true,
            })}
          </aside>
        </div>
      )}

      {/* ---------- main column ---------- */}
      <main className="relative z-10 flex min-w-0 flex-1 flex-col bg-background">
        <ChatTopBar
          scrolled={scrolled}
          onOpenNav={() => setDrawerOpen(true)}
          onDownload={downloadTranscript}
          canDownload={messages.length > 0}
          uploadTrigger={
            <UploadDialog
              trigger={
                <Button className="h-9 px-3.5" aria-label="Upload content" title="Upload content">
                  <UploadCloud />
                  <span className="hidden sm:inline">Upload</span>
                </Button>
              }
            />
          }
        />

        <div
          className="flex-1 overflow-y-auto"
          onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 4)}
        >
          <div
            className={`mx-auto flex min-h-full w-full flex-col gap-3 px-4 py-4 sm:px-6 ${
              messages.length === 0 ? "max-w-3xl" : "max-w-4xl"
            }`}
          >
            <div className="flex min-h-0 flex-1 flex-col">
              <Conversation
                messages={messages}
                isTyping={ask.isPending}
                onNewChat={newChat}
                exampleCards={cards}
                onExampleSelect={useExample}
                onGenerateDocument={generateForMessage}
                onCancelDocument={cancelDocument}
                onDocumentModeChange={changeDocumentMode}
                intake={picker}
              />
            </div>
          </div>
        </div>

        {/* Pinned composer — the context row lives inside the card. */}
        <div className="relative z-20 shrink-0 border-t border-border bg-background">
          <div className="mx-auto w-full max-w-5xl px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:px-6">
            {showSuggestion && (
              <div
                role="status"
                className="mb-2 flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-foreground"
              >
                <Sparkles size={14} className="shrink-0 text-primary" aria-hidden />
                <p className="min-w-0 flex-1">{DOCUMENT_SUGGESTION}</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 shrink-0 px-2 text-xs"
                  onClick={() => startDocument("pptx")}
                >
                  Make a deck
                </Button>
                <button
                  type="button"
                  onClick={dismissSuggestion}
                  aria-label="Dismiss document suggestion"
                  className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                >
                  <X size={13} />
                </button>
              </div>
            )}

            <Composer
              value={input}
              onChange={setInput}
              onSend={send}
              isTyping={ask.isPending}
              focusSignal={focusSignal}
              onCreateTool={onCreateTool}
              disabled={picking}
              {...(picking
                ? {
                    placeholder:
                      intake.stage === "options"
                        ? "Choose what you need above to continue…"
                        : "Finish choosing your scope to continue…",
                  }
                : {})}
              contextBar={
                <ContextToolbar
                  value={context}
                  onChange={setContextValue}
                  onReset={() => setContext(EMPTY_CONTEXT)}
                  clients={allClients}
                  industries={industries}
                  summary={summary}
                />
              }
            />
          </div>
        </div>
      </main>
    </div>
  );
}

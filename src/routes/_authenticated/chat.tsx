import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { UploadDialog } from "@/components/UploadDialog";
import { useIndustries } from "@/lib/industries";
import { useIndustryClients } from "@/lib/chat/clients";
import { askLibrary, type AskLibraryResult } from "@/lib/chat/chat.functions";
import {
  INTAKE_GREETING,
  INITIAL_INTAKE,
  READY_QUESTION,
  SECTOR_QUESTION,
  capabilityOptions,
  capabilitySummary,
  clientQuestion,
  clientsDone,
  isPickingScope,
  optionsDone,
  sectorsDone,
  urlDone,
  urlQuestion,
  type IntakeState,
} from "@/lib/chat/intake";
import {
  EMPTY_CONTEXT,
  contextSummary,
  examplePrompts,
  normaliseWebsite,
  titleFromQuestion,
  type ChatContext,
} from "@/lib/chat/scope";
import {
  EMPTY_SCOPE,
  contextFromScope,
  mergeScopeWithContext,
  normalizeScope,
  scopePillLabels,
  reorderTargetClients,
  withPrimaryTargetInfo,
  withPrimaryTargetName,
  withPrimaryTargetWebsite,
  type ConversationScope,
  type TargetClient,
} from "@/lib/chat/conversationScope";
import { loadConversationScope, saveConversationScope } from "@/lib/chat/scope.functions";
import { analyzeTargetSite } from "@/lib/documents/logo.functions";
import { stopRequest } from "@/lib/documents/cancel.functions";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { ChatTopBar } from "@/components/chat/ChatTopBar";
import { Composer } from "@/components/chat/Composer";
import { ContextToolbar } from "@/components/chat/ContextToolbar";
import { Conversation } from "@/components/chat/Conversation";
import { SelectionCard } from "@/components/chat/SelectionCard";
import { ScopeBar } from "@/components/chat/ScopeBar";
import { ExportHint } from "@/components/chat/ExportHint";
import type { ChatMessageView } from "@/components/chat/types";
import { generateDocument, planDocument } from "@/lib/documents/documents.functions";
import { SHOW_EXPORT_CONFIRM, buildDraft, detectExportIntent } from "@/lib/documents/intent";
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
  validateSearch: (search: Record<string, unknown>): { c?: string } =>
    typeof search["c"] === "string" ? { c: search["c"] } : {},
  component: ChatPage,
});

/** The sidebar's two widths: the resting icon rail and the expanded overlay. */
const RAIL_WIDTH = 64;
const FULL_WIDTH = 280;
/** Turns of history sent with each question; older turns stay in the transcript. */
const HISTORY_TURNS = 6;
/** Exports read the whole conversation, not just the recent chat turns. */
const DOCUMENT_HISTORY_TURNS = 40;

/** The opening tools, phrased as the user's own sentence once Done is clicked. */
type ChatThread = {
  /** Also the persisted conversation id, so its scope can be loaded later. */
  id: string;
  title: string;
  messages: ChatMessageView[];
  intake: IntakeState;
  /** Steps already taken, for Undo: the state and message count before each one. */
  intakeUndo?: { state: IntakeState; messages: number }[];
};

/** A fresh chat opens with the assistant's greeting already in the transcript. */
function greetingThread(): ChatThread {
  return {
    id: crypto.randomUUID(),
    title: "New conversation",
    messages: [{ id: crypto.randomUUID(), role: "assistant", content: INTAKE_GREETING }],
    intake: INITIAL_INTAKE,
  };
}

/**
 * Moves the intake to its next step, appending the echoed user message and the
 * assistant's follow-up, and remembering the previous step so Undo can return.
 */
function advanceThread(
  thread: ChatThread,
  next: IntakeState,
  appended: ChatMessageView[],
): ChatThread {
  return {
    ...thread,
    intake: next,
    intakeUndo: [
      ...(thread.intakeUndo ?? []),
      { state: thread.intake, messages: thread.messages.length },
    ],
    messages: [...thread.messages, ...appended],
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
  const { user } = Route.useRouteContext();
  const userId = user.id;

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

  // The scope lives with the conversation on the server, so it survives a
  // reload and a later session of the same chat; the client only displays it.
  const conversationId = activeThread?.id ?? "";
  const scopeQuery = useQuery({
    queryKey: ["conversation-scope", conversationId],
    enabled: conversationId.length > 0,
    staleTime: 30_000,
    queryFn: async (): Promise<ConversationScope> => {
      const result = await loadConversationScope({ data: { conversationId } });
      return result.ok ? normalizeScope(result.scope) : EMPTY_SCOPE;
    },
  });
  const queryClient = useQueryClient();
  const scope = scopeQuery.data ?? EMPTY_SCOPE;
  const scopeLabels = useMemo(
    () => scopePillLabels(scope, industryNameBySlug),
    [scope, industryNameBySlug],
  );

  /** Saves an edited scope for this conversation; it applies from the next turn. */
  const persistScope = useCallback(
    (next: ConversationScope) => {
      if (!conversationId) return;
      const withStamp: ConversationScope = normalizeScope({
        ...next,
        // The target client is never dropped by an unrelated scope edit.
        targetClients:
          next.targetClients ??
          queryClient.getQueryData<ConversationScope>(["conversation-scope", conversationId])
            ?.targetClients ??
          [],
        updatedAt: new Date().toISOString(),
      });
      const key = ["conversation-scope", conversationId];
      const previous = queryClient.getQueryData<ConversationScope>(key);
      queryClient.setQueryData(key, withStamp);
      // Mirror into the composer context so drafts and example prompts follow
      // the same selection, and clearing the scope really clears the filters.
      setContext((rest) =>
        contextFromScope(withStamp, {
          personas: rest.personas,
          sectors: rest.sectors,
          website: rest.website,
        }),
      );
      const failed = () => {
        if (previous) queryClient.setQueryData(key, previous);
        toast("Could not save the selected scope", {
          description: "The previous selection is still active.",
        });
      };
      // A rejected server call and an `ok: false` result both mean the scope is
      // not stored, so exports would silently fall back to the house theme.
      return saveConversationScope({
        data: {
          conversationId,
          scope: {
            industries: withStamp.industries,
            companies: withStamp.companies,
            targetClients: withStamp.targetClients,
            updatedAt: withStamp.updatedAt,
          },
        },
      })
        .then((result) => {
          if (!result.ok) {
            failed();
            return false;
          }
          return true;
        })
        .catch(() => {
          failed();
          return false;
        });
    },
    [conversationId, queryClient],
  );

  /**
   * The website field above the composer stores the target's URL on the primary
   * target and detects its logo, which the deck puts on the first slide.
   */
  const syncTargetWebsite = useCallback(
    async (raw: string) => {
      const website = normaliseWebsite(raw);
      if (!website || !conversationId) return;
      const read = () =>
        queryClient.getQueryData<ConversationScope>(["conversation-scope", conversationId]) ??
        scope;
      const current = read();
      if (!current.targetClients[0]) return;
      if (current.targetClients[0].websiteUrl !== website) {
        await persistScope(withPrimaryTargetWebsite(current, website));
      }
      if (read().targetClients[0]?.logo) return;
      try {
        const result = await analyzeTargetSite({ data: { url: website } });
        if (!result.ok) return;
        await persistScope(
          withPrimaryTargetInfo(read(), {
            logo: result.logo
              ? {
                  dataUrl: result.logo.dataUrl,
                  light: result.logo.light,
                  aspect: result.logo.width / result.logo.height,
                }
              : null,
            siteText: result.siteText,
          }),
        );
      } catch (error) {
        // No logo/site text is fine; the cover falls back to the client's name.
        console.warn("[SITE] analyze failed", error);
      }
    },
    [conversationId, persistScope, queryClient, scope],
  );

  /** Tracks the website save so an export cannot read the target before it lands. */
  const websiteSyncRef = useRef<Promise<void> | null>(null);
  const queueTargetWebsite = useCallback(
    (website: string) => {
      const task = syncTargetWebsite(website);
      websiteSyncRef.current = task;
      void task.finally(() => {
        if (websiteSyncRef.current === task) websiteSyncRef.current = null;
      });
      return task;
    },
    [syncTargetWebsite],
  );

  /** Edits the pitched client from the composer row and re-points the target. */
  const setTargetName = useCallback(
    (name: string) => {
      if (!conversationId) return;
      const current =
        queryClient.getQueryData<ConversationScope>(["conversation-scope", conversationId]) ??
        scope;
      const next = withPrimaryTargetName(current, name);
      if (next === current) return;
      void persistScope(next);
      const primary = next.targetClients[0];
      if (primary?.websiteUrl) void queueTargetWebsite(primary.websiteUrl);
    },
    [conversationId, persistScope, queryClient, queueTargetWebsite, scope],
  );

  /** In-flight server requests, so Stop can cancel them at the source. */
  const activeRequestsRef = useRef<Map<string, AbortController>>(new Map());
  const trackRequest = useCallback((id: string, controller: AbortController) => {
    activeRequestsRef.current.set(id, controller);
  }, []);
  const untrackRequest = useCallback((id: string) => {
    activeRequestsRef.current.delete(id);
  }, []);
  /** Stops every running request server-side and cancels its client fetch. */
  const cancelActiveRequests = useCallback(() => {
    for (const [id, controller] of activeRequestsRef.current) {
      void stopRequest({ data: { requestId: id } });
      controller.abort();
    }
    activeRequestsRef.current.clear();
  }, []);

  const navigate = Route.useNavigate();
  const search = Route.useSearch();

  /** Opening a conversation also puts its id in the URL, so the scope survives. */
  const openThread = useCallback(
    (threadId: string) => {
      setActiveId(threadId);
      void navigate({ to: "/chat", search: { c: threadId }, replace: true });
    },
    [navigate],
  );

  // A conversation id in the URL reopens that conversation — and with it the
  // stored scope — even in a fresh tab, where the transcript restarts empty.
  useEffect(() => {
    const id = search.c;
    if (!id) return;
    setThreads((previous) =>
      previous.some((thread) => thread.id === id)
        ? previous
        : [
            {
              id,
              title: "Resumed conversation",
              messages: [{ id: crypto.randomUUID(), role: "assistant", content: INTAKE_GREETING }],
              intake: { stage: "complete" },
            },
            ...previous,
          ],
    );
    setActiveId(id);
  }, [search.c]);

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
    mutationFn: async (payload: {
      messageId: string;
      draft: DocumentDraft;
      history: { role: "user" | "assistant"; content: string }[];
    }) => {
      // A website just entered in the toolbar may still be saving; wait for the
      // target row to carry it before the server reads the scope.
      await websiteSyncRef.current;
      const requestId = crypto.randomUUID();
      const controller = new AbortController();
      trackRequest(requestId, controller);
      try {
        return await generateDocument({
          data: {
            draft: payload.draft,
            history: payload.history,
            requestId,
            ...(conversationId ? { conversationId } : {}),
            industryNames: industryNameBySlug,
          },
          signal: controller.signal,
        });
      } finally {
        untrackRequest(requestId);
      }
    },
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
    },
    onError: (error, payload) => {
      // A Stop aborts the fetch; that is not a failure to report.
      if (error instanceof Error && error.name === "AbortError") return;
      const detail = error instanceof Error ? error.message.trim() : "";
      updateDocument(payload.messageId, {
        status: "error",
        error: detail
          ? `Document generation failed: ${detail}`
          : "Document generation failed. Please try again.",
      });
    },
  });

  /**
   * The confirm card shows the outline the model planned from the conversation,
   * not the sector template. Planning runs once per proposed card (and again
   * when the mode changes); Generate always uses whatever is on the card.
   */
  const documentPlanning = useMutation({
    mutationFn: async (payload: {
      messageId: string;
      draft: DocumentDraft;
      mode: DocumentDraft["mode"];
      history: {
        role: "user" | "assistant";
        content: string;
        sources?: { title: string; contentId?: string | null; chunkId?: string | null }[];
      }[];
    }) => {
      const requestId = crypto.randomUUID();
      const controller = new AbortController();
      trackRequest(requestId, controller);
      try {
        return await planDocument({
          data: {
            prompt: payload.draft.prompt,
            type: payload.draft.type,
            mode: payload.mode,
            context,
            industryNames: industryNameBySlug,
            requestId,
            ...(conversationId ? { conversationId } : {}),
            history: payload.history,
          },
          signal: controller.signal,
        });
      } finally {
        untrackRequest(requestId);
      }
    },
    onSuccess: (result, payload) => {
      if (!result.ok) return;
      updateDocument(payload.messageId, {
        draft: {
          ...payload.draft,
          mode: payload.mode,
          title: result.title,
          outline: result.outline,
          outlinePlan: result.outlinePlan,
        },
      });
    },
  });

  useEffect(() => {
    if (!activeThread) return;
    const history = activeThread.messages
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

    for (const message of activeThread.messages) {
      const document = message.document;
      if (!document || document.status !== "proposed" || document.planning) continue;
      updateDocument(message.id, { planning: true });
      documentPlanning.mutate({
        messageId: message.id,
        draft: document.draft,
        mode: document.draft.mode,
        history,
      });
    }
  }, [activeThread, documentPlanning, updateDocument]);

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
                  planning: false,
                },
              }
            : message,
        ),
      })),
    );
  }, []);

  /**
   * Appends a draft for an explicit request. With SHOW_EXPORT_CONFIRM false the
   * request builds straight away; the composer hint only prefills text, so no
   * document is ever generated without a user asking for it.
   */
  const startExport = useCallback(
    (
      threadId: string,
      draft: DocumentDraft,
      history: { role: "user" | "assistant"; content: string }[],
    ) => {
      const messageId = crypto.randomUUID();
      appendMessage(threadId, {
        id: messageId,
        role: "assistant",
        content: "",
        document: { draft, status: SHOW_EXPORT_CONFIRM ? "proposed" : "generating" },
      });
      if (!SHOW_EXPORT_CONFIRM) documentGeneration.mutate({ messageId, draft, history });
    },
    [appendMessage, documentGeneration],
  );

  /** Starts a draft from the "+" menu, using current context. */
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
      const messageId = crypto.randomUUID();
      appendMessage(threadId, {
        id: messageId,
        role: "assistant",
        content: "",
        document: { draft, status: SHOW_EXPORT_CONFIRM ? "proposed" : "generating" },
      });
      if (!SHOW_EXPORT_CONFIRM) {
        documentGeneration.mutate({ messageId, draft, history: [] });
      }
    },
    [activeThread, appendMessage, context, documentGeneration, industryNameBySlug],
  );

  /**
   * The final turn of the intake: only the ready prompt. Finishing the wizard
   * never proposes or builds a document; generation waits for an explicit
   * request, and one slim hint above the composer explains that.
   */
  const completeIntake = useCallback(
    (): ChatMessageView[] => [
      { id: crypto.randomUUID(), role: "assistant", content: READY_QUESTION },
    ],
    [],
  );

  /** Opening card Done: tools are informational only, so just ask for sectors. */
  const finishOptions = useCallback(
    (selected: string[]) => {
      const thread = activeThread;
      if (!thread || thread.intake.stage !== "options") return;

      const summary = capabilitySummary(selected);

      setThreads((previous) =>
        previous.map((item): ChatThread =>
          item.id === thread.id
            ? advanceThread(item, optionsDone(), [
                { id: crypto.randomUUID(), role: "user", content: summary },
                { id: crypto.randomUUID(), role: "assistant", content: SECTOR_QUESTION },
              ])
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
      // The picked sectors are the conversation's scope from here on: whole
      // industries until companies are added below.
      persistScope(
        mergeScopeWithContext(
          {
            industries: selected,
            companies: [],
            targetClients: scope.targetClients,
            updatedAt: null,
          },
          nextContext,
        ),
      );
      const next = sectorsDone(selected);
      const firstName =
        next.stage === "clients" ? (industryNameBySlug[next.current] ?? next.current) : "";
      const pickedNames = selected.map((slug) => industryNameBySlug[slug] ?? slug);
      const userMessage: ChatMessageView = {
        id: crypto.randomUUID(),
        role: "user",
        content: pickedNames.length ? pickedNames.join(", ") : "All sectors",
      };
      const followUp: ChatMessageView[] =
        next.stage === "clients"
          ? [{ id: crypto.randomUUID(), role: "assistant", content: clientQuestion(firstName) }]
          : completeIntake();

      setThreads((previous) =>
        previous.map((item): ChatThread =>
          item.id === thread.id ? advanceThread(item, next, [userMessage, ...followUp]) : item,
        ),
      );
    },
    [activeThread, completeIntake, context, industryNameBySlug, persistScope, scope.targetClients],
  );

  /**
   * Client Done: this is the company we are PITCHING. It is stored as the target
   * client, never as an evidence company, because a new prospect is normally
   * absent from the library and must not filter retrieval.
   */
  const finishClients = useCallback(
    (selected: string[]) => {
      const thread = activeThread;
      if (!thread || thread.intake.stage !== "clients") return;
      const currentIndustry = thread.intake.current;

      if (selected.length > 0) {
        const existing = scope.targetClients;
        // A URL typed before the client was chosen is already in the composer
        // context; it belongs on the target so the deck can pick up its logo.
        const website = normaliseWebsite(context.website);
        const selectedClients: TargetClient[] = selected.map(
          (name) =>
            existing.find((client) => client.name.toLowerCase() === name.toLowerCase()) ?? {
              name,
              websiteUrl: website || null,
              logo: null,
              siteText: null,
              industry: currentIndustry,
              anonymise: true,
              includePriorWork: false,
              notes: "",
            },
        );
        persistScope({
          ...scope,
          // The newest pick becomes the primary target (index 0); generation and
          // the website/logo steps always read index 0.
          targetClients: reorderTargetClients(existing, selectedClients),
          updatedAt: new Date().toISOString(),
        });
        if (website) void queueTargetWebsite(website);
      }

      const primaryName = selected[0] ?? null;
      const next = clientsDone(primaryName, thread.intake.queue);
      const nextName =
        next.stage === "clients" ? (industryNameBySlug[next.current] ?? next.current) : "";
      const userMessage: ChatMessageView = {
        id: crypto.randomUUID(),
        role: "user",
        content: selected.length ? selected.join(", ") : "No specific client yet",
      };
      const followUp: ChatMessageView[] =
        next.stage === "clients"
          ? [{ id: crypto.randomUUID(), role: "assistant", content: clientQuestion(nextName) }]
          : next.stage === "url"
            ? [{ id: crypto.randomUUID(), role: "assistant", content: urlQuestion(next.name) }]
            : completeIntake();

      setThreads((previous) =>
        previous.map((item): ChatThread =>
          item.id === thread.id ? advanceThread(item, next, [userMessage, ...followUp]) : item,
        ),
      );
    },
    [
      activeThread,
      completeIntake,
      context.website,
      industryNameBySlug,
      persistScope,
      queueTargetWebsite,
      scope,
    ],
  );

  /** URL Done: store the website on the target (pulls logo + a short read). */
  const finishUrl = useCallback(
    (values: string[]) => {
      const thread = activeThread;
      if (!thread || thread.intake.stage !== "url") return;
      const website = normaliseWebsite(values[0] ?? "");
      if (website) {
        setContextValue("website", website);
        void queueTargetWebsite(website);
      }
      const next = urlDone(thread.intake.queue);
      const nextName =
        next.stage === "clients" ? (industryNameBySlug[next.current] ?? next.current) : "";
      const userMessage: ChatMessageView = {
        id: crypto.randomUUID(),
        role: "user",
        content: website || "No website for them yet",
      };
      const followUp: ChatMessageView[] =
        next.stage === "clients"
          ? [{ id: crypto.randomUUID(), role: "assistant", content: clientQuestion(nextName) }]
          : completeIntake();

      setThreads((previous) =>
        previous.map((item): ChatThread =>
          item.id === thread.id ? advanceThread(item, next, [userMessage, ...followUp]) : item,
        ),
      );
    },
    [activeThread, completeIntake, industryNameBySlug, queueTargetWebsite, setContextValue],
  );

  /** Undo the last intake step: restore its previous state and trim its messages. */
  const undoIntake = useCallback(() => {
    const thread = activeThread;
    if (!thread) return;
    const stack = thread.intakeUndo ?? [];
    const last = stack[stack.length - 1];
    if (!last) return;
    setThreads((previous) =>
      previous.map((item): ChatThread =>
        item.id === thread.id
          ? {
              ...item,
              intake: last.state,
              messages: item.messages.slice(0, last.messages),
              intakeUndo: stack.slice(0, -1),
            }
          : item,
      ),
    );
  }, [activeThread]);

  const canUndo = (activeThread?.intakeUndo?.length ?? 0) > 0;

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
          options={capabilityOptions}
          large
          skipLabel="Skip"
          onDone={finishOptions}
          onSkip={() => finishOptions([])}
          {...(canUndo ? { onUndo: undoIntake } : {})}
        />
      );
    }
    if (intake.stage === "sectors") {
      return (
        <SelectionCard
          key="intake-sectors"
          title="Sectors & industries"
          options={industryOptions}
          initial={scope.industries}
          freeTextLabel="Other industry"
          freeTextPlaceholder="Type your own, e.g. Airports"
          freeTextAction="Use industry"
          onDone={finishSectors}
          onSkip={() => finishSectors([])}
          {...(canUndo ? { onUndo: undoIntake } : {})}
        />
      );
    }
    if (intake.stage === "clients") {
      const currentName = industryNameBySlug[intake.current] ?? intake.current;
      return (
        <SelectionCard
          key={`intake-clients-${intake.current}`}
          title={`Who are you pitching in ${currentName}?`}
          options={clientOptions}
          emptyLabel={`No ${currentName} companies are in the library yet — type the client below.`}
          skipLabel={`Skip ${currentName}`}
          freeTextLabel="Client you're pitching"
          freeTextPlaceholder="Type any company, e.g. Zurich Airport"
          freeTextAction="Use as new client"
          onDone={finishClients}
          onSkip={() => finishClients([])}
          {...(canUndo ? { onUndo: undoIntake } : {})}
        />
      );
    }
    if (intake.stage === "url") {
      return (
        <SelectionCard
          key={`intake-url-${intake.name}`}
          title={`${intake.name}'s website`}
          options={[]}
          freeTextLabel="Client website"
          freeTextPlaceholder="acme.com"
          freeTextAction="Set website"
          skipLabel="Skip website"
          onDone={finishUrl}
          onSkip={() => finishUrl([])}
          {...(canUndo ? { onUndo: undoIntake } : {})}
        />
      );
    }
    return null;
  })();

  const ask = useMutation({
    mutationFn: async (payload: {
      threadId: string;
      question: string;
      history: { role: "user" | "assistant"; content: string }[];
    }) => {
      const requestId = crypto.randomUUID();
      const controller = new AbortController();
      trackRequest(requestId, controller);
      try {
        return await askLibrary({
          data: {
            question: payload.question,
            context,
            industryNames: industryNameBySlug,
            requestId,
            ...(conversationId ? { conversationId } : {}),
            history: payload.history,
          },
          signal: controller.signal,
        });
      } finally {
        untrackRequest(requestId);
      }
    },
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
        ...(result.addedEntities && result.addedEntities.length > 0
          ? { addedEntities: result.addedEntities }
          : {}),
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

    // Only an explicit request (verb + format) starts an export; merely naming a
    // deck, or finishing the wizard, never does.
    const intent = detectExportIntent(question, history);
    if (intent) {
      startExport(
        threadId,
        {
          ...buildDraft({
            prompt: question,
            type: intent.type,
            context,
            industryNames: industryNameBySlug,
          }),
          mode: intent.mode,
        },
        history,
      );
      return;
    }

    ask.mutate({ threadId, question, history });
  }, [activeThread, appendMessage, ask, context, industryNameBySlug, input, startExport]);

  const newChat = useCallback(() => {
    const pristine =
      activeThread !== null &&
      !activeThread.messages.some((message) => message.role === "user" || message.document);
    if (!pristine) {
      const thread = greetingThread();
      setThreads((previous) => [thread, ...previous]);
      openThread(thread.id);
      setContext(EMPTY_CONTEXT);
    }
    setInput("");
    setFocusSignal((signal) => signal + 1);
  }, [activeThread, openThread]);

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

  // One slim hint above the composer, remembered per user once dismissed.
  const hintKey = `export-hint-dismissed:${userId}`;
  const [hintDismissed, setHintDismissed] = useState(false);
  useEffect(() => {
    try {
      setHintDismissed(window.localStorage.getItem(hintKey) === "1");
    } catch {
      setHintDismissed(false);
    }
  }, [hintKey]);
  const dismissHint = useCallback(() => {
    setHintDismissed(true);
    try {
      window.localStorage.setItem(hintKey, "1");
    } catch {
      // Private mode: the hint returns next visit, which is harmless.
    }
  }, [hintKey]);

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
      onSelectChat={openThread}
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

        {/* What this conversation is scoped to, editable at any time. */}
        <ScopeBar
          labels={scopeLabels}
          sectors={scope.industries}
          companies={scope.companies.map((company) => company.canonicalName)}
          industryOptions={industryOptions}
          companyOptions={allClients.map((name) => ({ value: name, label: name }))}
          onSave={({ industries: pickedSectors, companies: pickedCompanies }) =>
            persistScope({
              industries: pickedSectors,
              targetClients: scope.targetClients,
              companies: pickedCompanies.map((name) => ({
                id:
                  scope.companies.find(
                    (company) => company.canonicalName.toLowerCase() === name.toLowerCase(),
                  )?.id ?? null,
                canonicalName: name,
                industry:
                  scope.companies.find(
                    (company) => company.canonicalName.toLowerCase() === name.toLowerCase(),
                  )?.industry ??
                  pickedSectors[0] ??
                  null,
              })),
              updatedAt: new Date().toISOString(),
            })
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
                onAddToScope={(names) =>
                  persistScope({
                    ...scope,
                    companies: [
                      ...scope.companies,
                      ...names
                        .filter(
                          (name) =>
                            !scope.companies.some(
                              (company) =>
                                company.canonicalName.toLowerCase() === name.toLowerCase(),
                            ),
                        )
                        .map((name) => ({ id: null, canonicalName: name, industry: null })),
                    ],
                    updatedAt: new Date().toISOString(),
                  })
                }
              />
            </div>
          </div>
        </div>

        {/* Pinned composer — the context row lives inside the card. */}
        <div className="relative z-20 shrink-0 border-t border-border bg-background">
          <div className="mx-auto w-full max-w-5xl px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:px-6">
            {!hintDismissed && <ExportHint onPrefill={useExample} onDismiss={dismissHint} />}

            <Composer
              value={input}
              onChange={setInput}
              onSend={send}
              isTyping={ask.isPending}
              busy={
                ask.isPending ||
                documentGeneration.isPending ||
                documentPlanning.isPending ||
                messages.some((message) => message.document?.status === "generating")
              }
              onStop={() => {
                // Cancel server-side first (abort the in-flight model calls),
                // then reset the client mutations.
                cancelActiveRequests();
                ask.reset();
                documentGeneration.reset();
                documentPlanning.reset();
                const threadId = activeThread?.id;
                if (threadId) {
                  setThreads((previous) =>
                    previous.map((item): ChatThread =>
                      item.id === threadId
                        ? {
                            ...item,
                            messages: item.messages.map((message) =>
                              message.document && message.document.status === "generating"
                                ? {
                                    ...message,
                                    document: { ...message.document, status: "cancelled" as const },
                                  }
                                : message,
                            ),
                          }
                        : item,
                    ),
                  );
                }
                toast("Stopped");
              }}
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
                  onCommit={(website) => {
                    setContextValue("website", website);
                    void queueTargetWebsite(website);
                  }}
                  onReset={() => {
                    setContext(EMPTY_CONTEXT);
                    persistScope(EMPTY_SCOPE);
                  }}
                  clients={allClients}
                  industries={industries}
                  summary={summary}
                  targetClient={scope.targetClients[0]?.name ?? ""}
                  onTargetClient={setTargetName}
                />
              }
            />
          </div>
        </div>
      </main>
    </div>
  );
}

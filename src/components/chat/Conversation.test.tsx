import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ChatSource } from "@/lib/chat/answer";
import { EMPTY_CONTEXT, type ExampleCard } from "@/lib/chat/scope";
import { buildDraft } from "@/lib/documents/intent";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    }),
  },
}));

import { Conversation } from "./Conversation";

// jsdom has no layout, so the transcript's scroll anchor needs a stub.
Element.prototype.scrollIntoView = vi.fn();

const cards: ExampleCard[] = [
  { kind: "deck", label: "Pitch deck for Airlines", prompt: "Build a pitch deck for Airlines." },
  { kind: "question", label: "What have we delivered?", prompt: "What have we delivered?" },
];

const source: ChatSource = {
  citation: 1,
  chunkId: "chunk-1",
  contentId: "content-1",
  title: "United brief",
  fileName: "united.docx",
  industry: "airlines",
  customerName: "United Airlines",
  page: 3,
  slide: null,
  snippet: "United Next expands the fleet.",
};

function renderConversation(ui: React.ReactElement) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

describe("Conversation", () => {
  it("offers the example cards and never sends on click", () => {
    const onExampleSelect = vi.fn();
    const onNewChat = vi.fn();
    renderConversation(
      <Conversation
        messages={[]}
        isTyping={false}
        onNewChat={onNewChat}
        exampleCards={cards}
        onExampleSelect={onExampleSelect}
        onGenerateDocument={vi.fn()}
        onCancelDocument={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "How can I help today?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Pitch deck for Airlines/ }));
    expect(onExampleSelect).toHaveBeenCalledWith("Build a pitch deck for Airlines.");
    expect(onNewChat).not.toHaveBeenCalled();
  });

  it("renders the transcript, the answer and its numbered sources", async () => {
    renderConversation(
      <Conversation
        messages={[
          { id: "1", role: "user", content: "Tell me about United Next." },
          {
            id: "2",
            role: "assistant",
            content: "United Next expands the fleet [1].",
            sources: [source],
          },
        ]}
        isTyping={false}
        onNewChat={vi.fn()}
        exampleCards={cards}
        onExampleSelect={vi.fn()}
        onGenerateDocument={vi.fn()}
        onCancelDocument={vi.fn()}
      />,
    );

    const log = screen.getByRole("log");
    expect(within(log).getByText("Tell me about United Next.")).toBeInTheDocument();
    expect(screen.getByText("United Next expands the fleet [1].")).toBeInTheDocument();
    expect(screen.getByText("Sources")).toBeInTheDocument();
    expect(await screen.findByText("United brief")).toBeInTheDocument();
    expect(screen.getByText("· p.3")).toBeInTheDocument();
  });

  it("shows a thinking indicator while a turn is in flight", () => {
    renderConversation(
      <Conversation
        messages={[{ id: "1", role: "user", content: "Anything?" }]}
        isTyping
        onNewChat={vi.fn()}
        exampleCards={cards}
        onExampleSelect={vi.fn()}
        onGenerateDocument={vi.fn()}
        onCancelDocument={vi.fn()}
      />,
    );
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("AI Search is forming an answer");
  });

  it("waits for confirmation before generating a document", () => {
    const onGenerateDocument = vi.fn();
    const draft = buildDraft({
      prompt: "Create a pitch deck",
      type: "pptx",
      context: EMPTY_CONTEXT,
    });

    renderConversation(
      <Conversation
        messages={[
          {
            id: "doc-1",
            role: "assistant",
            content: "",
            document: { draft, status: "proposed" },
          },
        ]}
        isTyping={false}
        onNewChat={vi.fn()}
        exampleCards={cards}
        onExampleSelect={vi.fn()}
        onGenerateDocument={onGenerateDocument}
        onCancelDocument={vi.fn()}
      />,
    );

    expect(screen.getByText("Nothing is generated until you confirm.")).toBeInTheDocument();
    expect(onGenerateDocument).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Generate PowerPoint deck/ }));
    expect(onGenerateDocument).toHaveBeenCalledWith("doc-1");
  });
});

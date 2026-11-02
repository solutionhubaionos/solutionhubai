import type { ChatSource } from "@/lib/chat/answer";
import type { DocumentDraftState } from "@/lib/documents/types";

/** One rendered turn. `notice` marks a system line rather than an answer. */
export type ChatMessageView = {
  id: string;
  role: "user" | "assistant";
  content: string;
  notice?: boolean;
  sources?: ChatSource[];
  /** Present when this turn proposes or delivers a generated document. */
  document?: DocumentDraftState;
};

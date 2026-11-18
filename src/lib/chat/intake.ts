/**
 * The guided opening of a chat: greet, ask what the user wants to do, then which
 * sectors/industries they care about, then walk through the companies of each
 * selected sector one at a time, and only then invite the actual question.
 *
 * The state is kept pure so the sequence can be tested without a browser. The
 * picked tools are informational, the picked sectors become the conversation's
 * scope industries and the picked companies its scope companies, which is what
 * retrieval and exports filter on.
 */
import type { DocumentType } from "../documents/types";

export type IntakeState =
  | { stage: "options" }
  | { stage: "sectors" }
  | { stage: "clients"; current: string; queue: string[] }
  | { stage: "complete" };

export const INITIAL_INTAKE: IntakeState = { stage: "options" };

export const INTAKE_GREETING = "Hey! How can I help you today?";

export const SECTOR_QUESTION =
  "Which specific sectors or industries are you looking for? Select one or more, then choose Done.";

export const READY_QUESTION =
  "Ok, now that I have enough context. What can I help you with? You can ask about anything in these files, or tell me to create a deck, proposal or PDF.";

/** The work types offered on the opening card, in display order. */
export type Capability = {
  id: string;
  label: string;
  /**
   * The format this tool maps to, if any. Informational only: finishing the
   * intake never proposes a document, and generation waits for an explicit ask.
   */
  type: DocumentType | null;
};

export const CAPABILITIES: Capability[] = [
  { id: "research", label: "Research", type: null },
  { id: "deck", label: "Create Pitch Deck", type: "pptx" },
  { id: "proposal", label: "Create a Proposal", type: "docx" },
  { id: "onepager", label: "Create a PDF one-pager", type: "pdf" },
];

export const capabilityOptions: { value: string; label: string }[] = CAPABILITIES.map(
  (capability) => ({ value: capability.id, label: capability.label }),
);

export function clientQuestion(industryName: string): string {
  return `Who are you pitching in ${industryName}? Pick an existing company, or type the new client's name — a prospect that isn't in the library is the normal case.`;
}

/** True while the transcript is waiting on a picker rather than typing. */
export function isPickingScope(state: IntakeState): boolean {
  return state.stage === "options" || state.stage === "sectors" || state.stage === "clients";
}

/** After the opening card the scope questions always follow, even on Skip. */
export function optionsDone(): IntakeState {
  return { stage: "sectors" };
}

/**
 * Moves from "pick sectors" to the first sector's companies. An empty pick
 * skips straight to the ready prompt, so a user can search the whole library.
 */
export function sectorsDone(selected: readonly string[]): IntakeState {
  const [current, ...queue] = selected;
  return current ? { stage: "clients", current, queue } : { stage: "complete" };
}

/** Advances to the next selected sector, or completes the intake. */
export function clientsDone(queue: readonly string[]): IntakeState {
  const [current, ...rest] = queue;
  return current ? { stage: "clients", current, queue: rest } : { stage: "complete" };
}

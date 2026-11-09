import { describe, expect, it } from "vitest";
import {
  INITIAL_INTAKE,
  capabilityOptions,
  clientsDone,
  documentTypesForCapabilities,
  isPickingScope,
  optionsDone,
  sectorsDone,
  type IntakeState,
} from "./intake";

describe("isPickingScope", () => {
  it("locks the composer while the opening card or a picker is waiting", () => {
    expect(isPickingScope(INITIAL_INTAKE)).toBe(true);
    expect(isPickingScope({ stage: "options" })).toBe(true);
    expect(isPickingScope({ stage: "sectors" })).toBe(true);
    expect(isPickingScope({ stage: "clients", current: "airports", queue: [] })).toBe(true);
    expect(isPickingScope({ stage: "complete" })).toBe(false);
  });
});

describe("capabilityOptions", () => {
  it("opens with research and the document makers", () => {
    const labels = capabilityOptions.map((option) => option.label);
    expect(labels).toContain("Research");
    expect(labels).toContain("Create Pitch Deck");
    expect(labels).toContain("Create a Proposal");
  });
});

describe("optionsDone", () => {
  it("always follows the opening card with the sector question", () => {
    expect(optionsDone()).toEqual({ stage: "sectors" });
  });
});

describe("documentTypesForCapabilities", () => {
  it("proposes nothing for research alone", () => {
    expect(documentTypesForCapabilities(["research"])).toEqual([]);
  });

  it("maps each picked maker to its format in display order", () => {
    expect(documentTypesForCapabilities(["proposal", "deck", "onepager"])).toEqual([
      "pptx",
      "docx",
      "pdf",
    ]);
  });

  it("ignores unknown and duplicate picks", () => {
    expect(documentTypesForCapabilities(["deck", "deck", "nonsense"])).toEqual(["pptx"]);
  });
});

describe("sectorsDone", () => {
  it("starts with the first picked sector and queues the rest", () => {
    expect(sectorsDone(["airports", "telecom"])).toEqual({
      stage: "clients",
      current: "airports",
      queue: ["telecom"],
    });
  });

  it("completes when nothing was picked, so the whole library stays searchable", () => {
    expect(sectorsDone([])).toEqual({ stage: "complete" });
  });
});

describe("clientsDone", () => {
  it("walks each remaining sector one at a time", () => {
    expect(clientsDone(["telecom", "retail"])).toEqual({
      stage: "clients",
      current: "telecom",
      queue: ["retail"],
    });
  });

  it("completes after the final sector", () => {
    expect(clientsDone([])).toEqual({ stage: "complete" });
  });

  it("ends in a state that unlocks the composer", () => {
    const state: IntakeState = clientsDone([]);
    expect(isPickingScope(state)).toBe(false);
  });
});

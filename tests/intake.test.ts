import { describe, expect, test } from "bun:test";
import {
  capabilityOptions,
  capabilitySummary,
  clientsDone,
  INITIAL_INTAKE,
  optionsDone,
  sectorsDone,
  urlDone,
} from "../src/lib/chat/intake";

describe("chat intake serial", () => {
  test("the opening pick echoes back as one message", () => {
    expect(capabilitySummary(["research", "deck"])).toBe(
      "I want to research and create a pitch deck",
    );
    expect(capabilitySummary(["deck"])).toBe("I want to create a pitch deck");
    expect(capabilitySummary([])).toBe("I want to explore the library");
  });

  test("the opening labels are the four work types", () => {
    expect(capabilityOptions.map((option) => option.label)).toEqual([
      "Research",
      "Create Pitch Deck",
      "Proposal",
      "PDF One Pager",
    ]);
  });

  test("the questions run options -> sectors -> client -> url -> ready", () => {
    expect(INITIAL_INTAKE.stage).toBe("options");
    const sectors = optionsDone();
    expect(sectors.stage).toBe("sectors");
    const client = sectorsDone(["airports"]);
    expect(client).toEqual({ stage: "clients", current: "airports", queue: [] });
    const url = clientsDone("Zurich Airport", []);
    expect(url).toMatchObject({ stage: "url", name: "Zurich Airport" });
    expect(urlDone([])).toEqual({ stage: "complete" });
  });
});

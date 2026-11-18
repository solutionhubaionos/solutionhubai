import { describe, expect, test } from "bun:test";
import {
  beginCancelable,
  cancelRequest,
  endCancelable,
  throwIfAborted,
} from "../src/lib/documents/cancel";

describe("request cancellation", () => {
  test("cancelRequest aborts the registered controller exactly once", () => {
    const id = crypto.randomUUID();
    const controller = beginCancelable(id);
    expect(controller.signal.aborted).toBe(false);
    expect(cancelRequest(id)).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    // A second cancel finds nothing: the request already stopped.
    expect(cancelRequest(id)).toBe(false);
  });

  test("ending a finished request leaves the registry clean", () => {
    const id = crypto.randomUUID();
    const controller = beginCancelable(id);
    endCancelable(id, controller);
    expect(cancelRequest(id)).toBe(false);
  });

  test("throwIfAborted stops a stage once cancelled", () => {
    const id = crypto.randomUUID();
    const controller = beginCancelable(id);
    expect(() => throwIfAborted(controller.signal)).not.toThrow();
    cancelRequest(id);
    expect(() => throwIfAborted(controller.signal)).toThrow();
  });
});

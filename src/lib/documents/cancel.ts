/**
 * In-process cancellation registry. A long request (a chat answer or a deck
 * build) registers an AbortController under a client-supplied id; the Stop
 * button calls `cancelRequest`, which aborts the controller. The signal then
 * aborts the in-flight provider fetches and is checked between pipeline stages,
 * so no further compute is spent.
 *
 * The registry lives on `globalThis` so a dev hot-reload does not orphan it.
 * It is single-instance: on a multi-instance deployment the cancel call must
 * reach the instance running the request (a shared store would be the upgrade).
 */
const REGISTRY = Symbol.for("solutionHub.cancelRegistry");

function registry(): Map<string, AbortController> {
  const store = globalThis as unknown as Record<symbol, Map<string, AbortController>>;
  if (!store[REGISTRY]) store[REGISTRY] = new Map();
  return store[REGISTRY];
}

export function beginCancelable(id: string): AbortController {
  const map = registry();
  const existing = map.get(id);
  if (existing) return existing;
  const controller = new AbortController();
  map.set(id, controller);
  return controller;
}

/** Aborts the request behind `id`. Returns false when it already finished. */
export function cancelRequest(id: string): boolean {
  const map = registry();
  const controller = map.get(id);
  if (!controller) return false;
  controller.abort(new DOMException("Cancelled by the user", "AbortError"));
  map.delete(id);
  return true;
}

export function endCancelable(id: string, controller: AbortController): void {
  const map = registry();
  if (map.get(id) === controller) map.delete(id);
}

/** Stops a pipeline stage early once the request has been cancelled. */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("Cancelled", "AbortError");
}

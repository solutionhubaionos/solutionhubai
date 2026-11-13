/**
 * `bun test tests/chat-eval.test.ts` — each eval check becomes its own test, so a failure
 * names the case and the rule that broke.
 */
import { describe, expect, test } from "bun:test";
import { runChatEval } from "../evals/chat/cases";

const results = await runChatEval();

for (const result of results) {
  describe(`${result.id}: ${result.title}`, () => {
    for (const entry of result.checks) {
      test(entry.name, () => {
        expect(entry.passed).toBe(true);
      });
    }
  });
}

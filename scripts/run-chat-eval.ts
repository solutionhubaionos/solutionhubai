/**
 * Answer-quality eval runner. Uses fixtures and a mocked completion endpoint, so
 * it needs no database, provider key or network access.
 *
 *   bun run eval:chat
 *   bun test evals/chat
 */
import { runChatEval } from "../evals/chat/cases";

const results = await runChatEval();
let failed = 0;

for (const result of results) {
  console.log(`\n${result.passed ? "PASS" : "FAIL"} ${result.id} — ${result.title}`);
  for (const entry of result.checks) {
    console.log(
      `  ${entry.passed ? "✓" : "✗"} ${entry.name}${entry.detail ? ` (${entry.detail})` : ""}`,
    );
  }
  if (!result.passed) failed += 1;
}

console.log(`\n${results.length - failed}/${results.length} cases passed`);
if (failed > 0) process.exitCode = 1;

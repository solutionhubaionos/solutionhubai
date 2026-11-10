/**
 * Answer-level evaluation: generate one grounded answer per case, then score it
 * deterministically plus an LLM judge for citation support.
 *
 * Metrics
 * - citation validity: every [n] exists, and every cited sentence is supported
 *   by the passages it cites (judge, strict rubric);
 * - numeric faithfulness: every number/percentage/currency/multiple in the
 *   answer occurs in at least one cited passage (deterministic, must be 100%);
 * - completeness: share of the case's mustMention facts present;
 * - refusal: unanswerable cases must decline rather than invent.
 *
 * Usage:
 *   bun run eval:answers
 *   bun run eval:answers --no-judge --json evals/results/answers.json
 *   bun run eval:answers --strict       # exit 1 on numeric or refusal failures
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildMessages, generateAnswer, noPassagesAnswer } from "../src/lib/chat/answer";
import { ANSWER_MODEL } from "../src/lib/rag/config";
import { embedTexts, queryEmbeddingText } from "../src/lib/rag/embeddings";
import {
  buildJudgePrompt,
  checkCitations,
  checkNumericFaithfulness,
  completeness,
  isRefusal,
  parseJudgeVerdicts,
  splitSentences,
  stripCitations,
  type NumericViolation,
} from "../src/lib/rag/answer-eval";
import { clampMatchCount } from "../src/lib/rag/search";
import { resolveCaseQuestion, type EvalCase } from "../src/lib/rag/eval";
import {
  createEvalBackend,
  fail,
  loadEvalSet,
  productionQueryForCase,
  requireProviderEnv,
  retrieveForCase,
} from "./eval-runtime";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const setPath = value("--set") ?? "evals/rag-eval.json";
const requestedK = Number(value("--k") ?? 0);
const requestedEmail = value("--email");
const jsonPath = value("--json");
const limit = Number(value("--limit") ?? 0);
const useJudge = !flag("--no-judge");
const strict = flag("--strict");
const verbose = flag("--verbose");
const model = process.env["ANSWER_MODEL"] ?? ANSWER_MODEL;
// Fast and cheap; kept separate so the answer model is never its own judge.
const judgeModel = process.env["JUDGE_MODEL"] ?? "openai/gpt-oss-120b";

const { apiKey, baseUrl } = requireProviderEnv();
const set = loadEvalSet(setPath, requestedK);
const k = clampMatchCount(set.k);
const backend = createEvalBackend();

type CaseResult = {
  id: string;
  category: string;
  answerable: boolean;
  answer: string;
  citationsInvalid: number[];
  uncitedNumericSentences: string[];
  numericChecked: number;
  numericViolations: NumericViolation[];
  completeness: number;
  missing: string[];
  refusalCorrect: boolean | null;
  judged: number;
  supported: number;
  judgeErrors: number;
  generationError: string | null;
};

type ChatResponse = {
  choices?: Array<{
    message?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
  error?: { message?: string } | string;
};

async function chat(prompt: string, maxTokens: number): Promise<string> {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  let lastError = "judge returned no content";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: judgeModel,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const raw = await response.text();
    if (!response.ok) {
      lastError = `Judge failed (${response.status}): ${raw.slice(0, 200)}`;
      if (response.status === 429 || response.status >= 500) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        continue;
      }
      throw new Error(lastError);
    }
    const body = JSON.parse(raw) as ChatResponse;
    const message = body.choices?.[0]?.message;
    // Reasoning models sometimes put the JSON in reasoning_content and leave content empty.
    const content = (message?.content ?? message?.reasoning_content ?? "").trim();
    if (content) return content;
    lastError = "judge returned no content";
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }
  throw new Error(lastError);
}

async function judgeAnswer(
  testCase: EvalCase,
  answer: string,
  chunks: Awaited<ReturnType<typeof retrieveForCase>>["chunks"],
): Promise<{ judged: number; supported: number; errors: number }> {
  if (!useJudge) return { judged: 0, supported: 0, errors: 0 };

  const sentences = splitSentences(answer).map((text, index) => ({
    index,
    text,
    citations: [...text.matchAll(/\[(\d+)\]/g)]
      .map((match) => Number(match[1]))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= chunks.length),
  }));
  const cited = sentences.filter((sentence) => sentence.citations.length > 0);
  if (cited.length === 0) return { judged: 0, supported: 0, errors: 0 };

  const passages = new Map<number, string>(
    chunks.map((chunk, index) => [index + 1, stripCitations(chunk.content)]),
  );

  try {
    const raw = await chat(
      buildJudgePrompt(
        resolveCaseQuestion(testCase),
        cited.map((sentence, index) => ({ ...sentence, index })),
        passages,
      ),
      3000,
    );
    const verdicts = parseJudgeVerdicts(raw, cited.length);
    const supported = verdicts.filter((verdict) => verdict?.supported === true).length;
    const errors = verdicts.filter((verdict) => verdict === null).length;
    return { judged: cited.length, supported, errors };
  } catch (error) {
    console.error(
      `judge error for ${testCase.id}:`,
      error instanceof Error ? error.message : String(error),
    );
    return { judged: cited.length, supported: 0, errors: cited.length };
  }
}

function writeResults(
  results: readonly CaseResult[],
  totalCases: number,
  k: number,
  model: string,
  judgeModel: string | null,
) {
  if (!jsonPath) return;
  const answerable = results.filter((result) => result.answerable);
  const unanswerable = results.filter((result) => !result.answerable);
  const judged = results.reduce((sum, result) => sum + result.judged, 0);
  const supported = results.reduce((sum, result) => sum + result.supported, 0);
  const numericChecked = results.reduce((sum, result) => sum + result.numericChecked, 0);
  const numericViolations = results.reduce(
    (sum, result) => sum + result.numericViolations.length,
    0,
  );
  const refusalCorrect = unanswerable.filter((result) => result.refusalCorrect === true).length;

  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(
    jsonPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        complete: results.length === totalCases,
        set: setPath,
        k,
        model,
        judgeModel,
        summary: {
          citationSupport: judged ? supported / judged : null,
          invalidCitations: results.reduce(
            (sum, result) => sum + result.citationsInvalid.length,
            0,
          ),
          uncitedNumericSentences: results.reduce(
            (sum, result) => sum + result.uncitedNumericSentences.length,
            0,
          ),
          numericFaithfulness: numericChecked
            ? (numericChecked - numericViolations) / numericChecked
            : null,
          numericChecked,
          numericViolations,
          completeness:
            answerable.length === 0
              ? 0
              : answerable.reduce((sum, result) => sum + result.completeness, 0) /
                answerable.length,
          refusalAccuracy: unanswerable.length ? refusalCorrect / unanswerable.length : null,
          generationErrors: results.filter((result) => result.generationError !== null).length,
        },
        cases: results,
      },
      null,
      2,
    )}\n`,
  );
}

async function main() {
  const subject = await backend.resolveSubject(requestedEmail);
  const cases = limit > 0 ? set.cases.slice(0, limit) : set.cases;
  console.log(
    `Answer eval: ${setPath} (${cases.length} cases, k=${k}) · model=${model} · judge=${
      useJudge ? judgeModel : "off"
    }`,
  );

  const queries = cases.map(productionQueryForCase);
  const { embeddings } = await embedTexts(
    queries.map((query) => queryEmbeddingText(query, false)),
    { apiKey, baseUrl },
  );

  const results: CaseResult[] = [];
  for (const [index, testCase] of cases.entries()) {
    const embedding = embeddings[index];
    if (!embedding) fail(`No embedding returned for case ${testCase.id}`);

    let chunks;
    try {
      ({ chunks } = await retrieveForCase(
        backend,
        subject,
        testCase,
        embedding,
        queries[index]!,
        k,
      ));
    } catch (error) {
      fail(
        `Retrieval failed for ${testCase.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    let answer: string;
    let generationError: string | null = null;
    if (chunks.length === 0) {
      answer = noPassagesAnswer();
    } else {
      const history = (testCase.turns ?? []).slice(0, -1);
      const messages = buildMessages(resolveCaseQuestion(testCase), chunks, history);
      try {
        ({ answer } = await generateAnswer(messages, {
          apiKey,
          baseUrl,
          model,
          fetchImpl: (input, init) =>
            fetch(input, { ...init, signal: AbortSignal.timeout(60_000) }),
        }));
      } catch (error) {
        generationError = error instanceof Error ? error.message : String(error);
        answer = "";
      }
    }

    const citations = checkCitations(answer, chunks.length);
    const citedChunks = chunks.filter((_chunk, chunkIndex) =>
      citations.cited.includes(chunkIndex + 1),
    );
    const numeric = checkNumericFaithfulness(
      answer,
      citedChunks.map((chunk) => stripCitations(chunk.content)),
    );
    const mentionCheck = completeness(answer, testCase.mustMention ?? []);
    const judge = await judgeAnswer(testCase, answer, chunks);

    const result: CaseResult = {
      id: testCase.id,
      category: testCase.category,
      answerable: testCase.expectedFiles.length > 0,
      answer,
      citationsInvalid: citations.invalid,
      uncitedNumericSentences: citations.uncitedNumericSentences,
      numericChecked: numeric.checked,
      numericViolations: numeric.violations,
      completeness: mentionCheck.score,
      missing: mentionCheck.missing,
      refusalCorrect: testCase.expectedFiles.length === 0 ? isRefusal(answer) : null,
      judged: judge.judged,
      supported: judge.supported,
      judgeErrors: judge.errors,
      generationError,
    };
    results.push(result);
    // Write after every case so an interrupted run still leaves usable numbers.
    if (jsonPath) writeResults(results, cases.length, k, model, useJudge ? judgeModel : null);

    console.log(
      `\n[${result.category}] ${result.id} · nums=${result.numericChecked} ` +
        (result.generationError ? `ERROR=${result.generationError.slice(0, 80)} ` : "") +
        `viol=${result.numericViolations.length} ` +
        `cite=${citations.cited.length}/${chunks.length} invalid=${citations.invalid.length} ` +
        `judge=${judge.supported}/${judge.judged} (+${judge.errors} err) ` +
        `must=${(mentionCheck.score * 100).toFixed(0)}%` +
        (result.refusalCorrect === null ? "" : ` refusal=${result.refusalCorrect}`),
    );
    if (verbose) {
      console.log(result.answer.slice(0, 1200));
      if (result.numericViolations.length > 0) console.log("violations:", result.numericViolations);
    }
  }

  const answerable = results.filter((result) => result.answerable);
  const unanswerable = results.filter((result) => !result.answerable);
  const judged = results.reduce((sum, result) => sum + result.judged, 0);
  const supported = results.reduce((sum, result) => sum + result.supported, 0);
  const numericChecked = results.reduce((sum, result) => sum + result.numericChecked, 0);
  const numericViolations = results.reduce(
    (sum, result) => sum + result.numericViolations.length,
    0,
  );
  const invalidCitations = results.reduce((sum, result) => sum + result.citationsInvalid.length, 0);
  const uncitedNumeric = results.reduce(
    (sum, result) => sum + result.uncitedNumericSentences.length,
    0,
  );
  const generationErrors = results.filter((result) => result.generationError !== null).length;
  const refusalCorrect = unanswerable.filter((result) => result.refusalCorrect === true).length;
  const avgCompleteness =
    answerable.length === 0
      ? 0
      : answerable.reduce((sum, result) => sum + result.completeness, 0) / answerable.length;

  console.log("\n=== Summary ===");
  console.log(
    `citation support: ${judged ? ((supported / judged) * 100).toFixed(1) : "n/a"}% ` +
      `(${supported}/${judged} judged sentences; ${invalidCitations} invalid markers; ` +
      `${uncitedNumeric} uncited numeric sentences)`,
  );
  console.log(
    `numeric faithfulness: ${
      numericChecked
        ? (((numericChecked - numericViolations) / numericChecked) * 100).toFixed(1)
        : "n/a"
    }% (${numericViolations} violations in ${numericChecked} checked numbers)`,
  );
  console.log(`completeness: ${(avgCompleteness * 100).toFixed(1)}% of mustMention facts`);
  console.log(
    `refusal accuracy: ${
      unanswerable.length ? ((refusalCorrect / unanswerable.length) * 100).toFixed(1) : "n/a"
    }% (${refusalCorrect}/${unanswerable.length} unanswerable cases)`,
  );
  if (generationErrors > 0) console.log(`generation errors: ${generationErrors}`);

  const categories = [...new Set(results.map((result) => result.category))];
  for (const category of categories) {
    const bucket = results.filter((result) => result.category === category);
    const bucketJudged = bucket.reduce((sum, result) => sum + result.judged, 0);
    const bucketSupported = bucket.reduce((sum, result) => sum + result.supported, 0);
    const bucketChecked = bucket.reduce((sum, result) => sum + result.numericChecked, 0);
    const bucketViolations = bucket.reduce(
      (sum, result) => sum + result.numericViolations.length,
      0,
    );
    const bucketCompleteness =
      bucket.filter((result) => result.answerable).length === 0
        ? 0
        : bucket
            .filter((result) => result.answerable)
            .reduce((sum, result) => sum + result.completeness, 0) /
          bucket.filter((result) => result.answerable).length;
    console.log(
      `  ${category.padEnd(13)} n=${String(bucket.length).padEnd(3)} ` +
        `cite=${bucketJudged ? ((bucketSupported / bucketJudged) * 100).toFixed(1) : "n/a"}% ` +
        `nums=${bucketChecked ? (((bucketChecked - bucketViolations) / bucketChecked) * 100).toFixed(1) : "n/a"}% ` +
        `must=${(bucketCompleteness * 100).toFixed(0)}%`,
    );
  }

  if (jsonPath) {
    writeResults(results, cases.length, k, model, useJudge ? judgeModel : null);
    console.log(`\nWrote ${jsonPath}`);
  }

  if (strict) {
    const numericOk = numericViolations === 0;
    const refusalOk = unanswerable.length === 0 || refusalCorrect / unanswerable.length >= 0.8;
    if (!numericOk || !refusalOk) {
      console.log(
        `\nSTRICT FAIL: numeric violations=${numericViolations}, refusal=${refusalCorrect}/${unanswerable.length}`,
      );
      process.exitCode = 1;
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await backend.end();
}

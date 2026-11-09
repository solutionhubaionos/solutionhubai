/**
 * Retrieval evaluation for evals/rag-eval.json.
 *
 * Runs the production query path (context hints + scope logic) and the real
 * hybrid search (public.search_chunks) as an authenticated member, so RLS
 * applies and the numbers match what a signed-in user would get.
 *
 * Phase 0 intentionally mirrors today's defects so the baseline is honest:
 * - follow-ups embed the last user turn as typed (no rewrite yet);
 * - focus/strict apply the hard SQL scope filter (no global arm yet);
 * - `--prefix instruct` is opt-in; production does not send it yet.
 *
 * Usage:
 *   bun run eval                      # document recall@8, needs 80% to pass
 *   bun run eval --prefix instruct    # A/B the Qwen3 query instruction
 *   bun run eval --diagnostics --json evals/results/retrieval.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { embedTexts, queryEmbeddingText } from "../src/lib/rag/embeddings";
import { evaluateCase, summarize, type EvalOutcome } from "../src/lib/rag/eval";
import { clampMatchCount } from "../src/lib/rag/search";
import {
  connectDatabase,
  fail,
  loadEvalSet,
  productionQueryForCase,
  requireProviderEnv,
  resolveSubject,
  retrieveForCase,
} from "./eval-runtime";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const verbose = flag("--verbose");
const setPath = value("--set") ?? "evals/rag-eval.json";
const threshold = Number(value("--threshold") ?? 0.8);
const requestedK = Number(value("--k") ?? 0);
const requestedEmail = value("--email");
const jsonPath = value("--json");
const diagnostics = flag("--diagnostics");
const prefixMode = value("--prefix") === "instruct" ? "instruct" : "raw";
const instruct = prefixMode === "instruct";

const { apiKey, baseUrl } = requireProviderEnv();
const set = loadEvalSet(setPath, requestedK);
const k = clampMatchCount(set.k);
const sql = connectDatabase();

function printOutcome(outcome: EvalOutcome) {
  const documentHit = outcome.answerable
    ? outcome.firstRank === null
      ? "MISS"
      : `doc@${outcome.firstRank}`
    : "n/a";
  const chunkHit = outcome.answerable
    ? outcome.chunkFirstRank === null
      ? "no-chunk"
      : `chunk@${outcome.chunkFirstRank}`
    : "n/a";
  console.log(`\n[${outcome.category}] ${documentHit} ${chunkHit} ${outcome.id}`);
  console.log(`  Q: ${outcome.question}`);
  const top = outcome.files.slice(0, verbose ? k : 3);
  for (const file of top) console.log(`  ${file.rank}. ${file.fileName}`);
  if (outcome.answerable && outcome.firstRank === null) {
    console.log(`  expected: ${outcome.expectedFiles.join(", ")}`);
  }
}

async function runDiagnostics(example?: {
  embedding: readonly number[];
  queryText: string;
  scope: { industry: string | null; customer: string | null };
}) {
  console.log("\n=== Diagnostics ===");
  try {
    const models = await sql<{ embedding_model: string; n: number }[]>`
      select embedding_model, count(*)::int as n
      from public.document_chunks
      group by 1
      order by 2 desc`;
    console.log("embedding_model rows:", models);
    const [ext] = await sql<{ extversion: string }[]>`
      select extversion from pg_extension where extname = 'vector'`;
    console.log("pgvector:", ext?.extversion ?? "MISSING");
    const [counts] = await sql<{ items: number; chunks: number; ready: number }[]>`
      select
        (select count(*)::int from public.content_items) as items,
        (select count(*)::int from public.document_chunks) as chunks,
        (select count(*)::int from public.ingestion_jobs where status = 'ready') as ready`;
    console.log("library:", counts);

    if (example) {
      const literal = `[${example.embedding.join(",")}]`;
      console.log("\nEXPLAIN search_chunks (narrow industry+customer filter):");
      const plan = await sql`
        explain (analyze, buffers)
        select * from public.search_chunks(
          ${literal}::vector(1536),
          ${example.queryText},
          ${example.scope.industry},
          ${example.scope.customer},
          ${k}
        )`;
      for (const row of plan) console.log(Object.values(row as Record<string, unknown>)[0]);
    }
  } catch (error) {
    console.error("diagnostics failed:", error instanceof Error ? error.message : String(error));
  }
}

async function main() {
  const subject = await resolveSubject(sql, requestedEmail);
  const [library] = await sql<{ items: number; indexed: number; ready: number }[]>`
    select
      (select count(*) from public.content_items)::int as items,
      (select count(distinct content_id) from public.document_chunks)::int as indexed,
      (select count(*) from public.ingestion_jobs where status = 'ready')::int as ready`;
  console.log(
    `Library: ${library?.items ?? 0} files, ${library?.indexed ?? 0} indexed ` +
      `(${library?.ready ?? 0} jobs ready). Subject: ${subject.email}`,
  );
  console.log(
    `Eval: ${setPath} (${set.cases.length} cases, k=${k}) · prefix=${prefixMode} · ` +
      "query path=production (no rewrite yet)",
  );

  const queries = set.cases.map(productionQueryForCase);
  const { embeddings, promptTokens } = await embedTexts(
    queries.map((query) => queryEmbeddingText(query, instruct)),
    { apiKey, baseUrl },
  );

  const outcomes: EvalOutcome[] = [];
  const startedAt = Date.now();
  let example: Parameters<typeof runDiagnostics>[0];
  for (const [index, testCase] of set.cases.entries()) {
    const embedding = embeddings[index];
    if (!embedding) fail(`No embedding returned for case ${testCase.id}`);
    let chunks;
    try {
      ({ chunks } = await retrieveForCase(sql, subject, testCase, embedding, queries[index]!, k));
    } catch (error) {
      fail(
        `Search failed for ${testCase.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!example && testCase.scope?.industry && testCase.scope.customer) {
      example = {
        embedding,
        queryText: queries[index]!,
        scope: {
          industry: testCase.scope.industry ?? null,
          customer: testCase.scope.customer ?? null,
        },
      };
    }
    const outcome = evaluateCase(testCase, chunks, k);
    outcomes.push(outcome);
    printOutcome(outcome);
  }

  const elapsed = (Date.now() - startedAt) / 1000;
  const summary = summarize(outcomes);

  console.log("\n=== Summary ===");
  console.log(
    `document recall@${k}: ${(summary.documentRecallAtK * 100).toFixed(1)}% ` +
      `(${outcomes.filter((o) => o.documentRecall === 1).length}/${summary.answerable} answerable cases)`,
  );
  console.log(`chunk recall@${k}:    ${(summary.chunkRecallAtK * 100).toFixed(1)}%`);
  console.log(`MRR:                 ${summary.mrr.toFixed(3)}`);
  console.log(`nDCG@${k}:              ${summary.ndcgAtK.toFixed(3)}`);
  console.log(
    `Unanswerable: ${summary.unanswerable} cases, ${summary.unanswerableWithResults} returned ` +
      `passages (false-positive rate ${(summary.unanswerableFalsePositiveRate * 100).toFixed(1)}%)`,
  );
  for (const [category, bucket] of Object.entries(summary.byCategory)) {
    console.log(
      `  ${category.padEnd(13)} n=${String(bucket.total).padEnd(3)} ` +
        `doc=${(bucket.documentRecallAtK * 100).toFixed(1)}% ` +
        `chunk=${(bucket.chunkRecallAtK * 100).toFixed(1)}% ` +
        `mrr=${bucket.mrr.toFixed(3)} ndcg=${bucket.ndcgAtK.toFixed(3)}`,
    );
  }
  console.log(
    `\n${summary.total} queries in ${elapsed.toFixed(1)}s ` +
      `(${((elapsed * 1000) / summary.total).toFixed(0)}ms each, ${promptTokens ?? "?"} query tokens)`,
  );

  if (diagnostics) await runDiagnostics(example);

  if (jsonPath) {
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(
      jsonPath,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          set: setPath,
          k,
          prefix: prefixMode,
          queryPath: "production",
          summary,
          cases: outcomes,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`\nWrote ${jsonPath}`);
  }

  if (summary.answerable === 0) {
    console.log("\nNo answerable cases; nothing to score.");
  } else if (summary.documentRecallAtK < threshold) {
    console.log(
      `\nBELOW THRESHOLD: document recall@${k} must reach ${(threshold * 100).toFixed(0)}%.`,
    );
    process.exitCode = 1;
  } else {
    console.log(`\nThreshold met: document recall@${k} >= ${(threshold * 100).toFixed(0)}%.`);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await sql.end();
}

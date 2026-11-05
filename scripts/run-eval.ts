/**
 * Retrieval evaluation: recall@k and MRR for evals/rag-eval.json.
 *
 * Runs the real hybrid search (public.search_chunks) as an authenticated member,
 * so RLS applies and the numbers match what a signed-in user would get. It needs
 * the database connection string and the embedding provider; a member password
 * session is not required, which keeps it usable before the service role and new
 * API keys are in place.
 *
 * Usage:
 *   bun scripts/run-eval.ts                     # recall@8, needs 80% to pass
 *   bun scripts/run-eval.ts --k 5 --verbose
 *   bun scripts/run-eval.ts --email someone@aionos.ai
 *   bun scripts/run-eval.ts --set evals/other.json --threshold 0.9
 */
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { embedTexts } from "../src/lib/rag/embeddings";
import {
  evaluateCase,
  summarize,
  type EvalCase,
  type EvalSet,
  type EvalOutcome,
} from "../src/lib/rag/eval";
import {
  clampMatchCount,
  formatVectorLiteral,
  mapSearchRows,
  normalizeScope,
  type RetrievedChunk,
} from "../src/lib/rag/search";

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

if (!process.env.SUPABASE_DB_URL) {
  console.error("SUPABASE_DB_URL is missing from .env");
  process.exit(1);
}
if (!process.env.TOKENFACTORY_API_BASE || !process.env.TOKENFACTORY_API_KEY) {
  console.error("TOKENFACTORY_API_BASE / TOKENFACTORY_API_KEY are missing from .env");
  process.exit(1);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function loadEvalSet(path: string): EvalSet {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`Could not read ${path}: ${error instanceof Error ? error.message : error}`);
  }
  const set = parsed as EvalSet;
  if (!set || !Array.isArray(set.cases) || set.cases.length === 0) {
    fail(`${path} has no cases`);
  }
  const seen = new Set<string>();
  for (const testCase of set.cases) {
    if (!testCase.id || !testCase.question || !Array.isArray(testCase.expectedFiles)) {
      fail(`Malformed eval case: ${JSON.stringify(testCase).slice(0, 120)}`);
    }
    if (seen.has(testCase.id)) fail(`Duplicate eval case id: ${testCase.id}`);
    seen.add(testCase.id);
  }
  return { version: set.version ?? 1, k: requestedK || set.k || 8, cases: set.cases };
}

const set = loadEvalSet(setPath);
const k = clampMatchCount(set.k);

const sql = postgres(process.env.SUPABASE_DB_URL, { ssl: "require", max: 1, prepare: false });

type Subject = { id: string; email: string };

async function resolveSubject(): Promise<Subject> {
  if (requestedEmail) {
    const [row] = await sql<Subject[]>`
      select id, email from auth.users
      where lower(email) = lower(${requestedEmail})
      limit 1`;
    if (!row) fail(`No auth user with email ${requestedEmail}`);
    return row;
  }
  const rows = await sql<Subject[]>`
    select id, email from auth.users
    where public.is_allowed_email(email)
    order by created_at
    limit 2`;
  if (rows.length === 0) fail("No allowed auth user found; pass --email <address>");
  if (rows.length > 1) {
    console.warn(
      `Multiple allowed users found; using ${rows[0]!.email}. Pass --email to choose another.`,
    );
  }
  return rows[0]!;
}

async function searchAsMember(
  subject: Subject,
  embedding: readonly number[],
  queryText: string,
  testCase: EvalCase,
): Promise<RetrievedChunk[]> {
  const scope = normalizeScope(testCase.scope ?? {});
  const literal = formatVectorLiteral(embedding);
  const claims = JSON.stringify({ sub: subject.id, email: subject.email, role: "authenticated" });

  return sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;
    await tx.unsafe("set local role authenticated");
    const rows = await tx`
      select * from public.search_chunks(
        ${literal}::vector(1536),
        ${queryText},
        ${scope.industry},
        ${scope.customer},
        ${k}
      )`;
    return mapSearchRows(rows as never);
  });
}

function printOutcome(outcome: EvalOutcome) {
  const hit = outcome.answerable
    ? outcome.firstRank === null
      ? "MISS"
      : `hit@${outcome.firstRank}`
    : "n/a";
  console.log(`\n[${outcome.category}] ${hit} ${outcome.id}`);
  console.log(`  Q: ${outcome.question}`);
  const top = outcome.files.slice(0, verbose ? k : 3);
  for (const file of top) console.log(`  ${file.rank}. ${file.fileName}`);
  if (outcome.answerable && outcome.firstRank === null) {
    console.log(`  expected: ${outcome.expectedFiles.join(", ")}`);
  }
}

async function main() {
  const subject = await resolveSubject();
  const [library] = await sql<{ items: number; indexed: number; ready: number }[]>`
    select
      (select count(*) from public.content_items)::int as items,
      (select count(distinct content_id) from public.document_chunks)::int as indexed,
      (select count(*) from public.ingestion_jobs where status = 'ready')::int as ready`;
  console.log(
    `Library: ${library?.items ?? 0} files, ${library?.indexed ?? 0} indexed ` +
      `(${library?.ready ?? 0} jobs ready). Subject: ${subject.email}`,
  );
  console.log(`Eval: ${setPath} (${set.cases.length} cases, k=${k})\n`);

  const texts = set.cases.map((testCase) => testCase.question);
  const { embeddings, promptTokens } = await embedTexts(texts, {
    apiKey: process.env.TOKENFACTORY_API_KEY!,
    baseUrl: process.env.TOKENFACTORY_API_BASE!,
  });

  const outcomes: EvalOutcome[] = [];
  const startedAt = Date.now();
  for (const [index, testCase] of set.cases.entries()) {
    const embedding = embeddings[index];
    if (!embedding) fail(`No embedding returned for case ${testCase.id}`);
    let chunks: RetrievedChunk[] = [];
    try {
      chunks = await searchAsMember(subject, embedding, testCase.question, testCase);
    } catch (error) {
      fail(
        `Search failed for ${testCase.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const outcome = evaluateCase(testCase, chunks);
    outcomes.push(outcome);
    printOutcome(outcome);
  }

  const elapsed = (Date.now() - startedAt) / 1000;
  const summary = summarize(outcomes);

  console.log("\n=== Summary ===");
  console.log(
    `recall@${k}: ${(summary.recallAtK * 100).toFixed(1)}% ` +
      `(${outcomes.filter((o) => o.recall === 1).length}/${summary.answerable} answerable cases)`,
  );
  console.log(`MRR: ${summary.mrr.toFixed(3)}`);
  console.log(
    `Unanswerable: ${summary.unanswerable} cases, ${summary.unanswerableWithResults} still returned passages`,
  );
  for (const [category, bucket] of Object.entries(summary.byCategory)) {
    console.log(
      `  ${category.padEnd(12)} n=${String(bucket.total).padEnd(3)} ` +
        `answerable=${String(bucket.answerable).padEnd(3)} ` +
        `recall=${(bucket.recallAtK * 100).toFixed(1)}% mrr=${bucket.mrr.toFixed(3)}`,
    );
  }
  console.log(
    `\n${summary.total} queries in ${elapsed.toFixed(1)}s ` +
      `(${((elapsed * 1000) / summary.total).toFixed(0)}ms each, ${promptTokens ?? "?"} query tokens)`,
  );

  if (summary.answerable === 0) {
    console.log("\nNo answerable cases; nothing to score.");
  } else if (summary.recallAtK < threshold) {
    console.log(
      `\nBELOW THRESHOLD: recall@${k} must reach ${(threshold * 100).toFixed(0)}%. ` +
        "Iterate on chunk size, fusion or add the rerank step, and report before/after.",
    );
    process.exitCode = 1;
  } else {
    console.log(`\nThreshold met: recall@${k} >= ${(threshold * 100).toFixed(0)}%.`);
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

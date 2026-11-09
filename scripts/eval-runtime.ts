/**
 * Shared runtime for the RAG evals: load the case set, build the same query the
 * chat server function builds, and run public.search_chunks as an authenticated
 * member so RLS applies.
 *
 * Phase 0 limitation, recorded on purpose: there is no query rewrite yet, so the
 * follow-up question's final user turn is embedded as typed. Phase 2 replaces
 * `productionQueryForCase` with the rewritten standalone question.
 */
import { readFileSync } from "node:fs";
import postgres from "postgres";
import {
  EMPTY_CONTEXT,
  buildRetrievalQuery,
  retrievalScopes,
  type ChatContext,
} from "../src/lib/chat/scope";
import {
  clampMatchCount,
  formatVectorLiteral,
  mapSearchRows,
  normalizeScope,
  type RetrievalScope,
  type RetrievedChunk,
} from "../src/lib/rag/search";
import {
  resolveCaseQuestion,
  type EvalCase,
  type EvalSet,
  type EvalScopeMode,
} from "../src/lib/rag/eval";

export type Database = ReturnType<typeof postgres>;
export type Subject = { id: string; email: string };

const SCOPE_MODES: readonly EvalScopeMode[] = ["focus", "strict", "all"];

export function loadEvalSet(path: string, requestedK: number): EvalSet {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`Could not read ${path}: ${error instanceof Error ? error.message : error}`);
  }
  const set = parsed as EvalSet;
  if (!set || !Array.isArray(set.cases) || set.cases.length === 0) fail(`${path} has no cases`);

  const seen = new Set<string>();
  for (const testCase of set.cases) {
    if (!testCase.id || !testCase.question || !Array.isArray(testCase.expectedFiles)) {
      fail(`Malformed eval case: ${JSON.stringify(testCase).slice(0, 120)}`);
    }
    if (seen.has(testCase.id)) fail(`Duplicate eval case id: ${testCase.id}`);
    seen.add(testCase.id);
    if (testCase.turns && !Array.isArray(testCase.turns)) {
      fail(`Case ${testCase.id} has malformed turns`);
    }
    if (testCase.scopeMode && !SCOPE_MODES.includes(testCase.scopeMode)) {
      fail(`Case ${testCase.id} has unknown scopeMode: ${testCase.scopeMode}`);
    }
  }
  return { version: set.version ?? 1, k: requestedK || set.k || 8, cases: set.cases };
}

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export function requireProviderEnv(): { apiKey: string; baseUrl: string } {
  const apiKey = process.env["TOKENFACTORY_API_KEY"];
  const baseUrl = process.env["TOKENFACTORY_API_BASE"];
  if (!apiKey || !baseUrl)
    fail("TOKENFACTORY_API_BASE / TOKENFACTORY_API_KEY are missing from .env");
  return { apiKey, baseUrl };
}

export function connectDatabase(): Database {
  const url = process.env["SUPABASE_DB_URL"];
  if (!url) fail("SUPABASE_DB_URL is missing from .env");
  return postgres(url, { ssl: "require", max: 1, prepare: false, connect_timeout: 15 });
}

export async function resolveSubject(sql: Database, requestedEmail?: string): Promise<Subject> {
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

/** The scope chips the eval case would have picked in the UI. */
export function scopeContextForCase(testCase: EvalCase): ChatContext {
  return {
    ...EMPTY_CONTEXT,
    industries: testCase.scope?.industry ? [testCase.scope.industry] : [],
    clients: testCase.scope?.customer ? [testCase.scope.customer] : [],
  };
}

/**
 * `focus` and `strict` are identical in Phase 0 because retrieval still applies
 * a hard SQL filter. `all` skips the filter. Phase 2 makes focus soft.
 */
export function scopesForCase(testCase: EvalCase): RetrievalScope[] {
  if (testCase.scopeMode === "all") return [{}];
  return retrievalScopes(scopeContextForCase(testCase));
}

/** The exact query text the chat server function embeds today. */
export function productionQueryForCase(testCase: EvalCase): string {
  return buildRetrievalQuery(resolveCaseQuestion(testCase), scopeContextForCase(testCase));
}

export async function searchAsMember(
  sql: Database,
  subject: Subject,
  params: { embedding: readonly number[]; queryText: string; scope: RetrievalScope; k: number },
): Promise<RetrievedChunk[]> {
  const scope = normalizeScope(params.scope);
  const literal = formatVectorLiteral(params.embedding);
  const claims = JSON.stringify({ sub: subject.id, email: subject.email, role: "authenticated" });

  return sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;
    await tx.unsafe("set local role authenticated");
    const rows = await tx`
      select * from public.search_chunks(
        ${literal}::vector(1536),
        ${params.queryText},
        ${scope.industry},
        ${scope.customer},
        ${params.k}
      )`;
    return mapSearchRows(rows as never);
  });
}

/**
 * Mirrors searchLibraryChunksAcrossScopes: one search per scope, best score per
 * chunk, then the final cutoff.
 */
export async function retrieveForCase(
  sql: Database,
  subject: Subject,
  testCase: EvalCase,
  embedding: readonly number[],
  queryText: string,
  requestedK: number,
): Promise<{ chunks: RetrievedChunk[]; scopes: RetrievalScope[] }> {
  const k = clampMatchCount(requestedK);
  const scopes = scopesForCase(testCase);
  const batches: RetrievedChunk[] = [];
  for (const scope of scopes) {
    batches.push(...(await searchAsMember(sql, subject, { embedding, queryText, scope, k })));
  }

  const best = new Map<string, RetrievedChunk>();
  for (const chunk of batches) {
    const existing = best.get(chunk.chunkId);
    if (!existing || chunk.score > existing.score) best.set(chunk.chunkId, chunk);
  }

  return {
    chunks: [...best.values()].sort((a, b) => b.score - a.score).slice(0, k),
    scopes,
  };
}

/**
 * Shared runtime for the RAG evals: load the case set, build the same query the
 * chat server function builds, and run public.search_chunks as an authenticated
 * member so RLS applies.
 *
 * Two backends, same interface:
 * - Supabase REST (default on Lovable Cloud, which does not expose Postgres):
 *   signs in as the library member and calls the same RPC the app uses.
 * - Direct Postgres (self-hosted): sets request.jwt.claims and role
 *   authenticated inside a transaction, and can run EXPLAIN.
 *
 * Phase 0 limitation, recorded on purpose: there is no query rewrite yet, so the
 * follow-up question's final user turn is embedded as typed. Phase 2 replaces
 * `productionQueryForCase` with the rewritten standalone question.
 */
import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import type { Database as SupabaseDatabase } from "../src/integrations/supabase/types";
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

export type Sql = ReturnType<typeof postgres>;
export type Subject = { id: string; email: string };

export type LibraryCounts = { items: number; indexed: number; ready: number | null };
export type EmbeddingModelCount = { embedding_model: string; n: number };

export type EvalBackend = {
  kind: "postgres" | "supabase";
  resolveSubject(email?: string): Promise<Subject>;
  counts(): Promise<LibraryCounts>;
  embeddingModels(): Promise<EmbeddingModelCount[]>;
  pgvectorVersion(): Promise<string | null>;
  search(
    subject: Subject,
    params: { embedding: readonly number[]; queryText: string; scope: RetrievalScope; k: number },
  ): Promise<RetrievedChunk[]>;
  /** Direct Postgres only; null when the backend cannot run a query plan. */
  explain(
    example: {
      embedding: readonly number[] | null;
      queryText: string;
      scope: { industry: string | null; customer: string | null };
    },
    k: number,
  ): Promise<string[] | null>;
  end(): Promise<void>;
};

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

/** A Postgres URI is required for the direct backend; the https API URL is not one. */
function isPostgresUrl(url: string | undefined): url is string {
  return Boolean(url && /^postgres(?:ql)?:\/\//i.test(url));
}

export function createEvalBackend(): EvalBackend {
  const dbUrl = process.env["SUPABASE_DB_URL"];
  return isPostgresUrl(dbUrl) ? postgresBackend(dbUrl) : supabaseBackend();
}

function postgresBackend(url: string): EvalBackend {
  const sql = postgres(url, { ssl: "require", max: 1, prepare: false, connect_timeout: 15 });

  return {
    kind: "postgres",
    async resolveSubject(requestedEmail?: string): Promise<Subject> {
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
    },
    async counts(): Promise<LibraryCounts> {
      const [row] = await sql<LibraryCounts[]>`
        select
          (select count(*) from public.content_items)::int as items,
          (select count(distinct content_id) from public.document_chunks)::int as indexed,
          (select count(*) from public.ingestion_jobs where status = 'ready')::int as ready`;
      return row ?? { items: 0, indexed: 0, ready: 0 };
    },
    async embeddingModels(): Promise<EmbeddingModelCount[]> {
      return sql<EmbeddingModelCount[]>`
        select embedding_model, count(*)::int as n
        from public.document_chunks
        group by 1
        order by 2 desc`;
    },
    async pgvectorVersion(): Promise<string | null> {
      const [row] = await sql<{ extversion: string }[]>`
        select extversion from pg_extension where extname = 'vector'`;
      return row?.extversion ?? null;
    },
    async search(subject, params): Promise<RetrievedChunk[]> {
      const scope = normalizeScope(params.scope);
      const literal = formatVectorLiteral(params.embedding);
      const claims = JSON.stringify({
        sub: subject.id,
        email: subject.email,
        role: "authenticated",
      });
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
    },
    async explain(example, k): Promise<string[] | null> {
      if (!example.embedding) return null;
      const literal = `[${example.embedding.join(",")}]`;
      const plan = await sql`
        explain (analyze, buffers)
        select * from public.search_chunks(
          ${literal}::vector(1536),
          ${example.queryText},
          ${example.scope.industry},
          ${example.scope.customer},
          ${k}
        )`;
      return plan.map((row) => String(Object.values(row as Record<string, unknown>)[0]));
    },
    async end() {
      await sql.end();
    },
  };
}

function supabaseBackend(): EvalBackend {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"] ?? process.env["SUPABASE_ANON_KEY"];
  const email = process.env["LIBRARY_USER_EMAIL"];
  const password = process.env["LIBRARY_USER_PASSWORD"];
  if (!url || !key) fail("SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY are missing from .env");
  if (!email || !password) {
    fail("LIBRARY_USER_EMAIL / LIBRARY_USER_PASSWORD are required for the Supabase backend");
  }

  const client: SupabaseClient<SupabaseDatabase> = createClient<SupabaseDatabase>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let signedIn: Subject | null = null;

  async function signIn(requestedEmail?: string): Promise<Subject> {
    if (
      signedIn &&
      (!requestedEmail || requestedEmail.toLowerCase() === signedIn.email.toLowerCase())
    ) {
      return signedIn;
    }
    if (requestedEmail && requestedEmail.toLowerCase() !== email!.toLowerCase()) {
      fail(
        `The Supabase backend can only evaluate as ${email}; ` +
          `set LIBRARY_USER_EMAIL to use --email ${requestedEmail}`,
      );
    }
    const { data, error } = await client.auth.signInWithPassword({
      email: email!,
      password: password!,
    });
    if (error || !data.user?.email) fail(`Supabase sign-in failed: ${error?.message ?? "no user"}`);
    signedIn = { id: data.user.id, email: data.user.email };
    return signedIn;
  }

  async function selectAll<T>(
    table: "content_items" | "document_chunks",
    columns: string,
  ): Promise<T[]> {
    const pageSize = 1000;
    const rows: T[] = [];
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await client
        .from(table)
        .select(columns)
        .range(from, from + pageSize - 1);
      if (error) throw new Error(`Reading ${table} failed: ${error.message}`);
      const page = (data ?? []) as T[];
      rows.push(...page);
      if (page.length < pageSize) break;
    }
    return rows;
  }

  async function exactCount(
    table: "content_items" | "document_chunks" | "ingestion_jobs",
    filter?: { column: string; value: string },
  ): Promise<number> {
    let query = client.from(table).select("*", { count: "exact", head: true });
    if (filter) query = query.eq(filter.column, filter.value);
    const { count, error } = await query;
    if (error) throw new Error(`Counting ${table} failed: ${error.message}`);
    return count ?? 0;
  }

  return {
    kind: "supabase",
    resolveSubject: signIn,
    async counts(): Promise<LibraryCounts> {
      const items = await exactCount("content_items");
      const chunkRows = await selectAll<{ content_id: string }>("document_chunks", "content_id");
      const indexed = new Set(chunkRows.map((row) => row.content_id)).size;
      let ready: number | null = null;
      try {
        ready = await exactCount("ingestion_jobs", { column: "status", value: "ready" });
      } catch {
        // ingestion_jobs is admin-readable only; the count is diagnostic, not scored.
      }
      return { items, indexed, ready };
    },
    async embeddingModels(): Promise<EmbeddingModelCount[]> {
      const rows = await selectAll<{ embedding_model: string }>(
        "document_chunks",
        "embedding_model",
      );
      const counts = new Map<string, number>();
      for (const row of rows)
        counts.set(row.embedding_model, (counts.get(row.embedding_model) ?? 0) + 1);
      return [...counts.entries()]
        .map(([embedding_model, n]) => ({ embedding_model, n }))
        .sort((a, b) => b.n - a.n);
    },
    async pgvectorVersion(): Promise<string | null> {
      // pg_extension is not exposed over PostgREST; direct Postgres is required.
      return null;
    },
    async search(_subject, params): Promise<RetrievedChunk[]> {
      const scope = normalizeScope(params.scope);
      const args = {
        query_embedding: formatVectorLiteral(params.embedding),
        query_text: params.queryText,
        filter_industry: scope.industry,
        filter_customer: scope.customer,
        match_count: params.k,
      };
      let lastError = "Library search failed";
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const { data, error } = await client.rpc("search_chunks", args);
        if (!error) return mapSearchRows((data ?? []) as never);
        lastError = error.message;
        if (!/timeout|429|50\d|fetch/i.test(error.message)) break;
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
      throw new Error(`Library search failed: ${lastError}`);
    },
    async explain(): Promise<string[] | null> {
      return null;
    },
    async end() {
      await client.auth.signOut();
    },
  };
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

/**
 * Mirrors searchLibraryChunksAcrossScopes: one search per scope, best score per
 * chunk, then the final cutoff.
 */
export async function retrieveForCase(
  backend: EvalBackend,
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
    batches.push(...(await backend.search(subject, { embedding, queryText, scope, k })));
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

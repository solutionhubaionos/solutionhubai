/**
 * RLS smoke test for the RAG tables. Creates throwaway users/content inside one
 * transaction and rolls everything back, so it is safe to run against any DB.
 * Usage: bun scripts/verify-rag.ts
 */
import postgres from "postgres";

if (!process.env.SUPABASE_DB_URL) {
  console.error("SUPABASE_DB_URL is missing from .env");
  process.exit(1);
}

type User = { id: string; email: string };
type Tx = Parameters<Parameters<ReturnType<typeof postgres>["begin"]>[0]>[0];

const sql = postgres(process.env.SUPABASE_DB_URL, { ssl: "require", max: 1 });
const memberA: User = { id: crypto.randomUUID(), email: "rag-member-a@aionos.ai" };
const memberB: User = { id: crypto.randomUUID(), email: "rag-member-b@aionos.ai" };
const admin: User = { id: crypto.randomUUID(), email: "rag-admin@aionos.ai" };
let passed = 0;

function check(ok: boolean, label: string) {
  if (!ok) throw new Error(`FAIL: ${label}`);
  passed += 1;
  console.log(`PASS: ${label}`);
}

async function asUser<T>(tx: Tx, user: User, fn: () => Promise<T>): Promise<T> {
  await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: user.id, email: user.email })}, true)`;
  await tx`set local role authenticated`;
  try {
    return await fn();
  } finally {
    await tx`reset role`;
  }
}

async function expectDenied(tx: Tx, user: User | null, label: string, fn: () => Promise<unknown>) {
  await tx.unsafe("savepoint expected_denial");
  try {
    if (user) {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: user.id, email: user.email })}, true)`;
      await tx`set local role authenticated`;
    } else {
      await tx`set local role anon`;
    }
    await fn();
    throw new Error(`EXPECTED_DENIAL_SUCCEEDED:${label}`);
  } catch (error) {
    const err = error as { code?: string; message?: string };
    if (err.message?.startsWith("EXPECTED_DENIAL_SUCCEEDED")) throw error;
    await tx.unsafe("rollback to savepoint expected_denial");
    if (err.code !== "42501") throw error;
    passed += 1;
    console.log(`PASS: ${label} (${err.code})`);
  }
}

async function seedUser(tx: Tx, user: User) {
  await tx`
    insert into auth.users
      (id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
    values
      (${user.id}, ${user.email}, now(),
       ${JSON.stringify({ provider: "email", providers: ["email"] })}::jsonb, '{}'::jsonb,
       'authenticated', 'authenticated', now(), now())
  `;
  await tx`
    insert into auth.identities
      (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values
      (${user.id}, ${user.id}, ${JSON.stringify({ sub: user.id, email: user.email })}::jsonb,
       'email', now(), now(), now())
  `;
}

// Same shape the ingestion worker sends to replace_document_chunks. Pass the
// value as JSON (sql.json), never as a string cast to jsonb: a cast turns the
// whole payload into a JSON string instead of an array.
function chunkEntries(entries: Array<{ index: number; content: string }>) {
  return entries.map((entry) => ({
    chunk_index: entry.index,
    content: entry.content,
    estimated_tokens: 3,
    page: 1,
    slide: null,
    heading: null,
    embedding: new Array(1536).fill(0),
  }));
}

try {
  await sql.begin(async (tx) => {
    const fn = await tx`
      select p.prosecdef
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'match_document_chunks'
    `;
    check(fn[0]?.prosecdef === false, "match_document_chunks is security invoker");

    const index = await tx`
      select indexdef from pg_indexes
      where schemaname = 'public' and indexname = 'document_chunks_embedding_idx'
    `;
    check(index[0]?.indexdef.includes("hnsw"), "document_chunks_embedding_idx uses HNSW");

    const anonGrant = await tx`
      select has_table_privilege('anon', 'public.document_chunks', 'SELECT') as can_select
    `;
    check(!anonGrant[0].can_select, "anon has no chunk SELECT grant");

    const [searchFn] = await tx`
      select p.prosecdef
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'search_chunks'
    `;
    check(searchFn?.prosecdef === false, "search_chunks is security invoker");

    await seedUser(tx, memberA);
    await seedUser(tx, memberB);
    await seedUser(tx, admin);
    await tx`insert into public.user_roles (user_id, role) values (${admin.id}, 'admin') on conflict do nothing`;

    const [content] = await tx`
      insert into public.content_items
        (industry, title, file_path, file_name, uploaded_by, uploader_email)
      values
        ('airlines', 'RLS test file', ${`test/${crypto.randomUUID()}.pdf`}, 'rls.pdf',
         ${memberA.id}, ${memberA.email})
      returning id
    `;
    await tx`
      insert into public.document_chunks
        (content_id, chunk_index, content, estimated_tokens, page, embedding)
      values
        (${content.id}, 0, 'RLS test passage', 3, 1, array_fill(0.0::real, ARRAY[1536])::vector)
    `;
    const [queuedJob] = await tx`
      select
        status,
        not_before between now() + interval '119 seconds' and now() + interval '121 seconds'
          as delayed
      from public.ingestion_jobs
      where content_id = ${content.id}
    `;
    check(queuedJob?.status === "queued", "content insert queues an ingestion job");
    check(queuedJob?.delayed === true, "new jobs wait 120 seconds before ingestion");

    // Assertions stay scoped to this test item: the database already holds real
    // indexed content, so a global count is not stable.
    const chunkCount = await asUser(
      tx,
      memberA,
      async () =>
        (
          await tx`select count(*)::int as n from public.document_chunks
                    where content_id = ${content.id}`
        )[0].n,
    );
    check(chunkCount === 1, "member A reads chunks");

    const rpcRows = await asUser(
      tx,
      memberA,
      async () =>
        await tx`select content_id from public.match_document_chunks(
          array_fill(0.0::real, ARRAY[1536])::vector, 50, null
        )`,
    );
    check(
      rpcRows.some((row) => row.content_id === content.id),
      "member A retrieves via match_document_chunks",
    );

    const filteredIn = await asUser(
      tx,
      memberA,
      async () =>
        await tx`select content_id from public.match_document_chunks(
          array_fill(0.0::real, ARRAY[1536])::vector, 50, 'airlines'
        )`,
    );
    check(
      filteredIn.some((row) => row.content_id === content.id),
      "industry filter includes matching chunk",
    );

    const filteredOut = await asUser(
      tx,
      memberA,
      async () =>
        await tx`select content_id, industry from public.match_document_chunks(
          array_fill(0.0::real, ARRAY[1536])::vector, 50, 'bfsi'
        )`,
    );
    check(
      filteredOut.every((row) => row.industry === "bfsi") &&
        !filteredOut.some((row) => row.content_id === content.id),
      "industry filter excludes non-matching chunk",
    );

    const hybrid = await asUser(
      tx,
      memberA,
      async () =>
        await tx`select content_id, content, vector_rank, text_rank from public.search_chunks(
          array_fill(0.0::real, ARRAY[1536])::vector, 'RLS test passage', null, null, 50
        )`,
    );
    const hybridHit = hybrid.find((row) => row.content_id === content.id);
    check(hybridHit?.content === "RLS test passage", "member A retrieves via hybrid search");
    check(hybridHit?.text_rank !== null, "hybrid search used the full-text arm");

    const hybridScopedOut = await asUser(
      tx,
      memberA,
      async () =>
        await tx`select content_id from public.search_chunks(
          array_fill(0.0::real, ARRAY[1536])::vector, 'RLS test passage', 'bfsi', null, 50
        )`,
    );
    check(
      !hybridScopedOut.some((row) => row.content_id === content.id),
      "hybrid search applies the industry scope",
    );

    const hybridCustomerOut = await asUser(
      tx,
      memberA,
      async () =>
        await tx`select content_id from public.search_chunks(
          array_fill(0.0::real, ARRAY[1536])::vector, 'RLS test passage', null, 'Nobody Ltd', 50
        )`,
    );
    check(
      !hybridCustomerOut.some((row) => row.content_id === content.id),
      "hybrid search applies the customer scope",
    );

    const memberBChunks = await asUser(
      tx,
      memberB,
      async () =>
        (
          await tx`select count(*)::int as n from public.document_chunks
                    where content_id = ${content.id}`
        )[0].n,
    );
    check(memberBChunks === 1, "member B reads chunks");

    const memberJobs = await asUser(
      tx,
      memberA,
      async () =>
        (
          await tx`select count(*)::int as n from public.ingestion_jobs
                    where content_id = ${content.id}`
        )[0].n,
    );
    check(memberJobs === 0, "member A cannot read ingestion jobs");

    const adminJobs = await asUser(
      tx,
      admin,
      async () =>
        (
          await tx`select count(*)::int as n from public.ingestion_jobs
                    where content_id = ${content.id}`
        )[0].n,
    );
    check(adminJobs === 1, "admin reads ingestion jobs");

    const replacement = chunkEntries([
      { index: 0, content: "First replacement passage." },
      { index: 1, content: "Second replacement passage." },
    ]);
    const [firstReplace] = await tx`
      select public.replace_document_chunks(
        ${content.id}, ${tx.json(replacement)}, 'hash-v1'
      ) as n
    `;
    check(firstReplace.n === 2, "replace_document_chunks writes every chunk");

    const [secondReplace] = await tx`
      select public.replace_document_chunks(
        ${content.id}, ${tx.json(replacement)}, 'hash-v1'
      ) as n
    `;
    const afterReplace = await tx`
      select count(*)::int as n from public.document_chunks where content_id = ${content.id}
    `;
    check(
      secondReplace.n === 2 && afterReplace[0].n === 2,
      "re-running replacement never duplicates chunks",
    );

    const [job] = await tx`
      select content_hash, chunk_count, status from public.ingestion_jobs
      where content_id = ${content.id}
    `;
    check(
      job.content_hash === "hash-v1" && job.chunk_count === 2 && job.status === "ready",
      "replacement records hash, chunk count and status",
    );

    const [fts] = await tx`
      select count(*)::int as n from public.document_chunks
      where content_id = ${content.id}
        and tsv @@ websearch_to_tsquery('english', 'replacement passage')
    `;
    check(fts.n === 2, "full-text index covers replaced chunks");

    const [ftsFiltered] = await tx`
      select count(*)::int as n from public.document_chunks
      where tsv @@ websearch_to_tsquery('english', 'zebra')
    `;
    check(ftsFiltered.n === 0, "full-text search misses unrelated terms");

    await tx`update public.content_items set title = 'Renamed file' where id = ${content.id}`;
    const [afterTitle] = await tx`
      select status from public.ingestion_jobs where content_id = ${content.id}
    `;
    check(afterTitle.status === "ready", "metadata edits do not requeue ingestion");

    await tx`update public.content_items set file_size = 4242 where id = ${content.id}`;
    const [afterFile] = await tx`
      select
        status,
        not_before between now() + interval '119 seconds' and now() + interval '121 seconds'
          as delayed
      from public.ingestion_jobs
      where content_id = ${content.id}
    `;
    check(afterFile.status === "queued", "changing the stored file requeues ingestion");
    check(afterFile.delayed === true, "a replaced file restarts the 120 second delay");

    await expectDenied(tx, memberA, "member cannot replace chunks", async () => {
      await tx`select public.replace_document_chunks(${content.id}, '[]'::jsonb)`;
    });

    await expectDenied(tx, null, "anon cannot replace chunks", async () => {
      await tx`select public.replace_document_chunks(${content.id}, '[]'::jsonb)`;
    });

    const [thread] = await asUser(
      tx,
      memberA,
      async () =>
        await tx`insert into public.chat_threads (title) values ('A thread') returning id`,
    );
    await asUser(
      tx,
      memberA,
      async () =>
        await tx`insert into public.chat_messages (thread_id, role, content)
                 values (${thread.id}, 'user', 'hello')`,
    );

    const ownThreads = await asUser(
      tx,
      memberA,
      async () => (await tx`select count(*)::int as n from public.chat_threads`)[0].n,
    );
    check(ownThreads === 1, "member A reads own thread");

    const ownMessages = await asUser(
      tx,
      memberA,
      async () => (await tx`select count(*)::int as n from public.chat_messages`)[0].n,
    );
    check(ownMessages === 1, "member A reads own message");

    const otherThreads = await asUser(
      tx,
      memberB,
      async () => (await tx`select count(*)::int as n from public.chat_threads`)[0].n,
    );
    check(otherThreads === 0, "member B cannot read member A's thread");

    const otherMessages = await asUser(
      tx,
      memberB,
      async () => (await tx`select count(*)::int as n from public.chat_messages`)[0].n,
    );
    check(otherMessages === 0, "member B cannot read member A's message");

    const adminThreads = await asUser(
      tx,
      admin,
      async () => (await tx`select count(*)::int as n from public.chat_threads`)[0].n,
    );
    check(adminThreads === 0, "admin cannot read another user's thread");

    await expectDenied(tx, memberB, "member B cannot insert into member A's thread", async () => {
      await tx`insert into public.chat_messages (thread_id, role, content)
               values (${thread.id}, 'user', 'intrusion')`;
    });

    await expectDenied(tx, memberA, "member A cannot insert chunks", async () => {
      await tx`insert into public.document_chunks
               (content_id, chunk_index, content, estimated_tokens, page, embedding)
               values (${content.id}, 1, 'poison', 3, 1, array_fill(0.0::real, ARRAY[1536])::vector)`;
    });

    await expectDenied(tx, admin, "admin cannot insert chunks", async () => {
      await tx`insert into public.document_chunks
               (content_id, chunk_index, content, estimated_tokens, page, embedding)
               values (${content.id}, 2, 'poison', 3, 1, array_fill(0.0::real, ARRAY[1536])::vector)`;
    });

    await expectDenied(tx, null, "anon cannot read chunks", async () => {
      await tx`select count(*) from public.document_chunks`;
    });

    await expectDenied(tx, null, "anon cannot execute match_document_chunks", async () => {
      await tx`select count(*) from public.match_document_chunks(
        array_fill(0.0::real, ARRAY[1536])::vector, 5, null
      )`;
    });

    await expectDenied(tx, null, "anon cannot execute search_chunks", async () => {
      await tx`select count(*) from public.search_chunks(
        array_fill(0.0::real, ARRAY[1536])::vector, 'RLS test passage', null, null, 5
      )`;
    });

    await tx`delete from public.content_items where id = ${content.id}`;
    const chunksAfterDelete = await tx`
      select count(*)::int as n from public.document_chunks where content_id = ${content.id}`;
    check(chunksAfterDelete[0].n === 0, "content delete cascades chunks");
    const jobsAfterDelete = await tx`
      select count(*)::int as n from public.ingestion_jobs where content_id = ${content.id}`;
    check(jobsAfterDelete[0].n === 0, "content delete cascades ingestion job");

    await tx`delete from public.chat_threads where id = ${thread.id}`;
    const messagesAfterDelete = await tx`
      select count(*)::int as n from public.chat_messages where thread_id = ${thread.id}`;
    check(messagesAfterDelete[0].n === 0, "thread delete cascades messages");

    throw new Error("__ROLLBACK__");
  });
} catch (error) {
  if ((error as Error).message !== "__ROLLBACK__") {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
} finally {
  await sql.end();
}

if (process.exitCode !== 1) console.log(`\n${passed} checks passed; test data rolled back.`);

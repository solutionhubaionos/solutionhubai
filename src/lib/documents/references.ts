/**
 * Loads the names that must not reach a client-facing export, then builds the
 * deterministic redactor. The database is the authority for customer names and
 * aliases; failure to read it degrades to metadata titles/customer names, never
 * to naming a reference.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../integrations/supabase/types";
import type { RetrievedChunk } from "../rag/search";
import {
  createReferenceRedactor,
  type ReferenceDocument,
  type ReferenceName,
  type ReferenceRedactor,
} from "./redact";

type UntypedClient = {
  from: (table: string) => {
    select: (columns: string) => PromiseLike<{
      data: unknown[] | null;
      error: { message: string } | null;
    }>;
  };
};

function asUntyped(client: SupabaseClient<Database>): UntypedClient {
  return client as unknown as UntypedClient;
}

/**
 * Platform and partner names that appear in the customers table but are not
 * clients whose name must be hidden.
 * shortcut: curated list, move to a flag on customers when vendors are modelled.
 */
const NON_CLIENT_NAMES = new Set(["booking.com"]);

/** Codenames that appear in file names instead of a dedicated customer row. */
const EXPLICIT_ALIASES: Record<string, readonly string[]> = {
  "indigo airlines": ["IndiGo", "Fly++"],
};

function isNonClient(name: string): boolean {
  return NON_CLIENT_NAMES.has(name.trim().toLowerCase());
}

export async function loadReferenceRedactor(
  client: SupabaseClient<Database>,
  chunks: readonly RetrievedChunk[],
  targets: readonly string[],
  log: (event: string, meta: Record<string, unknown>) => void = () => undefined,
): Promise<ReferenceRedactor> {
  const db = asUntyped(client);
  const [customers, content, aliases] = await Promise.all([
    db.from("customers").select("name, industry"),
    db.from("content_items").select("id, customer_name, industry"),
    db.from("customer_aliases").select("alias, canonical"),
  ]);

  if (customers.error) log("reference customers unavailable", { error: customers.error.message });
  if (content.error) log("reference content unavailable", { error: content.error.message });
  if (aliases.error) log("reference aliases unavailable", { error: aliases.error.message });

  const aliasRows = (aliases.data ?? []) as { alias: string; canonical: string }[];
  const aliasesByCanonical = new Map<string, string[]>();
  for (const row of aliasRows) {
    const key = row.canonical.trim().toLowerCase();
    if (!key || !row.alias.trim()) continue;
    const list = aliasesByCanonical.get(key) ?? [];
    list.push(row.alias.trim());
    aliasesByCanonical.set(key, list);
  }

  const references: ReferenceName[] = [];
  const seen = new Set<string>();
  const add = (name: string | null, industry: string | null, extra: string[] = []) => {
    const value = (name ?? "").trim();
    const key = value.toLowerCase();
    if (!value || isNonClient(value) || seen.has(key)) return;
    seen.add(key);
    references.push({
      name: value,
      industry,
      aliases: extra.filter((alias) => !isNonClient(alias)),
    });
  };

  const customerRows = (customers.data ?? []) as { name: string; industry: string }[];
  for (const row of customerRows) {
    const key = row.name.trim().toLowerCase();
    add(row.name, row.industry, [
      ...(aliasesByCanonical.get(key) ?? []),
      ...(EXPLICIT_ALIASES[key] ?? []),
    ]);
  }

  const contentRows = (content.data ?? []) as {
    id: string;
    customer_name: string | null;
    industry: string | null;
  }[];
  for (const row of contentRows) {
    add(row.customer_name, row.industry);
  }

  const documents: ReferenceDocument[] = contentRows.map((row) => ({
    contentId: row.id,
    industry: row.industry,
    customerName: row.customer_name,
  }));
  for (const chunk of chunks) {
    if (!documents.some((document) => document.contentId === chunk.contentId)) {
      documents.push({
        contentId: chunk.contentId,
        industry: chunk.industry,
        customerName: chunk.customerName,
      });
    }
  }

  const redactor = createReferenceRedactor({ references, documents, targets });
  log("reference redactor loaded", {
    names: redactor.entries.length,
    sample: redactor.entries.slice(0, 30).map((entry) => entry.value),
    aliases: aliasRows.length,
    documents: documents.length,
  });
  return redactor;
}

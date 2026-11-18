/**
 * Conversation scope persistence. The server is the only reader that matters:
 * every chat turn and every export loads the scope by conversation id, so the
 * client never has to resend it (and cannot silently lose it).
 *
 * The table is owner-only under RLS, so a caller can only read and write their
 * own conversations.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  EMPTY_SCOPE,
  normalizeScope,
  normalizeTargetClients,
  type ConversationScope,
} from "./conversationScope";

const scopeSchema = z.object({
  industries: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
  companies: z
    .array(
      z.object({
        id: z.string().uuid().nullish(),
        canonicalName: z.string().trim().min(1).max(120),
        industry: z.string().trim().max(64).nullish(),
      }),
    )
    .max(40)
    .default([]),
  updatedAt: z.string().trim().max(40).nullish(),
  /** Target clients live in their own column; normalised server-side. */
  targetClients: z.array(z.unknown()).max(6).optional(),
});

export type LoadScopeResult = { ok: true; scope: ConversationScope } | { ok: false; error: string };

/**
 * Reads the stored scope for one conversation. A missing row is not an error:
 * it is a conversation that never picked a scope, which behaves as before.
 */
export async function readConversationScope(
  client: SupabaseClient<Database>,
  conversationId: string,
): Promise<ConversationScope> {
  try {
    const { data, error } = await client
      .from("conversations")
      .select("scope, target_client")
      .eq("id", conversationId)
      .maybeSingle();
    if (error) {
      // A database without the target_client column must still serve the
      // industry/company scope rather than collapsing to an empty one.
      console.error("[SCOPE] target_client read failed", error.message);
      const fallback = await client
        .from("conversations")
        .select("scope")
        .eq("id", conversationId)
        .maybeSingle();
      if (fallback.error || !fallback.data) return EMPTY_SCOPE;
      return normalizeScope(fallback.data.scope);
    }
    if (!data) return EMPTY_SCOPE;
    return {
      ...normalizeScope(data.scope),
      targetClients: normalizeTargetClients(data.target_client),
    };
  } catch {
    // Never block a turn on scope persistence; unscoped behaves like today.
    return EMPTY_SCOPE;
  }
}

/** Inserts or updates the scope for the caller's conversation. */
export async function writeConversationScope(
  client: SupabaseClient<Database>,
  userId: string,
  conversationId: string,
  scope: ConversationScope,
): Promise<boolean> {
  const payload = {
    id: conversationId,
    user_id: userId,
    scope: {
      industries: scope.industries,
      companies: scope.companies,
      updatedAt: scope.updatedAt,
    },
    target_client: scope.targetClients,
    updated_at: new Date().toISOString(),
  };
  const { error } = await client.from("conversations").upsert(payload, { onConflict: "id" });
  return !error;
}

export const loadConversationScope = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => z.object({ conversationId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }): Promise<LoadScopeResult> => {
    const scope = await readConversationScope(context.supabase, data.conversationId);
    return { ok: true, scope };
  });

export const saveConversationScope = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z.object({ conversationId: z.string().uuid(), scope: scopeSchema }).parse(data),
  )
  .handler(async ({ data, context }): Promise<LoadScopeResult> => {
    const scope = normalizeScope({
      ...data.scope,
      targetClients: normalizeTargetClients(data.scope.targetClients),
      updatedAt: new Date().toISOString(),
    });
    const saved = await writeConversationScope(
      context.supabase,
      context.userId,
      data.conversationId,
      scope,
    );
    console.log("[SCOPE] saved", {
      conversationId: data.conversationId,
      industries: scope.industries,
      companies: scope.companies.length,
      targets: scope.targetClients.map((target) => ({
        name: target.name,
        website: target.websiteUrl,
      })),
      saved,
    });
    if (!saved) return { ok: false, error: "Could not save the selected scope." };
    return { ok: true, scope };
  });

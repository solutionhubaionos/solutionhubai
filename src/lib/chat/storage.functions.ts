/**
 * Persistent chats. The `conversations` table already holds one row per chat
 * (scope + target client); this adds its transcript and intake so a reload or a
 * later session reopens the same conversation, and the sidebar can list every
 * past one. Owner-only RLS (migration 0022) governs every query.
 *
 * The list query deliberately never reads `messages`: it can carry a generated
 * document's bytes. Only opening a chat loads its transcript.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";

export type ChatSummaryRow = { id: string; title: string; updatedAt: string };
export type LoadedConversation = {
  id: string;
  title: string;
  messages: Json[];
  intake: Json | null;
  updatedAt: string;
};

/** Above this the row is not stored; a runaway transcript costs the save, never the chat. */
const MAX_TRANSCRIPT_BYTES = 8_000_000;

const messagesSchema = z.array(z.unknown()).max(500);

export async function listConversationRows(
  client: SupabaseClient<Database>,
  userId: string,
): Promise<ChatSummaryRow[]> {
  const { data, error } = await client
    .from("conversations")
    .select("id,title,updated_at")
    .eq("user_id", userId)
    // A row is a real chat only once it has a title; scope-only rows from the
    // wizard have none and stay out of the list.
    .not("title", "is", null)
    .order("updated_at", { ascending: false })
    .limit(60);
  if (error || !data) return [];
  return data.map((row) => ({
    id: row.id,
    title: (row.title ?? "Conversation").slice(0, 120),
    updatedAt: row.updated_at,
  }));
}

export const listConversations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ChatSummaryRow[]> => {
    return listConversationRows(context.supabase, context.userId);
  });

export const loadConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => z.object({ conversationId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }): Promise<LoadedConversation | null> => {
    const { data: row, error } = await context.supabase
      .from("conversations")
      .select("id,title,messages,intake,updated_at")
      .eq("id", data.conversationId)
      .maybeSingle();
    if (error || !row) return null;
    return {
      id: row.id,
      title: (row.title ?? "Conversation").slice(0, 120),
      messages: Array.isArray(row.messages) ? row.messages : [],
      intake: row.intake ?? null,
      updatedAt: row.updated_at,
    };
  });

export const saveConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({
        conversationId: z.string().uuid(),
        title: z.string().trim().max(120),
        messages: messagesSchema,
        intake: z.unknown().optional(),
      })
      .parse(data),
  )
  .handler(async ({ data, context }): Promise<{ ok: boolean }> => {
    const messages = JSON.stringify(data.messages);
    if (messages.length > MAX_TRANSCRIPT_BYTES) {
      // The chat stays usable; only this save is skipped.
      return { ok: false };
    }
    const { error } = await context.supabase.from("conversations").upsert(
      {
        id: data.conversationId,
        user_id: context.userId,
        title: data.title,
        messages: data.messages as Json,
        intake: (data.intake ?? null) as Json,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
    return { ok: !error };
  });

export const deleteConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => z.object({ conversationId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }): Promise<{ ok: boolean }> => {
    const { error } = await context.supabase
      .from("conversations")
      .delete()
      .eq("id", data.conversationId);
    return { ok: !error };
  });
